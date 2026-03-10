'use strict';

const { toMs, frameDurationMs } = require('../utils/timeUtils');

/**
 * WebVTT writer (dependency-light).
 *
 * Phase 1 goals (baseline correctness):
 * - Always emit syntactically valid WebVTT
 * - Canonical HH:MM:SS.mmm timestamps
 * - Clamp negative/invalid times and guarantee start < end
 * - Normalize newlines to \n
 * - Escape unsafe characters in cue text (&, <, >)
 * - Strip internal encoder/editor tags so they never leak into VTT
 * - Stable-sort segments by start time
 *
 * Phase 2 goals (professional formatting):
 * - Speaker label cohesion (avoid "SPEAKER:" orphan line)
 * - Better wrapping with basic orphan rebalancing
 * - Cue splitting remains line-count based, with proportional time allocation
 * - Optional readability timing assist (min duration + CPS-aware end extension into gaps)
 *
 * Phase 3 goals (enhanced styling + placement, compatibility-first):
 * - Optional cue settings (line/position/size/align) when placement tags exist
 * - Optional STYLE block and safe, controlled cue markup
 * - Best-effort translation of common CEA-608 mid-row style tokens into WebVTT markup
 *   (italics/underline and limited color classes)
 *
 * Notes:
 * - WebVTT styling/placement is inconsistently supported across players.
 *   Defaults remain conservative; enhancements are opt-in.
 */

function boolish(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}

