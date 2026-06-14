/**
 * Transcription Worker (ES module)
 *
 * Runs Whisper transcription off the main thread so the UI stays responsive.
 * Loads the reusable Transcriber engine (Transformers.js under the hood).
 *
 * Messages in:
 *   { type: 'transcribe', payload: { audioBuffer, sampleRate, options } }
 *   { type: 'abort' }
 *
 * Messages out:
 *   { type: 'progress', progress: { pct, label } }
 *   { type: 'result', segments }
 *   { type: 'error', message }
 */

import { Transcriber } from './transcriber.js';

const transcriber = new Transcriber();
let busy = false;

self.onmessage = async (event) => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'transcribe':
      await handleTranscribe(payload);
      break;
    case 'abort':
      // Transformers.js inference is not cancellable mid-run; flag only.
      self.postMessage({ type: 'aborted' });
      break;
    default:
      // 'init' is no longer required — the model loads on first transcribe.
      break;
  }
};

async function handleTranscribe(payload) {
  if (busy) {
    self.postMessage({
      type: 'error',
      message: 'A transcription is already in progress.',
    });
    return;
  }

  busy = true;
  try {
    const { audioBuffer, sampleRate, options } = payload;
    const audioData = new Float32Array(audioBuffer);

    const segments = await transcriber.transcribe(audioData, {
      sampleRate,
      ...options,
      onModelProgress: (p) => {
        // p: { status, file, progress, loaded, total }
        if (p && p.status === 'progress') {
          const pct = Math.round(p.progress || 0);
          self.postMessage({
            type: 'progress',
            progress: {
              pct,
              label: `Downloading model (${p.file || ''}) ${pct}%`,
              segments: [],
            },
          });
        } else if (p && p.status === 'done') {
          self.postMessage({
            type: 'progress',
            progress: { pct: 100, label: 'Model ready', segments: [] },
          });
        }
      },
      onStatus: (s) => {
        if (s.stage === 'loading-model') {
          self.postMessage({
            type: 'progress',
            progress: { pct: null, label: 'Loading model…', segments: [] },
          });
        } else if (s.stage === 'transcribing') {
          self.postMessage({
            type: 'progress',
            progress: { pct: 0, label: 'Transcribing… 0%', segments: [] },
          });
        }
      },
      onProgress: (p) => {
        // Streaming progress: pct, label, accumulated segments
        self.postMessage({
          type: 'progress',
          progress: p,
        });
      },
    });

    self.postMessage({ type: 'result', segments });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err && err.message ? err.message : String(err),
    });
  } finally {
    busy = false;
  }
}
