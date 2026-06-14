/**
 * FormatExporter: Convert transcript segments to various output formats.
 * 
 * Formats:
 * - TXT: Plain text (no timestamps)
 * - SRT: SubRip (subtitle format with timestamps)
 * - VTT: WebVTT (web video text tracks)
 */

class FormatExporter {
  /**
   * Convert segments to plain text.
   * @param {Array} segments - [{id, start, end, text}, ...]
   * @returns {string}
   */
  static toText(segments) {
    return segments.map((seg) => seg.text).join('\n');
  }

  /**
   * Convert segments to SubRip (.srt) format.
   * @param {Array} segments
   * @returns {string}
   */
  static toSRT(segments) {
    return segments
      .map((seg, idx) => {
        const start = this._formatTimestamp(seg.start, 'srt');
        const end = this._formatTimestamp(seg.end, 'srt');
        return `${idx + 1}\n${start} --> ${end}\n${seg.text}`;
      })
      .join('\n\n');
  }

  /**
   * Convert segments to WebVTT (.vtt) format.
   * @param {Array} segments
   * @returns {string}
   */
  static toVTT(segments) {
    const header = 'WEBVTT\n\n';
    const cues = segments
      .map((seg) => {
        const start = this._formatTimestamp(seg.start, 'vtt');
        const end = this._formatTimestamp(seg.end, 'vtt');
        return `${start} --> ${end}\n${seg.text}`;
      })
      .join('\n\n');
    return header + cues;
  }

  /**
   * Format time in seconds to timestamp string.
   * @private
   * @param {number} seconds - Time in seconds
   * @param {string} format - 'srt' or 'vtt'
   * @returns {string} e.g., "00:00:15,500" (SRT) or "00:00:15.500" (VTT)
   */
  static _formatTimestamp(seconds, format) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);

    const pad = (n) => String(n).padStart(2, '0');
    const separator = format === 'srt' ? ',' : '.';
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${String(ms).padStart(3, '0')}`;
  }

  /**
   * Download transcript as a file.
   * @param {string} content - File content
   * @param {string} filename - Output filename
   */
  static download(content, filename) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FormatExporter;
}
