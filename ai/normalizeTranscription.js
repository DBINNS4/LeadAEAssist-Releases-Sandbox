// ✅ Use centralized timecode core
const {
  toFrame,
  toFrameEnd,
  toMs,
  formatTimecode,
  isDropFrameRate,
  parseTime: parseTimeMs
} = require('../utils/timeUtils');
const { ensureCueSchema } = require('../utils/cueSchema');

function normalizeTranscriptionStructure(
  jsonData,
  fps = 30,
  dropFrame = false
) {
  if (!jsonData || !Array.isArray(jsonData.transcription)) return;

  jsonData.segments = jsonData.transcription.map((entry, idx) => {
    const tokens = Array.isArray(entry.tokens)
      ? entry.tokens.filter(t => t?.text && !t.text.startsWith('[_'))
      : [];

    const firstToken = tokens[0] || {};
    const lastToken = tokens.at(-1) || {};

    const msStart = firstToken.msStart ?? firstToken.offsets?.from ?? 0;
    const msEnd = lastToken.msEnd ?? lastToken.offsets?.to ?? 0;

    const floatStart = msStart / 1000;
    const floatEnd = msEnd / 1000;

    return {
      id: idx,
      start: floatStart,
      end: floatEnd,
      msStart,
      msEnd,
      // Frame counters here are "real frames" at `fps` (no DF label math).
      // Suitable for math/comparison; not equivalent to ;FF timecode labels.
      frameStart: toFrame(floatStart, fps),
      frameEnd: toFrameEnd(floatEnd, fps),
      timecodeStart: formatTimecode(floatStart, dropFrame, fps),
      timecodeEnd: formatTimecode(floatEnd, dropFrame, fps),
      text: entry.text,
      speaker: entry.speaker || 'SPEAKER',
      confidence: entry.confidence || null,
      tokens: entry.tokens || []
    };
  });

  delete jsonData.transcription;
}

function resolveSeconds(value, fps = 30) {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const str = value.trim();
    if (!str) return 0;
    if (/^-?\d+(?:\.\d+)?$/.test(str)) {
      return parseFloat(str);
    }
    try {
      // parseTimeMs returns milliseconds (DF-aware); pass through here.
      const ms = parseTimeMs(str, fps, /* auto */ null);
      if (typeof ms === 'number' && !Number.isNaN(ms)) {
        return ms / 1000;
      }
    } catch {}
  }

  if (value && typeof value === 'object') {
    if (typeof value.ms === 'number') {
      return value.ms / 1000;
    }
    if (typeof value.from === 'number') {
      return value.from / 1000;
    }
    if (typeof value.start === 'number') {
      return value.start;
    }
  }

  return 0;
}

function segmentsToCueList(segments = [], fps = 30) {
  return segments.map((segment, idx) => {
    // Phase 1: tolerate V2 cues/segments that embed canonical+overrides.
    const embeddedCanonical = (segment && typeof segment === 'object' && segment.canonical && typeof segment.canonical === 'object')
      ? { ...segment.canonical }
      : null;
    const embeddedOverrides = (segment && typeof segment === 'object' && segment.overrides && typeof segment.overrides === 'object')
      ? { ...segment.overrides }
      : null;

    const start = resolveSeconds(
      segment.start ?? embeddedCanonical?.start ?? (typeof segment.msStart === 'number' ? segment.msStart / 1000 : segment.timecodeStart),
      fps,
    );
    const end = resolveSeconds(
      segment.end ?? embeddedCanonical?.end ?? (typeof segment.msEnd === 'number' ? segment.msEnd / 1000 : segment.timecodeEnd),
      fps,
    );
    const startMs = toMs(Math.max(0, start));
    const endMs = toMs(Math.max(end, start));
    const rawLines = Array.isArray(segment.lines)
      ? segment.lines.map(line => String(line || '')).filter(Boolean)
      : (Array.isArray(embeddedCanonical?.lines)
        ? embeddedCanonical.lines.map(line => String(line || '')).filter(Boolean)
        : null);
    const textFromLines = rawLines && rawLines.length ? rawLines.join('\n') : null;

    // Phase A: optional rich-style runs[] (CEA-708)
    // We keep `text` as a plain fallback for legacy exporters, but carry `runs`
    // end-to-end so MCC/708 can be styled.
    const runs = Array.isArray(segment.runs)
      ? segment.runs.map(r => ({
          text: String((r && typeof r === 'object') ? (r.text ?? '') : ''),
          ...(r && typeof r === 'object' && r.style && typeof r.style === 'object' ? { style: { ...r.style } } : {})
        }))
      : (segment.text && typeof segment.text === 'object' && Array.isArray(segment.text.runs))
        ? segment.text.runs.map(r => ({
            text: String((r && typeof r === 'object') ? (r.text ?? '') : ''),
            ...(r && typeof r === 'object' && r.style && typeof r.style === 'object' ? { style: { ...r.style } } : {})
          }))
        : (Array.isArray(embeddedCanonical?.runs)
          ? embeddedCanonical.runs.map(r => ({
              text: String((r && typeof r === 'object') ? (r.text ?? '') : ''),
              ...(r && typeof r === 'object' && r.style && typeof r.style === 'object' ? { style: { ...r.style } } : {})
            }))
          : null);
    const textFromRuns = runs && runs.length ? runs.map(r => String(r.text || '')).join('') : null;
    const cue = {
      id: segment.id ?? idx,
      start,
      end,
      startMs,
      endMs,
      text: (typeof segment.text === 'string')
        ? segment.text
        : (segment.text && typeof segment.text === 'object' && typeof segment.text.text === 'string')
          ? segment.text.text
          : (textFromRuns ?? textFromLines ?? (embeddedCanonical?.text ?? '')),
      ...(runs && runs.length ? { runs } : {}),
      speaker: segment.speaker || segment.speakerLabel || embeddedCanonical?.speaker || null,
      lines: rawLines && rawLines.length ? rawLines : undefined,
      // preserve manual placements
      sccPlacement: segment.sccPlacement ? { ...segment.sccPlacement } : (embeddedCanonical?.sccPlacement ? { ...embeddedCanonical.sccPlacement } : undefined),
      // Optional per-cue 708 placement override (ASS-style \an1..\an9).
      cea708Placement: (segment.cea708Placement && typeof segment.cea708Placement === 'object')
        ? { ...segment.cea708Placement }
        : (segment.cea708An != null ? { an: segment.cea708An } : (embeddedCanonical?.cea708Placement ? { ...embeddedCanonical.cea708Placement } : undefined)),
      // Milestone 3: optional per-cue 608 override (kept alongside canonical 708 text)
      compat608: (segment.compat608 && typeof segment.compat608 === 'object')
        ? {
            ...segment.compat608,
            ...(Array.isArray(segment.compat608.lines)
              ? { lines: segment.compat608.lines.map(line => String(line || '')) }
              : {})
          }
        : undefined,
      compat608Text: (typeof segment.compat608Text === 'string' && segment.compat608Text.length)
        ? segment.compat608Text
        : undefined
    };

    if (embeddedCanonical) cue.canonical = embeddedCanonical;
    if (embeddedOverrides) cue.overrides = embeddedOverrides;
    ensureCueSchema(cue);
    return cue;
  });
}

