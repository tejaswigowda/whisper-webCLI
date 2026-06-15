# whisper webCLI

[![GitHub stars](https://img.shields.io/github/stars/tejaswigowda/whisper-webCLI?style=social)](https://github.com/tejaswigowda/whisper-webCLI/stargazers)

A browser-based speech-to-text transcriber powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) and OpenAI's Whisper model. <b><ins>No uploads, no servers -- all processing happens locally</ins></b> in your browser using WebAssembly.

▶ **Live app:** https://tejaswigowda.github.io/whisper-webCLI/

> Second in the **webCLI** family of zero-egress, offline-first browser tools, alongside [ffmpeg-webCLI](https://github.com/tejaswigowda/ffmpeg-webCLI). Same look and feel, same privacy promise: your media never leaves your device.

---

## Key Features

✓ **No Server Uploads** : All transcription happens entirely on your device — audio is never sent anywhere

✓ **OpenAI Whisper** : High-quality multilingual speech recognition running locally via whisper.cpp WASM

✓ **Multiple Export Formats** : Plain text (.txt), SubRip (.srt), and WebVTT (.vtt)

✓ **Editable Transcripts** : Rich-text editor (Quill) to correct and format the transcript before download

✓ **Offline-First PWA** : Works completely offline after first use; install as a native app

✓ **Model Caching** : Model weights are cached in IndexedDB and reused with no re-download

✓ **Multi-Language** : ~99 languages with auto-detection, or pick the language explicitly

✓ **Translation** : Optionally translate non-English audio directly to English

✓ **Screen Wake Lock** : Screen stays active during long transcriptions on any device

✓ **Fast & Responsive** : Transcription runs in a Web Worker to keep the UI smooth

✓ **Privacy First** : Zero data collection, zero telemetry; works with your files locally

---

## What It Replaces

| Tool | What you replace |
|---|---|
| Otter.ai | Audio/video transcription |
| Rev / Temi | Paid transcription with file upload |
| Sonix / Trint | Multi-format subtitle export (SRT, VTT) |
| Google Speech-to-Text | Cloud STT API calls |
| YouTube auto-captions | SRT/VTT caption generation |
| Happy Scribe | Translation + transcription |

**The difference that matters:** every one of those tools uploads your audio to a
server. Some are free with limits, some charge per minute -- but all of them *hear your
audio*, and all are subject to data breaches, subpoenas, and privacy-policy changes.

whisper-webCLI covers the common transcription tasks for free, with audio that
**never leaves your device**.

---

## Usage

### ▤ 1 · Select Audio Input
Choose one of two input modes:

**📁 Upload File** — Drag & drop or click to load a file. Supported inputs: MP3, WAV, M4A, OGG, FLAC, MP4, WebM, MOV. File name, size, and duration are shown once loaded.

**🎤 Recording** — Click to start recording directly from your microphone. Real-time waveform visualization shows your audio levels. Duration and sample rate are displayed throughout the recording.

### ⚙ 2 · Configure
Pick a **model** (tiny → medium) and a **language** (auto-detect or explicit). Optionally enable **Translate to English** to convert non-English speech to English text.

### ⊕ Advanced Settings
Expand for fine control:
- **Temperature** (0–1) — 0 is deterministic, higher is more creative.
- **Beam Size** — search width during decoding; higher is slower but more accurate.

### ◉ 3 · Preview
While Whisper runs, the partial transcript streams into a live preview pane so you can watch progress in real time.

### ✎ 4 · Edit & Review
When transcription completes, the full transcript opens in a rich-text editor. Fix recognition errors and apply formatting before exporting.

### ↓ 5 · Download
Export the transcript as **.txt**, **.srt**, or **.vtt** — ready for documents, video editors, or web players.

---

## Model Sizes & Speed

| Model  | Size   | Speed (relative) | Accuracy | RAM    |
|--------|--------|------------------|----------|--------|
| tiny   | 39 MB  | 1×               | ★★★      | ~200 MB |
| base   | 74 MB  | 0.7×             | ★★★★     | ~400 MB |
| small  | 244 MB | 0.3×             | ★★★★★    | ~800 MB |
| medium | 1.5 GB | 0.1×             | ★★★★★    | ~2 GB   |

**Tip:** the tiny model is excellent for clear English; use base or small for non-English audio or noisy recordings.

---

## How It Works

whisper-webCLI brings OpenAI's Whisper model to the browser:

1. **WASM compilation** — Whisper is compiled to WebAssembly via [whisper.cpp](https://github.com/ggerganov/whisper.cpp).
2. **Browser execution** — The WASM binary and model weights run entirely client-side in a Web Worker.
3. **Zero network egress** — Audio never leaves your device; only static assets and model weights are downloaded.
4. **PWA deployment** — A service worker caches the WASM binary and assets for offline use.
5. **Model caching** — Model weights are cached in IndexedDB for reuse without re-downloading.

```
┌─────────────────────────────────────┐
│ index.html (UI · webCLI look & feel)│
│ - File upload (drag & drop)         │
│ - Model / language / advanced opts  │
│ - Live preview, editor, export      │
└──────────────┬──────────────────────┘
               │
    ┌──────────┴──────────┐
    ▼                     ▼
┌──────────────────┐ ┌─────────────────────┐
│ app.js           │ │ transcription-      │
│ (controller)     │ │ worker.js           │
│ - UI + PWA       │ │ (Web Worker)        │
│ - model manager  │ │ - off-main-thread   │
│ - downloads      │ │ - progress updates  │
└──────────────────┘ └────────┬────────────┘
    │                         │
    └────────────┬────────────┘
                 ▼
        ┌─────────────────────┐
        │ transcriber.js      │
        │ (reusable engine)   │
        │ - whisper.cpp WASM  │
        │ - audio processing  │
        │ - segment parsing   │
        └─────────────────────┘
```

---

## Privacy & Security

**Zero-egress verification:**
1. Open DevTools (F12) → Network tab.
2. Load the app and transcribe any file.
3. Observe **zero outbound requests during transcription** — only the initial asset/model downloads appear. No telemetry, no analytics, no external API calls.

**Data storage:**
- Model weights cached locally in IndexedDB (survives browser restart).
- Service worker caches static assets and the WASM binary.
- No data is sent to any server.

**Cross-origin isolation:**
- The server sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- This enables `SharedArrayBuffer` for multi-threaded WASM.

---

## Running Locally

### Prerequisites
- Node.js 14+
- A modern browser (Chrome, Edge, Firefox, Safari 15+)

### Setup

```bash
git clone https://github.com/tejaswigowda/whisper-webCLI.git
cd whisper-webCLI

# Start the development server (sets COOP/COEP headers automatically)
node server.js

# Open http://127.0.0.1:5500
```

### Deployment

Deploy the `docs/` folder to any static host:

- **GitHub Pages** — enable in repo settings; serve from `docs/`.
- **Vercel / Netlify / Cloudflare Pages** — drag & drop the `docs/` folder.
- **Traditional web server** — copy `docs/` to the web root.

**Important:** the host must send these headers so `SharedArrayBuffer` is available:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## Project Structure

```
docs/
├── index.html                # Main UI (webCLI look & feel, PWA manifest)
├── style.css                 # Dark theme, shared webCLI design tokens
├── app.js                    # App controller (UI + orchestration)
├── transcriber.js            # Reusable transcription engine (WASM wrapper)
├── model-manager.js          # Model download, cache, progress
├── format-exporter.js        # TXT / SRT / VTT conversion
├── transcription-worker.js   # Web Worker for transcription
├── service-worker.js         # PWA offline caching + header injection
└── manifest.json             # PWA manifest

server.js                     # Node.js dev server (COOP/COEP headers)
```

### Reuse in the webCLI family

`transcriber.js` is designed to be reused by [ffmpeg-webCLI](https://github.com/tejaswigowda/ffmpeg-webCLI) to power an auto-caption feature:

```javascript
import { Transcriber } from 'whisper-webCLI/transcriber.js';

const transcriber = new Transcriber();
await transcriber.init(wasmBinary);
const segments = await transcriber.transcribe(audioBuffer, { model: 'base' });
// segments: [{ id, start, end, text }, ...] → generate SRT, embed as soft subtitles
```

---

## Dependencies

**None** — pure browser APIs plus the whisper.cpp WASM build. Node.js is only used for the local development server.

---

## Acknowledgments

- **whisper.cpp** — Georgi Gerganov (MIT)
- **OpenAI Whisper** — OpenAI Research (MIT)
- **ffmpeg-webCLI** — sibling project and design inspiration

---

## License

GPL-3.0 — see [LICENSE](LICENSE). OpenAI Whisper (MIT) and whisper.cpp (MIT) are compatible with GPL-3.0.

---

**Questions?** Open an [issue](https://github.com/tejaswigowda/whisper-webCLI/issues) or submit a PR.
