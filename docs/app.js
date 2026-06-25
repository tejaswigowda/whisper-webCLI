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
    
    // Metrics tracking
    this.metricsStartTime = null;
    this.totalTokens = 0;
    this.detectedLanguage = null;
    this.confidenceScores = [];
    this.segmentDetails = [];
    
    // Batch processing
    this.batchMode = false;
    this.batchQueue = [];
    this.batchCurrentIndex = 0;
    this.batchResults = [];

    // Microphone recording
    this.inputMode = 'file'; // 'file', 'mic', or 'stream'
    this.mediaStream = null;
    this.audioContext = null;
    this.audioWorklet = null;
    this.isRecording = false;
    this.recordingStartTime = null;
    this.micAudioBuffer = new Float32Array(0);
    this.recordedAudio = null;
    this.recordedSampleRate = null;

    // Live streaming
    this.isStreaming = false;
    this.streamStartTime = null;
    this.streamAudioBuffer = new Float32Array(0);
    this.streamChunkSize = 30; // seconds per chunk (longer = better Whisper quality)
    this.streamOverlapSize = 5; // seconds of overlap prepended from previous chunk for context
    this.streamOverlapBuffer = new Float32Array(0); // tail of last chunk for context
    this.streamChunkIntervalId = null;
    this.streamTotalDuration = 0;
    this.streamChunkCount = 0;
    this.isStreamChunkProcessing = false; // Prevent overlapping chunk processing
    this.streamAccumulatedText = ''; // Accumulate transcription during streaming
    this.lastStreamSegmentEnd = 0; // Track last segment boundary to avoid overlaps
  }

  /**
   * Initialize the application
   */
  async init() {
    console.log('Initializing whisper-webCLI...');
    window._initCalled = true;  // Debug flag

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

    // Batch mode checkbox
    const batchCheckbox = document.getElementById('batch-mode-checkbox');
    if (batchCheckbox) {
      batchCheckbox.addEventListener('change', (e) => {
        this.batchMode = e.target.checked;
        document.getElementById('batch-file-list').classList.toggle('hidden', !this.batchMode);
      });
    }

    // Detailed info toggle
    const detailedToggle = document.getElementById('detailed-info-toggle');
    if (detailedToggle) {
      detailedToggle.addEventListener('change', (e) => {
        document.getElementById('segment-details').classList.toggle('hidden', !e.target.checked);
      });
    }

    // Raw command line flags input
    const rawFlagsInput = document.getElementById('raw-flags-input');
    if (rawFlagsInput) {
      rawFlagsInput.addEventListener('input', (e) => {
        this._applyRawFlags(e.target.value);
      });
    }

    // Input mode switching
    const modeFileBtn = document.getElementById('mode-file-btn');
    const modeMicBtn = document.getElementById('mode-mic-btn');
    const modeStreamBtn = document.getElementById('mode-stream-btn');
    if (modeFileBtn) {
      modeFileBtn.addEventListener('click', () => this._switchInputMode('file'));
    }
    if (modeMicBtn) {
      modeMicBtn.addEventListener('click', () => this._switchInputMode('mic'));
    }
    if (modeStreamBtn) {
      modeStreamBtn.addEventListener('click', () => this._switchInputMode('stream'));
    }

    // Microphone controls
    const micStartBtn = document.getElementById('mic-start-btn');
    const micStopBtn = document.getElementById('mic-stop-btn');
    if (micStartBtn) {
      micStartBtn.addEventListener('click', () => this._startMicRecording());
    }
    if (micStopBtn) {
      micStopBtn.addEventListener('click', () => this._stopMicRecording());
    }

    // Stream controls
    const streamStartBtn = document.getElementById('stream-start-btn');
    const streamStopBtn = document.getElementById('stream-stop-btn');
    if (streamStartBtn) {
      streamStartBtn.addEventListener('click', () => this._startLiveStream());
    }
    if (streamStopBtn) {
      streamStopBtn.addEventListener('click', () => this._stopLiveStream());
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
   * Decode audio file to AudioBuffer and convert to transferable format
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
      return;
    }

    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');

      // Re-acquire when the tab becomes visible again (browser releases lock on hide)
      this.wakeLockSentinel.addEventListener('release', () => {
        if (this.isTranscribing || this.isStreaming) {
          this._requestWakeLock();
        }
      });
    } catch (err) {
      // Wake lock is a best-effort feature; silently ignore failures
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
        // If streaming, update progress with final segments and clear flag
        if (this.isStreaming) {
          if (segments && segments.length > 0) {
            // Skip segments that fall within the overlap prefix to avoid duplicates.
            // The overlap buffer was prepended, so segments with end <= overlapSize are repeats.
            const newSegments = segments.filter(
              (seg) => seg.end > this.streamOverlapSize
            );
            this._updateTranscriptionProgress({
              pct: null,
              label: 'Transcribing… (streaming)',
              segments: newSegments.length > 0 ? newSegments : segments,
            });
          }
          this.isStreamChunkProcessing = false;
        } else {
          this._handleTranscriptionComplete(segments);
        }
        break;
      case 'progress':
        this._updateTranscriptionProgress(progress);
        break;
      case 'error':
        this._showAlert(`Transcription error: ${message}`, 'error');
        // Clear both flags on error
        this.isTranscribing = false;
        this.isStreamChunkProcessing = false;
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
      console.log('Progress update:', { pct, label, progressBarExists: !!progressBar });
      if (progressBar) {
        progressBar.style.width = `${pct}%`;
        progressBar.textContent = `${pct}%`;
        progressBar.classList.remove('indeterminate');
        console.log('Progress bar updated:', { width: progressBar.style.width, text: progressBar.textContent });
      } else {
        console.warn('Progress bar element not found');
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

    // Track metrics
    if (segments && segments.length > 0) {
      // Store segment details for later display
      this.segmentDetails = segments.map(seg => ({
        start: seg.start?.toFixed(2),
        end: seg.end?.toFixed(2),
        text: seg.text?.substring(0, 50),
      }));

      // Calculate tokens (rough estimate: words * 1.3)
      const totalWords = segments.reduce((sum, seg) => sum + (seg.text?.split(/\s+/).length || 0), 0);
      this.totalTokens = Math.round(totalWords * 1.3);

      // Update metrics display
      if (this.metricsStartTime) {
        const elapsedMs = Date.now() - this.metricsStartTime;
        const elapsedSec = (elapsedMs / 1000).toFixed(2);
        const tokensPerSec = this.totalTokens > 0 ? (this.totalTokens / (elapsedSec / 1)).toFixed(1) : '-';
        const secPerToken = this.totalTokens > 0 ? ((elapsedSec / this.totalTokens).toFixed(3)) : '-';

        document.getElementById('speed-metric').textContent = secPerToken + ' sec/token';
        document.getElementById('time-metric').textContent = elapsedSec + ' sec';
        document.getElementById('tokens-metric').textContent = tokensPerSec + ' t/s';
      }

      // Update segment details if displayed
      const segmentDetails = document.getElementById('segment-details');
      if (segmentDetails && !segmentDetails.classList.contains('hidden')) {
        const detailsHtml = segments
          .slice(-5) // Show last 5 segments
          .map(seg => `<div>[${seg.start?.toFixed(2)}-${seg.end?.toFixed(2)}s] ${seg.text?.substring(0, 40)}...</div>`)
          .join('');
        segmentDetails.innerHTML = detailsHtml;
      }
    }

    // Live streaming transcription in preview
    if (segments && segments.length > 0) {
      // For streaming mode: each chunk is independently transcribed non-overlapping audio,
      // so just append the new text directly.
      if (this.isStreaming) {
        const newText = segments.map((seg) => seg.text).join(' ').trim();
        if (newText) {
          this.streamAccumulatedText += (this.streamAccumulatedText ? ' ' : '') + newText;
        }

        // Display accumulated text in Step 3
        const previewText = document.getElementById('preview-text');
        if (previewText) {
          previewText.textContent = this.streamAccumulatedText;
          previewText.scrollTop = previewText.scrollHeight;
        }
        return; // Skip file/mic mode logic below
      }

      // For file/mic mode: show full transcription
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

    // Finalize metrics display
    if (this.metricsStartTime) {
      const elapsedMs = Date.now() - this.metricsStartTime;
      const elapsedSec = (elapsedMs / 1000).toFixed(2);
      
      // Display detected language
      const langMap = {
        'auto': 'Auto-detected',
        'en': 'English',
        'es': 'Spanish',
        'fr': 'French',
        'de': 'German',
        'it': 'Italian',
        'pt': 'Portuguese',
        'ja': 'Japanese',
        'ko': 'Korean',
        'zh': 'Chinese',
      };
      const detectedLang = this.selectedLanguage === 'auto' ? 'Detected' : langMap[this.selectedLanguage] || this.selectedLanguage;
      document.getElementById('language-metric').textContent = detectedLang;
    }

    // For streaming mode: finalize accumulated text and show editor
    if (this.inputMode === 'stream') {
      const previewContainer = document.getElementById('preview-container');
      previewContainer.classList.add('hidden');

      const transcriptContainer = document.getElementById('transcript-container');
      transcriptContainer.classList.remove('hidden');

      const downloadSection = document.getElementById('download-section');
      downloadSection.classList.remove('hidden');

      // Initialize Quill with accumulated text
      this._initializeQuillEditor(this.streamAccumulatedText);

      // Reset streaming text accumulation
      this.streamAccumulatedText = '';
      this.lastStreamSegmentEnd = 0; // Reset segment boundary tracking

      // Hide progress
      const progressContainer = document.getElementById('progress-container');
      progressContainer.classList.add('hidden');

      this._showAlert('Stream transcription complete', 'success');
    } else {
      // For file/mic mode: hide preview, show editor
      const previewContainer = document.getElementById('preview-container');
      previewContainer.classList.add('hidden');

      const transcriptContainer = document.getElementById('transcript-container');
      transcriptContainer.classList.remove('hidden');

      const downloadSection = document.getElementById('download-section');
      downloadSection.classList.remove('hidden');

      // Initialize Quill editor with the transcript
      const text = segments.map((seg) => seg.text).join('\n');
      this._initializeQuillEditor(text);

      // Hide progress
      const progressContainer = document.getElementById('progress-container');
      progressContainer.classList.add('hidden');

      // Show success message
      this._showAlert(
        `Transcription complete (${segments.length} segments)`,  
        'success'
      );
    }

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

    let segments;
    let content;
    let filename;

    if (format === 'txt') {
      content = editedText;
      filename = 'transcript.txt';
    } else if (format === 'srt') {
      // For SRT: always use original segments to preserve timestamps
      segments = this.currentTranscript;
      content = FormatExporter.toSRT(segments);
      filename = 'transcript.srt';
    } else if (format === 'vtt') {
      // For VTT: always use original segments to preserve timestamps
      segments = this.currentTranscript;
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
      success: '<i class="fas fa-check"></i>',
      warning: '<i class="fas fa-triangle-exclamation"></i>',
      error: '<i class="fas fa-xmark"></i>',
      info: '<i class="fas fa-circle-info"></i>',
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

  /**
   * Switch between input modes (file, mic, stream)
   */
  _switchInputMode(mode) {
    this.inputMode = mode;
    
    const fileMode = document.getElementById('file-mode');
    const micMode = document.getElementById('mic-mode');
    const streamMode = document.getElementById('stream-mode');
    const modeFileBtn = document.getElementById('mode-file-btn');
    const modeMicBtn = document.getElementById('mode-mic-btn');
    const modeStreamBtn = document.getElementById('mode-stream-btn');
    const transcribeBtn = document.getElementById('transcribe-button');

    // Hide all modes
    fileMode?.classList.add('hidden');
    micMode?.classList.add('hidden');
    streamMode?.classList.add('hidden');
    
    // Remove active state from all buttons
    modeFileBtn?.classList.remove('active');
    modeMicBtn?.classList.remove('active');
    modeStreamBtn?.classList.remove('active');

    if (mode === 'file') {
      fileMode?.classList.remove('hidden');
      modeFileBtn?.classList.add('active');
      const fileInput = document.getElementById('audio-file');
      if (transcribeBtn) transcribeBtn.disabled = !fileInput.files.length;
    } else if (mode === 'mic') {
      micMode?.classList.remove('hidden');
      modeMicBtn?.classList.add('active');
      if (this.isRecording) this._stopMicRecording();
      if (this.isStreaming) this._stopLiveStream();
      if (transcribeBtn) transcribeBtn.disabled = true;
    } else if (mode === 'stream') {
      streamMode?.classList.remove('hidden');
      modeStreamBtn?.classList.add('active');
      if (this.isRecording) this._stopMicRecording();
      if (transcribeBtn) transcribeBtn.disabled = true;
    }
  }

  /**
   * Start microphone recording
   */
  async _startMicRecording() {
    try {
      if (!this.mediaStream) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.micAudioBuffer = new Float32Array(0);
      
      // Show recording panel
      document.getElementById('mic-start-btn').disabled = true;
      document.getElementById('mic-recording-panel').classList.remove('hidden');
      document.getElementById('mic-status').innerHTML = '<i class="fas fa-microphone"></i> Listening...';

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        this._accumulateAudio(inputData, 'mic');
        this._drawMicWaveform(inputData, 'mic');
        this._updateRecordingTime();
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination);
      this.audioWorklet = processor;

      document.getElementById('mic-duration').textContent = '0:00';
      document.getElementById('mic-sample-rate').textContent = `${this.audioContext.sampleRate} Hz`;

      this._showAlert('🎤 Recording started', 'success');
    } catch (err) {
      this._showAlert(`Microphone access denied: ${err.message}`, 'error');
      this.isRecording = false;
      document.getElementById('mic-start-btn').disabled = false;
    }
  }

  /**
   * Update recording elapsed time
   */
  _updateRecordingTime() {
    if (!this.recordingStartTime) return;
    
    const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    const timeEl = document.getElementById('recording-time');
    if (timeEl) {
      timeEl.textContent = `${timeStr} elapsed`;
    }
  }

  /**
   * Stop microphone recording
   */
  async _stopMicRecording() {
    try {
      if (!this.isRecording) return;

      this.isRecording = false;

      if (this.audioWorklet) {
        this.audioWorklet.disconnect();
        this.audioWorklet = null;
      }

      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => track.stop());
        this.mediaStream = null;
      }

      this.recordedAudio = this.micAudioBuffer;
      this.recordedSampleRate = this.audioContext.sampleRate;

      const recordingDuration = this.recordedAudio.length / this.recordedSampleRate;
      document.getElementById('mic-duration').textContent = this._formatSeconds(recordingDuration);

      document.getElementById('mic-recording-panel').classList.add('hidden');
      document.getElementById('mic-start-btn').disabled = false;
      document.getElementById('mic-status').innerHTML = '<i class="fas fa-check"></i> Recording saved. Ready to transcribe.';

      document.getElementById('transcribe-button').disabled = false;

      this._showAlert('Recording stopped', 'success');
    } catch (err) {
      this._showAlert(`Error stopping recording: ${err.message}`, 'error');
    }
  }

  /**
   * Start live streaming with 5-second chunks
   */
  async _startLiveStream() {
    try {
      if (!this.mediaStream) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      this.isStreaming = true;
      this.streamStartTime = Date.now();
      this.streamAudioBuffer = new Float32Array(0);
      this.streamOverlapBuffer = new Float32Array(0);
      this.streamTotalDuration = 0;
      this.streamChunkCount = 0;
      this.streamAccumulatedText = ''; // Reset accumulated text
      this.lastStreamSegmentEnd = 0; // Reset segment boundary tracking
      
      // Show Step 3: preview with real-time transcription
      this.metricsStartTime = Date.now();
      document.getElementById('progress-container').classList.remove('hidden');
      document.getElementById('preview-container').classList.remove('hidden');
      document.getElementById('transcript-container').classList.add('hidden');
      document.getElementById('download-section').classList.add('hidden');
      document.getElementById('preview-text').textContent = ''; // Clear previous text
      this._updateTranscriptionProgress({ pct: 0, label: 'Streaming… (0%)', segments: [] });
      
      document.getElementById('stream-start-btn').disabled = true;
      document.getElementById('stream-active-panel').classList.remove('hidden');
      document.getElementById('stream-status').innerHTML = '<i class="fas fa-circle" style="color:var(--accent)"></i> Streaming...';

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        this._accumulateAudio(inputData, 'stream');
        this._drawMicWaveform(inputData, 'stream');
        this._updateStreamTime();
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination);
      this.audioWorklet = processor;

      document.getElementById('stream-duration').textContent = '0:00';
      document.getElementById('stream-sample-rate').textContent = `${this.audioContext.sampleRate} Hz`;

      this.streamChunkIntervalId = setInterval(() => {
        this._processStreamChunk();
      }, this.streamChunkSize * 1000);

      await this._requestWakeLock();
      this._showAlert('Live streaming started (15s chunks, 5s overlap)', 'success');
    } catch (err) {
      this._showAlert(`Microphone access denied: ${err.message}`, 'error');
      this.isStreaming = false;
      document.getElementById('stream-start-btn').disabled = false;
    }
  }

  /**
   * Process audio chunk for live streaming
   */
  async _processStreamChunk() {
    if (!this.isStreaming || this.streamAudioBuffer.length === 0) return;

    // Skip if a chunk is already being processed (avoid overlapping transcriptions)
    if (this.isStreamChunkProcessing) return;

    const sampleRate = this.audioContext.sampleRate;
    const audioSeconds = this.streamAudioBuffer.length / sampleRate;

    if (audioSeconds < this.streamChunkSize - 0.5) return;

    const samplesPerChunk = Math.floor(this.streamChunkSize * sampleRate);
    const newAudio = this.streamAudioBuffer.slice(0, samplesPerChunk);

    // Prepend overlap from previous chunk so Whisper has context
    const chunkData = new Float32Array(this.streamOverlapBuffer.length + newAudio.length);
    chunkData.set(this.streamOverlapBuffer);
    chunkData.set(newAudio, this.streamOverlapBuffer.length);

    // Save tail of this new audio as overlap for the next chunk
    const overlapSamples = Math.floor(this.streamOverlapSize * sampleRate);
    this.streamOverlapBuffer = new Float32Array(newAudio.slice(-overlapSamples));

    // Advance the incoming buffer past the consumed chunk
    if (this.streamAudioBuffer.length > samplesPerChunk) {
      this.streamAudioBuffer = new Float32Array(
        this.streamAudioBuffer.slice(samplesPerChunk)
      );
    } else {
      this.streamAudioBuffer = new Float32Array(0);
    }

    this.streamChunkCount++;
    this.streamTotalDuration += this.streamChunkSize;

    // Mark chunk as processing
    this.isStreamChunkProcessing = true;

    if (this.worker) {
      this.worker.postMessage(
        {
          type: 'transcribe',
          payload: {
            audioBuffer: chunkData.buffer,
            sampleRate: sampleRate,
            options: {
              model: this.selectedModel,
              language: this.selectedLanguage,
              translate: this.translateToEnglish,
              // Tell transcriber to skip the overlap prefix when returning segments
              streamOverlapSeconds: this.streamOverlapBuffer.length / sampleRate,
            },
          },
        },
        [chunkData.buffer]
      );
    }
  }

  /**
   * Accumulate audio samples
   */
  _accumulateAudio(inputData, mode = 'mic') {
    const buffer = mode === 'stream' ? this.streamAudioBuffer : this.micAudioBuffer;
    const newBuffer = new Float32Array(buffer.length + inputData.length);
    newBuffer.set(buffer);
    newBuffer.set(inputData, buffer.length);
    
    if (mode === 'stream') {
      this.streamAudioBuffer = newBuffer;
    } else {
      this.micAudioBuffer = newBuffer;
    }
  }

  /**
   * Draw waveform visualization
   */
  _drawMicWaveform(audioData, mode = 'mic') {
    const canvasId = mode === 'stream' ? 'stream-waveform' : 'mic-waveform';
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#080a10';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = mode === 'stream' ? '#00ff00' : '#3665b6';
    ctx.lineWidth = 2;
    ctx.beginPath();

    const sliceWidth = width / audioData.length;
    let x = 0;

    for (let i = 0; i < audioData.length; i++) {
      const v = audioData[i] / 128.0;
      const y = (height / 2) * (1 + v);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  /**
   * Update stream elapsed time
   */
  _updateStreamTime() {
    if (!this.streamStartTime) return;
    
    const elapsed = Math.floor((Date.now() - this.streamStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    const timeEl = document.getElementById('stream-time');
    if (timeEl) {
      timeEl.textContent = `${timeStr} elapsed`;
    }
  }

  /**
   * Stop live streaming
   */
  async _stopLiveStream() {
    try {
      if (!this.isStreaming) return;

      this.isStreaming = false;

      if (this.streamChunkIntervalId) {
        clearInterval(this.streamChunkIntervalId);
        this.streamChunkIntervalId = null;
      }

      // Reset chunk processing flag
      this.isStreamChunkProcessing = false;

      if (this.streamAudioBuffer.length > 0) {
        const sampleRate = this.audioContext.sampleRate;
        const remainingData = new Float32Array(this.streamAudioBuffer);
        
        if (this.worker) {
          this.worker.postMessage(
            {
              type: 'transcribe',
              payload: {
                audioBuffer: remainingData.buffer,
                sampleRate: sampleRate,
                options: {
                  model: this.selectedModel,
                  language: this.selectedLanguage,
                  translate: this.translateToEnglish,
                },
              },
            },
            [remainingData.buffer]
          );
        }
      }

      if (this.audioWorklet) {
        this.audioWorklet.disconnect();
        this.audioWorklet = null;
      }

      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => track.stop());
        this.mediaStream = null;
      }

      const streamDuration = this.streamTotalDuration + (this.streamAudioBuffer.length / this.audioContext.sampleRate);
      document.getElementById('stream-duration').textContent = this._formatSeconds(streamDuration);

      document.getElementById('stream-active-panel').classList.add('hidden');
      document.getElementById('stream-start-btn').disabled = false;
      document.getElementById('stream-status').innerHTML = '<i class="fas fa-check"></i> Stream finished. Processing final chunk...';

      this._showAlert(`Stream stopped (${this.streamChunkCount} chunks processed)`, 'success');
    } catch (err) {
      this._showAlert(`Error stopping stream: ${err.message}`, 'error');
    }
  }

  /**
   * Handle transcription for both file and microphone modes
   */
  async _handleTranscribe() {
    let audioBuffer;
    let file = null;

    // Show UI feedback immediately before any async work
    const btn = document.getElementById('transcribe-button');
    btn.disabled = true;
    document.getElementById('preview-container').classList.remove('hidden');
    document.getElementById('progress-container').classList.remove('hidden');
    document.getElementById('transcript-container').classList.add('hidden');
    document.getElementById('download-section').classList.add('hidden');
    this._updateTranscriptionProgress({ pct: null, label: 'Preparing audio…', segments: [] });

    if (this.inputMode === 'file') {
      // File mode: original logic
      const fileInput = document.getElementById('audio-file');
      if (!fileInput.files.length) {
        this._showAlert('Please select an audio file', 'warning');
        btn.disabled = false;
        document.getElementById('preview-container').classList.add('hidden');
        return;
      }
      file = fileInput.files[0];
      audioBuffer = await this._decodeAudioFile(file);
    } else if (this.inputMode === 'mic') {
      // Microphone mode: use recorded audio
      if (!this.recordedAudio || this.recordedAudio.length === 0) {
        this._showAlert('Please record audio first', 'warning');
        btn.disabled = false;
        document.getElementById('preview-container').classList.add('hidden');
        return;
      }
      audioBuffer = {
        audioData: this.recordedAudio,
        sampleRate: this.recordedSampleRate,
        channels: 1,
        length: this.recordedAudio.length,
      };
    } else {
      this._showAlert('Invalid input mode', 'error');
      btn.disabled = false;
      document.getElementById('preview-container').classList.add('hidden');
      return;
    }

    try {
      this.isTranscribing = true;
      
      // Reset metrics
      this.metricsStartTime = Date.now();
      this.totalTokens = 0;
      this.detectedLanguage = null;
      this.confidenceScores = [];
      this.segmentDetails = [];
      
      this._updateTranscriptionProgress({ pct: 0, label: 'Initializing…', segments: [] });

      // Set up media player for file mode only
      if (this.inputMode === 'file' && file) {
        const mediaPlayer = document.getElementById('media-player');
        const seekbar = document.getElementById('media-seekbar');
        const mediaUrl = URL.createObjectURL(file);
        mediaPlayer.src = mediaUrl;
        this._setupMediaSeekbar();
        this._updateSeekbarFill(seekbar);
        
        // Start playing audio immediately
        mediaPlayer.play().catch(err => {
          console.warn('Could not autoplay audio:', err);
        });
      }

      // Send to worker
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

      await this._requestWakeLock();
    } catch (err) {
      this._showAlert(`Transcription error: ${err.message}`, 'error');
      this.isTranscribing = false;
      document.getElementById('transcribe-button').disabled = false;
    }
  }

  /**
   * Parse and apply raw command line flags
   */
  _applyRawFlags(flagsString) {
    const statusEl = document.getElementById('flags-status');
    const applied = [];
    const errors = [];

    if (!flagsString.trim()) {
      statusEl.style.display = 'none';
      return;
    }

    const tokens = flagsString.trim().split(/[\s\n]+/).filter(t => t);
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      
      if (token.startsWith('--')) {
        const flag = token.substring(2);
        const value = tokens[i + 1];

        try {
          switch (flag) {
            case 'language': {
              if (value && !value.startsWith('--')) {
                const langSelect = document.getElementById('language-select');
                if (langSelect) {
                  langSelect.value = value;
                  this.selectedLanguage = value;
                  applied.push(`language=${value}`);
                  i += 2;
                  continue;
                }
              }
              break;
            }

            case 'beam-size': {
              if (value && !value.startsWith('--')) {
                const beamInput = document.getElementById('beam-size-input');
                if (beamInput) {
                  const numValue = parseInt(value, 10);
                  if (numValue >= 1 && numValue <= 20) {
                    beamInput.value = numValue;
                    applied.push(`beam-size=${numValue}`);
                    i += 2;
                    continue;
                  } else {
                    errors.push('beam-size must be 1-20');
                  }
                }
              }
              break;
            }

            case 'temperature': {
              if (value && !value.startsWith('--')) {
                const tempInput = document.getElementById('temperature-input');
                if (tempInput) {
                  const numValue = parseFloat(value);
                  if (numValue >= 0 && numValue <= 1) {
                    tempInput.value = numValue;
                    applied.push(`temperature=${numValue}`);
                    i += 2;
                    continue;
                  } else {
                    errors.push('temperature must be 0-1');
                  }
                }
              }
              break;
            }

            case 'model': {
              if (value && !value.startsWith('--')) {
                const modelSelect = document.getElementById('model-select');
                if (modelSelect && Array.from(modelSelect.options).some(opt => opt.value === value)) {
                  modelSelect.value = value;
                  this.selectedModel = value;
                  applied.push(`model=${value}`);
                  i += 2;
                  continue;
                } else {
                  errors.push(`model '${value}' not available`);
                }
              }
              break;
            }

            case 'translate': {
              const translateCheck = document.getElementById('translate-checkbox');
              if (translateCheck) {
                translateCheck.checked = true;
                this.translateToEnglish = true;
                applied.push('translate=enabled');
                i += 1;
                continue;
              }
              break;
            }

            default: {
              errors.push(`unknown flag: --${flag}`);
              break;
            }
          }
        } catch (err) {
          errors.push(`error parsing --${flag}: ${err.message}`);
        }
      }
      i++;
    }

    const messages = [];
    if (applied.length > 0) {
      messages.push(`Applied: ${applied.join(', ')}`);
    }
    if (errors.length > 0) {
      messages.push(`⚠ ${errors.join('; ')}`);
    }

    if (messages.length > 0) {
      statusEl.textContent = messages.join(' | ');
      statusEl.style.display = 'block';
      statusEl.style.color = errors.length > 0 ? 'var(--warn)' : 'var(--success)';
    }
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new WhisperApp();
  window.app.init();
});