function cueListToSegments(cues = [], fps = 30, dropFrame = false) {
  return cues.map((cue, idx) => {
    // Phase 1: preserve any embedded canonical/overrides through the round-trip.
    const embeddedCanonical = (cue && typeof cue === 'object' && cue.canonical && typeof cue.canonical === 'object')
      ? { ...cue.canonical }
      : null;
    const embeddedOverrides = (cue && typeof cue === 'object' && cue.overrides && typeof cue.overrides === 'object')
      ? { ...cue.overrides }
      : null;

    const start = resolveSeconds(cue.start ?? cue.timecodeStart, fps, dropFrame);
    const end = resolveSeconds(cue.end ?? cue.timecodeEnd, fps, dropFrame);
    const safeStart = Math.max(0, start);
    const safeEnd = Math.max(end, safeStart);
    const rawLines = Array.isArray(cue.lines)
      ? cue.lines.map(line => String(line || '')).filter(Boolean)
      : null;
    const textFromLines = rawLines && rawLines.length ? rawLines.join('\n') : null;

    const runs = Array.isArray(cue.runs)
      ? cue.runs.map(r => ({
          text: String((r && typeof r === 'object') ? (r.text ?? '') : ''),
          ...(r && typeof r === 'object' && r.style && typeof r.style === 'object' ? { style: { ...r.style } } : {})
        }))
      : null;
    const textFromRuns = runs && runs.length ? runs.map(r => String(r.text || '')).join('') : null;
    const segment = {
      id: cue.id ?? idx,
      start: safeStart,
      end: safeEnd,
      msStart: toMs(safeStart),
      msEnd: toMs(safeEnd),
      // "Real frame" counters (see note above) — not DF label indices.
      frameStart: toFrame(safeStart, fps),
      frameEnd: toFrameEnd(safeEnd, fps),
      text: (typeof cue.text === 'string')
        ? cue.text
        : (textFromRuns ?? textFromLines ?? ''),
      ...(runs && runs.length ? { runs } : {}),
      lines: rawLines && rawLines.length ? rawLines : undefined,
      speaker: cue.speaker || null,
      // carry placement hints back to segments
      sccPlacement: cue.sccPlacement ? { ...cue.sccPlacement } : undefined,
      // Optional per-cue 708 placement override (ASS-style \an1..\an9).
      cea708Placement: (cue.cea708Placement && typeof cue.cea708Placement === 'object')
        ? { ...cue.cea708Placement }
        : (cue.cea708An != null ? { an: cue.cea708An } : undefined),
      // Milestone 3: optional per-cue 608 override (carried through to segments for export)
      compat608: (cue.compat608 && typeof cue.compat608 === 'object')
        ? {
            ...cue.compat608,
            ...(Array.isArray(cue.compat608.lines)
              ? { lines: cue.compat608.lines.map(line => String(line || '')) }
              : {})
          }
        : undefined,
      compat608Text: (typeof cue.compat608Text === 'string' && cue.compat608Text.length)
        ? cue.compat608Text
        : undefined
    };

    if (embeddedCanonical) segment.canonical = embeddedCanonical;
    if (embeddedOverrides) segment.overrides = embeddedOverrides;
    return segment;
  });
}

module.exports = {
  normalizeTranscriptionStructure,
  segmentsToCueList,
  cueListToSegments,
  // Preserve public API while using canonical implementation
  formatTimecode: formatTimecode,
  isDropFrameRate
};
