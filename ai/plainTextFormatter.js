'use strict';

// Plain Text (.txt) export formatter
//
// Intentionally dependency-light so it can be unit tested without Electron/FFmpeg/OpenAI.

const {
  parseTime: parseTimeMs,
  formatTimecode,
  isDropFrameRate,
  framesFromTimecodeLabel,
  framesToSeconds
} = require('../utils/timeUtils');

function normalizeOffset(value, fps, dropFrame) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();

    // Prefer frame-accurate parsing for SMPTE-like labels.
    // Using ms-rounding here can drift by a frame on DF rates (e.g., 29.97 DF).
    try {
      if (/^\d{1,3}:\d{2}:\d{2}[:;]\d{2}$/.test(raw)) {
        const frames = framesFromTimecodeLabel(raw, fps, dropFrame);
        if (Number.isFinite(frames)) return framesToSeconds(frames, fps);
      }
    } catch {}

    const parsed = parseTimeMs(raw, fps, dropFrame);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return 0;
}

function generatePlainText(jsonResults, opts = {}) {
  const segments = Array.isArray(jsonResults?.segments) ? jsonResults.segments : [];

  // NOTE: formatTimecode() style is about delimiter/precision (ms/dot/colon),
  // while DF vs NDF is controlled by the dropFrame boolean.
  opts.timecodeStyle = opts.timecodeStyle || 'colon';

  const sysFps = (jsonResults?.system?.fps ?? opts.fps);
  if (!sysFps) {
    throw new Error('[generatePlainText] Missing fps. Provide jsonResults.system.fps or opts.fps.');
  }

  // Prefer explicit override, otherwise use wrapped.system hints.
  const sysDfPref =
    (typeof opts.dropFrame === 'boolean')
      ? opts.dropFrame
      : (jsonResults?.system?.dropFramePreferred ?? jsonResults?.system?.dropFrame);
  const sysDF = Boolean(sysDfPref && isDropFrameRate(sysFps));

  const includeSpeakers = opts.includeSpeakers === true;
  const includeTimecodes = opts.includeTimecodes === true;

  // Normalize timestamp style (accept legacy underscores).
  let timestampStyle = String(opts.timestampStyle || 'start-end').trim().toLowerCase();
  timestampStyle = timestampStyle.replace(/_/g, '-').replace(/\s+/g, '-');
  if (!includeTimecodes) timestampStyle = 'none';
  if (timestampStyle === 'startend') timestampStyle = 'start-end';
  if (timestampStyle === 'everyline') timestampStyle = 'every-line';
  if (!['none', 'start', 'start-end', 'every-line'].includes(timestampStyle)) {
    timestampStyle = 'start-end';
  }

  const allowGrouping = Boolean(opts.groupBySpeaker) && timestampStyle !== 'every-line';
  const speakerStyle = opts.speakerStyle || 'title';
  const startOffset = normalizeOffset(opts.startTimecodeOffset, sysFps, sysDF);

  const withOffset = (value) => {
    if (!Number.isFinite(value)) return null;
    const adjusted = value + startOffset;
    return adjusted < 0 ? 0 : adjusted;
  };

  const defaultTc = (opts.timecodeStyle === 'ms')
    ? '00:00:00,000'
    : (sysDF ? '00:00:00;00' : '00:00:00:00');

  const cleanText = (value) => String(value ?? '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stripFillers = (value) => {
    if (!opts.removeFillers) return value;
    return String(value ?? '')
      .replace(/\b(?:um+|uh+|er+|ah+)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const resolveTime = (seg, field) => {
    const numeric = Number(seg?.[field]);
    if (Number.isFinite(numeric)) return numeric;
    const ms = seg?.timecodes?.ms?.[field];
    if (typeof ms === 'number') return ms / 1000;
    const tcLabel = seg?.timecodes?.df?.[field] || seg?.timecodes?.ndf?.[field];
    if (tcLabel) {
      const raw = String(tcLabel).trim();
      try {
        if (/^\d{1,3}:\d{2}:\d{2}[:;]\d{2}$/.test(raw)) {
          const frames = framesFromTimecodeLabel(raw, sysFps, sysDF);
          if (Number.isFinite(frames)) return framesToSeconds(frames, sysFps);
        }
      } catch {}
      const parsed = parseTimeMs(raw, sysFps, sysDF);
      if (Number.isFinite(parsed)) return parsed / 1000;
    }
    return null;
  };

  const formatSpeaker = (name) => {
    if (!name) return '';
    if (speakerStyle === 'caps') return String(name).toUpperCase();
    if (speakerStyle === 'title') return String(name).replace(/\b\w/g, c => c.toUpperCase());
    return String(name).trim();
  };

  const formatTc = (sec) => {
    if (!Number.isFinite(sec)) return defaultTc;
    return formatTimecode(sec, sysDF, sysFps, opts.timecodeStyle);
  };

  const lines = [];
  let currentGroup = null;

  const flushGroup = () => {
    if (!currentGroup) return;
    const textValue = cleanText(currentGroup.text);
    if (!textValue) {
      currentGroup = null;
      return;
    }

    const prefixParts = [];
    if (includeTimecodes && timestampStyle !== 'none') {
      const startLabel = formatTc(currentGroup.start);
      const endLabel = formatTc(
        Number.isFinite(currentGroup.end)
          ? currentGroup.end
          : (Number.isFinite(currentGroup.start) ? currentGroup.start : null)
      );
      if (timestampStyle === 'start') prefixParts.push(`[${startLabel}]`);
      else if (timestampStyle === 'start-end') prefixParts.push(`[${startLabel} - ${endLabel}]`);
      else if (timestampStyle === 'every-line') prefixParts.push(`[${startLabel}]`);
    }

    if (includeSpeakers && currentGroup.displaySpeaker) {
      prefixParts.push(`${currentGroup.displaySpeaker}:`);
    }

    lines.push((prefixParts.join(' ') + ' ' + textValue).trim());
    currentGroup = null;
  };

  for (const seg of segments) {
    const rawText = stripFillers(cleanText(seg?.text));
    const text = cleanText(rawText);

    // Speaker: keep a stable grouping key separate from the display formatting.
    let speakerRaw = (typeof seg?.speaker === 'string') ? seg.speaker : '';
    speakerRaw = String(speakerRaw || '').trim();
    if (!speakerRaw && jsonResults?.metadata?.autoSpeakerLabels && (includeSpeakers || allowGrouping)) {
      // Minimal fallback: don't invent alternation; keep a single "Speaker 1" label.
      speakerRaw = 'SPEAKER 1';
    }

    const speakerKey = speakerRaw || (includeSpeakers ? 'SPEAKER' : '');
    const displaySpeaker = includeSpeakers
      ? formatSpeaker(speakerRaw || 'SPEAKER')
      : '';

    const start = resolveTime(seg, 'start');
    const endRaw = resolveTime(seg, 'end');
    const startSec = withOffset(start);
    const endSec = withOffset(Number.isFinite(endRaw) ? endRaw : start);

    const entry = {
      start: startSec,
      end: endSec,
      speakerKey,
      displaySpeaker,
      text
    };

    if (allowGrouping && currentGroup && entry.speakerKey === currentGroup.speakerKey) {
      // Extend the grouped line and widen the time range.
      if (entry.text) currentGroup.text = `${currentGroup.text} ${entry.text}`.trim();
      if (Number.isFinite(entry.end)) currentGroup.end = entry.end;
    } else {
      flushGroup();
      currentGroup = entry;
    }
  }

  flushGroup();
  return lines.join('\n');
}

module.exports = {
  generatePlainText,
  normalizeOffset
};
