/**
 * whisper-webCLI Main Application Controller
 * 
 * Orchestrates:
 * - UI interactions and progressive disclosure
 * - Model management and downloads
 * - Audio file processing
 * - Transcription workflow via Web Worker
 * - Output format generation and download
 * - PWA and offline functionality
 * - Screen Wake Lock during transcription
 */

class WhisperApp {
  constructor() {
    this.modelManager = new ModelManager();
    this.worker = null;
    this.workerReady = false;
    this.currentTranscript = null;
    this.wakeLockSentinel = null;
    this.isTranscribing = false;
    this.selectedModel = 'tiny'; // Default model
    this.selectedLanguage = 'auto';
    this.translateToEnglish = false;
    this.quillEditor = null; // Rich text editor instance
  }

  /**
   * Initialize the application
   */
  async init() {
    console.log('Initializing whisper-webCLI...');

    // Initialize model manager
    await this.modelManager.init();

    // Setup UI
    this._setupUI();

    // Clear old service worker caches and unregister stale workers.
    // This ensures the latest code always loads (even after service worker updates).
    if ('serviceWorker' in navigator) {
      try {
        // Unregister all old service workers
        const registrations = await navigator.serviceWorker.getRegistrations();
        let hadOldWorkers = false;
        for (const reg of registrations) {
          await reg.unregister();
          hadOldWorkers = true;
          console.log('Unregistered old service worker');
        }

        // Clear all old caches to prevent stale code
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          await caches.delete(name);
          console.log(`Cleared cache: ${name}`);
        }

        // If we had old workers, reload to get the fresh code
        if (hadOldWorkers) {
          console.log('Old service workers cleared. Reloading…');
          location.reload();
          return; // Stop init, will run again after reload
        }
      } catch (err) {
        console.warn('Service worker cleanup failed:', err);
      }

      // Register the new service worker
      try {
        const reg = await navigator.serviceWorker.register('service-worker.js');
        console.log('✓ Service Worker registered:', reg);
      } catch (err) {
        console.warn('Service Worker registration failed:', err);
      }
    }

    // Initialize Web Worker for transcription (ES module worker).
    // The Whisper model is loaded lazily inside the worker on first transcribe.
    this.worker = new Worker('transcription-worker.js', { type: 'module' });
    this.worker.onmessage = (event) => this._handleWorkerMessage(event);
    this.worker.onerror = (err) => {
      this._showAlert(`Worker error: ${err.message}`, 'error');
      this.isTranscribing = false;
      const btn = document.getElementById('transcribe-button');
      if (btn) btn.disabled = false;
    };