function clampInt(n, lo, hi) {
  const x = Math.trunc(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

const MIDROW_COLOR_CLASS = {
  WH: 'c-wh',
  GR: 'c-gr',
  BL: 'c-bl',
  CY: 'c-cy',
  R:  'c-r',
  Y:  'c-y',
  MA: 'c-ma'
};

// Phase 4: delivery profiles / presets.
// These provide sensible, repeatable defaults for WebVTT generation.
// IMPORTANT: WebVTT is not a broadcast container; these are streaming/web oriented.
// Users can always override any value via config/formats.vtt.* or legacy vttOptions.*.
const VTT_PROFILES = {
  // Conservative, broadly compatible defaults.
  streaming: {
    label: 'Streaming (recommended)',
    maxCharsPerLine: 42,
    maxLinesPerBlock: 2,
    maxDurationSeconds: 6.0,
    minDurationSeconds: 1.0,
    minSplitDurationSeconds: 0.5,
    maxCps: 20,
    preventOverlaps: false,
    allowTimeExtension: true,
    maxEndExtensionSeconds: 1.5,
    includeStyleMetadata: false
  },

  // Stricter readability: lower CPS, no overlaps.
  strict: {
    label: 'Strict streaming (QC-focused)',
    maxCharsPerLine: 42,
    maxLinesPerBlock: 2,
    maxDurationSeconds: 6.0,
    minDurationSeconds: 1.0,
    minSplitDurationSeconds: 0.6,
    maxCps: 17,
    preventOverlaps: true,
    allowTimeExtension: true,
    maxEndExtensionSeconds: 1.0,
    includeStyleMetadata: false
  },

  // Looser web captioning: more room, more lines.
  web: {
    label: 'Web (looser)',
    maxCharsPerLine: 52,
    maxLinesPerBlock: 3,
    maxDurationSeconds: 7.0,
    minDurationSeconds: 0.8,
    minSplitDurationSeconds: 0.5,
    maxCps: 22,
    preventOverlaps: false,
    allowTimeExtension: true,
    maxEndExtensionSeconds: 2.0,
    includeStyleMetadata: false
  },

  // Same as streaming, but turns on style metadata for players that support it.
  styled: {
    label: 'Streaming + style metadata',
    maxCharsPerLine: 42,
    maxLinesPerBlock: 2,
    maxDurationSeconds: 6.0,
    minDurationSeconds: 1.0,
    minSplitDurationSeconds: 0.5,
    maxCps: 20,
    preventOverlaps: false,
    allowTimeExtension: true,
    maxEndExtensionSeconds: 1.5,
    includeStyleMetadata: true
  }
};

function normalizeVttProfileKey(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v && Object.prototype.hasOwnProperty.call(VTT_PROFILES, v)) return v;
  return '';
}

function resolveVttProfile(config = {}) {
  const fmt = (config && config.formats && config.formats.vtt && typeof config.formats.vtt === 'object')
    ? config.formats.vtt
    : {};
  const legacy = (config && config.vttOptions && typeof config.vttOptions === 'object')
    ? config.vttOptions
    : {};

  return (
    normalizeVttProfileKey(fmt.profile ?? fmt.deliveryProfile ?? fmt.vttProfile) ||
    normalizeVttProfileKey(legacy.profile ?? legacy.deliveryProfile ?? legacy.vttProfile) ||
    normalizeVttProfileKey(config.vttProfile ?? config.vttProfileKey ?? config.vttDeliveryProfile)
  );
}

// IMPORTANT: Keep this regex tight to avoid stripping literal curly-brace text.
// These tokens are internal CEA-608 mid-row attributes in your SCC text representation.
const MIDROW_TOKEN_RE = /\{\s*(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|IU|I)\s*\}/g;

function resolveVttOptions(config = {}) {
  const fmt = (config && config.formats && config.formats.vtt && typeof config.formats.vtt === 'object')
    ? config.formats.vtt
    : {};
  const legacy = (config && config.vttOptions && typeof config.vttOptions === 'object')
    ? config.vttOptions
    : {};

  const profileKey = resolveVttProfile(config);
  const profile = profileKey ? VTT_PROFILES[profileKey] : null;

  const strictTiming = (() => {
    const v = boolish(fmt.strictTiming ?? fmt.exactTiming);
    if (v !== undefined) return v;
    const v2 = boolish(legacy.strictTiming ?? legacy.exactTiming);
    if (v2 !== undefined) return v2;
    const v3 = boolish(config.strictTiming ?? config.exactTiming);
    if (v3 !== undefined) return v3;
    if (profile && typeof profile.strictTiming === 'boolean') return profile.strictTiming;
    return false;
  })();

  const includeSpeakerNames = (() => {
    const v = boolish(fmt.includeSpeakers ?? fmt.includeSpeakerNames);
    if (v !== undefined) return v;
    const v2 = boolish(config.includeSpeakerNames);
    if (v2 !== undefined) return v2;
    if (profile && typeof profile.includeSpeakerNames === 'boolean') return profile.includeSpeakerNames;
    return false;
  })();

  const speakerLabelStyle = (() => {
    const raw = String(
      fmt.speakerLabelStyle ??
      fmt.speakerStyle ??
      config.speakerLabelStyle ??
      config.speakerStyle ??
      (profile ? profile.speakerLabelStyle : undefined) ??
      'title'
    ).trim().toLowerCase();
    return (raw === 'caps' || raw === 'raw' || raw === 'title') ? raw : 'title';
  })();

  const includeStyleMetadata = (() => {
    const v = boolish(fmt.includeStyleMetadata ?? fmt.includeStyle);
    if (v !== undefined) return v;
    const v2 = boolish(legacy.includeStyle);
    if (v2 !== undefined) return v2;
    const v3 = boolish(config.includeStyleMetadata ?? config.includeStyle);
    if (v3 !== undefined) return v3;
    if (profile && typeof profile.includeStyleMetadata === 'boolean') return profile.includeStyleMetadata;
    return false;
  })();

  const maxCharsPerLine = (() => {
    const raw = legacy.maxCharsPerLine ?? fmt.maxCharsPerLine ?? config.maxCharsPerLine ?? (profile ? profile.maxCharsPerLine : undefined) ?? 42;
    const n = Math.trunc(Number(raw));
    return (Number.isFinite(n) && n > 0) ? n : 42;
  })();

  const maxLinesPerBlock = (() => {
    const raw = legacy.maxLinesPerBlock ?? fmt.maxLinesPerBlock ?? config.maxLinesPerBlock ?? (profile ? profile.maxLinesPerBlock : undefined) ?? 2;
    const n = Math.trunc(Number(raw));
    return (Number.isFinite(n) && n > 0) ? n : 2;
  })();

  // Optional guard: if enabled, we will avoid overlaps by clamping cue starts to the previous cue's end
  // AND clamping cue ends to the next cue's start.
  // Default is false to preserve original timings.
  const preventOverlaps = (() => {
    const v = boolish(fmt.preventOverlaps ?? fmt.noOverlaps ?? legacy.preventOverlaps ?? legacy.noOverlaps);
    if (v !== undefined) return v;
    const v2 = boolish(config.preventOverlaps ?? config.noOverlaps);
    if (v2 !== undefined) return v2;
    if (profile && typeof profile.preventOverlaps === 'boolean') return profile.preventOverlaps;
    return false;
  })();

  // Phase 3: cue settings (line/position/size/align) & translation of 608 mid-row tokens.
  const includeCueSettings = (() => {
    const v = boolish(fmt.includeCueSettings ?? fmt.includePlacementMetadata ?? fmt.includeCueMetadata);
    if (v !== undefined) return v;
    const v2 = boolish(legacy.includeCueSettings ?? legacy.includePlacementMetadata ?? legacy.includeCueMetadata);
    if (v2 !== undefined) return v2;
    const v3 = boolish(config.includeCueSettings ?? config.includePlacementMetadata ?? config.includeCueMetadata);
    if (v3 !== undefined) return v3;
    // Conservative default: only emit cue settings when the user has enabled style metadata.
    return includeStyleMetadata;
  })();

  const forceCueSettings = (() => {
    const v = boolish(fmt.forceCueSettings ?? fmt.forcePlacementSettings ?? legacy.forceCueSettings ?? legacy.forcePlacementSettings);
    if (v !== undefined) return v;
    const v2 = boolish(config.forceCueSettings ?? config.forcePlacementSettings);
    if (v2 !== undefined) return v2;
    if (profile && typeof profile.forceCueSettings === 'boolean') return profile.forceCueSettings;
    return false;
  })();

  const translate608Styles = (() => {
    const v = boolish(
      fmt.translate608Styles ??
      fmt.translate608StyleTokens ??
      fmt.translateInlineStyles ??
      legacy.translate608Styles ??
      legacy.translateInlineStyles
    );
    if (v !== undefined) return v;
    const v2 = boolish(config.translate608Styles ?? config.translateInlineStyles);
    if (v2 !== undefined) return v2;
    // Default: if the user opted into WebVTT style metadata, preserve the most common
    // 608 italics/underline/color intentions where possible.
    return includeStyleMetadata;
  })();

  const emitColorClasses = (() => {
    const v = boolish(fmt.emitColorClasses ?? fmt.includeColorClasses ?? legacy.emitColorClasses ?? legacy.includeColorClasses);
    if (v !== undefined) return v;
    const v2 = boolish(config.emitColorClasses ?? config.includeColorClasses);
    if (v2 !== undefined) return v2;
    // Only meaningful when we are translating 608 styles and emitting STYLE metadata.
    return translate608Styles && includeStyleMetadata;
  })();

  // FPS is used to derive a sane minimum cue duration when input timings are invalid.
  const fps = (() => {
    const n = Number(config?.fpsOverride ?? config?.fps ?? config?.system?.fps ?? 30);
    return (Number.isFinite(n) && n > 0) ? n : 30;
  })();

  // Hard minimum cue duration: at least one frame, rounded up to whole ms.
  const minCueDurationMs = frameDurationMs(fps, 'ceil');

  // Max cue duration: respect the shared subtitle UI maxDurationSeconds unless strict timing.
  const maxDurationSeconds = (() => {
    const raw =
      fmt.maxDurationSeconds ??
      legacy.maxDurationSeconds ??
      config.maxDurationSeconds ??
      (profile ? profile.maxDurationSeconds : undefined) ??
      6.0;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 6.0;
  })();

  const maxCueDurationMs = strictTiming ? Infinity : Math.max(1, toMs(maxDurationSeconds));

  // Professional readability helpers (Phase 2):
  // - minReadableDurationSeconds: try to extend too-short cues into available gaps.
  // - maxCps: try to extend into gaps when density is too high.
  // These are best-effort; if there is no gap, we keep timing.
  const minReadableDurationSeconds = (() => {
    const raw =
      fmt.minDurationSeconds ??
      legacy.minDurationSeconds ??
      config.minDurationSeconds ??
      (profile ? profile.minDurationSeconds : undefined) ??
      undefined;
    if (raw == null) return 1.0; // conservative default (can be overridden)
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 1.0;
  })();

  const minReadableCueDurationMs = strictTiming
    ? minCueDurationMs
    : Math.max(minCueDurationMs, toMs(minReadableDurationSeconds));

  const minSplitDurationSeconds = (() => {
    const raw =
      fmt.minSplitDurationSeconds ??
      legacy.minSplitDurationSeconds ??
      config.minSplitDurationSeconds ??
      (profile ? profile.minSplitDurationSeconds : undefined) ??
      undefined;
    if (raw == null) return 0.5;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 0.5;
  })();

  const minSplitCueDurationMs = strictTiming
    ? minCueDurationMs
    : Math.max(minCueDurationMs, toMs(minSplitDurationSeconds));

  const maxCps = (() => {
    const raw =
      fmt.maxCps ??
      fmt.maxCPS ??
      legacy.maxCps ??
      legacy.maxCPS ??
      config.maxCps ??
      config.maxCPS ??
      (profile ? profile.maxCps : undefined) ??
      undefined;
    if (raw == null || raw === '') return 20; // common streaming-safe default
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 20;
  })();

  const allowTimeExtension = (() => {
    // Default: enabled when NOT strict timing.
    const v = boolish(fmt.allowTimeExtension ?? legacy.allowTimeExtension);
    if (v !== undefined) return v;
    const v2 = boolish(config.allowTimeExtension);
    if (v2 !== undefined) return v2;
    if (profile && typeof profile.allowTimeExtension === 'boolean') return profile.allowTimeExtension;
    return !strictTiming;
  })();

  const maxEndExtensionSeconds = (() => {
    const raw =
      fmt.maxEndExtensionSeconds ??
      legacy.maxEndExtensionSeconds ??
      config.maxEndExtensionSeconds ??
      (profile ? profile.maxEndExtensionSeconds : undefined) ??
      undefined;
    if (raw == null) return 1.5;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 1.5;
  })();

  const maxEndExtensionMs = strictTiming
    ? 0
    : Math.max(0, toMs(maxEndExtensionSeconds));

  return {
    profileKey,
    strictTiming,
    includeSpeakerNames,
    speakerLabelStyle,
    includeStyleMetadata,
    maxCharsPerLine,
    maxLinesPerBlock,
    // Expose timing policy values in seconds for QC/reporting (Phase 5/6).
    maxDurationSeconds,
    minDurationSeconds: minReadableDurationSeconds,
    minSplitDurationSeconds,
    maxEndExtensionSeconds,
    preventOverlaps,
    includeCueSettings,
    forceCueSettings,
    translate608Styles,
    emitColorClasses,
    fps,
    minCueDurationMs,
    maxCueDurationMs,
    minReadableCueDurationMs,
    minSplitCueDurationMs,
    maxCps,
    allowTimeExtension,
    maxEndExtensionMs
  };
}

function formatSpeaker(name, style = 'title') {
  const s = String(name || '').trim();
  if (!s) return '';
  if (style === 'caps') return s.toUpperCase();
  if (style === 'title') return s.replace(/\b\w/g, c => c.toUpperCase());
  return s;
}

function escapeVttText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Phase 7-ish: defensive cue-text markup sanitizer.
// The writer already escapes all user-supplied text, so any remaining tags
// should be tags that *we* intentionally generate. This extra pass prevents
// accidental future regressions from emitting unsupported tags.
function isAllowedVttCueTag(tagRaw) {
  const tag = String(tagRaw || '').trim();
  if (!tag.startsWith('<') || !tag.endsWith('>')) return false;

  const inner = tag.slice(1, -1).trim();
  if (!inner) return false;

  const isEnd = inner.startsWith('/');
  const body = isEnd ? inner.slice(1).trim() : inner;
  const parts = body.split(/\s+/).filter(Boolean);
  const head = parts[0] || '';
  const name = head.split(/[.\s]/)[0];
  if (!name) return false;

  const allowed = new Set(['i', 'b', 'u', 'c', 'v', 'lang', 'ruby', 'rt']);
  if (!allowed.has(name)) return false;

  // Allow dot-classes on <c> and <v> (e.g. <c.speaker>, <c.c-gr>).
  if ((name === 'c' || name === 'v') && head.includes('.')) {
    const segs = head.split('.');
    if (!segs.length || segs[0] !== name) return false;
    for (const cls of segs.slice(1)) {
      if (!cls || !/^[A-Za-z0-9_-]+$/.test(cls)) return false;
    }
  }

  if (isEnd) return parts.length === 1;

  if (name === 'lang' || name === 'v') return parts.length <= 2;
  if (name === 'i' || name === 'b' || name === 'u' || name === 'ruby' || name === 'rt') return parts.length === 1;
  if (name === 'c') return parts.length === 1;
  return false;
}

function sanitizeCueTextMarkup(text) {
  return String(text || '').replace(/<[^>]*>/g, (m) => (isAllowedVttCueTag(m) ? m : escapeVttText(m)));
}

function normalizeNewlines(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n');
}

function toVttTimestampFromMs(ms) {
  let t = Math.round(Number(ms));
  if (!Number.isFinite(t) || t < 0) t = 0;

  const totalSeconds = Math.floor(t / 1000);
  const msec = t % 1000;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;

  const pad2 = (v) => String(v).padStart(2, '0');
  const pad3 = (v) => String(v).padStart(3, '0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(msec)}`;
}

// Pull optional editor placement tags like {row:15}{col:0} from the beginning of a line.
// (CEA-608 interop glue; these tags should never render in WebVTT.)
function pullPlacementTags(line) {
  let text = String(line || '');
  let row = null;
  let col = null;

  // Allow multiple tags in any order at the beginning of the line.
  while (true) {
    const m = text.match(/^\{\s*(row|r|col|c)\s*:\s*([0-9]{1,2})\s*\}\s*/i);
    if (!m) break;
    const key = String(m[1] || '').toLowerCase();
    const val = Number(m[2]);
    if (key === 'row' || key === 'r') row = val;
    else col = val;
    text = text.slice(m[0].length);
  }

  // Also allow {pac:...} tags at the start (encoder/editor glue).
  while (true) {
    const m = text.match(/^\{\s*pac\s*:\s*[^}]+\}\s*/i);
    if (!m) break;
    text = text.slice(m[0].length);
  }

  return { text, row, col };
}

// Strip common editor/encoder tags that should NOT appear in subtitle formats like VTT/SRT.
// Optionally preserve the CEA-608 mid-row style tokens so we can translate them into WebVTT markup.
function stripInternalTags(input, { preserve608Styles = false } = {}) {
  let s = String(input || '');

  // Remove placement tags even if they appear beyond the beginning (defensive).
  s = s.replace(/\{\s*(row|r|col|c|pac)\s*:\s*[^}]+\}\s*/gi, '');

  // Remove "no-operation" and command-like tokens.
  s = s.replace(/\{\s*(NOP)\s*\}\s*/gi, '');
  s = s.replace(/\{(?:rcl\d+)\}/gi, '');
  s = s.replace(/\{(?:midrow|pos|nl|clr|cr|eoc|edm|en|it|noit|speed\d+)\}/gi, '');

  // Remove common 608 color/italics tokens unless the caller wants to translate them.
  if (!preserve608Styles) {
    s = s.replace(MIDROW_TOKEN_RE, '');
  }

  // Normalize line breaks.
  s = normalizeNewlines(s);
  return s;
}

