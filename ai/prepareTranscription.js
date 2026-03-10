'use strict';

const { normalizeTranscriptionStructure } = require('./normalizeTranscription');
const { wrapToProfessionalFormat } = require('./whisperFormatter');

// Non-speech cues often appear in caption-style transcripts as either:
//   [APPLAUSE], [LAUGHTER], [INTERPOSING VOICES], ...
// or
//   (applause), (laughter), ...
//
// This helper is intentionally conservative for parentheses, because parentheses
// can also contain genuine spoken content in some transcripts.
function isStandaloneNonSpeechCue(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;

  // Common closed-caption style: [APPLAUSE], [LAUGHTER], [INTERPOSING VOICES]
  // We treat all-uppercase bracket cues as non-speech (up to a reasonable length).
  if (/^\[[A-Z0-9][A-Z0-9\s'".,!?-]{0,100}\]$/.test(t)) return true;

  // Parenthetical cues: (applause), (laughter), etc.
  const m = t.match(/^\(([^)]+)\)$/);
  if (!m) return false;

  const inner = m[1].trim().toLowerCase();
  // Allow a small set of common cue keywords (kept short on purpose).
  const cueKeywords = [
    'applause',
    'clapping',
    'laughter',
    'laugh',
    'laughs',
    'laughing',
    'cheering',
    'music',
    'crosstalk',
    'overlapping voices',
    'interposing voices',
    'inaudible',
    'audience',
    'crowd',
    'gasps',
    'gasp',
    'sighs',
    'sigh',
    'coughs',
    'cough',
    'crying'
  ];

  return cueKeywords.some(k => inner === k);
}

function assignMissingSpeakersByOverlap(segments, diarized) {
  if (!Array.isArray(segments) || !Array.isArray(diarized) || diarized.length === 0) return;

  for (const seg of segments) {
    if (!seg || typeof seg.start !== 'number') continue;

    const existing = (typeof seg.speaker === 'string') ? seg.speaker.trim() : '';
    if (existing) continue;

    const segStart = Number(seg.start);
    const segEndRaw = (typeof seg.end === 'number') ? Number(seg.end) : segStart;
    if (!Number.isFinite(segStart) || !Number.isFinite(segEndRaw)) continue;

    // Treat point-segments as a tiny window so overlap math still works.
    let segEnd = segEndRaw;
    if (segEnd <= segStart) segEnd = segStart + 0.001;

    let bestSpeaker = '';
    let bestOverlap = 0;

    for (const d of diarized) {
      if (!d || typeof d.start !== 'number' || typeof d.end !== 'number') continue;
      const sp = (typeof d.speaker === 'string') ? d.speaker.trim() : '';
      if (!sp) continue;

      const overlap = Math.min(segEnd, d.end) - Math.max(segStart, d.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = sp;
      }
    }

    if (bestSpeaker && bestOverlap > 0) {
      seg.speaker = bestSpeaker;
    }
  }
}


// Some transcripts (especially caption-derived) prefix dialogue lines with markers
// like "- ", "— ", or ">> ". These are useful in captions but often become noise
// in plain-text exports. This helper strips common leading markers at the start
// of each line (opt-in via config.removeLeadingChars).
function stripLeadingMarkers(text) {
  if (text == null) return text;
  const raw = String(text);
  if (!raw) return raw;

  // Keep this intentionally conservative: do NOT strip '[' or '(' cues here
  // (non-speech filtering handles those separately).
  const re = /^[\s\uFEFF]*(?:(?:[-–—―]+|[>»›]+|[•●○▪▫■□◆▶►※*♪]+)\s*)+/u;

  return raw
    .split(/\r?\n/)
    .map(line => String(line).replace(re, ''))
    .join('\n');
}

/**
 * Unified transcription prep pipeline.
 * @param {object} jsonData
 * @param {string} filePath
 * @param {object} config
 * @param {object} opts
 * @returns {object}
 */
async function prepareTranscription(jsonData, filePath, config, opts = {}) {
  const diarized = Array.isArray(opts.diarized) ? opts.diarized : [];

  if (!Array.isArray(jsonData?.segments)) {
    const clone = JSON.parse(JSON.stringify(jsonData || {}));
    normalizeTranscriptionStructure(clone, Number(config?.fps) || 30, !!config?.dropFrame);
    jsonData = clone;
  }
  if (!Array.isArray(jsonData?.segments)) {
    jsonData.segments = [];
  }

  if (diarized.length) {
    assignMissingSpeakersByOverlap(jsonData.segments, diarized);
  }

  const wrapped = await wrapToProfessionalFormat(jsonData, config, filePath);


  // Content cleanup enhancements (opt-in)
  if (wrapped && Array.isArray(wrapped.segments) && config?.removeLeadingChars) {
    for (const seg of wrapped.segments) {
      if (!seg) continue;
      if (typeof seg.text === 'string' && seg.text.trim()) {
        seg.text = stripLeadingMarkers(seg.text);
      }
    }
  }

  // Content cleanup enhancements (opt-in)
  if (wrapped && Array.isArray(wrapped.segments) && config?.filterNonSpeech) {
    const before = wrapped.segments.length;
    wrapped.segments = wrapped.segments.filter(seg => {
      const text = seg?.text;
      return !isStandaloneNonSpeechCue(text);
    });
    const after = wrapped.segments.length;

    // Keep metadata consistent for downstream exporters.
    if (wrapped.metadata && typeof wrapped.metadata === 'object') {
      wrapped.metadata.numSegments = after;
      wrapped.metadata.removedNonSpeechSegments = (before - after);
    }
  }

  return wrapped;
}

module.exports = { prepareTranscription };