    console.log('✓ whisper-webCLI ready');
  }

  /**
   * Setup UI elements and event listeners
   */
  _setupUI() {
    // File input
    const fileInput = document.getElementById('audio-file');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => this._handleFileSelect(e));
      fileInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        document.getElementById('drop-zone').classList.add('dragging');
      });
      fileInput.addEventListener('dragleave', (e) => {
        document.getElementById('drop-zone').classList.remove('dragging');
      });
      fileInput.addEventListener('drop', (e) => {
        e.preventDefault();
        document.getElementById('drop-zone').classList.remove('dragging');
        if (e.dataTransfer.files.length > 0) {
          fileInput.files = e.dataTransfer.files;
          this._handleFileSelect({ target: { files: e.dataTransfer.files } });
        }
      });
    }

    // Model selection
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
      modelSelect.addEventListener('change', (e) => {
        this.selectedModel = e.target.value;
      });
      // Populate models
      this.modelManager.listModels().forEach((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        if (model.id === this.selectedModel) option.selected = true;
        modelSelect.appendChild(option);
      });
    }

    // Language selection
    const langSelect = document.getElementById('language-select');
    if (langSelect) {
      langSelect.addEventListener('change', (e) => {
        this.selectedLanguage = e.target.value;
      });
    }

    // Translate checkbox
    const translateCheck = document.getElementById('translate-checkbox');
    if (translateCheck) {
      translateCheck.addEventListener('change', (e) => {
        this.translateToEnglish = e.target.checked;
      });
    }

    // Transcribe button
    const transcribeBtn = document.getElementById('transcribe-button');
    if (transcribeBtn) {
      transcribeBtn.addEventListener('click', () => this._handleTranscribe());
    }

    // Download buttons
    document.getElementById('download-txt')?.addEventListener('click', () => {
      this._downloadFormat('txt');
    });
    document.getElementById('download-srt')?.addEventListener('click', () => {
      this._downloadFormat('srt');
    });
    document.getElementById('download-vtt')?.addEventListener('click', () => {
      this._downloadFormat('vtt');
    });

    // Expandable advanced panel
    const advancedHeader = document.getElementById('advanced-header');
    if (advancedHeader) {
      advancedHeader.addEventListener('click', () => {
        const panel = advancedHeader.closest('.collapsible');
        panel.classList.toggle('open');
      });
    }

    // Copy to clipboard
    document.getElementById('copy-transcript')?.addEventListener('click', () => {
      let textToCopy;
      if (this.quillEditor) {
        textToCopy = this.quillEditor.getText();
      } else {
        const textarea = document.getElementById('transcript-text');
        textToCopy = textarea?.value || '';
      }
      
      if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          this._showAlert('Copied to clipboard', 'success');
        });
      }
    });
  }

  /**
   * Handle file selection
   */
  async _handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Clear media player from previous file
    const mediaPlayer = document.getElementById('media-player');
    if (mediaPlayer.src) {
      URL.revokeObjectURL(mediaPlayer.src);
      mediaPlayer.src = '';
    }

    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-size').textContent = this._formatBytes(file.size);

    // Preview: extract audio duration if possible
    try {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      audio.src = url;
      audio.onloadedmetadata = () => {
        document.getElementById('file-duration').textContent = this._formatSeconds(
          audio.duration
        );
        URL.revokeObjectURL(url);
      };
    } catch (err) {
      console.warn('Could not extract audio metadata:', err);
    }

    // Enable transcribe button
    document.getElementById('transcribe-button').disabled = false;
  }

  /**
   * Handle transcription
   */
  async _handleTranscribe() {
    const fileInput = document.getElementById('audio-file');
    if (!fileInput.files.length) {
      this._showAlert('Please select an audio file', 'warning');
      return;
    }

    const file = fileInput.files[0];

    try {
      this.isTranscribing = true;
      document.getElementById('transcribe-button').disabled = true;
      document.getElementById('progress-container').classList.remove('hidden');
      document.getElementById('preview-container').classList.remove('hidden');
      document.getElementById('transcript-container').classList.add('hidden');
      document.getElementById('download-section').classList.add('hidden');
      this._updateTranscriptionProgress({ pct: 0, label: 'Decoding audio…', segments: [] });

      // Set up media player for playback
      const mediaPlayer = document.getElementById('media-player');
      const seekbar = document.getElementById('media-seekbar');
      const mediaUrl = URL.createObjectURL(file);
      mediaPlayer.src = mediaUrl;
      this._setupMediaSeekbar();
      this._updateSeekbarFill(seekbar);
      
      // Start playing audio immediately when transcription begins
      mediaPlayer.play().catch(err => {
        console.warn('Could not autoplay audio:', err);
      });

      // Decode audio file to mono PCM (the worker resamples to 16 kHz and
      // lazily downloads + caches the Whisper model on first use).
      const audioBuffer = await this._decodeAudioFile(file);

      // Send to worker for transcription.
      // Transfer audioData buffer ownership to avoid copying.
      this.worker.postMessage(
        {
          type: 'transcribe',
          payload: {
            audioBuffer: audioBuffer.audioData.buffer,
            sampleRate: audioBuffer.sampleRate,
            options: {
              model: this.selectedModel,
              language: this.selectedLanguage,
              translate: this.translateToEnglish,
            },
          },
        },
        [audioBuffer.audioData.buffer]
      );

      // Request screen wake lock
      await this._requestWakeLock();
    } catch (err) {
      this._showAlert(`Transcription error: ${err.message}`, 'error');
      this.isTranscribing = false;
      document.getElementById('transcribe-button').disabled = false;
    }
  }

  /**
   * Decode audio file to AudioBuffer and convert to transferable format
   * AudioBuffer cannot be cloned, so we convert to Float32Array
   */
  async _decodeAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Convert to transferable format (Float32Array)
    // Whisper expects mono audio
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    
    // Get mono audio (mix channels if needed)
    let monoData;
    if (numChannels === 1) {
      monoData = audioBuffer.getChannelData(0);
    } else {
      // Mix stereo/multi-channel to mono
      monoData = new Float32Array(length);
      for (let channel = 0; channel < numChannels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          monoData[i] += channelData[i] / numChannels;
        }
      }
    }
    
    return {
      audioData: monoData,
      sampleRate: sampleRate,
      channels: 1,
      length: length,
    };
  }

  /**
   * Request screen wake lock to prevent sleep during transcription
   */
  async _requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      console.warn('Screen Wake Lock API not supported');
      return;
    }

    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
      console.log('✓ Screen wake lock acquired');

      this.wakeLockSentinel.addEventListener('release', () => {
        console.log('Screen wake lock released');
      });
    } catch (err) {
      console.warn('Failed to acquire screen wake lock:', err);
    }
  }

  /**
   * Set up media seekbar to sync with player playback
   */
  _setupMediaSeekbar() {
    const mediaPlayer = document.getElementById('media-player');
    const seekbar = document.getElementById('media-seekbar');

    if (!mediaPlayer || !seekbar) return;

    // Update seekbar max when metadata loads
    mediaPlayer.addEventListener('loadedmetadata', () => {
      seekbar.max = mediaPlayer.duration || 100;
    });

    // Update seekbar position as audio plays
    mediaPlayer.addEventListener('timeupdate', () => {
      seekbar.value = mediaPlayer.currentTime || 0;
      // Update visual fill percentage
      this._updateSeekbarFill(seekbar);
    });
  }

  /**
   * Update the visual fill of the seekbar based on current value
   */
  _updateSeekbarFill(seekbar) {
    const max = parseFloat(seekbar.max) || 100;
    const value = parseFloat(seekbar.value) || 0;
    const percentage = (value / max) * 100;
    
    // Update background gradient to show filled portion
    seekbar.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${percentage}%, var(--surface3) ${percentage}%, var(--surface3) 100%)`;
  }

  /**
   * Release screen wake lock
   */
  _releaseWakeLock() {
    if (this.wakeLockSentinel) {
      this.wakeLockSentinel.release();
      this.wakeLockSentinel = null;
    }
  }

  /**
   * Handle worker messages (transcription results, progress, errors)
   */
  _handleWorkerMessage(event) {
    const { type, segments, message, progress } = event.data;

    switch (type) {
      case 'result':
        this._handleTranscriptionComplete(segments);
        break;
      case 'progress':
        this._updateTranscriptionProgress(progress);
        break;
      case 'error':
        this._showAlert(`Transcription error: ${message}`, 'error');
        this.isTranscribing = false;
        document.getElementById('transcribe-button').disabled = false;
        document.getElementById('progress-container').classList.add('hidden');
        this._releaseWakeLock();
        break;
    }
  }

  /**
   * Update progress during transcription
   */
  _updateTranscriptionProgress(progress) {
    const progressBar = document.querySelector('.progress-bar');
    const progressText = document.getElementById('progress-text');
    if (!progress) return;

    const label = progress.label || 'Working…';
    const segments = progress.segments || [];

    // Update progress bar with percentage
    if (typeof progress.pct === 'number') {
      const pct = progress.pct;
      if (progressBar) {
        progressBar.style.width = `${pct}%`;
        progressBar.textContent = `${pct}%`;
        progressBar.classList.remove('indeterminate');
      }
      if (progressText) progressText.textContent = label;
    } else {
      // Indeterminate (model loading): animate full bar.
      if (progressBar) {
        progressBar.style.width = '100%';
        progressBar.textContent = '';
        progressBar.classList.add('indeterminate');
      }
      if (progressText) progressText.textContent = label;
    }

    // Live streaming transcription in preview
    if (segments && segments.length > 0) {
      const previewText = document.getElementById('preview-text');
      if (previewText) {
        const text = segments.map((seg) => seg.text).join('\n');
        previewText.textContent = text;
        // Auto-scroll to bottom (console-like behavior)
        previewText.scrollTop = previewText.scrollHeight;
      }

      // Seek media player to follow transcription progress
      const mediaPlayer = document.getElementById('media-player');
      if (mediaPlayer && segments.length > 0) {
        // Seek to the end time of the last segment
        const lastSegment = segments[segments.length - 1];
        mediaPlayer.currentTime = lastSegment.end;
        // Ensure audio continues playing after seeking
        if (!mediaPlayer.paused) {
          mediaPlayer.play().catch(err => {
            console.warn('Could not resume audio after seek:', err);
          });
        }
      }
    }
  }

  /**
   * Handle transcription completion
   */
  _handleTranscriptionComplete(segments) {
    this.currentTranscript = segments;
    this.isTranscribing = false;

    // Release screen wake lock
    this._releaseWakeLock();

    // Hide preview, show editor (Step 4)
    const previewContainer = document.getElementById('preview-container');
    previewContainer.classList.add('hidden');

    const transcriptContainer = document.getElementById('transcript-container');
    transcriptContainer.classList.remove('hidden');

    const downloadSection = document.getElementById('download-section');
    downloadSection.classList.remove('hidden');

    // Initialize Quill editor with the transcript
    const text = segments.map((seg) => seg.text).join('\n');
    this._initializeQuillEditor(text);

    // Hide progress, update to 100%
    const progressContainer = document.getElementById('progress-container');
    progressContainer.classList.add('hidden');

    // Show success message
    this._showAlert(
      `✓ Transcription complete (${segments.length} segments)`,
      'success'
    );

    // Enable download buttons
    document.getElementById('download-txt').disabled = false;
    document.getElementById('download-srt').disabled = false;
    document.getElementById('download-vtt').disabled = false;

    document.getElementById('transcribe-button').disabled = false;
  }

  /**
   * Initialize Quill rich text editor
   */
  _initializeQuillEditor(initialText) {
    if (this.quillEditor) {
      this.quillEditor.setContents([{ insert: initialText }]);
      return;
    }

    this.quillEditor = new Quill('#editor', {
      theme: 'snow',
      placeholder: 'Edit your transcript here...',
      modules: {
        toolbar: [
          ['bold', 'italic', 'underline'],
          ['link', 'blockquote', 'code-block'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['clean'],
        ],
      },
    });

    // Set initial content
    this.quillEditor.setContents([{ insert: initialText }]);

    // Style the editor for dark theme
    const editorEl = document.querySelector('#editor .ql-editor');
    if (editorEl) {
      editorEl.style.color = '#c9d1d9';
      editorEl.style.background = 'var(--color-bg)';
    }
  }

  /**
   * Download transcript in specified format
   */
  _downloadFormat(format) {
    if (!this.currentTranscript) {
      this._showAlert('No transcript to download', 'warning');
      return;
    }

    // Get edited text from Quill editor (if available) or fall back to original
    let editedText;
    if (this.quillEditor) {
      editedText = this.quillEditor.getText();
    } else {
      editedText = this.currentTranscript.map((s) => s.text).join('\n');
    }

    // If text was edited, reconstruct segments for formats that need timestamps
    let segments = this.currentTranscript;
    if (format !== 'txt' && editedText !== segments.map((s) => s.text).join('\n')) {
      // Text was edited; for SRT/VTT, we'll use the edited text
      // but maintain original timestamps for the first segment only
      segments = [{ ...segments[0], text: editedText }];
    }

    let content;
    let filename;

    if (format === 'txt') {
      content = editedText;
      filename = 'transcript.txt';
    } else if (format === 'srt') {
      content = FormatExporter.toSRT(segments);
      filename = 'transcript.srt';
    } else if (format === 'vtt') {
      content = FormatExporter.toVTT(segments);
      filename = 'transcript.vtt';
    }

    FormatExporter.download(content, filename);
    this._showAlert(`Downloaded ${filename}`, 'success');
  }

  /**
   * Show alert message
   */
  _showAlert(message, type = 'info') {
    const alertContainer = document.getElementById('alerts');
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;

    const icons = {
      success: '✓',
      warning: '⚠',
      error: '✕',
      info: 'ℹ',
    };

    alert.innerHTML = `
      <span class="alert-icon">${icons[type]}</span>
      <div class="alert-content">
        <div>${message}</div>
      </div>
    `;

    alertContainer.appendChild(alert);

    // Auto-remove after 5 seconds
    setTimeout(() => alert.remove(), 5000);
  }

  /**
   * Format bytes to human-readable string
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Format seconds to human-readable duration
   */
  _formatSeconds(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new WhisperApp();
  app.init();
});