function measureChars(s) {
  // Unicode-safe count (treats surrogate pairs as one char)
  return Array.from(String(s || '')).length;
}

function hardBreakToken(token, limit) {
  const chars = Array.from(String(token || ''));
  const out = [];
  for (let i = 0; i < chars.length; i += limit) {
    out.push(chars.slice(i, i + limit).join(''));
  }
  return out;
}

function splitWordsPreserveBasic(text) {
  // Normalize whitespace to single spaces; keep punctuation attached to words.
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wrapWordsToLines(words, limitFirst, limitOther) {
  const out = [];
  let current = '';
  let curLimit = limitFirst;

  const pushCurrent = () => {
    if (current) out.push(current);
    current = '';
    curLimit = limitOther;
  };

  for (const wordRaw of words) {
    const word = String(wordRaw);

    if (!current) {
      if (measureChars(word) <= curLimit) {
        current = word;
      } else {
        // Unbreakable token; hard-break.
        const parts = hardBreakToken(word, Math.max(1, curLimit));
        if (parts.length > 1) out.push(...parts.slice(0, -1));
        current = parts[parts.length - 1] || '';
        curLimit = limitOther;
      }
      continue;
    }

    const candidate = `${current} ${word}`;
    if (measureChars(candidate) <= curLimit) {
      current = candidate;
      continue;
    }

    pushCurrent();

    if (measureChars(word) <= curLimit) {
      current = word;
    } else {
      const parts = hardBreakToken(word, Math.max(1, curLimit));
      if (parts.length > 1) out.push(...parts.slice(0, -1));
      current = parts[parts.length - 1] || '';
      curLimit = limitOther;
    }
  }

  if (current) out.push(current);
  return out;
}

function rebalanceLastLineOrphan(lines, limitFirst, limitOther) {
  if (!Array.isArray(lines) || lines.length < 2) return lines;

  const getLimit = (idx) => (idx === 0 ? limitFirst : limitOther);

  const lastIdx = lines.length - 1;
  const lastWords = splitWordsPreserveBasic(lines[lastIdx]);

  // Only rebalance obvious orphans: last line has 1–2 words.
  if (lastWords.length > 2) return lines;

  const prevIdx = lines.length - 2;
  const prevWords = splitWordsPreserveBasic(lines[prevIdx]);
  if (prevWords.length <= 1) return lines;

  // Try moving one word from end of previous line to start of last line.
  for (let k = 0; k < 2; k++) {
    if (prevWords.length <= 1) break;

    const moved = prevWords.pop();
    lastWords.unshift(moved);

    const newPrev = prevWords.join(' ');
    const newLast = lastWords.join(' ');

    if (
      measureChars(newPrev) <= getLimit(prevIdx) &&
      measureChars(newLast) <= getLimit(lastIdx)
    ) {
      lines[prevIdx] = newPrev;
      lines[lastIdx] = newLast;
      continue;
    }

    // Revert if it doesn't fit.
    lastWords.shift();
    prevWords.push(moved);
    break;
  }

  return lines;
}

function wrapOneParagraphToLines(paraText, limitFirst, limitOther) {
  const words = splitWordsPreserveBasic(paraText);
  if (!words.length) return [];
  const lines = wrapWordsToLines(words, limitFirst, limitOther);
  rebalanceLastLineOrphan(lines, limitFirst, limitOther);
  return lines;
}

function wrapParagraphsToLineObjects(paragraphs, limit, firstLineLimit = null) {
  const out = [];
  let firstLineUsed = false;

  for (const p of (Array.isArray(paragraphs) ? paragraphs : [])) {
    const raw = normalizeNewlines(String(p?.text ?? '')).trim();
    if (!raw) continue;

    // IMPORTANT: never emit blank lines inside a cue; a blank line terminates a cue in WebVTT.
    const normalized = raw.replace(/[\t ]+/g, ' ').trim();
    if (!normalized) continue;

    const limFirst = (!firstLineUsed && firstLineLimit != null)
      ? Math.max(1, Math.trunc(firstLineLimit))
      : Math.max(1, Math.trunc(limit));

    const limOther = Math.max(1, Math.trunc(limit));

    const lines = wrapOneParagraphToLines(normalized, limFirst, limOther);
    for (const ln of lines) {
      out.push({
        text: ln,
        style: p?.style ?? { italic: false, underline: false, colorClass: null }
      });
    }

    if (lines.length && !firstLineUsed) firstLineUsed = true;
  }

  return out;
}

function chunkLineObjects(lines, maxLines) {
  const out = [];
  const list = Array.isArray(lines) ? lines : [];
  const n = Math.max(1, Math.trunc(Number(maxLines) || 1));
  for (let i = 0; i < list.length; i += n) {
    out.push(list.slice(i, i + n));
  }
  return out;
}

function countCharsNoSpace(s) {
  return String(s || '').replace(/\s+/g, '').length;
}

// Allocate contiguous time spans for N chunks based on weights.
// If durMs is too short for minSpanMs * N, we refuse to split.
function allocateSpansByWeightsMs(startMs, endMs, weights, minSpanMs = 1) {
  let sMs = Math.round(Number(startMs || 0));
  let eMs = Math.round(Number(endMs || 0));
  if (!Number.isFinite(sMs)) sMs = 0;
  if (!Number.isFinite(eMs)) eMs = sMs + minSpanMs;
  if (eMs <= sMs) eMs = sMs + minSpanMs;

  const n = Array.isArray(weights) ? weights.length : 0;
  const durMs = eMs - sMs;

  if (n <= 1) return [[sMs, eMs]];
  if (durMs < n * minSpanMs) return [[sMs, eMs]];

  const safeWeights = weights.map(w => Math.max(1, Number(w) || 0));
  const total = safeWeights.reduce((a, b) => a + b, 0);

  // Give each chunk minSpanMs, then distribute remaining duration proportionally.
  const remaining = durMs - (n * minSpanMs);

  const spans = [];
  let cur = sMs;

  // First pass: compute raw allocations.
  const allocs = safeWeights.map(w => minSpanMs + Math.floor(remaining * (w / total)));

  // Fix rounding remainder by adding leftover ms to the last chunk.
  const allocSum = allocs.reduce((a, b) => a + b, 0);
  const leftover = durMs - allocSum;
  if (leftover !== 0) allocs[allocs.length - 1] += leftover;

  for (let i = 0; i < n; i++) {
    const a = Math.max(minSpanMs, Math.round(allocs[i]));
    const next = (i === n - 1) ? eMs : (cur + a);
    spans.push([cur, next]);
    cur = next;
  }

  // Clamp last end exactly.
  spans[spans.length - 1][1] = eMs;
  return spans;
}

function defaultStyle() {
  return { italic: false, underline: false, colorClass: null };
}

// Best-effort extraction of CEA-608 mid-row attribute tokens from a single line.
// We intentionally apply the derived style to the WHOLE line (paragraph-level), not mid-line.
function extract608StylesFromLine(line) {
  let italic = false;
  let underline = false;
  let colorClass = null;

  let s = String(line || '');

  s = s.replace(MIDROW_TOKEN_RE, (m, tokenRaw) => {
    const token = String(tokenRaw || '').trim();
    const upper = token.toUpperCase();

    if (upper === 'I') {
      italic = true;
      return '';
    }
    if (upper === 'IU') {
      italic = true;
      underline = true;
      return '';
    }

    // Color tokens: {Wh}/{Gr}/... and underlined variants {WhU}/{GrU}/...
    const isUnder = upper.endsWith('U');
    const base = isUnder ? upper.slice(0, -1) : upper;

    const cls = MIDROW_COLOR_CLASS[base];
    if (cls) {
      colorClass = cls;
      // In 608, underline is part of these mid-row attribute tokens.
      underline = isUnder;
      return '';
    }

    // Shouldn't hit because regex is tight; remove defensively.
    return '';
  });

  // Normalize whitespace after token removal.
  s = normalizeNewlines(s).replace(/[\t ]+/g, ' ').trim();

  return {
    text: s,
    style: { italic, underline, colorClass }
  };
}

function renderSpeakerLabel(speakerPrefix, opts) {
  const safe = escapeVttText(speakerPrefix);
  if (opts.includeStyleMetadata) return `<c.speaker>${safe}</c>`;
  return safe;
}

function renderStyledText(text, style, opts) {
  const safe = escapeVttText(text);

  if (!opts.translate608Styles) return safe;

  const st = style || defaultStyle();

  // Keep color classes behind includeStyleMetadata (otherwise they're inert markup).
  const useColor = Boolean(opts.includeStyleMetadata && opts.emitColorClasses && st.colorClass);

  const open = [];
  const close = [];

  if (useColor) {
    open.push(`<c.${st.colorClass}>`);
    close.unshift('</c>');
  }
  if (st.italic) {
    open.push('<i>');
    close.unshift('</i>');
  }
  if (st.underline) {
    open.push('<u>');
    close.unshift('</u>');
  }

  return open.join('') + safe + close.join('');
}

// Convert a 608-ish row/col hint into a best-effort WebVTT cue settings string.
// NOTE: WebVTT placement is not pixel/row precise, and many players ignore cue settings.
function cueSettingsFromPlacement(placement, opts) {
  if (!opts?.includeCueSettings) return '';

  const rowRaw = placement?.row;
  const colRaw = placement?.col;

  const hasRow = rowRaw != null && Number.isFinite(Number(rowRaw));
  const hasCol = colRaw != null && Number.isFinite(Number(colRaw));

  if (!opts.forceCueSettings && !hasRow && !hasCol) return '';

  // Default conservative settings.
  let line = '90%';
  let position = '50%';
  let size = '100%';
  let align = 'center';

  if (hasRow) {
    const r = clampInt(rowRaw, 1, 15);
    const pct = Math.round((((r - 1) / 14) * 90) * 10) / 10; // 1 decimal
    line = `${pct}%`;
  }

  if (hasCol) {
    const c = clampInt(colRaw, 0, 31);
    // Heuristic: treat left-third as "start", right-third as "end", otherwise centered.
    if (c <= 10) {
      align = 'start';
      position = '10%';
      size = '90%';
    } else if (c >= 21) {
      align = 'end';
      position = '90%';
      size = '90%';
    } else {
      align = 'center';
      position = '50%';
      size = '100%';
    }
  }

  const parts = [];
  if (line) parts.push(`line:${line}`);
  if (position) parts.push(`position:${position}`);
  if (size) parts.push(`size:${size}`);
  if (align) parts.push(`align:${align}`);

  return parts.length ? parts.join(' ') : '';
}

function stableSortSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const indexed = list.map((seg, idx) => ({ seg, idx }));

  indexed.sort((a, b) => {
    const aStart = Number(a.seg?.start);
    const bStart = Number(b.seg?.start);
    const aEnd = Number(a.seg?.end);
    const bEnd = Number(b.seg?.end);

    const aS = Number.isFinite(aStart) ? aStart : Number.POSITIVE_INFINITY;
    const bS = Number.isFinite(bStart) ? bStart : Number.POSITIVE_INFINITY;
    if (aS !== bS) return aS - bS;

    const aE = Number.isFinite(aEnd) ? aEnd : Number.POSITIVE_INFINITY;
    const bE = Number.isFinite(bEnd) ? bEnd : Number.POSITIVE_INFINITY;
    if (aE !== bE) return aE - bE;

    return a.idx - b.idx;
  });

  return indexed.map(x => x.seg);
}

function buildStyleBlock(opts) {
  // Conservative styling; many players ignore WebVTT CSS.
  // NOTE: Keep this short/simple. Downstream validators/players can be picky.
  const lines = [];

  lines.push('STYLE');
  lines.push('::cue {');
  lines.push('  background-color: rgba(0,0,0,0.75);');
  lines.push('  color: white;');
  lines.push('  text-shadow: 0 0 4px rgba(0,0,0,0.9);');
  lines.push('  font-family: sans-serif;');
  lines.push('}');
  lines.push('::cue(.speaker) {');
  lines.push('  font-weight: bold;');
  lines.push('}');

  if (opts.translate608Styles && opts.emitColorClasses) {
    // Limited set of 608-ish colors. Exact colors are heuristics.
    lines.push('::cue(.c-wh) { color: #fff; }');
    lines.push('::cue(.c-gr) { color: #0f0; }');
    lines.push('::cue(.c-bl) { color: #3af; }');
    lines.push('::cue(.c-cy) { color: #0ff; }');
    lines.push('::cue(.c-r)  { color: #f33; }');
    lines.push('::cue(.c-y)  { color: #ff0; }');
    lines.push('::cue(.c-ma) { color: #f0f; }');
  }

  return lines.join('\n');
}

function generateVTT(segments, config = {}) {
  const opts = resolveVttOptions(config);

  const sorted = stableSortSegments(segments);
  const cuesOut = [];
  let cueId = 1;

  // Track last cue end to optionally prevent overlaps.
  let lastEndMs = null;

  for (let si = 0; si < sorted.length; si++) {
    const seg = sorted[si];

    const startSecRaw = Number(seg?.start);
    const endSecRaw = Number(seg?.end);
    if (!Number.isFinite(startSecRaw)) continue;

    const startMs0 = Math.max(0, toMs(startSecRaw));

    // Ensure a valid end time.
    let endMs0 = Number.isFinite(endSecRaw) ? Math.max(0, toMs(endSecRaw)) : (startMs0 + opts.minCueDurationMs);
    if (endMs0 < 0) endMs0 = 0;

    // Enforce a hard minimum cue duration (one frame at the configured FPS, at minimum).
    // Some parsers/QC tools reject near-zero cues even when start < end by 1ms.
    const minEnd0 = startMs0 + opts.minCueDurationMs;
    if (endMs0 < minEnd0) endMs0 = minEnd0;

    // Clamp overly long cues if not strict timing.
    if (Number.isFinite(opts.maxCueDurationMs) && opts.maxCueDurationMs !== Infinity) {
      const maxEnd = startMs0 + opts.maxCueDurationMs;
      if (!opts.strictTiming && endMs0 > maxEnd) endMs0 = maxEnd;
    }

    // Prevent overlaps (start clamp) if requested.
    let startMs = startMs0;
    let endMs = endMs0;
    if (opts.preventOverlaps && lastEndMs != null && startMs < lastEndMs) {
      startMs = lastEndMs;
      const minEnd = startMs + opts.minCueDurationMs;
      if (endMs < minEnd) endMs = minEnd;
    }

    // Look ahead for the next segment start (used for safe end-extension into gaps).
    let nextStartMs0 = null;
    if (si + 1 < sorted.length) {
      const ns = Number(sorted[si + 1]?.start);
      if (Number.isFinite(ns)) nextStartMs0 = Math.max(0, toMs(ns));
    }

    // Clean + normalize text.
    let rawText = String(seg?.text ?? '');
    if (rawText && rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);
    rawText = normalizeNewlines(rawText).trim();
    if (!rawText) continue;

    const rawLines = rawText.split('\n');
    const paragraphs = [];
    const placement = { row: null, col: null };

    for (const rawLine of rawLines) {
      const ln0 = String(rawLine || '');
      if (!ln0.trim()) continue;

      const pulled = pullPlacementTags(ln0);
      if (placement.row == null && pulled.row != null && Number.isFinite(Number(pulled.row))) placement.row = Number(pulled.row);
      if (placement.col == null && pulled.col != null && Number.isFinite(Number(pulled.col))) placement.col = Number(pulled.col);

      // Strip control tags but optionally preserve 608 style tokens for translation.
      const stripped = stripInternalTags(pulled.text, { preserve608Styles: opts.translate608Styles });

      if (opts.translate608Styles) {
        const ex = extract608StylesFromLine(stripped);
        const cleaned = normalizeNewlines(ex.text).replace(/\n+/g, ' ').replace(/[\t ]+/g, ' ').trim();
        if (cleaned) paragraphs.push({ text: cleaned, style: ex.style });
      } else {
        const cleaned = normalizeNewlines(stripped).replace(/\n+/g, ' ').replace(/[\t ]+/g, ' ').trim();
        if (cleaned) paragraphs.push({ text: cleaned, style: defaultStyle() });
      }
    }

    if (!paragraphs.length) continue;

    const speakerRaw = (typeof seg?.speaker === 'string') ? seg.speaker : '';
    const speaker = (opts.includeSpeakerNames && speakerRaw) ? formatSpeaker(speakerRaw, opts.speakerLabelStyle) : '';

    const speakerPrefix = speaker ? `${speaker}:` : '';

    // Speaker label cohesion (Phase 2): reserve space on the first line for "SPEAKER:".
    let speakerInline = false;
    let firstLineLimit = null;

    if (speakerPrefix) {
      const reserved = measureChars(speakerPrefix) + 1; // +1 for space after colon
      if (reserved < opts.maxCharsPerLine) {
        speakerInline = true;
        firstLineLimit = Math.max(1, opts.maxCharsPerLine - reserved);
      }
    }

    let lines = wrapParagraphsToLineObjects(paragraphs, opts.maxCharsPerLine, firstLineLimit);
    if (!Array.isArray(lines) || !lines.length) continue;

    if (speakerPrefix && !speakerInline) {
      // Extremely long speaker label: put label on its own line (still valid, best-effort).
      lines = [{ text: speakerPrefix, style: defaultStyle(), _speakerLabel: true }, ...lines];
    }

    // Readability timing assist (Phase 2): try to extend cue end into available gap.
    // This can reduce CPS and avoid ultra-short cues, without creating overlaps.
    if (opts.allowTimeExtension && !opts.strictTiming) {
      const measureLines = lines.map((ln, idx) => {
        if (speakerInline && idx === 0 && speakerPrefix) return `${speakerPrefix} ${ln.text}`;
        return ln.text;
      });

      const visibleJoined = measureLines.join(' ');
      const charCount = Math.max(0, countCharsNoSpace(visibleJoined));
      const durMs = Math.max(opts.minCueDurationMs, endMs - startMs);

      const requiredForCpsMs = (opts.maxCps && opts.maxCps > 0)
        ? Math.ceil((charCount / opts.maxCps) * 1000)
        : 0;

      const targetDurMs = Math.max(durMs, opts.minReadableCueDurationMs, requiredForCpsMs);

      // Respect max cue duration.
      const maxDurMs = Number.isFinite(opts.maxCueDurationMs) ? opts.maxCueDurationMs : Infinity;
      const cappedTargetDurMs = Math.min(targetDurMs, maxDurMs);

      if (cappedTargetDurMs > durMs) {
        const needExtra = cappedTargetDurMs - durMs;

        const maxEndByDur = (maxDurMs !== Infinity) ? (startMs + maxDurMs) : Infinity;
        const maxEndByNext = (nextStartMs0 != null) ? nextStartMs0 : Infinity;
        const maxEndByPolicy = endMs + opts.maxEndExtensionMs;

        const hardMaxEnd = Math.min(maxEndByDur, maxEndByNext, maxEndByPolicy);
        const proposedEnd = endMs + needExtra;
        const newEnd = Math.min(proposedEnd, hardMaxEnd);

        if (newEnd > endMs) endMs = newEnd;
      }
    }

    // Break into cue blocks by max line count.
    let chunks = chunkLineObjects(lines, opts.maxLinesPerBlock);

    // If chunking would require more cues than we can allocate even the hard minimum time for,
    // collapse into a single cue block to avoid duplicate/invalid timing.
    const durMsFinal = endMs - startMs;
    if (chunks.length > 1 && durMsFinal < chunks.length * opts.minCueDurationMs) {
      chunks = [lines];
    }

    // Allocate times proportionally to text density.
    const weights = [];
    let globalLineOffset = 0;
    for (const ch of chunks) {
      const texts = ch.map((ln, li) => {
        const g = globalLineOffset + li;
        if (speakerInline && speakerPrefix && g === 0) return `${speakerPrefix} ${ln.text}`;
        return ln.text;
      });
      globalLineOffset += ch.length;
      weights.push(countCharsNoSpace(texts.join(' ')) || 1);
    }

    // Prefer a readability floor for split cues when possible.
    const desiredMinSpan = opts.minSplitCueDurationMs;
    const minSpan = (durMsFinal >= chunks.length * desiredMinSpan)
      ? desiredMinSpan
      : opts.minCueDurationMs;

    let spans = allocateSpansByWeightsMs(startMs, endMs, weights, minSpan);

    // If we refused to split (returned one span) but we have multiple chunks, fall back to hard min.
    if (spans.length !== chunks.length && chunks.length > 1) {
      spans = allocateSpansByWeightsMs(startMs, endMs, weights, opts.minCueDurationMs);
    }

    // If we still can't split safely, collapse.
    if (spans.length !== chunks.length) {
      chunks = [lines];
      spans = [[startMs, endMs]];
    }

    const settings = cueSettingsFromPlacement(placement, opts);

    globalLineOffset = 0;

    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      const span = spans[i] || spans[spans.length - 1];
      let sMs = span[0];
      let eMs = span[1];

      // Final clamp/repair.
      if (opts.preventOverlaps && lastEndMs != null && sMs < lastEndMs) sMs = lastEndMs;
      const minEnd = sMs + opts.minCueDurationMs;
      if (eMs < minEnd) eMs = minEnd;

      // If overlaps are disallowed, do not run past the next segment start.
      // IMPORTANT: If the available window to nextStart is too small to satisfy the minimum cue duration,
      // prefer a valid (min-duration) cue over a near-zero cue that will fail QC/parsers.
      if (opts.preventOverlaps && nextStartMs0 != null && eMs > nextStartMs0) {
        const clampedEnd = nextStartMs0;
        const minDur = opts.minCueDurationMs;

        if (clampedEnd - sMs >= minDur) {
          eMs = clampedEnd;
        } else {
          // Try to pull the start earlier (without overlapping the previous cue) so we can still end at nextStart.
          let candidateStart = clampedEnd - minDur;
          if (lastEndMs != null && candidateStart < lastEndMs) candidateStart = lastEndMs;

          if (clampedEnd - candidateStart >= minDur && candidateStart < clampedEnd) {
            sMs = candidateStart;
            eMs = clampedEnd;
          } else {
            // Cannot fit: keep minimum duration even if this forces a tiny overlap.
            eMs = sMs + minDur;
          }
        }

        if (eMs <= sMs) eMs = sMs + minDur;
      }

      const startLabel = toVttTimestampFromMs(sMs);
      const endLabel = toVttTimestampFromMs(eMs);
      const settingsSuffix = settings ? ` ${settings}` : '';

      const textLines = [];

      for (let li = 0; li < ch.length; li++) {
        const ln = ch[li];
        const g = globalLineOffset + li;

        // Speaker label insertion (only once, at the very beginning of the cue group).
        if (speakerPrefix) {
          if (speakerInline && g === 0) {
            const speakerRendered = renderSpeakerLabel(speakerPrefix, opts);
            const spokenRendered = renderStyledText(ln.text, ln.style, opts);
            textLines.push(spokenRendered ? `${speakerRendered} ${spokenRendered}` : speakerRendered);
            continue;
          }
          if (!speakerInline && g === 0 && (ln._speakerLabel || ln.text === speakerPrefix)) {
            textLines.push(renderSpeakerLabel(speakerPrefix, opts));
            continue;
          }
        }

        textLines.push(renderStyledText(ln.text, ln.style, opts));
      }

      globalLineOffset += ch.length;

      const cueText = sanitizeCueTextMarkup(textLines.join('\n'));

      // Defensive: ensure only supported cue-text tags remain.
      const safeCueText = sanitizeCueTextMarkup(cueText);

      cuesOut.push(
        `${cueId}\n` +
        `${startLabel} --> ${endLabel}${settingsSuffix}\n` +
        `${safeCueText}`
      );
      cueId += 1;

      lastEndMs = eMs;
    }
  }

  const blocks = [];

  if (opts.includeStyleMetadata) {
    blocks.push('NOTE\nGenerated by Lead AE Assist');
    blocks.push(buildStyleBlock(opts));
  }

  blocks.push(...cuesOut);

  // Mandatory blank line after WEBVTT.
  return blocks.length
    ? `WEBVTT\n\n${blocks.join('\n\n')}\n`
    : 'WEBVTT\n\n';
}

module.exports = {
  generateVTT,
  resolveVttOptions,
  resolveVttProfile,
  VTT_PROFILES
};
