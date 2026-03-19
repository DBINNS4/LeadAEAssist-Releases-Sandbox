// modules/sccEncoder.js
'use strict';

const {
  parseTime: parseTimeMs,
  formatTimecode,
  formatTimecodeFromFrames,
  isDropFrameRate,
  secondsToFrames,
  toFrameStart,
  toFrameEnd,
  framesToSeconds,
  framesFromTimecodeLabel,
  timecodeComponentsFromFrames,
  assertLegalDropFrameLabel,
  nominalFrameBase
} = require('../utils/timeUtils');
// NOTE: SCC timing policy added: sccOptions.timeSource ∈ 'auto'|'start'|'df-string'
// NEW: sccOptions.allowNdf (default: false) permits 29.97 NDF SCC

const SCC_MODEL = {
  name: 'CEA-608 Pop-on',
  maxLinesPerCue: 2,
  maxCharsPerLine: 32
};

const DEFAULT_608_GLYPH_MAP = require('./sccGlyphMap').extendedGlyphMap;

// ------------------------ Small text wrappers
function wrapText(text, maxChars, opts = {}) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  const limit = Math.max(1, Number(maxChars) || 32);
  const measure = (opts && typeof opts.measure === 'function')
    ? opts.measure
    : (s => String(s || '').length);
  let current = '';
  for (const word of words) {
    const candidate = current ? (current + ' ' + word) : word;
    if (measure(candidate) > limit) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapTextAndClamp(text, maxChars, maxLines, opts = {}) {
  // Normalize: strip HTML-like tags, condense spaces, map smart quotes -> plain
  const clean = _normalizeForCea608(String(text || ''));
  const limitChars = Math.max(1, Number(maxChars) || 32);
  const limitLines = (maxLines == null) ? null : Math.max(1, Number(maxLines) || 2);
  const overflowPolicyRaw = (opts && typeof opts.overflowPolicy === 'string') ? opts.overflowPolicy : 'truncate';
  const overflowPolicy = String(overflowPolicyRaw || '').trim().toLowerCase() || 'truncate';
  const cueIndex = (opts && Number.isFinite(opts.cueIndex)) ? Number(opts.cueIndex) : null;

  const cueLabel = cueIndex ? `Cue ${cueIndex}` : 'Cue';

  const wrapped = wrapText(clean, limitChars, { measure: (s) => _visible608Length(s) });
  const lineTooLong = wrapped.find(ln => _visible608Length(ln) > limitChars);
  if (lineTooLong && overflowPolicy === 'error') {
    throw new Error(`${cueLabel} exceeds ${limitChars} chars/line. Split the cue or reduce text.`);
  }

  if (!limitLines || wrapped.length <= limitLines) return wrapped.slice(0, limitLines || wrapped.length);

  if (overflowPolicy === 'error') {
    throw new Error(`${cueLabel} exceeds ${limitLines} lines at ${limitChars} chars/line. Split the cue or reduce text.`);
  }
  return wrapped.slice(0, limitLines);
}

// ------------------------ 708 rich-text wrapping (basic styling + placement)
//
// For professional CEA-708 output we preserve basic styling markup in the text stream
// (italics/underline) and wrap based on VISIBLE characters (tags do not count).
//
// Supported (non-rendered) control/styling inputs:
//   - HTML-ish: <i>, </i>, <u>, </u>, <br>
//   - ASS/SSA override blocks: { ... } containing backslash tags (e.g. {\i1}, {\an8})
//
// Placement support (ASS \an1..\an9):
//   Map to a per-cue 708 window anchor override (anchorId + anchorV/H) and a per-cue
//   justify override (left/center/right).
function _decodeBasicEntities708(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function _stripAssOverrideBlocks(s) {
  // Remove ASS/SSA override blocks that contain any backslash tag.
  // Example: {\an8} or {\i1\bord1}
  return String(s || '').replace(/\{[^}]*\\[a-zA-Z][^}]*\}/g, '');
}

function _visible708Length(s) {
  // Visible characters only: remove markup/position tags before measuring.
  let t = String(s || '');
  // Non-rendering placement tags (Rev/CaptionMax-style interop glue): {row:..}{col:..}
  t = t.replace(/\{(?:row|r|col|c)\s*:\s*-?\d+\}/gi, '');
  t = t.replace(/<[^>]*>/g, '');
  t = _stripAssOverrideBlocks(t);
  return Array.from(t).length;
}

function _normalizeForCea708Rich(text) {
  // Keep <i>/<u> tags for styling, but strip other HTML-ish tags.
  let s = String(text || '');
  s = s.replace(/\r\n?/g, '\n');
  s = _decodeBasicEntities708(s);

  // Normalize common "line break" tag variants.
  s = s.replace(/<br\s*\/?>/gi, '\n');

  // Strip all HTML tags except italics/underline.
  s = s.replace(/<(?!\/?(?:i|u)\b)[^>]*>/gi, '');

  // Normalize “smart” punctuation to plain equivalents.
  s = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/•/g, '*')
    .replace(/`/g, "'")
    .replace(/∼/g, '~');

  // Collapse internal whitespace per line, preserve explicit newlines.
  s = s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n');

  // Trim outer blank lines.
  s = s.replace(/^\n+/, '').replace(/\n+$/, '');
  return s;
}

function _assAnTo708WindowOverride(an) {
  const n = Number(an) | 0;
  // Use a small safe-margin rather than hugging the edge.
  const TOP = 10, MID = 50, BOT = 90;
  const LEFT = 10, CTR = 50, RIGHT = 90;

  // CTA-708 anchorId grid assumption:
  //   0 UL, 1 UC, 2 UR, 3 ML, 4 MC, 5 MR, 6 LL, 7 LC, 8 LR
  const map = {
    1: { anchorId: 6, anchorV: BOT, anchorH: LEFT,  justify: 'left' },
    2: { anchorId: 7, anchorV: BOT, anchorH: CTR,   justify: 'center' },
    3: { anchorId: 8, anchorV: BOT, anchorH: RIGHT, justify: 'right' },
    4: { anchorId: 3, anchorV: MID, anchorH: LEFT,  justify: 'left' },
    5: { anchorId: 4, anchorV: MID, anchorH: CTR,   justify: 'center' },
    6: { anchorId: 5, anchorV: MID, anchorH: RIGHT, justify: 'right' },
    7: { anchorId: 0, anchorV: TOP, anchorH: LEFT,  justify: 'left' },
    8: { anchorId: 1, anchorV: TOP, anchorH: CTR,   justify: 'center' },
    9: { anchorId: 2, anchorV: TOP, anchorH: RIGHT, justify: 'right' }
  };
  return map[n] || null;
}

function _extractAssAlignment(text) {
  // Find an ASS \an# tag anywhere inside an override block, even if combined with other tags.
  // Example: {\an8\i1} ... or {\i1\an8} ...
  const m = /\{[^}]*\\an([1-9])[^}]*\}/i.exec(String(text || ''));
  if (!m) return { text: String(text || ''), window: null, justify: null };

  const override = _assAnTo708WindowOverride(m[1]);
  if (!override) return { text: String(text || ''), window: null, justify: null };

  // Remove ONLY the \an# portion; keep other tags (e.g., \i1) intact for styling.
  let stripped = String(text || '').replace(/\\an[1-9]/ig, '');
  // Clean up any now-empty override blocks (e.g. "{}" or "{\}")
  stripped = stripped.replace(/\{\s*\\?\s*\}/g, '');

  const { justify, ...window } = override;
  return { text: stripped, window: { rel: true, ...window }, justify };
}

function wrapTextAndClamp708Rich(text, maxChars, maxLines, opts = {}) {
  const limitChars = Math.max(1, Number(maxChars) || 32);
  const limitLines = (maxLines == null) ? null : Math.max(1, Number(maxLines) || 2);

  const overflowPolicyRaw = (opts && typeof opts.overflowPolicy === 'string') ? opts.overflowPolicy : 'truncate';
  const overflowPolicy = String(overflowPolicyRaw || '').trim().toLowerCase() || 'truncate';

  const overflowCtx = (opts && typeof opts.overflowCtx === 'object') ? opts.overflowCtx : {};
  const cueIndex = Number.isFinite(overflowCtx?.cueIndex) ? Number(overflowCtx.cueIndex) : null;
  const cueLabel = cueIndex ? `Cue ${cueIndex}` : 'Cue';

  const extracted = _extractAssAlignment(text);

  // Optional per-cue pen location tags for true row/col placement (SPL):
  //   {row:12}{col:4}Hello
  //   {r:12}{c:4}Hello
  // These tags are removed from the rendered text and returned as `pen`.
  let pen = null;
  try {
    const pulled = _pullPlacementTags(String(extracted.text || '').trimStart());
    if (pulled && (pulled.row != null || pulled.col != null)) {
      pen = { row: pulled.row, col: pulled.col };
      extracted.text = pulled.text;
    }
  } catch { /* ignore */ }
  const clean = _normalizeForCea708Rich(extracted.text);

  if (!clean.trim()) return { lines: [], window: extracted.window, justify: extracted.justify, pen };

  // Respect explicit line breaks: wrap each paragraph separately.
  const paragraphs = clean.split('\n');
  const wrappedAll = [];
  for (const para of paragraphs) {
    const p = String(para || '').trim();
    if (!p) continue;
    const wrapped = wrapText(p, limitChars, { measure: _visible708Length });
    wrappedAll.push(...wrapped);
  }

  const lineTooLong = wrappedAll.find(ln => _visible708Length(ln) > limitChars);
  if (lineTooLong && overflowPolicy === 'error') {
    throw new Error(`${cueLabel} exceeds ${limitChars} chars/line. Split the cue or reduce text.`);
  }

  if (!limitLines || wrappedAll.length <= limitLines) {
    return { lines: wrappedAll.slice(0, limitLines || wrappedAll.length), window: extracted.window, justify: extracted.justify, pen };
  }

  if (overflowPolicy === 'error') {
    throw new Error(`${cueLabel} exceeds ${limitLines} lines at ${limitChars} chars/line. Split the cue or reduce text.`);
  }

  return { lines: wrappedAll.slice(0, limitLines), window: extracted.window, justify: extracted.justify, pen };
}


// Duplicate helper for SCC redundancy
function maybeDup(word, repeat) {
  return repeat ? [word, word] : [word];
}

// Map a desired start column (0..31) to a legal 608 indent nibble (0..7)
function _colToIndentNibble(col) {
  const c = Math.max(0, Math.min(31, Math.floor(Number(col) || 0)));
  return Math.min(7, Math.floor(c / 4));
}

function _normalizeAlignment(align) {
  let a = String(align || '').trim().toLowerCase();
  if (a === 'centre') a = 'center';
  if (a !== 'left' && a !== 'center' && a !== 'right') return '';
  return a;
}

function _normalizeMccCompatibilityMode(mode) {
  const raw = String(mode || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'nle' || raw === 'edit' || raw === 'editor') return 'nle';
  if (raw === 'broadcast' || raw === 'bcast' || raw === 'tx') return 'broadcast';
  if (raw === 'strict' || raw === 'qc') return 'strict';
  return '';
}

// Broadcast/title-safe defaults.
// Most NLEs (Premiere included) render 608 "col 0" flush to the edge.
// A 2-col inset on both sides gives a 28-col safe width (≈ 90% title safe).
function _normalizeSafeMargins(safe) {
  // Allow explicit opt-out: safeMargins === false → legacy full-width behavior.
  if (safe === false) return { left: 0, right: 0, width: 32 };

  // Accept already-normalized objects ({left,right,width}) without recomputing.
  if (safe && typeof safe === 'object' && Number.isFinite(safe.left) && Number.isFinite(safe.right) && Number.isFinite(safe.width)) {
    return safe;
  }

  let left = 0;
  let right = 0;
  if (safe && typeof safe === 'object') {
    if (Number.isFinite(safe.left)) left = safe.left;
    if (Number.isFinite(safe.right)) right = safe.right;
  }

  left = Math.max(0, Math.min(31, Math.floor(Number(left) || 0)));
  right = Math.max(0, Math.min(31, Math.floor(Number(right) || 0)));

  // Keep at least 1 usable column (and avoid negative widths).
  if ((left + right) > 31) {
    // Prefer reducing the right margin first.
    const over = (left + right) - 31;
    right = Math.max(0, right - over);
    if ((left + right) > 31) {
      left = Math.max(0, left - ((left + right) - 31));
    }
  }

  const width = Math.max(1, 32 - left - right);
  return { left, right, width };
}

function _startColForAlignment(text, align, safeMargins) {
  const a = _normalizeAlignment(align) || 'left';
  const len = _visible608Length(text);
  const safe = _normalizeSafeMargins(safeMargins);
  const usable = Math.max(1, Math.min(32, safe.width));
  const free = Math.max(0, usable - len);

  let startCol = (a === 'center') ? (safe.left + Math.floor(free / 2))
    : (a === 'right') ? (safe.left + free)
    : safe.left;

  // Clamp so we never run past the right safe edge.
  const maxStart = Math.max(0, 32 - safe.right - len);
  startCol = Math.max(0, Math.min(maxStart, startCol));

  return Math.max(0, Math.min(31, startCol));
}

function _clampStartColToSafe(startCol, text, safeMargins) {
  const safe = _normalizeSafeMargins(safeMargins);
  const len = Math.max(0, _visible608Length(text));
  const minStart = safe.left;
  const maxStart = Math.max(minStart, safe.left + safe.width - len);
  const requested = Math.floor(Number(startCol) || 0);
  const clamped = Math.max(minStart, Math.min(maxStart, requested));
  return { requested, clamped, minStart, maxStart, len, safe };
}

function _splitIndentAndTab(col) {
  const c = Math.max(0, Math.min(31, Math.floor(Number(col) || 0)));
  const indentNibble = Math.min(7, Math.floor(c / 4));
  const tabRemainder = c - (indentNibble * 4);
  return { indentNibble, tabRemainder };
}

// Pull optional placement tags like {col:12} {row:15} from the start of a line
function _pullPlacementTags(s) {
  let text = String(s || '');
  let row = null, col = null;
  // Allow multiple tags in any order at the beginning of the line
  while (true) {
    const m = text.match(/^\{\s*(row|r|col|c)\s*:\s*([0-9]{1,2})\s*\}\s*/i);
    if (!m) break;
    if (m[1].toLowerCase() === 'row' || m[1].toLowerCase() === 'r') row = Number(m[2]);
    else                               col = Number(m[2]);
    text = text.slice(m[0].length);
  }
  return { text, row, col };
}

// ------------------------ Parity + text encoding (CEA-608)
//
// CEA-608 is *not* ASCII. Some printable ASCII codepoints map to accented
// letters/symbols in 608 (e.g. 0x2A displays "á", not "*").
// We must encode characters using the CEA-608 tables.

function _isSecond608Channel(channel) {
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  return ch === 2 || ch === 4;
}

// Single-byte CEA-608 "exceptions" (bytes that do NOT match ASCII)
const CEA608_ASCII_EXCEPTION_BYTES = new Set([0x2A, 0x5C, 0x5E, 0x5F, 0x60, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F]);
const CEA608_SINGLE_BYTE_UNICODE = {
  'á': 0x2A,
  'é': 0x5C,
  'í': 0x5E,
  'ó': 0x5F,
  'ú': 0x60,
  'ç': 0x7B,
  '÷': 0x7C,
  'Ñ': 0x7D,
  'ñ': 0x7E,
  '█': 0x7F
};

function _normalizeForCea608(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(/\r\n?/g, '\n');
  // SCC/608 cannot carry HTML tags. Also, _visible608Length() already ignores <...>
  // for layout, so leaving tags here causes layout != encoded output.
  s = s.replace(/<[^>]*>/g, '');
  // Strip ASS/SSA override blocks (e.g. {\an8}, {\i1}). 608 cannot carry them.
  s = _stripAssOverrideBlocks(s);
  s = s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/`/g, "'")
    .replace(/~/g, '∼');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ------------------------ 608 derivation helpers (MCC true708 pipeline)
//
// These helpers build a derived CEA-608 fallback from canonical (708) text
// without mutating the canonical cue text.

function _stripSccPlacementTags(text) {
  // Strip editor placement tags like {row:10}{col:5}{pac:...}. 608 fallback does not carry them.
  return String(text || '').replace(/(?:\{(?:row|r|col|c|pac)\s*:[^}]+\})+/gi, '');
}

/**
 * Wrap/clamp text for 608 (32 cols, 2 lines) while respecting explicit "\n" line breaks.
 * Returns both the clamped lines and metadata about truncation/overflow.
 */
function wrapTextAndClamp608WithMeta(inputText, opts = {}) {
  const maxCols = Number.isFinite(Number(opts.maxCols))
    ? Math.max(1, Math.min(32, Math.trunc(Number(opts.maxCols))))
    : 32;
  const maxLines = Number.isFinite(Number(opts.maxLines))
    ? Math.max(1, Math.min(2, Math.trunc(Number(opts.maxLines))))
    : 2;

  const allowExplicitLineBreaks = (opts.allowExplicitLineBreaks !== false);

  const overflowPolicyRaw = (opts && typeof opts.overflowPolicy === 'string') ? opts.overflowPolicy : 'truncate';
  const overflowPolicy = String(overflowPolicyRaw || '').trim().toLowerCase() || 'truncate';

  const cueIndex = Number.isFinite(Number(opts.cueIndex)) ? Number(opts.cueIndex) : null;
  const cueLabel = (cueIndex != null) ? `Cue ${cueIndex}` : 'Cue';

  // Text shaping preferences (608): optional, but defaults are “post safe”.
  // Allow caller to pass either at the top-level or nested under opts.wrap / opts.wrap608.
  const wrapCfg = (opts && typeof opts === 'object')
    ? ((opts.wrap608 && typeof opts.wrap608 === 'object') ? opts.wrap608
      : ((opts.wrap && typeof opts.wrap === 'object') ? opts.wrap : null))
    : null;

  const _bool = (key, defVal) => {
    const v = (wrapCfg && wrapCfg[key] != null) ? wrapCfg[key] : opts[key];
    return (v === undefined || v === null) ? defVal : !!v;
  };

  const smartWrap = _bool('smartWrap', true);
  const hyphenateLongWords = _bool('hyphenateLongWords', true);
  const dontSplitNumbersTimecodes = _bool('dontSplitNumbersTimecodes', true);
  const avoidLeadingPunctuation = _bool('avoidLeadingPunctuation', true);
  const preferKeepSpeakerLabelWithFirstWords = _bool('preferKeepSpeakerLabelWithFirstWords', true);
  const avoidOrphanWords = _bool('avoidOrphanWords', true);
  const keepLastWordWithPunctuation = _bool('keepLastWordWithPunctuation', true);

  let raw = _stripSccPlacementTags(
    String(inputText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  );

  // Optional: ignore explicit line breaks (treat them as spaces).
  if (!allowExplicitLineBreaks) raw = raw.replace(/\n+/g, ' ');

  const clampToCols = (line) => {
    const glyphs = Array.from(String(line || ''));
    if (glyphs.length <= maxCols) return { text: String(line || ''), truncated: false };
    return { text: glyphs.slice(0, maxCols).join(''), truncated: true };
  };

  const normalizeLine = (line) => {
    let t = String(line || '');
    try {
      // Normalize per-line so explicit newlines survive the 608 pipeline.
      t = (typeof _normalizeForCea608 === 'function')
        ? _normalizeForCea608(t)
        : t.replace(/\s+/g, ' ').trim();
    } catch (_e) {
      t = t.replace(/\s+/g, ' ').trim();
    }
    return clampToCols(t);
  };

  const maybeThrow = (meta) => {
    if (overflowPolicy !== 'error') return;
    if (meta && (meta.overflowed || meta.truncated)) {
      const why = meta.truncated
        ? 'text contains a token longer than the max column width'
        : 'text exceeds the max line count';
      throw new Error(`${cueLabel} overflows CEA-608 ${maxCols}x${maxLines} wrap (${why}). Split the cue or shorten text.`);
    }
  };

  // Explicit line breaks are authoritative for 608 overrides/derived text.
  if (allowExplicitLineBreaks && raw.includes('\n')) {
    const parts = raw.split('\n');
    const overflowed = parts.length > maxLines;

    const lines = [];
    let truncated = false;
    for (const p of parts.slice(0, maxLines)) {
      const r = normalizeLine(p);
      lines.push(r.text);
      truncated = truncated || r.truncated;
    }
    while (lines.length < maxLines) lines.push('');
    const meta = { lines, overflowed, truncated, usedExplicitBreaks: true };
    maybeThrow(meta);
    return meta;
  }

  // No explicit breaks -> word wrap.
  let normalized = '';
  try {
    normalized = (typeof _normalizeForCea608 === 'function')
      ? _normalizeForCea608(raw)
      : raw.replace(/\s+/g, ' ').trim();
  } catch (_e) {
    normalized = raw.replace(/\s+/g, ' ').trim();
  }

  const visibleLen = (s) => Array.from(String(s || '')).length;

  const isNumericLike = (token) => {
    const t = String(token || '');
    if (!t) return false;
    const bare = t.replace(/[)\]}'"”.,;:!?]+$/g, '');
    if (!bare) return false;
    // Digits with optional separators (timecodes, decimals, thousands separators, ratios).
    return /^[0-9][0-9:.,/-]*$/.test(bare);
  };

  const isPunctStarter = (line) => {
    const t = String(line || '').trim();
    return !!t && /^[-\u2013\u2014.,;:!?)]/.test(t);
  };

  const isSpeakerLabelToken = (token) => {
    const t = String(token || '').trim();
    if (!t || t.length < 2 || t.length > 24) return false;
    if (!t.endsWith(':')) return false;
    // Must contain at least one letter to avoid treating timecode-ish tokens as labels.
    if (!/[A-Za-z]/.test(t)) return false;
    // Avoid pathological cases like "http:" or "https:".
    if (/^https?:$/i.test(t)) return false;
    return true;
  };

  const words = String(normalized || '').split(' ').filter(Boolean);
  const tokens = [];

  // Basic punctuation de-orphaning: attach stand-alone punctuation to the previous token when safe.
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;

    const punctOnly = /^[()[\]{}"'“”‘’.,;:!?]+$/.test(w);
    const dashOnly = /^-+$/.test(w);

    if (dashOnly && tokens.length) {
      const candidate = `${tokens[tokens.length - 1]} -`;
      if (visibleLen(candidate) <= maxCols) {
        tokens[tokens.length - 1] = candidate;
        continue;
      }
    }

    if (punctOnly && tokens.length) {
      const candidate = `${tokens[tokens.length - 1]}${w}`;
      if (visibleLen(candidate) <= maxCols) {
        tokens[tokens.length - 1] = candidate;
        continue;
      }
    }

    tokens.push(w);
  }

  let truncated = false;

  // Hyphenate long tokens so the 608 track doesn’t silently drop text.
  // Respect numeric/timecode-like tokens when dontSplitNumbersTimecodes is enabled.
  for (let i = 0; i < tokens.length; i++) {
    let t = String(tokens[i] || '');
    if (!t) continue;

    let wroteHead = false;

    // Expand until the current token fits (or we decide to truncate).
    while (visibleLen(t) > maxCols) {
      if (dontSplitNumbersTimecodes && isNumericLike(t)) {
        truncated = true;
        t = Array.from(t).slice(0, maxCols).join('');
        break;
      }

      if (!hyphenateLongWords || maxCols < 2) {
        truncated = true;
        t = Array.from(t).slice(0, maxCols).join('');
        break;
      }

      const glyphs = Array.from(t);
      const head = glyphs.slice(0, maxCols - 1).join('') + '-';
      const rest = glyphs.slice(maxCols - 1).join('');

      tokens[i] = head;
      wroteHead = true;

      // Insert remainder as the next token; it will be processed by subsequent iterations.
      if (rest) tokens.splice(i + 1, 0, rest);
      break;
    }

    if (!wroteHead) tokens[i] = t;
  }

  const outLines = [];
  let overflowed = false;

  if (!tokens.length) {
    const meta = { lines: new Array(maxLines).fill(''), overflowed: false, truncated: false, usedExplicitBreaks: false };
    maybeThrow(meta);
    return meta;
  }

  // Fast path: fits in one line.
  if (maxLines === 1) {
    let cur = '';
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      const candidate = cur ? `${cur} ${w}` : w;
      if (visibleLen(candidate) <= maxCols) {
        cur = candidate;
      } else {
        overflowed = true;
        break;
      }
    }
    outLines.push(cur || '');
    while (outLines.length < maxLines) outLines.push('');
    const meta = { lines: outLines.slice(0, maxLines), overflowed, truncated, usedExplicitBreaks: false };
    maybeThrow(meta);
    return meta;
  }

  // Smart 2-line wrap: choose a breakpoint that avoids orphan words and leading punctuation.
  const speakerLabel = preferKeepSpeakerLabelWithFirstWords && isSpeakerLabelToken(tokens[0]) ? tokens[0] : null;

  // “Hanger” words are function words that look awkward when they end a caption line.
  // Some are worse than others (articles/conjunctions are the big offenders).
  const HARD_HANGERS = new Set([
    'a','an','the','to','of','and','or','but'
  ]);
  const HANGERS = new Set([
    ...Array.from(HARD_HANGERS),
    'for','in','on','at','with','from','by','as','into','onto','over','under','about','before','after','between','through'
  ]);

  const cleanTokenForHanger = (tok) => String(tok || '').toLowerCase().replace(/[^a-z0-9']+/g, '');

  const joinTokens = (arr) => arr.join(' ').trim();

  // If the full caption text already fits on one line, keep it on one line.
  // This prevents “helpful” two-line balancing from splitting very short
  // captions (e.g. “Three, two, four.”) into two lines, which looks wrong
  // and does not match typical broadcast decoders/NLE previews.
  const fullOneLine = joinTokens(tokens);
  if (fullOneLine && visibleLen(fullOneLine) <= maxCols) {
    outLines.push(fullOneLine);
    while (outLines.length < maxLines) outLines.push('');
    const lines = outLines.slice(0, maxLines).map(l => clampToCols(String(l || '')).text);
    // Preserve truncation flags from pre-processing (e.g. long numeric/timecode tokens).
    // This is critical for strict overflowPolicy='error' workflows and QC reporting.
    const meta = { lines, overflowed: false, truncated, usedExplicitBreaks: false };
    maybeThrow(meta);
    return meta;
  }

  let best = null;
  if (smartWrap && tokens.length > 1) {
    for (let cut = 1; cut < tokens.length; cut++) {
      const a = tokens.slice(0, cut);
      const b = tokens.slice(cut);

      const la = joinTokens(a);
      const lb = joinTokens(b);
      const lenA = visibleLen(la);
      const lenB = visibleLen(lb);

      if (lenA > maxCols || lenB > maxCols) continue;

      // Objective: balanced lines, avoid ugly starters/endings.
      // NOTE: We intentionally weight “ending line 1 with a hanger word” heavily.
      // This matches common broadcast caption style guides and reduces QC warnings.
      let score = Math.abs(lenA - lenB);

      if (avoidOrphanWords) {
        // Avoid single-token second lines when we have at least 3 tokens total.
        if (tokens.length >= 3 && b.length === 1) score += 50;
        // Avoid very short lines (caption "orphans").
        if (lenA < 6) score += 25;
        if (lenB < 6) score += 25;

        // Avoid ending line 1 with a hanging function word.
        // (e.g., “... the” / “... in” / “... and”) — those are classic “looks amateur” splits.
        const lastA = cleanTokenForHanger(a[a.length - 1]);
        if (lastA && HANGERS.has(lastA)) {
          score += HARD_HANGERS.has(lastA) ? 90 : 45;
        }
      }

      if (avoidLeadingPunctuation && isPunctStarter(lb)) score += 40;

      if (speakerLabel && cut === 1) score += 100; // never leave the label alone

      if (keepLastWordWithPunctuation) {
        // Avoid ending line 1 with an opening bracket/quote.
        if (/[([{"'“]$/.test(la.trim())) score += 15;
      }

      // Prefer breaks after natural punctuation when it doesn't force overflow.
      // This is a soft preference (small reward).
      if (/[.!?]["')\]]?$/.test(la.trim())) score -= 8;
      else if (/[,;:]["')\]]?$/.test(la.trim())) score -= 4;

      if (!best || score < best.score) best = { cut, score, la, lb };
    }
  }

  if (best) {
    outLines.push(best.la);
    outLines.push(best.lb);
  } else {
    // Fallback: greedy wrap with overflow marking.
    let cur = '';
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      const candidate = cur ? `${cur} ${w}` : w;
      if (visibleLen(candidate) <= maxCols) {
        cur = candidate;
      } else {
        outLines.push(cur);
        cur = w;
        if (outLines.length >= maxLines) {
          overflowed = true;
          cur = '';
          break;
        }
      }
    }
    if (cur && outLines.length < maxLines) outLines.push(cur);

    // If we hit the cap exactly and there are still words, mark overflow.
    if (!overflowed && outLines.length >= maxLines && tokens.length) {
      const used = joinTokens(outLines).trim();
      const orig = joinTokens(tokens).trim();
      if (used && orig && used.length < orig.length) overflowed = true;
    }
  }

  while (outLines.length < maxLines) outLines.push('');
  const lines = outLines.slice(0, maxLines).map(l => clampToCols(String(l || '')).text);

  const meta = { lines, overflowed, truncated, usedExplicitBreaks: false };
  maybeThrow(meta);
  return meta;
}

function wrapTextAndClamp608(inputText, opts = {}) {
  return wrapTextAndClamp608WithMeta(inputText, opts).lines;
}

function _extractCompat608OverrideText(cueOrSeg) {
  if (!cueOrSeg || typeof cueOrSeg !== 'object') return null;

  // Phase 1: per-cue overrides schema
  // Prefer overrides['608'] when present.
  const o = cueOrSeg.overrides;
  if (o && typeof o === 'object') {
    const o608 = o['608'];
    if (o608 && typeof o608 === 'object') {
      if (typeof o608.text === 'string' && o608.text.trim()) return o608.text;
      if (Array.isArray(o608.breaks) && o608.breaks.length) {
        const joined = o608.breaks.map(l => String(l || '')).join('\n');
        if (joined.trim()) return joined;
      }
    }
  }

  const direct = cueOrSeg.compat608Text ?? cueOrSeg.compat608_override ?? cueOrSeg.compat608OverrideText;
  if (typeof direct === 'string' && direct.trim()) return direct;

  const container = cueOrSeg.compat608;
  if (container && typeof container === 'object') {
    if (typeof container.text === 'string' && container.text.trim()) return container.text;
    if (Array.isArray(container.lines) && container.lines.length) {
      const joined = container.lines.map(l => String(l || '')).join('\n');
      if (joined.trim()) return joined;
    }
  }

  if (Array.isArray(cueOrSeg.compat608Lines) && cueOrSeg.compat608Lines.length) {
    const joined = cueOrSeg.compat608Lines.map(l => String(l || '')).join('\n');
    if (joined.trim()) return joined;
  }

  return null;
}

function _extractCompat608OverrideMute(cueOrSeg) {
  if (!cueOrSeg || typeof cueOrSeg !== 'object') return false;

  const o = cueOrSeg.overrides;
  if (!o || typeof o !== 'object') return false;
  const o608 = o['608'];
  if (!o608 || typeof o608 !== 'object') return false;

  return o608.mute === true;
}

function _extractCompat608OverrideParts(cueOrSeg) {
  if (!cueOrSeg || typeof cueOrSeg !== 'object') return null;

  const o = cueOrSeg.overrides;
  if (!o || typeof o !== 'object') return null;
  const o608 = o['608'];
  if (!o608 || typeof o608 !== 'object') return null;

  const raw = o608.parts;
  if (!Array.isArray(raw) || !raw.length) return null;

  const out = [];
  for (const part of raw) {
    if (part == null) continue;

    let t = null;
    if (typeof part === 'string') {
      t = part;
    } else if (part && typeof part === 'object') {
      if (typeof part.text === 'string') t = part.text;
      else if (Array.isArray(part.lines) && part.lines.length) t = part.lines.map(l => String(l ?? '')).join('\n');
      else if (typeof part.value === 'string') t = part.value;
    }

    const s = String(t ?? '').replace(/\r\n?/g, '\n').trim();
    if (s) out.push(s);
  }

  return out.length ? out : null;
}

/**
 * Derive a strict 608 fallback track from canonical cues (no mutation).
 * Returned cues are 608-shaped (32 cols, 2 lines) with overflow/truncation flags.
 */
function derive608CuesFromCanonical(cues = [], rules = {}) {
  // Derive a 608 layout *per canonical cue* (1:1). This is used for mapping/preview and
  // for legacy-style 608 embedding where the cue boundary is the canonical cue boundary.
  const src = Array.isArray(cues) ? cues : [];

  const maxCols = Math.max(1, Math.min(32, Math.floor(Number(rules.maxCols ?? rules.maxCols608 ?? 32) || 32)));
  const maxLines = Math.max(1, Math.min(2, Math.floor(Number(rules.maxLines ?? rules.maxLines608 ?? 2) || 2)));

  // Default for derived-from-canonical: treat explicit "\n" as SOFT and re-wrap for 32x2.
  // (708 editors commonly insert line breaks at 42 cols; using them verbatim causes 608 truncation.)
  let allowExplicitLineBreaks = (rules.allowExplicitLineBreaks === true);

  // Optional 608 shaping options (speaker labels, punctuation, hyphenation).
  // These can be passed as rules.wrap608 / rules.cea608Wrap / rules.textWrap608.
  const wrap608UserRaw = (rules && typeof rules === 'object')
    ? (rules.wrap608 || rules.wrap608Options || rules.textWrap608 || rules.cea608Wrap || rules.textWrap || rules.wrap || null)
    : null;
  const wrap608 = (wrap608UserRaw && typeof wrap608UserRaw === 'object') ? { ...wrap608UserRaw } : null;

  // allowExplicitLineBreaks may also be provided inside wrap config.
  if (wrap608 && wrap608.allowExplicitLineBreaks != null) {
    allowExplicitLineBreaks = (wrap608.allowExplicitLineBreaks !== false);
    delete wrap608.allowExplicitLineBreaks;
  }

  const out = new Array(src.length).fill(null);

  for (let i = 0; i < src.length; i++) {
    const cue = src[i];
    if (!cue) continue;

    const start = Number(cue.start);
    const end = Number(cue.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const sourceCueId = (cue.id != null) ? cue.id : i;
    const overrideText = _extractCompat608OverrideText(cue);

    const baseText = (overrideText != null)
      ? String(overrideText)
      : (Array.isArray(cue.lines) ? cue.lines.join('\n') : String(cue.text || ''));

    if (!baseText || !String(baseText).trim()) continue;

    // Canonical 708 cue text often carries editor-inserted newlines (42-col wrapping).
    // For derived 608 we treat those as soft and re-wrap, but explicit 608 overrides
    // should honor the author's explicit line breaks.
    const allowBreaksForCue = (overrideText != null) ? true : allowExplicitLineBreaks;

    const meta = wrapTextAndClamp608WithMeta(baseText, { maxCols, maxLines, allowExplicitLineBreaks: allowBreaksForCue, ...(wrap608 ? { wrap608 } : {}) });
    const needsReview = !!meta.overflowed || !!meta.truncated;

    out[i] = {
      id: sourceCueId,
      sourceIndex: i,
      sourceCueId,
      start,
      end,
      text: baseText,
      lines: meta.lines,
      overflowed: !!meta.overflowed,
      truncated: !!meta.truncated,
      usedExplicitBreaks: !!meta.usedExplicitBreaks,
      needsReview,
      override: overrideText != null
    };
  }

  return out;
}

function derive608TrackFromCanonical(cues = [], rules = {}) {
  // Milestone 4: derived 608 can auto-split on 32x2 overflow and (optionally) bounded-ripple
  // to satisfy reading-speed constraints. This returns a *flat* list of derived cues.
  //
  // Input cues are expected to contain at least: { start, end, text|lines }, plus optional
  // { id, compat608Text / compat608 } overrides.
  const src = Array.isArray(cues) ? cues : [];

  const qc = (rules && typeof rules === 'object' && rules.qc && typeof rules.qc === 'object') ? rules.qc : null;

  const maxCols = Math.max(1, Math.min(32, Math.floor(Number(rules.maxCols ?? rules.maxCols608 ?? 32) || 32)));
  const maxLines = Math.max(1, Math.min(2, Math.floor(Number(rules.maxLines ?? rules.maxLines608 ?? 2) || 2)));

  const minDurationSec = Math.max(0, Number(qc?.minDurationSec ?? qc?.minDurationSeconds ?? rules.minDurationSec ?? 0.8) || 0.8);
  const minGapSec = Math.max(0, Number(qc?.minGapSec ?? qc?.minGapSeconds ?? rules.minGapSec ?? 0.1) || 0.1);
  const maxCps = Number(qc?.maxCps ?? qc?.maxCPS ?? rules.maxCps ?? rules.maxCPS ?? 20);
  const maxWpm = Number(qc?.maxWpm ?? qc?.maxWPM ?? rules.maxWpm ?? rules.maxWPM ?? 180);

  const preferLinguisticBreaks = (rules.preferLinguisticBreaks !== false);
  const preserveSpeakerBoundaries = (rules.preserveSpeakerBoundaries !== false);
  const avoidOrphanWords = (rules.avoidOrphanWords !== false);

  const allowBoundedRipple = (rules.allowBoundedRipple !== false) && (rules.allowRipple !== false);
  // Defaults match the MCC true708 compat generator: bounded drift, but enough headroom
  // to satisfy common QC targets (min duration / CPS / WPM) on fast dialogue.
  const maxShiftSec = Math.max(0, Number(rules.maxShiftSec ?? rules.maxRippleSec ?? 1.0) || 1.0);
  const maxTotalShiftSec = Math.max(0, Number(rules.maxTotalShiftSec ?? rules.maxTotalRippleSec ?? 6.0) || 6.0);
  const maxPartsPerCue = Math.max(1, Math.min(10, Math.floor(Number(rules.maxPartsPerCue ?? rules.maxParts ?? 4) || 4)));

  // For optional override retiming via timecode strings.
  const fps = Number(rules.fps ?? rules.frameRate ?? 29.97) || 29.97;
  const dropFrameHint = (rules.dropFrame != null) ? (rules.dropFrame === true) : null;
  const _resolveOverrideSeconds = (value) => {
    if (value == null) return null;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const s = String(value).trim();
    if (!s) return null;
    const ms = parseTimeMs(s, fps, dropFrameHint);
    if (!Number.isFinite(ms)) return null;
    if (ms === 0) {
      const looksZero = /^(0+(?:\.0+)?)$/.test(s) || /^00:00:00(?:[:;.]00)?$/.test(s);
      if (!looksZero) return null;
    }
    return ms / 1000;
  };

  // Derived-from-canonical 608: treat explicit "\n" as SOFT by default and re-wrap.
  // Overrides can still opt into explicit newlines per cue.
  let allowExplicitLineBreaks = (rules.allowExplicitLineBreaks === true);

  // Optional 608 shaping options (speaker labels, punctuation, hyphenation).
  // These can be passed as rules.wrap608 / rules.cea608Wrap / rules.textWrap608.
  const wrap608UserRaw = (rules && typeof rules === 'object')
    ? (rules.wrap608 || rules.wrap608Options || rules.textWrap608 || rules.cea608Wrap || rules.textWrap || rules.wrap || null)
    : null;
  const wrap608 = (wrap608UserRaw && typeof wrap608UserRaw === 'object') ? { ...wrap608UserRaw } : null;

  // allowExplicitLineBreaks may also be provided inside wrap config.
  if (wrap608 && wrap608.allowExplicitLineBreaks != null) {
    allowExplicitLineBreaks = (wrap608.allowExplicitLineBreaks !== false);
    delete wrap608.allowExplicitLineBreaks;
  }

  const HANGERS = new Set([
    'a','an','the','to','of','and','or','but','for','in','on','at','with','from','by','as','into','onto','over','under','about','before','after','between','through'
  ]);

  const cleanTextForCounts = (s) => _normalizeForCea608(_stripSccPlacementTags(String(s || '')));

  const countWords = (s) => {
    const t = cleanTextForCounts(s).trim();
    return t ? t.split(/\s+/).filter(Boolean).length : 0;
  };

  const countCharsNoSpace = (s) => Array.from(cleanTextForCounts(s).replace(/\s+/g, '')).length;

  const requiredDurationSecForText = (s) => {
    const chars = countCharsNoSpace(s);
    const words = countWords(s);
    const cpsReq = (Number.isFinite(maxCps) && maxCps > 0) ? (chars / maxCps) : 0;
    const wpmReq = (Number.isFinite(maxWpm) && maxWpm > 0) ? ((words * 60) / maxWpm) : 0;
    return Math.max(minDurationSec, cpsReq, wpmReq);
  };

  const wrapMeta = (text, allowBreaks = allowExplicitLineBreaks) => wrapTextAndClamp608WithMeta(
    text,
    { maxCols, maxLines, allowExplicitLineBreaks: allowBreaks, ...(wrap608 ? { wrap608 } : {}) }
  );

  const chooseSplit = (text) => {
    const t = cleanTextForCounts(text).trim();
    const words = t ? t.split(/\s+/).filter(Boolean) : [];
    if (words.length < 2) return [String(text || ''), ''];

    const candidates = [];
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1] || '';
      const prevClean = prev.toLowerCase().replace(/[^a-z0-9']+/g, '');
      const isSentenceEnd = /[.!?]["')\]]?$/.test(prev);
      const isClauseEnd = /[;:]["')\]]?$/.test(prev);
      const isComma = /[,]["')\]]?$/.test(prev);

      let score = Math.abs((i / words.length) - 0.5);
      if (preferLinguisticBreaks) {
        if (isSentenceEnd) score -= 0.25;
        else if (isClauseEnd) score -= 0.18;
        else if (isComma) score -= 0.10;
      }

      if (avoidOrphanWords && HANGERS.has(prevClean)) score += 0.35;
      if (i < 2 || (words.length - i) < 2) score += 0.40;

      candidates.push({ i, score });
    }

    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0]?.i ?? Math.floor(words.length / 2);

    const left = words.slice(0, best).join(' ').trim();
    const right = words.slice(best).join(' ').trim();
    return [left, right];
  };

  const splitToFit = (text) => {
    const parts = [String(text || '').trim()].filter(Boolean);
    let guard = 0;

    while (guard++ < 200) {
      let idxToSplit = -1;
      let worst = -1;

      for (let i = 0; i < parts.length; i++) {
        const meta = wrapMeta(parts[i]);
        const bad = !!(meta.overflowed || meta.truncated);
        if (!bad) continue;

        const size = countCharsNoSpace(parts[i]);
        if (size > worst) {
          worst = size;
          idxToSplit = i;
        }
      }

      if (idxToSplit < 0) break;
      if (parts.length >= maxPartsPerCue) break;

      const target = parts[idxToSplit];
      const [a, b] = chooseSplit(target);
      if (!b || !String(b).trim()) break;

      parts.splice(idxToSplit, 1, a.trim(), b.trim());
    }

    return parts.filter(p => String(p).trim().length > 0);
  };

  const allocateWithinWindow = (start, end, partTexts, sourceCtx = {}) => {
    const windowDur = Math.max(0, (Number(end) || 0) - (Number(start) || 0));
    const n = partTexts.length || 1;
    const gapTotal = Math.max(0, (n - 1) * minGapSec);
    const usable = Math.max(0.001, windowDur - gapTotal);

    const reqDur = partTexts.map(t => Math.max(minDurationSec, requiredDurationSecForText(t)));
    const reqSum = reqDur.reduce((a, b) => a + b, 0);

    let alloc = new Array(n).fill(usable / n);
    let needsReview = false;

    if (reqSum <= usable) {
      alloc = reqDur.slice();
      const extra = usable - reqSum;
      if (extra > 0.0001) {
        const denom = Math.max(0.001, reqSum);
        for (let i = 0; i < n; i++) {
          alloc[i] += extra * (reqDur[i] / denom);
        }
      }
    } else {
      needsReview = true;
      const denom = Math.max(0.001, reqSum);
      for (let i = 0; i < n; i++) {
        alloc[i] = Math.max(0.001, usable * (reqDur[i] / denom));
      }
    }

    const out = [];
    let cursor = Number(start) || 0;
    for (let i = 0; i < n; i++) {
      const partStart = cursor;
      const partEnd = (i === n - 1) ? (Number(end) || (partStart + alloc[i])) : (partStart + alloc[i]);
      cursor = partEnd + minGapSec;

      out.push({
        ...sourceCtx,
        start: partStart,
        end: Math.max(partStart + 0.001, partEnd),
        text: partTexts[i],
        requiredDurationSec: reqDur[i],
        needsReview
      });
    }

    return out;
  };

  const derived = [];
  let shiftSec = 0;
  let shiftBudget = maxTotalShiftSec;

  for (let srcIndex = 0; srcIndex < src.length; srcIndex++) {
    const cue = src[srcIndex];
    if (!cue) continue;

    const cueStartCanon = Number(cue.start);
    const cueEndCanon = Number(cue.end);
    if (!Number.isFinite(cueStartCanon) || !Number.isFinite(cueEndCanon) || cueEndCanon <= cueStartCanon) continue;

    // Phase 1.2: optional per-cue 608 retime override.
    const o608 = (cue.overrides && typeof cue.overrides === 'object') ? (cue.overrides['608'] || null) : null;
    // Phase 2: 608-only structural overrides
    //   - mute: suppress 608 output for this canonical cue
    //   - parts: split this canonical cue into multiple 608-only sub-cues
    const overrideMute = _extractCompat608OverrideMute(cue);
    if (overrideMute) continue;
    const overrideParts = _extractCompat608OverrideParts(cue);
    const startOverride = _resolveOverrideSeconds(o608?.start);
    const endOverride = _resolveOverrideSeconds(o608?.end);

    let cueStart = (startOverride != null) ? startOverride : cueStartCanon;
    let cueEnd = (endOverride != null) ? endOverride : cueEndCanon;
    if (!Number.isFinite(cueStart) || !Number.isFinite(cueEnd) || cueEnd <= cueStart) {
      cueStart = cueStartCanon;
      cueEnd = cueEndCanon;
    }

    const sourceCueId = (cue.id != null) ? cue.id : srcIndex;
    // Precedence: mute > parts > text/breaks override.
    // If parts exist, ignore any text/break overrides.
    const overrideText = (overrideParts && overrideParts.length)
      ? null
      : _extractCompat608OverrideText(cue);
    const baseText = (overrideText != null)
      ? String(overrideText)
      : (Array.isArray(cue.lines) ? cue.lines.join('\n') : String(cue.text || ''));

    if (overrideParts && overrideParts.length) {
      // parts already trimmed/validated by the extractor.
    } else {
      if (!baseText || !String(baseText).trim()) continue;
    }

    let start = cueStart + shiftSec;
    let end = cueEnd + shiftSec;

    // Canonical 708 cue text often carries editor-inserted newlines (42-col wrapping).
    // For derived 608 we treat those as soft and re-wrap, but explicit 608 overrides
    // should honor the author's explicit line breaks.
    const allowBreaksForCue = (overrideText != null || (overrideParts && overrideParts.length))
      ? true
      : allowExplicitLineBreaks;

    // Split only when needed (canonical projection only; overrides are authoritative).
    let partTexts = null;
    if (overrideParts && overrideParts.length) {
      partTexts = overrideParts.slice();
    } else {
      const initialMeta = wrapMeta(baseText, allowBreaksForCue);
      partTexts = (overrideText != null)
        ? [baseText]
        : ((initialMeta.overflowed || initialMeta.truncated) ? splitToFit(baseText) : [baseText]);
    }

    // If we still overflow after splitting, accept but flag for review.
    let partMetas = partTexts.map(t => wrapMeta(t, allowBreaksForCue));
    let anyOverflow = partMetas.some(m => m.overflowed || m.truncated);

    // Determine if we have enough time in-window; bounded ripple can extend end a little.
    const partReq = partTexts.map(t => Math.max(minDurationSec, requiredDurationSecForText(t)));
    const needTotal = partReq.reduce((a, b) => a + b, 0) + Math.max(0, (partTexts.length - 1) * minGapSec);
    const windowDur = end - start;

    if (allowBoundedRipple && needTotal > windowDur && shiftBudget > 0) {
      const deficit = needTotal - windowDur;
      const extend = Math.min(deficit, shiftBudget, maxShiftSec || deficit);
      if (extend > 0) {
        end += extend;
        shiftSec += extend;
        shiftBudget -= extend;
      }
    }

    const allocated = allocateWithinWindow(start, end, partTexts, {
      sourceIndex: srcIndex,
      sourceCueId,
      sourceStart: cueStartCanon,
      sourceEnd: cueEndCanon,
      splitCount: partTexts.length,
      override: !!((overrideText != null) || (overrideParts && overrideParts.length))
    });

    for (let p = 0; p < allocated.length; p++) {
      const a = allocated[p];
      const m = wrapMeta(a.text, allowBreaksForCue);

      const needsReview = !!a.needsReview || !!m.overflowed || !!m.truncated || anyOverflow;
      derived.push({
        id: (partTexts.length > 1) ? `${String(sourceCueId)}.${p + 1}` : sourceCueId,
        start: a.start,
        end: a.end,
        text: a.text,
        lines: m.lines,
        overflowed: !!m.overflowed,
        truncated: !!m.truncated,
        sourceIndex: srcIndex,
        sourceCueId,
        splitIndex: p,
        splitCount: partTexts.length,
        override: !!((overrideText != null) || (overrideParts && overrideParts.length)),
        needsReview
      });
    }
  }

  if (preserveSpeakerBoundaries) {
    // No-op: input segmentation already preserves speaker boundaries.
  }

  return derived;
}

function _cea608SingleByteForChar(glyph) {
  if (!glyph) return null;
  const direct = CEA608_SINGLE_BYTE_UNICODE[glyph];
  if (direct != null) return direct;
  if (glyph.length !== 1) return null;
  const code = glyph.charCodeAt(0);
  if (code < 0x20 || code > 0x7F) return null;
  if (CEA608_ASCII_EXCEPTION_BYTES.has(code)) return null;
  return code & 0x7F;
}

function _cea608TwoByteSpecForChar(glyph, extendedGlyphMap) {
  if (!glyph) return null;
  const map = extendedGlyphMap || DEFAULT_608_GLYPH_MAP;
  if (!map) return null;
  return map[glyph] || null;
}

function _fallbackBaseGlyphForTwoByteGlyph(glyph) {
  const base = String(glyph || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  if (base && base.length === 1) return base;
  return ' ';
}

const MIDROW_MAP = {
  Wh: 0x20, WhU: 0x21,
  Gr: 0x22, GrU: 0x23,
  Bl: 0x24, BlU: 0x25,
  Cy: 0x26, CyU: 0x27,
  R:  0x28, RU:  0x29,
  Y:  0x2A, YU:  0x2B,
  Ma: 0x2C, MaU: 0x2D,
  I:  0x2E, // italics on
  // CTA-608 defines italics+underline as a *single* mid-row attribute: 0x2F.
  // Encode this as one code so SCC round-trips cleanly (no expansion).
  IU: 0x2F
};

function midRowWordsForToken(token, channel = 1) {
  const lo = MIDROW_MAP[token];
  if (lo == null) return [];
  const hiData = _isSecond608Channel(channel) ? 0x19 : 0x11; // F1 vs F2
  const { hi, lo: loP } = ensureOddParityPair(hiData, lo & 0x7f);
  const word = ((hi << 8) | loP).toString(16).padStart(4, '0');
  return [word];
}

function setOddParity7(byte) {
  const d = byte & 0x7f;
  let bits = d;
  bits = bits - ((bits >>> 1) & 0x55);
  bits = (bits & 0x33) + ((bits >>> 2) & 0x33);
  bits = (bits + (bits >>> 4)) & 0x0f;
  const ones = bits;
  const parityBit = (ones % 2 === 0) ? 0x80 : 0x00; // make total odd
  return d | parityBit;
}
function ensureOddParityPair(a, b) {
  return { hi: setOddParity7(a), lo: setOddParity7(b) };
}

function encode608Line(line, channel = 1, extendedGlyphMap, {
  strict = true,
  padByte = 0x20,
  onInvalidChar = null,
  fallbackChar = '?'
} = {}) {
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  const isSecond = _isSecond608Channel(ch);
  const s = _normalizeForCea608(line);
  if (!s) return [];

  const words = [];
  let pending = null;
  const invalid = new Set();

  const notifyInvalid = (glyph, replacement) => {
    if (typeof onInvalidChar !== 'function') return;
    try {
      const codePoint = typeof glyph === 'string' && glyph.length ? glyph.codePointAt(0) : null;
      onInvalidChar({ glyph, codePoint, replacement });
    } catch {}
  };

  const pushWord = (a7, b7) => {
    const { hi, lo } = ensureOddParityPair(a7 & 0x7F, b7 & 0x7F);
    words.push(((hi << 8) | lo).toString(16).padStart(4, '0'));
  };

  const pushSingle = (b7) => {
    if (pending == null) pending = (b7 & 0x7F);
    else {
      pushWord(pending, b7);
      pending = null;
    }
  };

  for (const glyph of s) {
    const twoByteSpec = _cea608TwoByteSpecForChar(glyph, extendedGlyphMap);
    if (twoByteSpec) {
      // Two-byte CEA-608 glyphs (Special NA + Extended WE) are transmitted as a control pair.
      // Many decoders implement these by overwriting the *previous* character cell.
      //
      // To prevent accidental spacing shifts, we ensure the byte immediately before the glyph
      // code is exactly ONE placeholder character:
      //  • If we have an unpaired printable byte (`pending`), we pair it with a normal space (0x20)
      //    and let the glyph overwrite that space.
      //  • If we're word-aligned (`pending` is null), we emit a "transparent space" first
      //    (0x11/0x19, 0x39) as the placeholder, then the glyph code.
      //
      // Net result: extended glyphs occupy 1 column, and centering/alignment stays stable.
      const hiData = isSecond ? (twoByteSpec.hiCh2 ?? twoByteSpec.hiF2) : (twoByteSpec.hiCh1 ?? twoByteSpec.hiF1);
      const loData = twoByteSpec.lo;
      if (hiData == null || loData == null) {
        invalid.add(glyph);
        if (strict) continue;
      }

      // Place a single overwriteable placeholder immediately before the glyph code.
      if (pending != null) {
        // Second byte of this word becomes the placeholder.
        pushWord(pending, 0x20);
        pending = null;
      } else {
        // "Transparent space" (Special NA 0x39) used internally for padding/placeholder.
        const hiTS = isSecond ? 0x19 : 0x11;
        pushWord(hiTS, 0x39);
      }

      // Extended glyph code word
      pushWord(hiData, loData);
      continue;
    }

    const b7 = _cea608SingleByteForChar(glyph);
    if (b7 == null) {
      invalid.add(glyph);
      if (strict) continue;
      let replacement = _fallbackBaseGlyphForTwoByteGlyph(glyph);
      if (!replacement || replacement === ' ' || _cea608SingleByteForChar(replacement) == null) {
        replacement = (typeof fallbackChar === 'string' && fallbackChar.length) ? fallbackChar[0] : '?';
      }
      const replB7 = _cea608SingleByteForChar(replacement) ?? 0x20;
      notifyInvalid(glyph, replacement);
      pushSingle(replB7);
    } else {
      pushSingle(b7);
    }
  }

  // SCC words are 2 bytes. If a chunk ends on an odd byte, we must pad.
  // Default padding is a visible space (0x20). For intermediate chunks in
  // styled lines, callers can request a non-printing filler (typically NUL / 0x00)
  // to avoid inserting visible spaces into the rendered caption.
  if (pending != null) pushWord(pending, padByte & 0x7F);

  if (strict && invalid.size) {
    const bad = Array.from(invalid).map(c => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`).join(', ');
    throw new Error(`[CEA-608] Unsupported character(s): ${bad}`);
  }

  return words;
}

// Encode a line that may contain {Wh}/{GrU}/.../{I}/{IU} mid-row tags
function encode608StyledLine(line, channel = 1, extendedGlyphMap, encodeOpts) {
  const parts = String(line || '').split(/\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i];
    if (i % 2 === 1) {
      const repeat = !!(encodeOpts && encodeOpts.repeatControlCodes);
      const midWords = midRowWordsForToken(piece, channel);
      for (const w of midWords) out.push(...maybeDup(w, repeat));
    } else if (piece) {
      // When splitting a line around mid-row attribute tokens, any odd-byte padding
      // inside intermediate chunks must NOT insert a visible space. Use a non-printing
      // filler (commonly NUL / 0x00) for these intermediate chunks so word alignment
      // stays stable without altering displayed text.
      const isIntermediateChunk = i < (parts.length - 1);
      const opts = {
        ...(encodeOpts || {}),
        padByte: isIntermediateChunk ? 0x00 : ((encodeOpts && encodeOpts.padByte) ?? 0x20)
      };
      out.push(...encode608Line(piece, channel, extendedGlyphMap, opts));
    }
  }
  return out;
}

// ------------------------ Control/PAC builders
function ctrl(suffix /* '20','ae','2f',... */, channel = 1) {
  const ch = Math.max(1, Math.min(4, Number(channel) || 1));
  // CC1: 0x14  CC2: 0x1C  CC3: 0x15  CC4: 0x1D
  const isField2 = (ch === 3 || ch === 4);
  const isSecond = _isSecond608Channel(ch);
  const hiData = (isField2 ? 0x15 : 0x14) + (isSecond ? 0x08 : 0x00);
  const loData = (parseInt(String(suffix), 16) & 0x7f) >>> 0;
  const { hi, lo } = ensureOddParityPair(hiData, loData);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function tabOffsetWord(amount = 1, channel = 1) {
  const n = Math.max(1, Math.min(3, amount | 0));
  const hiData = _isSecond608Channel(channel) ? 0x1f : 0x17; // TOx for data channel 1 vs 2
  const loData = 0x20 + n; // 0x21..0x23
  const { hi, lo } = ensureOddParityPair(hiData, loData);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function pacForRow(rowIndex = 15, indentNibble = 0, channel = 1, style = {}) {
  const row = Math.max(1, Math.min(15, Number(rowIndex) || 15));
  const indent = Math.max(0, Math.min(7, Math.floor(indentNibble || 0)));
  const underline = !!style.underline;

  // CTA-608 Table 53: first byte for each row (data channel 1)
  const FIRST_DC1 = {
    1: 0x11, 2: 0x11,
    3: 0x12, 4: 0x12,
    5: 0x15, 6: 0x15,
    7: 0x16, 8: 0x16,
    9: 0x17, 10: 0x17,
    11: 0x10,
    12: 0x13, 13: 0x13,
    14: 0x14, 15: 0x14,
  };

  // Channel mapping: CC2/CC4 uses +0x08 on the first byte.
  const firstBase = FIRST_DC1[row] ?? 0x14;
  const first = (firstBase + (_isSecond608Channel(channel) ? 0x08 : 0x00)) & 0x7f;

  // PAC second byte is NOT "0x40 | indent".
  // It is row-dependent base + (indent * 2) + underline-bit.
  //
  // IMPORTANT (Rev/MaxCaption-grade behavior):
  // Always emit *indent-style* PACs so indentation round-trips on *all* rows.
  //
  // Decoder indentation parsing uses pacIndex >= 0x10, which corresponds to the
  // 0x50–0x5F ("low" row group) and 0x70–0x7F ("high" row group) ranges.
  // If we use 0x40/0x60 for upper rows, indentation is silently lost.
  //
  // "Low/high" is determined by the row mapping (CTA-608 Table 53):
  //   Low rows:  1,3,5,7,9,11,12,14
  //   High rows: 2,4,6,8,10,13,15
  const isLowRowGroup = (row === 11) || (row <= 10 ? (row % 2 === 1) : (row % 2 === 0));
  const base = isLowRowGroup ? 0x50 : 0x70;

  const second = (base + (2 * indent) + (underline ? 1 : 0)) & 0x7f;
  const { hi, lo } = ensureOddParityPair(first, second);
  return ((hi << 8) | lo).toString(16).padStart(4, '0');
}

function _visible608Length(t) {
  // Visible-cell length on the 32-column CEA-608 grid.
  //
  // Important details for "broadcast-QC" correctness:
  //  • Placement tags ({row:x}{col:y}{pac:...}) and {NOP} are not rendered.
  //  • Mid-row attributes ({WhU}, {I}, etc.) occupy one cell on decoders
  //    (they appear as a styled blank). Count them as 1 visible column.
  let s = String(t || '').replace(/<[^>]+>/g, '');
  // Strip known non-visible tags
  s = s.replace(/\{\s*(row|col|pac)\s*:\s*[^}]+\}\s*/gi, '');
  s = s.replace(/\{\s*NOP\s*\}\s*/gi, '');
  // Mid-row attribute tokens are 1 visible cell
  s = s.replace(/\{(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|I|IU)\}/g, ' ');
  // Defensive: strip any other brace-wrapped tokens (non-visible)
  s = s.replace(/\{[^}]+\}/g, '');
  return s.length;
}
function _indentForAlignment(text, align) {
  const startCol = _startColForAlignment(text, align);
  return _splitIndentAndTab(startCol).indentNibble;
}

// ------------------------ Placement audit (for QC)
function computeCea608PlacementAudit(segments, {
  maxCharsPerLine = 32,
  maxLinesPerBlock = 2,
  includeSpeakerNames = false,
  sccOptions = {}
} = {}) {
  const alignment = _normalizeAlignment(sccOptions.alignment) || 'left';
  const policy = sccOptions.rowPolicy || 'bottom2';
  const safe = _normalizeSafeMargins(sccOptions.safeMargins);
  const effectiveMaxChars = Math.min(Math.max(1, Number(maxCharsPerLine) || 32), safe.width);
  const rowPair = policy === '13-14' ? [13, 14]
               : policy === '12-13' ? [12, 13]
               : [14, 15];

  const out = [];
  for (const seg of (segments || [])) {
    if (!seg) { out.push(null); continue; }
    let text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) { out.push(null); continue; }
    if (includeSpeakerNames && seg.speaker) text = `${seg.speaker}: ${text}`;

    const lines = wrapTextAndClamp(text, effectiveMaxChars, maxLinesPerBlock);
    const isSingle = lines.length === 1;
    const linesAudit = [];
    lines.forEach((line, idx) => {
      const startCol = _startColForAlignment(line, alignment, safe);
      const indentNibble = _splitIndentAndTab(startCol).indentNibble;
      // IMPORTANT: match the encoder's default behavior so placement previews/editing
      // don't drift on single-line captions.
      //  • two-line blocks → rowPair[0], rowPair[1]
      //  • single-line blocks → bottom row of the pair by default
      const row = isSingle
        ? (rowPair[1] || rowPair[0] || 15)
        : (rowPair[Math.min(idx, rowPair.length - 1)] || rowPair[0] || 14);
      linesAudit.push({
        index: idx,
        text: line,
        row,
        indentNibble,
        columnStart: startCol
      });
    });
    out.push({ start: seg.start, end: seg.end, timecodes: seg.timecodes, lines: linesAudit });
  }
  return out;
}

// ------------------------ Word builders (POP-ON only)
function build608WordsForPopOn(lines, alignment = 'left', opts = {}) {
  const ch = Math.max(1, Math.min(4, Number(opts.channel) || 1));
  const repeatCtrl = opts.repeatControlCodes !== false;      // default on
  const repeatPac  = opts.repeatPreambleCodes !== false;     // default on
  const placementOverflowPolicy = String(opts.placementOverflowPolicy || 'clamp').toLowerCase();
  const words = [];
  // Optional misc preface (behind flags)
  if (opts.misc && Array.isArray(opts.misc.prefix) && opts.misc.prefix.length) {
    for (const word of opts.misc.prefix) words.push(word);
  }
  // RCL + ENM (duplicated when enabled)
  words.push(...maybeDup(ctrl('20', ch), repeatCtrl)); // RCL
  words.push(...maybeDup(ctrl('2e', ch), repeatCtrl)); // ENM (94AE)
  const policy = opts.rowPolicy || 'bottom2';
  const rowPair = policy === '13-14' ? [13, 14]
               : policy === '12-13' ? [12, 13]
               : [14, 15];
  const normalizedAlign = _normalizeAlignment(alignment) || 'left';
  const safe = _normalizeSafeMargins(opts.safeMargins);
  const placements = lines.map(line => _pullPlacementTags(line));
  const plainLines = placements.map(p => p.text);
  const nonEmpty = plainLines.filter(l => l && l.trim()).length;
  const isSingle = nonEmpty === 1;

  placements.forEach((ovr, idx) => {
    const encoded = encode608StyledLine(
      ovr.text,
      ch,
      opts.extendedGlyphMap,
      {
        strict: opts.strictCharacterEncoding === true,
        onInvalidChar: opts.onInvalidChar,
        fallbackChar: opts.fallbackChar ?? '?'
      }
    );
    if (!encoded.length) return;
    // Default row: honor explicit tags; otherwise:
    //  • two-line blocks → rowPair[0], rowPair[1]
    //  • single-line blocks → bottom of the pair by default
    const rowDefault = isSingle
      ? (rowPair[1] || rowPair[0] || 15)
      : (rowPair[Math.min(idx, rowPair.length - 1)] || rowPair[0] || 14);
    // IMPORTANT:
    // Row placement tags {row:N} must be allowed across the full CEA-608 grid (1..15),
    // not hard-clamped to the title-safe default band (12..15). Title-safe behavior is
    // a *policy/UI default* (rowPolicy), not a file-format limitation.
    let row = Number.isFinite(ovr.row)
      ? Math.max(1, Math.min(15, ovr.row))
      : null;
    if (row == null && typeof opts.getRowForIndex === 'function') {
      const requested = opts.getRowForIndex({ text: ovr.text, index: idx, lines: plainLines, channel: ch });
      if (Number.isFinite(requested)) row = Math.max(1, Math.min(15, Math.trunc(requested)));
    }
    if (row == null) row = rowDefault;
    // Column selection order: explicit callback → {col:N} tag → alignment rule
    let indent = null;
    let tabRemainder = 0;
    let startCol = null;
    if (typeof opts.getColumnStart === 'function') {
      const col = opts.getColumnStart({ text: ovr.text, index: idx, row, lines: plainLines, channel: ch });
      if (Number.isFinite(col)) {
        startCol = Math.floor(col);
      }
    }
    if (startCol == null && Number.isFinite(ovr.col)) {
      startCol = Math.floor(ovr.col);
    }

    if (startCol != null) {
      const clamp = _clampStartColToSafe(startCol, ovr.text, safe);
      if (clamp.clamped !== clamp.requested) {
        if (placementOverflowPolicy === 'error') {
          throw new Error(`[CEA-608] Placement overflow: requested col ${clamp.requested} but must be within [${clamp.minStart}, ${clamp.maxStart}] for line length ${clamp.len}.`);
        }
        if (typeof opts.onPlacementAdjusted === 'function') {
          try {
            opts.onPlacementAdjusted({
              lineIndex: idx,
              row,
              requestedCol: clamp.requested,
              appliedCol: clamp.clamped,
              minCol: clamp.minStart,
              maxCol: clamp.maxStart,
              lineLen: clamp.len,
              safe
            });
          } catch {}
        }
        startCol = clamp.clamped;
      }
      const sp = _splitIndentAndTab(startCol);
      indent = sp.indentNibble;
      tabRemainder = sp.tabRemainder;
    }

    if (indent == null) {
      startCol = _startColForAlignment(ovr.text, normalizedAlign, safe);
      const split = _splitIndentAndTab(startCol);
      indent = split.indentNibble;
      tabRemainder = split.tabRemainder;
    }
    if (indent == null) { indent = 0; }
    if (startCol == null) { startCol = 0; }
    // PAC (duplicated when enabled)
    // NOTE: pacForRow takes INDENT NIBBLE (0..7), not raw columns.
    words.push(...maybeDup(pacForRow(row, indent, ch), repeatPac));
    if (tabRemainder > 0) words.push(...maybeDup(tabOffsetWord(tabRemainder, ch), repeatCtrl));
    words.push(...encoded);
  });

  // EOC (duplicated)
  words.push(...maybeDup(ctrl('2f', ch), repeatCtrl)); // EOC
  if (opts.padEven === true && (words.length % 2) !== 0) {
    const pad = words[words.length - 1] || ctrl('ae', ch); // duplicate EOC/ENM
    words.push(pad);
  }
  return words;
}

// ------------------------ The encoder (CEA‑608 .scc)
function generateSCC(
  segments,
  { 
    fps = 29.97,
    dropFrame = true,
    maxCharsPerLine = 32,
    maxLinesPerBlock = 2,
    serviceNumber: _serviceNumber = 1,
    pen: _pen = null,
    penColor: _penColor = null,
    windowStyle: _windowStyle = null,
    window: _window = null,
    includeSpeakerNames = false,
    sccOptions = {},
    // Optional Start TC offset (e.g., "01:00:00;00"). Applied only when
    // timing is derived from numeric start/msStart (not when anchoring to df-string labels).
    startTc = null,
    startTC = null,
    returnStats = false
  } = {}
) {
  // new: timing policy + eof placement
  const timeSource = (sccOptions && sccOptions.timeSource) || 'auto'; // 'auto'|'start'|'ms'|'df-string'

  // NEW: optional start-of-program reset/clear line.
  // Some pipelines want an initial clear to avoid "ghost captions" on ingest devices.
  // Supported values for sccOptions.startResetAt:
  //   - false / 'off' / 'none' : disabled
  //   - 'zero'                 : emit reset at 00:00:00;00 (or :00 for NDF)
  //   - 'startTc'              : emit reset at Start TC (if provided)
  //   - 'both'                 : emit both (when Start TC exists)
  // Operation controlled by sccOptions.startResetOp: 'edm' (default) or 'rdc'.

  // Start TC offset: used to shift the SCC timeline so the first cue can start at
  // program TC (common broadcast requirement). We keep it opt-in.
  const baseStartTc =
    (typeof startTc === 'string' && startTc.trim())
      ? startTc.trim()
      : (typeof startTC === 'string' && startTC.trim())
        ? startTC.trim()
        : (typeof sccOptions?.startTc === 'string' && sccOptions.startTc.trim())
          ? sccOptions.startTc.trim()
          : (typeof sccOptions?.startTC === 'string' && sccOptions.startTC.trim())
            ? sccOptions.startTC.trim()
            : null;

  const _normalizeStartTc = (tcLabel) => {
    const raw = String(tcLabel || '').trim();
    const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
    if (!m) return raw;
    // SCC delimiter reflects DF vs NDF
    const sep = dropFrame ? ';' : ':';
    return `${m[1]}${sep}${m[2]}`;
  };

  const baseStartTcNorm = baseStartTc ? _normalizeStartTc(baseStartTc) : null;
  let baseOffsetSec = 0;
  if (baseStartTcNorm && timeSource !== 'df-string') {
    // If DF, reject illegal DF positions early.
    if (dropFrame && /;/.test(baseStartTcNorm)) {
      assertLegalDropFrameLabel(baseStartTcNorm, fps);
    }
    baseOffsetSec = parseTimeMs(baseStartTcNorm, fps, /* auto */ null) / 1000;
    if (!Number.isFinite(baseOffsetSec)) baseOffsetSec = 0;
  }

  const allowPreStartTransmit = (sccOptions && sccOptions.allowPreStartTransmit) === true;
  let preStartTransmitSec = Number(sccOptions && sccOptions.preStartTransmitSec);
  if (!Number.isFinite(preStartTransmitSec) || preStartTransmitSec < 0) preStartTransmitSec = 0;
  if (allowPreStartTransmit && preStartTransmitSec === 0) preStartTransmitSec = baseOffsetSec;
  const earliestTxAllowedSec = baseOffsetSec > 0
    ? Math.max(0, baseOffsetSec - preStartTransmitSec)
    : 0;

  // Optional global cue slip / offset (post-production).
  // Supports strings like: -00:00:00:02, +12f, -0.5s
  const timecodeOffsetRaw = (typeof sccOptions?.timecodeOffset === 'string' && sccOptions.timecodeOffset.trim())
    ? sccOptions.timecodeOffset.trim()
    : (typeof sccOptions?.captionOffset === 'string' && sccOptions.captionOffset.trim())
      ? sccOptions.captionOffset.trim()
      : (typeof sccOptions?.offset === 'string' && sccOptions.offset.trim())
        ? sccOptions.offset.trim()
        : null;

  const timecodeOffsetFrames = timecodeOffsetRaw ? _parseCaptionOffsetToFrames(timecodeOffsetRaw, fps) : 0;
  const timecodeOffsetSec = (timecodeOffsetFrames !== 0) ? framesToSeconds(timecodeOffsetFrames, fps) : 0;

  if (!Array.isArray(segments)) return 'Scenarist_SCC V1.0\n';

  const allowNdf = !!(sccOptions && sccOptions.allowNdf);
  // SCC supports both 29.97 DF (';') and 29.97 NDF (':').
  // We keep DF as the default, and only allow NDF when explicitly requested.
  const is2997 = Math.abs((Number(fps) || 0) - 29.97) < 0.05;
  const dfOk = is2997 && dropFrame === true;
  const ndfOk = is2997 && allowNdf && dropFrame === false;
  if (!dfOk && !ndfOk) {
    throw new Error('SCC timing must be 29.97 DF or (opt-in) 29.97 NDF');
  }

  const header = 'Scenarist_SCC V1.0';
  const lines = [header];
  const events = [];

  const alignment = _normalizeAlignment(sccOptions.alignment) || 'left';
  const rowPolicy = sccOptions.rowPolicy || 'bottom2';
  const safe = _normalizeSafeMargins(sccOptions.safeMargins);
  const effectiveMaxChars = Math.min(Math.max(1, Number(maxCharsPerLine) || 32), safe.width);
  // For broadcast deliverables, silent truncation is not acceptable. Default to
  // hard errors unless a caller explicitly opts into truncation.
  const overflowPolicyRaw = (sccOptions && sccOptions.overflowPolicy) ?? null;
  const overflowPolicy = (typeof overflowPolicyRaw === 'string')
    ? overflowPolicyRaw.trim().toLowerCase()
    : 'error';
  // 🔒 hard-lock to pop-on for simplicity & parity with UI
  const ch = Math.max(1, Math.min(4, Number(sccOptions.channel) || 1));

  // Optional program-start reset (EDM/RDC) to prevent ingest devices from
  // displaying stale/"ghost" captions. This is independent of the EOF clear.
  const startResetAtRaw = (sccOptions && sccOptions.startResetAt);
  let startResetAt = (typeof startResetAtRaw === 'string')
    ? startResetAtRaw.trim().toLowerCase()
    : (startResetAtRaw === true ? 'starttc' : (startResetAtRaw === false ? 'off' : ''));

  if (!startResetAt || startResetAt === 'auto') {
    startResetAt = baseStartTcNorm ? 'starttc' : 'zero';
  }
  if (startResetAt === 'starttc' && !baseStartTcNorm) {
    startResetAt = 'zero';
  }
  const startResetOp = (String(sccOptions?.startResetOp || 'edm').toLowerCase() === 'rdc')
    ? '29'  // RDC
    : '2c'; // EDM
  const startResetOpWord = ctrl(startResetOp, ch);
  // A real "reset" for pop-on workflows clears BOTH displayed and non-displayed memory.
  // Emit OP OP ENM ENM (OP = EDM by default, or RDC if explicitly requested).
  const startResetWords = [
    startResetOpWord,
    startResetOpWord,
    ctrl('2e', ch), // ENM
    ctrl('2e', ch)  // ENM
  ];

  // Compute reset time(s)
  const resetTimes = [];
  const wantZero  = (startResetAt === 'zero' || startResetAt === 'both');
  const wantStart = (
    startResetAt === 'starttc' ||
    startResetAt === 'start' ||
    startResetAt === 'program' ||
    startResetAt === 'both'
  );

  if (wantZero) {
    resetTimes.push({ sec: 0, label: formatTimecode(0, dropFrame, fps, 'colon') });
  }

  if (wantStart && baseStartTcNorm) {
    let sec = 0;
    try {
      sec = (parseTimeMs(baseStartTcNorm, fps, null) / 1000) || 0;
    } catch {
      sec = 0;
    }
    resetTimes.push({ sec, label: baseStartTcNorm });
  }

  // De-dupe by label and keep deterministic ordering
  const seenReset = new Set();
  resetTimes
    .filter(r => r && typeof r.label === 'string' && r.label.trim())
    .sort((a, b) => (a.sec || 0) - (b.sec || 0))
    .forEach(r => {
      const key = r.label.trim();
      if (seenReset.has(key)) return;
      seenReset.add(key);
      if (startResetAt !== 'off' && startResetAt !== 'none' && startResetAt !== 'false') {
        events.push({
          kind: 'startReset',
          startFrame: toFrameStart(Number(r.sec) || 0, fps),
          label: key,
          words: startResetWords
        });
      }
    });
  // Default redundancy ON unless explicitly disabled
  const repeatControlCodes  = sccOptions.repeatControlCodes !== false;
  const repeatPreambleCodes = sccOptions.repeatPreambleCodes !== false;
  const frame = 1 / fps;
  const prepared = [];
  let txCursorSec = 0;
  const eocWord = ctrl('2f', ch);
  const edmWord = ctrl('2c', ch);

  let lastStartSec = -Infinity;
  let lastEndSec = -Infinity;
  const metrics = {
    captionsCount: 0,
    longestLineChars: 0,
    durations: [],
    avgDurationSec: 0,

    lateEocCount: 0,
    maxLateEocSec: 0,
    totalLateEocSec: 0,
    lateEocCues: [],

    // Cues whose EOC lands at/after their intended end are effectively unshowable.
    unshowableCueCount: 0,
    maxUnshowableLateSec: 0,
    totalUnshowableLateSec: 0,
    unshowableCues: [],

    mitigatedCount: 0,
    maxMitigationSavedSec: 0,
    warnings: []
  };

  for (const [segIndex, seg] of segments.entries()) {
    if (!seg) continue;
    const rawText = String(seg.text || '').replace(/\r\n?/g, '\n');
    let text = rawText.trim();
    const skipPrefix = /\{NOP\}/i.test(text);
    if (skipPrefix) {
      text = text.replace(/\{NOP\}/ig, ' ').replace(/\s+/g, ' ').trim();
    }
    // Remove leading dash bullets like "- Hello" / "— Hi" / "– Yo"
    if (sccOptions?.stripLeadingDashes) {
      text = text.replace(/^\s*[-–—]{1,2}\s+/, '');
    }
    if (!text) continue;
    const textNoSpeaker = text;
    if (includeSpeakerNames && seg.speaker) text = `${seg.speaker}: ${textNoSpeaker}`;

    const wrapCueText608 = (textForWrap) => {
      // IMPORTANT: preserve explicit line breaks or per-line placement tags so the
      // downstream placement parser can spot them before wrapping.
      const hasExplicit = textForWrap.includes('\n') || /\{\s*(row|col)\s*:\s*\d+\s*\}/i.test(textForWrap);
      const wrapOptsBase = {
        maxCols: effectiveMaxChars,
        overflowPolicy,
        cueIndex: segIndex + 1,
        preserveHyphenation: !!sccOptions?.preserveHyphenation,
        dontSplitNumbersTimecodes: !!sccOptions?.dontSplitNumbersTimecodes
      };

      // NOTE: For SCC export, we want deterministic, *CEA-608 aware* wrapping/clamping.
      // The legacy wrapTextAndClamp() does not actively split or truncate a single token
      // longer than maxCols when overflowPolicy==='truncate', which can lead to silent
      // on-grid clipping during encoding/decoding. wrapTextAndClamp608WithMeta() fixes that.

      return hasExplicit
        ? (() => {
            const explicitLines = textForWrap
              .split('\n')
              .map(s => s.replace(/\s+/g, ' ').trim())
              .map((ln) => {
                const pulled = _pullPlacementTags(ln);
                const meta = wrapTextAndClamp608WithMeta(pulled.text, {
                  ...wrapOptsBase,
                  maxLines: 1,
                  allowExplicitLineBreaks: false
                });
                const clamped = (meta.lines && meta.lines[0]) ? meta.lines[0] : '';
                if (!clamped) return '';
                const rowTag = Number.isFinite(pulled.row) ? `{row:${pulled.row}}` : '';
                const colTag = Number.isFinite(pulled.col) ? `{col:${pulled.col}}` : '';
                return `${rowTag}${colTag}${clamped}`.trim();
              })
              .filter(Boolean);

            if (maxLinesPerBlock && explicitLines.length > maxLinesPerBlock) {
              if (overflowPolicy === 'error') {
                throw new Error(
                  `Cue ${segIndex + 1} exceeds ${maxLinesPerBlock} lines at ${effectiveMaxChars} chars/line. ` +
                  `Split the cue or reduce text.`
                );
              }
              return explicitLines.slice(0, maxLinesPerBlock);
            }
            return explicitLines;
          })()
        : wrapTextAndClamp608WithMeta(textForWrap, {
            ...wrapOptsBase,
            maxLines: maxLinesPerBlock,
            allowExplicitLineBreaks: false
          }).lines;
    };

    const wrapped = wrapCueText608(text);
    if (!wrapped.length) continue;

    metrics.captionsCount += 1;
    const localMax = Math.max(...wrapped.map(_visible608Length));
    if (localMax > metrics.longestLineChars) metrics.longestLineChars = localMax;
    if (typeof seg.start === 'number' && typeof seg.end === 'number') {
      metrics.durations.push(Math.max(0, seg.end - seg.start));
    }

    const invalidGlyphs = [];
    const placementAdjustments = [];

    let words;
    try {
      words = build608WordsForPopOn(wrapped, alignment, {
        safeMargins: safe,
        padEven: !!sccOptions.padEven, channel: ch, rowPolicy,
        repeatControlCodes, repeatPreambleCodes, extendedGlyphMap: sccOptions.extendedGlyphMap,
        strictCharacterEncoding: sccOptions.strictCharacterEncoding,
        placementOverflowPolicy: sccOptions.placementOverflowPolicy,
        onPlacementAdjusted: (info) => { placementAdjustments.push(info); },
        onInvalidChar: (info) => { invalidGlyphs.push(info); },
        fallbackChar: '?'
      });
    } catch (err) {
      const where = `seg#${segIndex} @ ${formatTimecode(Number.isFinite(seg.start) ? (seg.start + baseOffsetSec) : seg.start, dropFrame, fps, 'colon')}`;
      const snippet = String(seg.text || '').slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new Error(`[SCC] Encoding failed (${where}): ${err.message}. Text="${snippet}"`);
    }
    // Optional caption prefix words (skippable with {NOP})
    if (!skipPrefix && Array.isArray(sccOptions.prefixWords) && sccOptions.prefixWords.length) {
      words = [...sccOptions.prefixWords, ...words];
    }

    if (sccOptions?.strictCharacterEncoding !== true && invalidGlyphs.length) {
      const maxGlyphs = 4;
      const render = (g) => {
        const glyph = typeof g?.glyph === 'string' && g.glyph.length ? g.glyph[0] : '?';
        const cp = g?.codePoint ?? (typeof glyph === 'string' && glyph.length ? glyph.codePointAt(0) : null);
        const repl = (typeof g?.replacement === 'string' && g.replacement.length) ? g.replacement[0] : null;
        const cpLabel = cp != null ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : 'unknown';
        const replLabel = repl ? `→ ${JSON.stringify(repl)}` : '';
        return `${JSON.stringify(glyph)} (${cpLabel}${replLabel ? ' ' + replLabel : ''})`;
      };
      const uniq = [];
      for (const g of invalidGlyphs) {
        const key = (typeof g?.glyph === 'string' && g.glyph.length) ? g.glyph : String(g?.glyph ?? '?');
        if (!uniq.includes(key)) uniq.push(key);
      }
      const sample = uniq.slice(0, maxGlyphs).map((key) => {
        const entry = invalidGlyphs.find(g => (typeof g?.glyph === 'string' ? g.glyph === key : String(g?.glyph ?? '?') === key));
        return render(entry || { glyph: key });
      }).join(', ');
      const more = uniq.length > maxGlyphs ? `, +${uniq.length - maxGlyphs} more` : '';
      const note = `[SCC] Cue #${segIndex + 1} replaced unsupported glyphs: ${sample}${more}`;
      console.warn(note);
      if (metrics.warnings.length < 25) metrics.warnings.push(note);
    }

    if (placementAdjustments.length) {
      const adj = placementAdjustments[0];
      const note = `[SCC] Cue #${segIndex + 1} placement adjusted: col ${adj.requestedCol} → ${adj.appliedCol} (safe ${adj.minCol}-${adj.maxCol})`;
      console.warn(note);
      if (metrics.warnings.length < 25) metrics.warnings.push(note);
    }

    // --- choose a source label/seconds from simplified JSON
    const pickJsonLabel = (segment, dropFrameFlag, frameRate) => {
      const t = segment?.timecodes;
      if (!t) return null;
      const preferred = dropFrameFlag
        ? (t.df && t.df.start)
        : (t.ndf && t.ndf.start);
      if (typeof preferred === 'string' && preferred) return preferred;
      const msStart = t.ms?.start;
      if (Number.isFinite(msStart)) {
        return formatTimecode(msStart / 1000, dropFrameFlag, frameRate, 'colon');
      }
      return null;
    };
    const srcTc = pickJsonLabel(seg, dropFrame, fps);
    // If we're anchoring to the DF label string, reject illegal DF positions early.
    if (timeSource === 'df-string' && dropFrame && typeof srcTc === 'string' && /;/.test(srcTc)) {
      assertLegalDropFrameLabel(srcTc, fps);
    }

    let startSecRaw;
    let startWasTcLabel = false;

    if (timeSource === 'ms' && Number.isFinite(seg.msStart)) {
      startSecRaw = seg.msStart / 1000;
    } else if (timeSource === 'start' && Number.isFinite(seg.start)) {
      startSecRaw = seg.start;
    } else if (timeSource === 'df-string' && srcTc) {
      // We will echo the label directly below; still compute seconds for EOF bookkeeping
      startSecRaw = parseTimeMs(srcTc, fps, /* auto */ null) / 1000;
      startWasTcLabel = true;
    } else {
      // 'auto' → prefer numeric start, then msStart, then parse tc string
      if (Number.isFinite(seg.start)) {
        startSecRaw = seg.start;
      } else if (Number.isFinite(seg.msStart)) {
        startSecRaw = seg.msStart / 1000;
      } else if (srcTc) {
        startSecRaw = parseTimeMs(srcTc, fps, /* auto */ null) / 1000;
        startWasTcLabel = true;
      } else {
        startSecRaw = 0;
      }
    }

    let startSec = Number.isFinite(startSecRaw) ? startSecRaw : 0;
    let endSec = null;
    if (timeSource === 'ms') {
      endSec = Number.isFinite(seg.msEnd)
        ? (seg.msEnd / 1000)
        : Number.isFinite(seg.end)
          ? seg.end
          : null;
    } else {
      endSec = Number.isFinite(seg.end)
        ? seg.end
        : Number.isFinite(seg.msEnd)
          ? seg.msEnd / 1000
          : null;
    }

    // Apply optional global cue slip/offset before Start TC offset.
    if (timecodeOffsetSec) {
      startSec += timecodeOffsetSec;
      if (endSec != null) endSec += timecodeOffsetSec;
      if (startSec < 0) startSec = 0;
      if (endSec != null && endSec < 0) endSec = 0;
    }


    // Apply Start TC offset only when we're using numeric timing (not df-string labels).
    if (baseOffsetSec && !startWasTcLabel) {
      startSec += baseOffsetSec;
      if (endSec != null) endSec += baseOffsetSec;
    }

    if (startSec <= lastEndSec) {
      startSec = lastEndSec + frame; // monotonic clamp
    }

    if (endSec == null && Number.isFinite(seg.duration)) {
      endSec = startSec + Number(seg.duration);
    } else if (endSec == null && Number.isFinite(seg.msDuration)) {
      endSec = startSec + (seg.msDuration / 1000);
    }
    if (endSec != null && endSec <= startSec) {
      endSec = startSec + frame;
    }

    lastStartSec = Math.max(lastStartSec, startSec);
    if (Number.isFinite(endSec)) {
      if (endSec > lastEndSec) lastEndSec = endSec;
    } else if (startSec > lastEndSec) {
      lastEndSec = startSec;
    }

    const tcFromSec = formatTimecode(startSec, dropFrame, fps, 'colon');
    if (timeSource === 'df-string' && srcTc && /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(srcTc)) {
      const match = srcTc.match(/^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/);
      if (match) {
        const [, h, m, s, f] = match;
        const labeledTc = `${h}:${m}:${s}${dropFrame ? ';' : ':'}${f}`;
        if (labeledTc !== tcFromSec) {
          console.warn(`[SCC] df-string mismatch @ ${labeledTc} vs ${tcFromSec}`);
        }
      }
    }

    // ── Late-EOC auto-mitigation (Phase E) ───────────────────────────────
    // If we can't pre-transmit enough words before the intended cue start
    // (due to txCursorSec overlap), we try to *shrink the payload* so the
    // ideal transmit start moves later and EOC can land on-time.
    const mit = (sccOptions && typeof sccOptions === 'object' && sccOptions.lateEocMitigation)
      ? sccOptions.lateEocMitigation
      : null;
    const mitEnabled = !!(mit && mit.enabled !== false);
    if (mitEnabled) {
      // Default thresholds: only bother when we're meaningfully late.
      const maxLateSec = Number.isFinite(Number(mit.maxLateSec)) ? Number(mit.maxLateSec) : (1 / fps);
      const allowDisableRedundancy = mit.allowDisableRedundancy !== false;
      const allowDropPrefixWords = mit.allowDropPrefixWords !== false;
      const allowDropSpeakerPrefix = mit.allowDropSpeakerPrefix !== false;
      const allowTruncate = mit.allowTruncate === true;

      // We only know we're late when txCursorSec is already after the ideal pre-roll.
      // But we can *reduce leadWords* so the ideal pre-roll shifts later.
      const maxLeadWordsAllowed = Math.floor((startSec - txCursorSec) / frame);

      // If there's no room at all, mitigation can't help.
      if (maxLeadWordsAllowed >= 0) {
        const baseLead = Math.max(0, words.indexOf(eocWord));
        const baseIdeal = Math.max(0, startSec - (baseLead * frame));
        const baseLate = Math.max(0, txCursorSec - baseIdeal);

        if (baseLate > maxLateSec) {
          // Attempt progressively more aggressive variants until leadWords fit.
          const variants = [];
          variants.push({ name: 'baseline', repeatControlCodes, repeatPreambleCodes, includePrefix: true, dropSpeaker: false });

          if (allowDropPrefixWords) {
            variants.push({ name: 'drop-prefixWords', repeatControlCodes, repeatPreambleCodes, includePrefix: false, dropSpeaker: false });
          }
          if (allowDropSpeakerPrefix && includeSpeakerNames && seg.speaker) {
            variants.push({ name: 'drop-speaker', repeatControlCodes, repeatPreambleCodes, includePrefix: true, dropSpeaker: true });
            if (allowDropPrefixWords) variants.push({ name: 'drop-speaker+prefixWords', repeatControlCodes, repeatPreambleCodes, includePrefix: false, dropSpeaker: true });
          }
          if (allowDisableRedundancy) {
            variants.push({ name: 'no-redundancy', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: true, dropSpeaker: false });
            if (allowDropPrefixWords) variants.push({ name: 'no-redundancy+drop-prefixWords', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: false, dropSpeaker: false });
            if (allowDropSpeakerPrefix && includeSpeakerNames && seg.speaker) {
              variants.push({ name: 'no-redundancy+drop-speaker', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: true, dropSpeaker: true });
              if (allowDropPrefixWords) variants.push({ name: 'no-redundancy+drop-speaker+prefixWords', repeatControlCodes: false, repeatPreambleCodes: false, includePrefix: false, dropSpeaker: true });
            }
          }

          let wrappedNoSpeaker = null;

          const buildWordsVariant = (v) => {
            // Build a candidate payload. When dropping the speaker prefix, we MUST re-wrap;
            // otherwise the speaker text remains baked into `wrapped` and the variant is a no-op.
            let wrappedLines = wrapped;
            if (v.dropSpeaker && includeSpeakerNames && seg && seg.speaker) {
              if (wrappedNoSpeaker == null) wrappedNoSpeaker = wrapCueText608(textNoSpeaker);
              wrappedLines = wrappedNoSpeaker;
            }
            if (!Array.isArray(wrappedLines) || wrappedLines.length === 0) {
              throw new Error('No wrapped lines available for SCC variant encoding.');
            }

            let w = build608WordsForPopOn(wrappedLines, alignment, {
              safeMargins: safe,
              padEven: !!sccOptions.padEven, channel: ch, rowPolicy,
              repeatControlCodes: v.repeatControlCodes, repeatPreambleCodes: v.repeatPreambleCodes,
              extendedGlyphMap: sccOptions.extendedGlyphMap,
              strictCharacterEncoding: sccOptions.strictCharacterEncoding,
              placementOverflowPolicy: sccOptions.placementOverflowPolicy,
              fallbackChar: '?'
            });

            if (v.includePrefix && !skipPrefix && Array.isArray(sccOptions.prefixWords) && sccOptions.prefixWords.length) {
              w = [...sccOptions.prefixWords, ...w];
            }
            return w;
          };

          let best = { words, lead: baseLead, name: 'baseline' };

          for (const v of variants) {
            let candWords;
            try {
              candWords = buildWordsVariant(v);
            } catch {
              continue;
            }
            const lead = Math.max(0, candWords.indexOf(eocWord));
            if (lead < best.lead) best = { words: candWords, lead, name: v.name };
            if (lead <= maxLeadWordsAllowed) {
              best = { words: candWords, lead, name: v.name };
              break;
            }
          }

          // Last-resort: truncate by stripping trailing words (pre-EOC) until leadWords fit.
          // This *will* change the displayed caption, so it's opt-in.
          if (allowTruncate && best.lead > maxLeadWordsAllowed) {
            const eocIdx = Math.max(0, best.words.indexOf(eocWord));
            if (eocIdx > 0) {
              const targetLead = Math.max(0, maxLeadWordsAllowed);
              const keepPre = best.words.slice(0, targetLead);
              // Keep EOC and everything after it (EDM out-time etc) intact.
              const rest = best.words.slice(eocIdx);
              best = { words: [...keepPre, ...rest], lead: targetLead, name: best.name + '+truncate' };
            }
          }

          if (best.words !== words) {
            const oldLead = baseLead;
            const newLead = best.lead;
            const oldIdeal = Math.max(0, startSec - (oldLead * frame));
            const newIdeal = Math.max(0, startSec - (newLead * frame));
            const saved = Math.max(0, newIdeal - oldIdeal);
            metrics.mitigatedCount += 1;
            if (saved > metrics.maxMitigationSavedSec) metrics.maxMitigationSavedSec = saved;

            const note = `[SCC] Late-EOC mitigation applied (cue #${segIndex + 1}): ${best.name} reduced leadWords ${oldLead} → ${newLead} (saved ${saved.toFixed(3)}s pre-roll)`;
            console.warn(note);
            if (metrics.warnings.length < 25) metrics.warnings.push(note);

            words = best.words;
          }
        }
      }
    }

    const leadWords = Math.max(0, words.indexOf(eocWord));
    const idealTxStart = Math.max(0, startSec - (leadWords * frame));
    // ── Broadcast safety clamp ─────────────────────────────────────
    // Do not emit SCC lines earlier than the program Start TC.
    // Some ingest/QC pipelines reject SCC that starts before the base TC.
    let clampedIdealTxStart = idealTxStart;
    if (earliestTxAllowedSec > 0 && idealTxStart < earliestTxAllowedSec) {
      const delta = earliestTxAllowedSec - idealTxStart;
      clampedIdealTxStart = earliestTxAllowedSec;

      const warn = `[SCC] Pre-transmit clamped at program start TC; first caption delayed by ${delta.toFixed(3)}s`;
      console.warn(warn);
      if (metrics.warnings.length < 25) metrics.warnings.push(warn);
    }

    const txStart = Math.max(clampedIdealTxStart, txCursorSec);
    const txEnd = txStart + (words.length * frame);
    const lateSec = Math.max(0, txStart - idealTxStart);
    if (lateSec > frame) {
      metrics.lateEocCount += 1;
      metrics.totalLateEocSec += lateSec;
      if (lateSec > metrics.maxLateEocSec) metrics.maxLateEocSec = lateSec;

      const msg = `[SCC] Not enough transmit room before cue #${segIndex + 1}; EOC may be late by ${lateSec.toFixed(3)}s`;
      // Keep console noise, but also capture a small warning list for returnStats callers.
      console.warn(msg);
      if (metrics.warnings.length < 25) metrics.warnings.push(msg);
    }
    prepared.push({ segIndex, startSec, endSec, txStart, txEnd, words });
    txCursorSec = txEnd;
  }

  // --- Frame-based scheduler so we can interleave EDM with next-cue preload ---
  const secToStartFrame = (sec) => toFrameStart(Number(sec) || 0, fps);
  const secToEndFrame = (sec) => toFrameEnd(Number(sec) || 0, fps);
  const frameToSec = (fr) => framesToSeconds(fr, fps);

  const cues = prepared.map((p, idx) => {
    const startFrame = secToStartFrame(p.startSec);
    const endFrame = Number.isFinite(p.endSec) ? secToEndFrame(p.endSec) : null;
    const txStartFrame = secToStartFrame(p.txStart);
    const leadWords = Math.max(0, p.words.indexOf(eocWord));
    return {
      idx,
      ...p,
      startFrame,
      endFrame,
      leadWords,
      txSegments: [{ startFrame: txStartFrame, words: p.words.slice() }]
    };
  });

  const cueTxEndFrame = (cue) => {
    const last = cue.txSegments[cue.txSegments.length - 1];
    return last.startFrame + last.words.length;
  };
  const shiftCue = (cue, deltaFrames) => {
    if (!deltaFrames) return;
    for (const seg of cue.txSegments) seg.startFrame += deltaFrames;
  };

  // Enforce a hard floor at the start TC for non df-string exports,
  // and also avoid colliding with a start-reset line emitted at that same time.
  const baseOffsetFrame = (baseOffsetSec && timeSource !== 'df-string') ? secToStartFrame(baseOffsetSec) : 0;
  let txFloorFrame = baseOffsetFrame;
  for (const ev of events) {
    if (ev.kind === 'startReset' && ev.startFrame === txFloorFrame) {
      txFloorFrame = Math.max(txFloorFrame, ev.startFrame + (ev.words?.length || 0));
    }
  }

  // Ensure sequential transmit windows (frame-aligned) and obey the floor.
  let cursorFrame = txFloorFrame;
  for (const cue of cues) {
    const start0 = cue.txSegments[0].startFrame;
    if (start0 < cursorFrame) shiftCue(cue, cursorFrame - start0);
    cursorFrame = cueTxEndFrame(cue);
  }

  const safeSplitIndex = (words, idx) => {
    let split = Math.floor(Number(idx) || 0);
    if (split < 0) split = 0;
    if (split > words.length) split = words.length;
    // Avoid splitting inside duplicated control code pairs (same word repeated).
    while (split > 0 && split < words.length && words[split - 1] === words[split]) split -= 1;
    return split;
  };

  const edmEvents = [];
  for (let i = 0; i < cues.length; i++) {
    const cur = cues[i];
    if (cur.endFrame == null) continue;
    const next = cues[i + 1] || null;
    const nextStartFrame = next ? next.startFrame : Infinity;

    // Never schedule an event (including EDM) inside already-occupied transmit frames.
    // In rapid-fire schedules (or when Start TC clamps the first cue), the cue's own
    // transmit window can extend beyond the cue's nominal endFrame.
    const safeMinEdmStart = cueTxEndFrame(cur);
    const desiredEdmStart = cur.endFrame;
    const edmStart = Math.max(desiredEdmStart, safeMinEdmStart);
    const edmEnd = edmStart + 2; // EDM must be duplicated: EDM EDM

    // Minimal policy: if there's no safe gap to clear before the *next cue's show frame*,
    // skip the EDM (the next EOC will replace the display anyway).
    if (Number.isFinite(nextStartFrame) && edmEnd > nextStartFrame) continue;

    edmEvents.push({
      kind: 'edm',
      startFrame: edmStart,
      words: [edmWord, edmWord]
    });

    if (!next) continue;

    // Reuse the computed EDM window.
    const edmStartFrame = edmStart;
    const edmEndFrame = edmEnd;

    // If the next cue's preload overlaps the EDM window, split its transmit into two SCC lines.
    const overlapsEdm = (seg) => seg.startFrame < edmEndFrame && (seg.startFrame + seg.words.length) > edmStartFrame;
    let segIdx = next.txSegments.findIndex(overlapsEdm);
    if (segIdx === -1) continue;

    // Try to compensate the 2-frame pause by shifting the next cue earlier,
    // but never past the end of the previous cue's transmit window or the global base offset.
    const prevTxEnd = cueTxEndFrame(cur);
    const slack = next.txSegments[0].startFrame - prevTxEnd;
    const floorSlack = next.txSegments[0].startFrame - baseOffsetFrame;
    const shiftEarlier = Math.max(0, Math.min(2, slack, floorSlack));
    if (shiftEarlier > 0) shiftCue(next, -shiftEarlier);

    // Re-locate the overlapping segment after the shift.
    segIdx = next.txSegments.findIndex(overlapsEdm);
    if (segIdx === -1) continue;

    const seg = next.txSegments[segIdx];
    const rel = edmStartFrame - seg.startFrame;
    const splitIdx = safeSplitIndex(seg.words, rel);
    const preWords = seg.words.slice(0, splitIdx);
    const postWords = seg.words.slice(splitIdx);

    const newSegs = [];
    if (preWords.length) newSegs.push({ startFrame: seg.startFrame, words: preWords });
    if (postWords.length) newSegs.push({ startFrame: edmEndFrame, words: postWords });
    if (!newSegs.length && seg.words.length) {
      // Worst case: move everything after EDM.
      newSegs.push({ startFrame: edmEndFrame, words: seg.words.slice() });
    }
    next.txSegments.splice(segIdx, 1, ...newSegs);

    // Enforce non-overlap inside this cue after inserting the EDM gap.
    for (let s = 1; s < next.txSegments.length; s++) {
      const prev = next.txSegments[s - 1];
      const prevEnd = prev.startFrame + prev.words.length;
      if (next.txSegments[s].startFrame < prevEnd) next.txSegments[s].startFrame = prevEnd;
    }

    // Propagate any delays to later cues so nothing overlaps.
    for (let k = i + 1; k < cues.length; k++) {
      const prev = cues[k - 1];
      const thisCue = cues[k];
      const minStart = cueTxEndFrame(prev);
      const curStart = thisCue.txSegments[0].startFrame;
      if (curStart < minStart) shiftCue(thisCue, minStart - curStart);
    }
  }

  // Recompute late-EOC metrics after interleaving.
  metrics.lateEocCount = 0;
  metrics.totalLateEocSec = 0;
  metrics.maxLateEocSec = 0;
  metrics.lateEocCues = [];

  // A cue is "unshowable" if its EOC occurs at (or after) its end frame.
  // In that case, the viewer never actually gets a visible caption window.
  metrics.unshowableCueCount = 0;
  metrics.totalUnshowableLateSec = 0;
  metrics.maxUnshowableLateSec = 0;
  metrics.unshowableCues = [];
  for (const cue of cues) {
    let idx = Math.max(0, cue.leadWords);
    let eocFrame = cue.txSegments[0]?.startFrame || 0;
    for (const seg of cue.txSegments) {
      if (idx < seg.words.length) { eocFrame = seg.startFrame + idx; break; }
      idx -= seg.words.length;
    }
    const lateFrames = Math.max(0, eocFrame - cue.startFrame);
    const lateSec = lateFrames * frame;
    if (lateSec > frame) {
      metrics.lateEocCount++;
      metrics.totalLateEocSec += lateSec;
      metrics.maxLateEocSec = Math.max(metrics.maxLateEocSec, lateSec);

      metrics.lateEocCues.push({
        cueIndex: cue.segIndex,
        startTc: formatTimecodeFromFrames(cue.startFrame, dropFrame, fps, 'colon'),
        eocTc: formatTimecodeFromFrames(eocFrame, dropFrame, fps, 'colon'),
        startFrame: cue.startFrame,
        eocFrame,
        lateFrames,
        lateSec
      });
    }

    if (cue.endFrame != null && eocFrame >= cue.endFrame) {
      const unshowableLateFrames = eocFrame - cue.endFrame;
      const unshowableLateSec = unshowableLateFrames * frame;
      metrics.unshowableCueCount++;
      metrics.totalUnshowableLateSec += unshowableLateSec;
      metrics.maxUnshowableLateSec = Math.max(metrics.maxUnshowableLateSec, unshowableLateSec);

      if (metrics.unshowableCues.length < 10) {
        metrics.unshowableCues.push({
          cueIndex: cue.segIndex,
          endTc: formatTimecodeFromFrames(cue.endFrame, dropFrame, fps, 'colon'),
          eocTc: formatTimecodeFromFrames(eocFrame, dropFrame, fps, 'colon'),
          endFrame: cue.endFrame,
          eocFrame,
          unshowableLateFrames,
          unshowableLateSec
        });
      }
    }
  }

  // Flatten scheduled events: startReset + cue segments + EDM + optional EOF, then sort by time.
  const scheduled = [];
  for (const ev of events) scheduled.push(ev);
  for (const cue of cues) {
    for (const seg of cue.txSegments) {
      if (!seg.words || !seg.words.length) continue;
      scheduled.push({ kind: 'tx', startFrame: seg.startFrame, words: seg.words });
    }
  }
  for (const ev of edmEvents) scheduled.push(ev);

  // Optional EOF clear
  // Public option name: appendEOFAt = 'afterLast' | 'atStart' | 'off'
  // Legacy alias: eofPolicy (kept for backward compatibility)
  const _normalizeEofAt = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return '';
    if (s === 'off' || s === 'none' || s === 'false' || s === '0') return 'off';
    if (s === 'atstart' || s === 'start' || s === 'starttc' || s === 'zero') return 'atstart';
    if (s === 'afterlast' || s === 'after' || s === 'end' || s === 'eof') return 'afterlast';
    return s;
  };

  const eofAt = _normalizeEofAt(
    (sccOptions.appendEOFAt != null) ? sccOptions.appendEOFAt : sccOptions.eofPolicy
  );

  if (eofAt && eofAt !== 'off') {
    const minTail = 0.5;
    const desiredEofSec =
      (eofAt === 'atstart')
        ? baseOffsetSec
        : Math.max(lastEndSec + minTail, lastStartSec + 1.0);

    let eofFrame = secToEndFrame(desiredEofSec);
    // Avoid colliding with a program-start reset line at the same frame.
    if (eofAt === 'atstart') eofFrame = Math.max(eofFrame, txFloorFrame);

    const op = (sccOptions.eofOp === 'rdc') ? '29' : '2c'; // RDC or EDM
    const eofWord = ctrl(op, ch);
    scheduled.push({
      kind: 'eof',
      startFrame: eofFrame,
      timeSec: frameToSec(eofFrame),
      label: null,
      words: [eofWord, eofWord]
    });
  }

  scheduled.sort((a, b) => {
    const af = a.startFrame ?? 0;
    const bf = b.startFrame ?? 0;
    if (af !== bf) return af - bf;
    // Stable-ish tiebreaker: keep resets before tx before edm/eof when times match.
    const prio = { startReset: 0, tx: 1, edm: 2, eof: 3 };
    return (prio[a.kind] ?? 9) - (prio[b.kind] ?? 9);
  });

  for (const ev of scheduled) {
    if (!ev.words || !ev.words.length) continue;
    const tc = ev.label || formatTimecodeFromFrames(ev.startFrame, dropFrame, fps, 'colon');
    lines.push(`${tc}\t${ev.words.map(w => String(w).toUpperCase()).join(' ')}`);
  }

  const text = lines.join('\n') + '\n';
  if (metrics.durations.length) {
    metrics.avgDurationSec = metrics.durations.reduce((a, b) => a + b, 0) / metrics.durations.length;
  }
  const avgLateEocSec = metrics.lateEocCount ? (metrics.totalLateEocSec / metrics.lateEocCount) : 0;

  return returnStats ? { scc: text, stats: {
    captionsCount: metrics.captionsCount,
    longestLineChars: metrics.longestLineChars,
    avgDurationSec: metrics.avgDurationSec,
    lateEocCount: metrics.lateEocCount,
    lateEocCues: metrics.lateEocCues,
    mitigatedCount: metrics.mitigatedCount,
    maxMitigationSavedSec: metrics.maxMitigationSavedSec,
    maxLateEocSec: metrics.maxLateEocSec,
    avgLateEocSec,
    warnings: metrics.warnings
  } } : text;
}

// ------------------------ Verifier (odd parity + token sanity)
function _stripSccComments(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\uFEFF/g, '').replace(/\r/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const line of s.split('\n')) {
    const cleaned = line.replace(/\/\/.*$/, '').trim();
    if (!cleaned) continue;
    if (/^Scenarist_SCC\b/i.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out.join('\n');
}

function _firstMeaningfulSccLineInfo(raw) {
  // Used to enforce SCC header presence.
  let s = String(raw || '').replace(/\uFEFF/g, '').replace(/\r/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cleaned = lines[i].replace(/\/\/.*$/, '').trim();
    if (!cleaned) continue;
    return { line: i + 1, text: cleaned };
  }
  return { line: 0, text: '' };
}
const _isTimecodeToken = tok => /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(tok);
const _isHexWord = tok => /^[0-9a-fA-F]{4}$/.test(tok);
function _onesCount(b) { let x = b & 0xff, c = 0; for (let i=0;i<8;i++){ c += x & 1; x >>= 1; } return c; }
function _isOddParity(byte) { return (_onesCount(byte) % 2) === 1; }

function verifySCC(fileOrText, { maxErrors = 50, fps = 29.97, checkTimecode = true, checkOverlap = true, checkMonotonic = true, checkDropFrameLabels = true, requireHeader = true } = {}) {
  const fs = require('fs');
  const path = require('path');

  let source = fileOrText || '';
  let filePath = null;
  try {
    if (typeof source === 'string' && fs.existsSync(source)) {
      filePath = path.resolve(source);
      source = fs.readFileSync(filePath, 'utf8');
    }
  } catch { /* fall through */ }

  const text = _stripSccComments(source);
  const lines = text.split('\n');

  fps = Number(fps) || 29.97;

  let totalWords = 0, checkedBytes = 0, invalidTokens = 0, parityErrors = 0;
  let headerErrors = 0;
  let timecodeErrors = 0, overlapErrors = 0, monotonicErrors = 0;
  let sawSemicolon = false, sawColon = false;
  let prevStartFrame = null;
  let prevLastFrame = null;
  const errors = [];
  let parsedLines = 0;

  // Enforce SCC header presence (first non-empty, non-comment line).
  if (requireHeader) {
    const first = _firstMeaningfulSccLineInfo(source);
    const headerOk = /^Scenarist_SCC\s+V1\.0\b/i.test(String(first.text || '').trim());
    if (!headerOk) {
      headerErrors += 1;
      if (errors.length < maxErrors) {
        errors.push({
          line: first.line || 1,
          timecode: '',
          type: 'header',
          message: 'Missing required SCC header "Scenarist_SCC V1.0" on the first non-comment line.'
        });
      }
    }
  }

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    if (!tokens.length) return;

    const timecode = tokens[0];
    if (!_isTimecodeToken(timecode)) return;

    parsedLines += 1;

    if (timecode.includes(';')) sawSemicolon = true;
    else if (timecode.includes(':')) sawColon = true;

    let startFrame = null;
    if (checkTimecode) {
      try {
        if (checkDropFrameLabels && /;/.test(timecode)) {
          assertLegalDropFrameLabel(timecode, fps);
        }
        startFrame = framesFromTimecodeLabel(timecode, fps);
        if (!Number.isFinite(startFrame)) throw new Error('Unable to parse timecode');
      } catch (e) {
        timecodeErrors += 1;
        if (errors.length < maxErrors) {
          errors.push({
            line: idx + 1,
            timecode,
            type: 'timecode',
            message: e?.message || String(e)
          });
        }
      }
    }

    const words = tokens.slice(1);
    const validWordCount = words.filter(_isHexWord).length;

    if (checkMonotonic && Number.isFinite(startFrame) && prevStartFrame != null && startFrame < prevStartFrame) {
      monotonicErrors += 1;
      if (errors.length < maxErrors) {
        errors.push({
          line: idx + 1,
          timecode,
          type: 'monotonic',
          message: `Timecode is earlier than previous line (${startFrame} < ${prevStartFrame})`
        });
      }
    }

    if (checkOverlap && Number.isFinite(startFrame) && prevLastFrame != null && startFrame <= prevLastFrame) {
      overlapErrors += 1;
      if (errors.length < maxErrors) {
        errors.push({
          line: idx + 1,
          timecode,
          type: 'overlap',
          message: `Line starts at frame ${startFrame} but previous line occupies through frame ${prevLastFrame}`
        });
      }
    }

    if (Number.isFinite(startFrame)) {
      prevStartFrame = startFrame;
      // Each SCC hex word is transmitted on its own frame; last occupied frame is start + (N-1).
      prevLastFrame = startFrame + Math.max(0, validWordCount) - 1;
    }

    for (let w = 0; w < words.length; w++) {
      const tok = words[w];
      if (!_isHexWord(tok)) { invalidTokens += 1; continue; }
      const word = parseInt(tok, 16) & 0xffff;
      const hi = (word >> 8) & 0xff;
      const lo = word & 0xff;

      const hiOk = _isOddParity(hi) && setOddParity7(hi & 0x7f) === hi;
      const loOk = _isOddParity(lo) && setOddParity7(lo & 0x7f) === lo;

      totalWords += 1;
      checkedBytes += 2;

      if (!hiOk || !loOk) {
        parityErrors += (!hiOk ? 1 : 0) + (!loOk ? 1 : 0);
        if (errors.length < maxErrors) {
          if (!hiOk) errors.push({ line: idx + 1, timecode, wordIndex: w + 1, word: tok, which: 'HI', byte: hi });
          if (!loOk) errors.push({ line: idx + 1, timecode, wordIndex: w + 1, word: tok, which: 'LO', byte: lo });
        }
      }
    }
  });

  const mixedDelimiter = sawSemicolon && sawColon;
  if (mixedDelimiter) {
    // Not strictly a parity issue, but broadcast workflows typically expect SCC to be consistently DF (";") or NDF (":").
    timecodeErrors += 1;
    if (errors.length < maxErrors) {
      errors.push({
        line: 0,
        timecode: '',
        type: 'mixed-delimiter',
        message: 'File contains both DF (";") and NDF (":") timecode delimiters'
      });
    }
  }

  const ok =
    (parityErrors === 0) &&
    (invalidTokens === 0) &&
    (headerErrors === 0) &&
    (timecodeErrors === 0) &&
    (monotonicErrors === 0) &&
    (overlapErrors === 0);

  const summary = ok
    ? `OK — ${totalWords} words (${checkedBytes} bytes) • 0 parity errors • 0 invalid tokens • 0 header errors • 0 timecode issues`
    : `FAIL — ${totalWords} words (${checkedBytes} bytes) • ${parityErrors} parity error(s) • ${invalidTokens} invalid tokens • ${headerErrors} header error(s) • ${timecodeErrors} timecode issue(s) • ${monotonicErrors} monotonic issue(s) • ${overlapErrors} overlap issue(s)`;

  return {
    ok,
    file: filePath || undefined,
    totalLines: lines.length,
    parsedLines,
    fps,
    totalWords, checkedBytes,
    invalidTokens, parityErrors, headerErrors, timecodeErrors, monotonicErrors, overlapErrors,
    mixedDelimiter,
    errors, summary
  };
}

// --- MacCaption (.mcc) time code rate label (importer-friendly enumerations)
function _timeCodeRateLabel(fps = 29.97, dropFrame = true) {
  // MCC interoperability: write the *timecode base* as an integer (24/25/30/50/60)
  // and append DF when drop-frame. Do not write decimals like 29.97/23.976 here.
  //
  // Practical mapping:
  //  23.976 -> 24
  //  29.97  -> 30 (or 30DF)
  //  59.94  -> 60 (or 60DF)
  const f = Number(fps);
  let best = 30;
  const bases = [24, 25, 30, 50, 60];
  let bestErr = Infinity;
  for (const b of bases) {
    const e = Math.abs(f - b);
    if (e < bestErr) {
      bestErr = e;
      best = b;
    }
  }
  // Favor common 1000/1001 variants.
  if (Math.abs(f - 23.976) < 0.05) best = 24;
  if (Math.abs(f - 29.97) < 0.06) best = 30;
  if (Math.abs(f - 59.94) < 0.12) best = 60;

  const baseStr = String(best);
  // Only 30/60(/120) have defined DF semantics.
  const dfOk = (best === 30 || best === 60 || best === 120);
  return (dropFrame && dfOk) ? `${baseStr}DF` : baseStr;
}

function _frameRateCode(fps) {
  // Map arbitrary fps to the nearest legal CDP frame-rate code (no 29.97 default).
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return 4; // safe default if caller supplied nonsense
  const table = [
    { code: 1, fps: 23.976 },
    { code: 2, fps: 24.000 },
    { code: 3, fps: 25.000 },
    { code: 4, fps: 29.970 },
    { code: 5, fps: 30.000 },
    { code: 6, fps: 50.000 },
    { code: 7, fps: 59.940 },
    { code: 8, fps: 60.000 }
  ];
  let best = table[0], err = Math.abs(f - table[0].fps);
  for (let i = 1; i < table.length; i++) {
    const e = Math.abs(f - table[i].fps);
    if (e < err) { err = e; best = table[i]; }
  }
  return best.code;
}

function _cdpCapacityForFps(fps, include608 = true) {
  const code = _frameRateCode(fps);
  let maxTriplets;
  if (code === 1 || code === 2) maxTriplets = 25;
  else if (code === 3) maxTriplets = 24;
  else if (code === 4 || code === 5) maxTriplets = 20;
  else if (code === 6) maxTriplets = 12;
  else if (code === 7 || code === 8) maxTriplets = 10;
  else maxTriplets = 31;

  let max608Triplets = 0;
  if (include608) {
    if (code === 6 || code === 7 || code === 8) max608Triplets = 1;
    else max608Triplets = 2;
    max608Triplets = Math.min(max608Triplets, maxTriplets);
  }

  const max708Triplets = Math.max(0, maxTriplets - max608Triplets);
  const maxDtvccPacketBytes = Math.max(2, max708Triplets * 2);
  const maxDtvccPayloadBytes = Math.max(0, maxDtvccPacketBytes - 1);
  const maxServiceBlockDataBytes = Math.min(31, Math.max(0, maxDtvccPayloadBytes - 2));

  return { maxTriplets, max608Triplets, max708Triplets, maxDtvccPacketBytes, maxServiceBlockDataBytes };
}

function _bcd(n) {
  return ((Math.floor(n / 10) & 0x0f) << 4) | (n % 10);
}

function _encodeSmpte12MFromFrames(totalFrames, fps, dropFrame) {
  const { hours, minutes, seconds, frames } = timecodeComponentsFromFrames(totalFrames, dropFrame, fps);
  // SMPTE ST 334-2 CDP time_code_section (0x71 + 4 bytes), packed per Tektronix/CTA-708 diagram:
  //   b1: reserved2='11', tc_10hrs(2), tc_1hrs(4)
  //   b2: reserved1='1',  tc_10min(3), tc_1min(4)
  //   b3: field_flag(1),  tc_10sec(3), tc_1sec(4)
  //   b4: drop_frame(1),  zero(1),     tc_10frm(2), tc_1frm(4)
  const hh = Math.max(0, Math.min(23, Number(hours) || 0));
  const mm = Math.max(0, Math.min(59, Number(minutes) || 0));
  const ss = Math.max(0, Math.min(59, Number(seconds) || 0));
  // frames can be 0..29 (or 0..24 etc). Clamp generously; verifier will catch impossible values.
  const ff = Math.max(0, Math.min(59, Number(frames) || 0));

  const tc10h = (Math.floor(hh / 10) & 0x03);
  const tc1h  = (hh % 10) & 0x0F;
  const tc10m = (Math.floor(mm / 10) & 0x07);
  const tc1m  = (mm % 10) & 0x0F;
  const tc10s = (Math.floor(ss / 10) & 0x07);
  const tc1s  = (ss % 10) & 0x0F;
  const tc10f = (Math.floor(ff / 10) & 0x03);
  const tc1f  = (ff % 10) & 0x0F;

  const fieldFlag = 0; // Progressive/default. (Interlaced workflows may set this externally later.)
  const b1 = (0xC0 | ((tc10h & 0x03) << 4) | tc1h) & 0xFF;
  const b2 = (0x80 | ((tc10m & 0x07) << 4) | tc1m) & 0xFF;
  const b3 = (((fieldFlag & 0x01) << 7) | ((tc10s & 0x07) << 4) | tc1s) & 0xFF;
  const b4 = (((dropFrame ? 1 : 0) << 7) | (0 << 6) | ((tc10f & 0x03) << 4) | tc1f) & 0xFF;

  return [0x71, b1, b2, b3, b4];
}

function _normalizeMccFileFormatVersion(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  // Accept common caller inputs:
  //  - "V1.0" / "1.0" / "1"
  //  - "V2.0" / "2.0" / "2"
  //  - "MacCaption_MCC V1.0" / "MacCaption_MCC V2.0"
  const stripped = raw.replace(/^MacCaption_MCC\s+/i, '').trim();
  const upper = stripped.toUpperCase();
  const withV = upper.startsWith('V') ? upper : `V${upper}`;
  if (withV === 'V1.0' || withV === 'V1') return 'V1.0';
  if (withV === 'V2.0' || withV === 'V2') return 'V2.0';
  return '';
}

function _mccHeader({
  fps,
  dropFrame,
  serviceNumber,
  language,
  creationProgram = null,
  fileFormatVersion = null,
  uuid = null,
  creationDate = null,
  creationTime = null,
  includeDescriptiveText = true
}) {
  // Broadcast-grade header: include the standard MCC descriptive block plus common metadata keys.
  // This improves interchange with strict ingest/QC tooling (and matches what FFmpeg emits).
  const rate = _timeCodeRateLabel(fps, dropFrame);
  // MCC versioning note:
  //  - "60DF" is a V2.0-only Time Code Rate in common tooling.
  //    If the caller doesn't explicitly request a version, auto-upgrade to V2.0 for 59.94 DF.
  const requestedVersionRaw = (fileFormatVersion != null) ? String(fileFormatVersion).trim() : '';
  const requestedVersion = _normalizeMccFileFormatVersion(requestedVersionRaw);
  if (requestedVersionRaw && !requestedVersion) {
    throw new Error(`Invalid MCC file format version "${requestedVersionRaw}". Expected "V1.0" or "V2.0".`);
  }
  const requiresV2 = /^60DF$/i.test(rate);
  if (requestedVersion === 'V1.0' && requiresV2) {
    throw new Error('MacCaption_MCC V1.0 does not support Time Code Rate=60DF. Use MacCaption_MCC V2.0 for 59.94 DF exports.');
  }
  const version = requestedVersion || (requiresV2 ? 'V2.0' : 'V1.0');
  const svc = Math.max(1, Math.min(63, Number(serviceNumber) || 1));
  const lang = String(language || 'eng').trim().toLowerCase();
  const safeLang = /^[a-z]{3}$/.test(lang) ? lang : 'eng';
  const pad2 = (n) => String(Math.trunc(Number(n) || 0)).padStart(2, '0');

  const crypto = require('crypto');
  const makeUuidV4 = () => {
    if (crypto && typeof crypto.randomUUID === 'function') return String(crypto.randomUUID()).toUpperCase();
    const b = crypto.randomBytes(16);
    // RFC 4122 v4
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString('hex').toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const now = new Date();
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const defaultCreationDate = (() => {
    const wd = weekdays[now.getDay()] || 'Monday';
    const mo = months[now.getMonth()] || 'January';
    const day = now.getDate();
    const yr = now.getFullYear();
    return `${wd}, ${mo} ${day}, ${yr}`;
  })();

  const defaultCreationTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  const uuidVal = (uuid != null && String(uuid).trim())
    ? String(uuid).trim()
    : makeUuidV4();

  const creationDateVal = (creationDate != null && String(creationDate).trim())
    ? String(creationDate).trim()
    : defaultCreationDate;

  const creationTimeVal = (creationTime != null && String(creationTime).trim())
    ? String(creationTime).trim()
    : defaultCreationTime;

  const safeCreationProgram = (creationProgram != null && String(creationProgram).trim())
    ? String(creationProgram).replace(/[\r\n].*$/g, '').trim()
    : null;

  const descriptiveBlockV1 = [
    '///////////////////////////////////////////////////////////////////////////////////',
    '// Computer Prompting and Captioning Company',
    '// Ancillary Data Packet Transfer File',
    '//',
    '// Permission to generate this format is granted provided that',
    '// 1. This ANC Transfer file format is used on an as-is basis and no warranty is given, and',
    '// 2. This entire descriptive information text is included in a generated .mcc file.',
    '//',
    '// General file format:',
    '// HH:MM:SS:FF(tab)[Hexadecimal ANC data in groups of 2 characters]',
    '// Hexadecimal data starts with the Ancillary Data Packet DID (Data ID defined in S291M)',
    '// and concludes with the Check Sum following the User Data Words.',
    '// Each time code line must contain at most one complete ancillary data packet.',
    '// To transfer additional ANC Data successive lines may contain identical time code.',
    '// Time Code Rate=[24, 25, 30, 30DF, 50, 60]',
    '//',
    '// ANC data bytes may be represented by one ASCII character according to the following schema:',
    '// G FAh 00h 00h',
    '// H 2 x (FAh 00h 00h)',
    '// I 3 x (FAh 00h 00h)',
    '// J 4 x (FAh 00h 00h)',
    '// K 5 x (FAh 00h 00h)',
    '// L 6 x (FAh 00h 00h)',
    '// M 7 x (FAh 00h 00h)',
    '// N 8 x (FAh 00h 00h)',
    '// O 9 x (FAh 00h 00h)',
    '// P FBh 80h 80h',
    '// Q FCh 80h 80h',
    '// R FDh 80h 80h',
    '// S 96h 69h',
    '// T 61h 01h',
    '// U E1h 00h 00h 00h',
    '// Z 00h',
    '//',
    '///////////////////////////////////////////////////////////////////////////////////'
  ];

  const descriptiveBlockV2 = [
    '///////////////////////////////////////////////////////////////////////////////////',
    '// Computer Prompting and Captioning Company',
    '// Ancillary Data Packet Transfer File',
    '//',
    '// Permission to generate this format is granted provided that',
    '// 1. This ANC Transfer file format is used on an as-is basis and no warranty is given, and',
    '// 2. This entire descriptive information text is included in a generated .mcc file.',
    '//',
    '// General file format:',
    '// HH:MM:SS:FF(tab)[Hexadecimal ANC data in groups of 2 characters]',
    '// Hexadecimal data starts with the Ancillary Data Packet DID (Data ID defined in S291M)',
    '// and concludes with the Check Sum following the User Data Words.',
    '// Each time code line must contain at most one complete ancillary data packet.',
    '// To transfer additional ANC Data successive lines may contain identical time code.',
    '// Time Code Rate=[24, 25, 30, 30DF, 50, 60, 60DF]',
    '//',
    '// ANC data bytes may be represented by one ASCII character according to the following schema:',
    '// G FAh 00h 00h',
    '// H 2 x (FAh 00h 00h)',
    '// I 3 x (FAh 00h 00h)',
    '// J 4 x (FAh 00h 00h)',
    '// K 5 x (FAh 00h 00h)',
    '// L 6 x (FAh 00h 00h)',
    '// M 7 x (FAh 00h 00h)',
    '// N 8 x (FAh 00h 00h)',
    '// O 9 x (FAh 00h 00h)',
    '// P FBh 80h 80h',
    '// Q FCh 80h 80h',
    '// R FDh 80h 80h',
    '// S 96h 69h',
    '// T 61h 01h',
    '// U E1h 00h 00h 00h',
    '// Z 00h',
    '//',
    '///////////////////////////////////////////////////////////////////////////////////'
  ];

  const headerLines = [
    `File Format=MacCaption_MCC ${version}`,
    '',
    ...(includeDescriptiveText !== false ? (version === 'V2.0' ? descriptiveBlockV2 : descriptiveBlockV1) : []),
    '',
    `UUID=${uuidVal}`,
    ...(safeCreationProgram ? [`Creation Program=${safeCreationProgram}`] : []),
    `Creation Date=${creationDateVal}`,
    `Creation Time=${creationTimeVal}`,
    `Time Code Rate=${rate}`,
    `Drop Frame=${dropFrame ? 'True' : 'False'}`,
    `Caption Service=${svc}`,
    `Language=${safeLang}`
  ];
  headerLines.push('');
  return headerLines.join('\r\n') + '\r\n';
}

// Wrap a CDP (0x96 0x69 … 0x74 … + CDP checksum) in a SMPTE-291 ANC packet
// DID=0x61, SDID=0x01, DC=<len>, then UDW bytes (CDP), then 8-bit ANC checksum
function _wrapANC291(userDataBytes) {
  const DID = 0x61, SDID = 0x01;
  const dc  = userDataBytes.length & 0xff;
  const payload = [DID, SDID, dc, ...userDataBytes];
  const sum = payload.reduce((a, b) => (a + (b & 0xff)) & 0xff, 0);
  const cks = (256 - sum) & 0xff;
  return Uint8Array.from([...payload, cks]);
}

function _compressMccLineHex(hexBytesUpperSpaced) {
  // Input: "61 01 2A 96 69 ..." (UPPER hex with spaces)
  const tokens = hexBytesUpperSpaced.trim().split(/\s+/).map(t => t.toUpperCase());

  const out = [];
  for (let i = 0; i < tokens.length; ) {
    // Multi-byte patterns first
    const next2 = tokens.slice(i, i + 2).join(' ');
    const next3 = tokens.slice(i, i + 3).join(' ');

    // Telestream common macros (observed in the wild)
    if (next2 === '61 01') { out.push('T'); i += 2; continue; }      // ANC DID+SDID
    if (next2 === '96 69') { out.push('S'); i += 2; continue; }      // CDP id

    if (next3 === 'FB 80 80') { out.push('P'); i += 3; continue; }   // 608 F2 blank
    if (next3 === 'FC 80 80') { out.push('Q'); i += 3; continue; }   // 608 F1 blank
    if (next3 === 'FD 80 80') { out.push('R'); i += 3; continue; }   // 608 F2 blank (alt)

    // Telestream macro: E1 00 00 00 → U
    if (tokens[i] === 'E1' && tokens[i + 1] === '00' && tokens[i + 2] === '00' && tokens[i + 3] === '00') { out.push('U'); i += 4; continue; }

    // Run-length for FA 00 00 → G..O (1..9). Advance greedily.
    if (tokens[i] === 'FA' && tokens[i + 1] === '00' && tokens[i + 2] === '00') {
      let n = 0;
      while (tokens[i + 3 * n] === 'FA' &&
             tokens[i + 3 * n + 1] === '00' &&
             tokens[i + 3 * n + 2] === '00' &&
             n < 9) n++;
      out.push(String.fromCharCode('G'.charCodeAt(0) + (n - 1))); // G..O
      i += 3 * n;
      continue;
    }

    // Single 00 → Z
    if (tokens[i] === '00') { out.push('Z'); i += 1; continue; }

    // Default: keep hex byte
    out.push(tokens[i]);
    i += 1;
  }
  return out.join('');
}

function _parseMccPayloadToBytes(payload, { strict = false, reportWhitespace = false } = {}) {
  // Stream parser:
  //  - supports contiguous hex (no spaces)
  //  - supports Telestream single-letter macros embedded anywhere
  //  - ignores whitespace anywhere (even between nibbles)
  const raw = String(payload || '');
  const bytes = [];
  const errors = [];
  const push = (...arr) => { for (const b of arr) bytes.push(b & 0xff); };
  const isWs = (c) => /\s/.test(c);
  const isHex = (c) => /^[0-9A-F]$/.test(c);

  let sawWhitespace = false;

  let i = 0;
  while (i < raw.length) {
    const chRaw = raw[i];
    if (isWs(chRaw)) {
      if (reportWhitespace && !sawWhitespace) {
        sawWhitespace = true;
        errors.push({ index: i, message: 'Whitespace is not allowed inside MCC payload streams (payload must be contiguous).' });
      }
      i++;
      continue;
    }
    const ch = String(chRaw).toUpperCase();

    if (ch === 'T') { push(0x61, 0x01); i++; continue; }
    if (ch === 'S') { push(0x96, 0x69); i++; continue; }
    if (ch === 'P') { push(0xFB, 0x80, 0x80); i++; continue; }
    if (ch === 'Q') { push(0xFC, 0x80, 0x80); i++; continue; }
    if (ch === 'R') { push(0xFD, 0x80, 0x80); i++; continue; }
    if (ch === 'U') { push(0xE1, 0x00, 0x00, 0x00); i++; continue; }
    if (ch === 'Z') { push(0x00); i++; continue; }
    if (ch >= 'G' && ch <= 'O') {
      const n = (ch.charCodeAt(0) - 'G'.charCodeAt(0)) + 1;
      for (let k = 0; k < n; k++) push(0xFA, 0x00, 0x00);
      i++;
      continue;
    }

    if (isHex(ch)) {
      const hi = ch;
      i++;
      while (i < raw.length && isWs(raw[i])) {
        if (reportWhitespace && !sawWhitespace) {
          sawWhitespace = true;
          errors.push({ index: i, message: 'Whitespace is not allowed inside MCC payload streams (payload must be contiguous).' });
        }
        i++;
      }
      if (i >= raw.length) {
        errors.push({ index: i - 1, message: `Dangling hex nibble '${hi}' at end of payload.` });
        if (strict) break;
        continue;
      }
      const loRaw = raw[i];
      const lo = String(loRaw).toUpperCase();
      if (!isHex(lo)) {
        errors.push({ index: i, message: `Expected hex nibble after '${hi}', got '${loRaw}'.` });
        if (strict) break;
        continue; // don't consume lo (lets alias/other parse next)
      }
      bytes.push(parseInt(hi + lo, 16) & 0xff);
      i++;
      continue;
    }

    errors.push({ index: i, message: `Unknown MCC payload character '${chRaw}'.` });
    if (strict) break;
    i++;
  }

  return { bytes, errors };
}

function _sum8(bytes) {
  let s = 0;
  for (const b of (bytes || [])) s = (s + (b & 0xff)) & 0xff;
  return s & 0xff;
}

function framesToTcString(frame, fps, dropFrame) {
  return formatTimecodeFromFrames(frame, dropFrame, fps, 'colon');
}

function _parseMccV2TimecodeToken(token) {
  // MCC V2.0 allows an optional timecode suffix: ".<field>,<line>"
  // Example: 00:00:00:00.0,9
  // Timing math uses only the base timecode.
  const raw = String(token || '').trim();
  const m = /^(\d{2}:\d{2}:\d{2}[:;]\d{2})(?:\.(\d+),(\d+))?$/.exec(raw);
  if (!m) return null;
  const base = m[1];
  const field = (m[2] != null) ? Math.trunc(Number(m[2])) : null;
  const line = (m[3] != null) ? Math.trunc(Number(m[3])) : null;
  return {
    base,
    field: Number.isFinite(field) ? field : null,
    line: Number.isFinite(line) ? line : null,
    full: raw
  };
}

function _parseMccTimeCodeRateValue(v) {
  const raw = String(v || '').trim();
  if (!raw) return { fps: null, dropFrame: null, nominal: null };

  const m = /^([0-9]+(?:\.[0-9]+)?)(DF)?$/i.exec(raw);
  if (!m) return { fps: null, dropFrame: null, nominal: null };

  let fps = Number(m[1]);
  const dropFrame = !!m[2];
  const nominal = dropFrame ? `${m[1]}DF` : String(m[1]);

  if (!Number.isFinite(fps) || fps <= 0) return { fps: null, dropFrame: dropFrame ? true : null, nominal };

  // MCC commonly uses *nominal* DF labels:
  //   30DF → 29.97 DF
  //   60DF → 59.94 DF
  // Treat these as such for correct timecode math.
  if (dropFrame) {
    if (Math.abs(fps - 30) < 0.06) fps = 29.97;
    if (Math.abs(fps - 60) < 0.12) fps = 59.94;
  }

  return { fps, dropFrame, nominal };
}

function _parseCaptionOffsetToFrames(value, fps) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  const sign = raw.startsWith('-') ? -1 : 1;
  const body = (raw.startsWith('-') || raw.startsWith('+')) ? raw.slice(1).trim() : raw;

  // HH:MM:SS:FF or HH:MM:SS;FF → interpret as a timecode duration at the nominal timecode fps
  // (e.g., 29.97 → 30, 23.976 → 24). This matches how editors think about timecode fields.
  const tc = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(body);
  if (tc) {
    const hh = Number(tc[1]);
    const mm = Number(tc[2]);
    const ss = Number(tc[3]);
    const ff = Number(tc[4]);
    const nominal = nominalFrameBase(fps);
    if (![hh, mm, ss, ff, nominal].every(Number.isFinite)) {
      throw new Error(`Invalid timecodeOffset: ${raw}`);
    }
    const frames = ((hh * 3600 + mm * 60 + ss) * nominal) + ff;
    return sign * Math.trunc(frames);
  }

  // Frames: "12f" / "12fr" / "12frames"
  const fm = /^(\d+(?:\.\d+)?)\s*(f|fr|frame|frames)$/i.exec(body);
  if (fm) {
    const f = Number(fm[1]);
    if (!Number.isFinite(f)) throw new Error(`Invalid timecodeOffset: ${raw}`);
    return sign * Math.trunc(f);
  }

  // Seconds: "0.5s", "2s", or bare number "2.0" (seconds)
  const sm = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds)?$/i.exec(body);
  if (sm) {
    const sec = Number(sm[1]);
    if (!Number.isFinite(sec)) throw new Error(`Invalid timecodeOffset: ${raw}`);
    return sign * secondsToFrames(sec, fps, 'nearest');
  }

  throw new Error(`Invalid timecodeOffset: ${raw}`);
}

function generateMCC(
  segments,
  {
    fps = 29.97,
    dropFrame: dropFrameOption = true,
    startTc = null,
    startTC = null,
    timecodeOffset = null,
    timecodeOffsetFrames = null,
    timecodeOffsetSeconds = null,
    timecodeOffsetPolicy: timecodeOffsetPolicyOption = 'clamp',
    // By default we do NOT embed SMPTE-12M (0x71) inside the CDP.
    // Many NLE importers/parsers expect CC_DATA (0x72) to begin immediately after
    // the CDP sequence counter (byte offset 7) and will ignore packets if 0x71 is present.
    // The MCC line timecode already provides the timing.
    includeCdpTimecode: includeCdpTimecodeOption = null,
    embedCdpTimecode: embedCdpTimecodeOption = null,
    compatibilityMode: compatibilityModeOption = null,
    includeCcsSvcInfo: includeCcsSvcInfoOption = null,
    authoringModel: _authoringModelOption = null,
    include608Compatibility: include608CompatibilityOption = null,
    // Optional: allow caller to provide a pre-derived 608 fallback track.
    // Milestone 3 requires a formal derived-608 step, and later milestones will
    // shape/split this derived track independently of 708.
    // Expected shape (initially 1:1 with input segments):
    //   [{ sourceIndex, sourceCueId, start, end, lines:[...], text:"...", flags:{...} }, ...]
    derived608Cues: derived608CuesOption = null,
    compatGenerationRules: compatGenerationRulesOption = null,
    telestreamCompression: telestreamCompressionOption = null,
    // MCC V2.0 optional timecode suffix: ".<field>,<line>" (example: .0,9)
    // When enabled, the MCC header is forced to V2.0 unless the caller explicitly
    // requested V1.0 (in which case we throw).
    mccTimecodeSuffix: mccTimecodeSuffixOption = null,
    // Optional: pad CC_DATA out to capacity (maxTriplets) using invalid filler triplets (0xFA 00 00).
    // Some broadcast ingest/QC chains expect a fixed-size cc_data channel rather than cc_count=0 on empty frames.
    padCcDataToCapacity: padCcDataToCapacityOption = null,
    pingPongWindows: pingPongWindowsOption = true,
    creationProgram: creationProgramOption = null,
    // Optional deterministic header fields (useful for fixtures/tests)
    uuid: uuidOption = null,
    creationDate: creationDateOption = null,
    creationTime: creationTimeOption = null,
    includeDescriptiveText: includeDescriptiveTextOption = true,
    maxCharsPerLine = 42,
    maxLinesPerBlock = 2,
    includeSpeakerNames = false,
    serviceNumber = 1,
    language = 'eng',
    // Optional global 708 presentation styling / placement.
    // These mirror generateSCC() options and are forwarded to the 708 encoder.
    // NOTE: These used to be referenced as free variables (pen/penColor/windowStyle/window)
    // which is ambiguous and can throw at runtime. Make them explicit options.
    pen = null,
    penColor = null,
    windowStyle = null,
    window = null,
    services = null,
    segmentsByService = null,
    sccOptions = {}
  } = {}
) {
  // _cea708 is guaranteed by the static require below.
  fps = Number(fps) || 29.97;
  // Preserve input segments; multi-service text selection happens per-service below.
  const segs = Array.isArray(segments) ? segments.slice() : [];

  // ---------------------------------------------------------------------------
  // Phase 2 — MCC timing policy: bounded ripple for file-start preload.
  //
  // MCC encodes one CDP per video frame. For early cues (especially the first),
  // the amount of CEA-708 preload data can exceed the available frames before
  // the cue's start time (because you can't transmit before frame 0). Without a
  // policy, the encoder either drifts the visible show time late or must fail.
  //
  // Policy (recommended "pro tool" default): If the earliest cue starts too
  // close to frame 0 to preload, shift the cue timing forward by the minimum
  // amount needed so the cue can be preloaded and shown exactly at its emitted
  // start time. Preserve relative timing thereafter by applying the same shift
  // to the rest of the file.
  //
  // If the required shift exceeds a small budget (default 1.0s), we still
  // generate the file (useful for debugging / gate_write) but mark QC failure.
  const mccStartRippleMaxSec = (() => {
    const raw = (sccOptions && typeof sccOptions === 'object')
      ? (sccOptions.mccStartRippleMaxSec ?? sccOptions.mccStartPreloadRippleMaxSec ?? sccOptions.mccStartPreloadMaxShiftSec)
      : undefined;
    if (raw == null) return 1.0;
    const n = Number(raw);
    return (Number.isFinite(n) && n >= 0) ? n : 1.0;
  })();

  let mccStartRippleShiftFrames = 0;
  let mccStartRippleComputed = false;
  const mccTimingMeta = {
    policy: 'bounded_start_ripple',
    applied: false,
    shiftFrames: 0,
    shiftSec: 0,
    maxShiftSec: mccStartRippleMaxSec,
    exceededBudget: false,
    firstCueIndex: null,
    firstCueOriginalStartFrame: null,
    firstCueRequiredLeadFrames: null
  };

  const _runsToText = (runs) => {
    if (!Array.isArray(runs)) return '';
    return runs.map(r => String((r && typeof r === 'object') ? (r.text ?? '') : '')).join('');
  };

  const _prefixRuns = (prefix, runs) => {
    if (!prefix) return Array.isArray(runs) ? runs.slice() : null;
    const list = Array.isArray(runs) ? runs.slice() : [];
    if (!list.length) return [{ text: prefix, style: null }];
    return [{ text: prefix, style: null }, ...list];
  };

  const _getServiceContent = (seg, svc) => {
    if (!seg) return { text: '', runs: null };
    const svcNum = Math.max(1, Math.min(63, Number(svc?.serviceNumber) || 1));
    const svcKey = String(svcNum);
    const langKey = (svc?.language != null) ? String(svc.language).trim().toLowerCase() : '';
    const speakerPrefix = (includeSpeakerNames && seg?.speaker) ? `${seg.speaker}: ` : '';
    // Phase 1.2: per-cue CEA-708 text override (primary service only).
    // Keep canonical text (seg.text) as the source of truth for 608 projection.
    const primarySvcNum = Math.max(1, Math.min(63, Number(serviceNumber) || 1));
    const o708 = (seg && seg.overrides && typeof seg.overrides === 'object') ? (seg.overrides['708'] || null) : null;
    if (svcNum === primarySvcNum && o708 && typeof o708 === 'object' && o708.text != null) {
      return { text: speakerPrefix + String(o708.text ?? ''), runs: null };
    }

    const pick = (val) => {
      if (typeof val === 'string') return { text: speakerPrefix + val, runs: null };
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const runs = Array.isArray(val.runs) ? val.runs : (Array.isArray(val.spans) ? val.spans : null);
        const text = (typeof val.text === 'string')
          ? val.text
          : (runs ? _runsToText(runs) : '');
        return {
          text: speakerPrefix + String(text || ''),
          runs: runs ? _prefixRuns(speakerPrefix, runs) : null
        };
      }
      return { text: '', runs: null };
    };

    const fromMap = (map) => {
      if (!map || typeof map !== 'object') return null;
      if (Array.isArray(map)) {
        const hit = map.find(x => Number(x?.serviceNumber) === svcNum || (langKey && String(x?.language || '').toLowerCase() === langKey));
        const got = pick(hit);
        return (got && got.text) ? got : null;
      }
      if (map[svcNum] != null) return pick(map[svcNum]);
      if (map[svcKey] != null) return pick(map[svcKey]);
      if (langKey && map[langKey] != null) return pick(map[langKey]);
      return null;
    };

    // Explicit per-service containers (common shapes)
    let got = fromMap(seg.services) || fromMap(seg.textByService) || fromMap(seg.texts);
    if (got && got.text) return got;

    // seg.text may itself be a mapping
    if (seg.text && typeof seg.text === 'object' && !Array.isArray(seg.text)) {
      got = fromMap(seg.text);
      if (got && got.text) return got;
      if (typeof seg.text.text === 'string') {
        const t = pick(seg.text.text);
        // If this is the primary service and segment has top-level runs, allow them.
        const primaryRuns = (svcNum === Math.max(1, Math.min(63, Number(serviceNumber) || 1)))
          ? (Array.isArray(seg.runs) ? seg.runs : null)
          : null;
        return { text: t.text, runs: primaryRuns ? _prefixRuns(speakerPrefix, primaryRuns) : t.runs };
      }
      if (Array.isArray(seg.text.runs)) {
        const r = seg.text.runs;
        return { text: speakerPrefix + _runsToText(r), runs: _prefixRuns(speakerPrefix, r) };
      }
    }

    if (typeof seg.text === 'string') {
      const primaryRuns = (svcNum === Math.max(1, Math.min(63, Number(serviceNumber) || 1)))
        ? (Array.isArray(seg.runs) ? seg.runs : null)
        : null;
      return { text: speakerPrefix + seg.text, runs: primaryRuns ? _prefixRuns(speakerPrefix, primaryRuns) : null };
    }

    // No explicit text, but runs exist (treat as primary service).
    if (Array.isArray(seg.runs) && seg.runs.length && svcNum === Math.max(1, Math.min(63, Number(serviceNumber) || 1))) {
      const t = _runsToText(seg.runs);
      return { text: speakerPrefix + t, runs: _prefixRuns(speakerPrefix, seg.runs) };
    }

    return { text: '', runs: null };
  };

  // Back-compat helper: most of the encoder still treats caption text as plain strings.
  // Runs are carried alongside via _getServiceContent().
  const _getServiceText = (seg, svc) => {
    const got = _getServiceContent(seg, svc);
    return String(got?.text || '');
  };

  const isDfRate = isDropFrameRate(fps);
  const dropFrame = !!dropFrameOption && isDfRate;
  const timeSource = sccOptions.timeSource || 'auto'; // 'df-string'|'start'|'auto'
  const align = _normalizeAlignment(sccOptions.alignment) || 'left';
  // NOTE: Global 708 presentation defaults (pen/window style/placement) are resolved later,
  // after we know whether 608 compatibility is enabled (which affects max chars/lines).



  // Optional: export multiple independent CEA-708 service tracks into one MCC.
  // When provided, each key is a service number and the value is an array of cue-like
  // segments ({ start, end, text, ... }). These tracks may overlap in time.
  const rawSegmentsByService = (segmentsByService != null)
    ? segmentsByService
    : (sccOptions?.segmentsByService ?? sccOptions?.cuesByService ?? null);

  const _normalizeSegmentsByService = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    // Allow either a plain mapping or something shaped like { cuesByService: {...} }.
    const base = (raw && typeof raw === 'object' && raw.cuesByService && typeof raw.cuesByService === 'object')
      ? raw.cuesByService
      : raw;
    const out = {};
    for (const k of Object.keys(base || {})) {
      const snRaw = Number(k);
      if (!Number.isFinite(snRaw)) continue;
      const sn = Math.max(1, Math.min(63, Math.trunc(snRaw)));
      const arr = base[k];
      if (!Array.isArray(arr)) continue;
      out[sn] = arr.slice();
    }
    return Object.keys(out).length ? out : null;
  };

  const segmentsByServiceMap = _normalizeSegmentsByService(rawSegmentsByService);

  // --- Multi-service configuration (CEA-708) --------------------------------
  // If `services` is provided (or sccOptions.mccServices), we emit multiple 708 services
  // in the same CDP stream, each with independent window state.
  const _normalizeLang3 = (l, fallback = 'eng') => {
    const raw = String(l || '').trim().toLowerCase();
    return /^[a-z]{3}$/.test(raw) ? raw : fallback;
  };

  const rawServices = (services != null)
    ? services
    : (sccOptions?.mccServices ?? sccOptions?.services ?? null);

  const serviceConfigs = (() => {
    let list = [];

    if (Array.isArray(rawServices)) {
      list = rawServices.slice();
    } else if (rawServices && typeof rawServices === 'object') {
      // Single config object OR mapping { "1": {language:'eng', ...}, "2": 'spa' }
      if (rawServices.serviceNumber != null || rawServices.language != null) {
        list = [rawServices];
      } else {
        list = Object.keys(rawServices).map((k) => {
          const v = rawServices[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) return { serviceNumber: k, ...v };
          return { serviceNumber: k, language: v };
        });
      }
    }



    // If the caller provided per-service cue tracks but no explicit service list,
    // infer the service configs from the track keys.
    if (!list.length && segmentsByServiceMap) {
      const svcNums = Object.keys(segmentsByServiceMap)
        .map(v => Number(v))
        .filter(n => Number.isFinite(n))
        .map(n => Math.max(1, Math.min(63, Math.trunc(n))))
        .sort((a, b) => a - b);
      if (svcNums.length) {
        list = svcNums.map(sn => ({ serviceNumber: sn, language }));
      }
    }
    if (!list.length) list = [{ serviceNumber, language }];

    const out = [];
    const seen = new Set();
    for (const item of list) {
      const sn = Math.max(1, Math.min(63, Number(item?.serviceNumber) || 1));
      if (seen.has(sn)) continue;
      seen.add(sn);
      out.push({
        serviceNumber: sn,
        language: _normalizeLang3(item?.language, _normalizeLang3(language, 'eng')),
        // Optional per-service overrides:
        alignment: item?.alignment ?? item?.justify ?? null,
        maxCharsPerLine: item?.maxCharsPerLine ?? null,
        maxLinesPerBlock: item?.maxLinesPerBlock ?? null,
        pingPongWindows: item?.pingPongWindows,
        window: item?.window ?? item?.windowPlacement ?? item?.mcc708Window ?? null,
        windowStyle: item?.windowStyle ?? item?.mcc708WindowStyle ?? null,
        pen: item?.pen ?? item?.mcc708Pen ?? null,
        penColor: item?.penColor ?? item?.mcc708PenColor ?? null
      });
    }

    // Prefer the caller's `serviceNumber` as the primary service when present.
    const preferred = Math.max(1, Math.min(63, Number(serviceNumber) || 1));
    const idx = out.findIndex(s => s.serviceNumber === preferred);
    if (idx > 0) out.unshift(out.splice(idx, 1)[0]);

    return out;
  })();

  const primaryService = serviceConfigs[0] || { serviceNumber: Math.max(1, Math.min(63, Number(serviceNumber) || 1)), language: _normalizeLang3(language, 'eng') };
  const primaryServiceNumber = primaryService.serviceNumber;
  const primaryLanguage = primaryService.language;

  // Caption slip / offset (post-production). Shifts *all* cues earlier/later by a fixed amount.
  // This is intentionally separate from Start TC (which is the label for media frame 0).
  let timecodeOffsetPolicy = String(timecodeOffsetPolicyOption || 'clamp').trim().toLowerCase();
  if (!['clamp', 'error'].includes(timecodeOffsetPolicy)) timecodeOffsetPolicy = 'clamp';

  let _slipFrames = 0;
  try {
    if (Number.isFinite(Number(timecodeOffsetFrames))) {
      _slipFrames = Math.trunc(Number(timecodeOffsetFrames));
    } else if (Number.isFinite(Number(timecodeOffsetSeconds))) {
      _slipFrames = secondsToFrames(Number(timecodeOffsetSeconds), fps, 'nearest');
    } else {
      const rawSlip = (typeof timecodeOffset === 'string' && timecodeOffset.trim())
        ? timecodeOffset.trim()
        : (typeof sccOptions.timecodeOffset === 'string' && sccOptions.timecodeOffset.trim() ? sccOptions.timecodeOffset.trim() : null);
      if (rawSlip) _slipFrames = _parseCaptionOffsetToFrames(rawSlip, fps);
    }
  } catch (e) {
    throw new Error(`MCC timecodeOffset parse error: ${e?.message || String(e)}`);
  }

  // Compatibility Modes:
  //  - 'nle'      : maximize NLE ingest (no CDP timecode, no CCSVCInfo, always emit 608 compat on CC1)
  //  - 'broadcast': allow richer metadata (optional timecode + CCSVCInfo)
  //  - 'strict'   : broadcast + stricter defaults and verification
  const compatMode = _normalizeMccCompatibilityMode(
    (compatibilityModeOption != null)
      ? compatibilityModeOption
      : (sccOptions?.mccCompatibilityMode ?? sccOptions?.mccCompatMode)
  );
  // MCC authoring model: fixed to True 708 (708 is canonical; 608 is derived separately when enabled).

  let ch = Math.max(1, Math.min(4, Number(sccOptions.channel) || 1));
  if (compatMode === 'nle') ch = 1;

  const rowPolicy = sccOptions.rowPolicy || 'bottom2';
  // MCC/CDP carries 608 words as field-tagged cc_data triplets (F1/F2).
  // This encoder currently emits only F1 triplets, so repeating 608 *control*
  // codes in the same field can be actively harmful (e.g., EOC swaps memory
  // and repeating it can immediately swap back and clear the caption).
  // Default OFF for MCC; callers can explicitly enable if they know what
  // they're doing.
  const repeatControlCodes = sccOptions.repeatControlCodes === true;
  const repeatPreambleCodes = sccOptions.repeatPreambleCodes !== false;
  let include608 = (include608CompatibilityOption == null)
    ? (sccOptions.mccInclude608 !== false)
    : (include608CompatibilityOption !== false);

  if (compatMode === 'nle') include608 = true;
  const include608Compat = include608 && (ch === 1);
  const requireCompat608Placement = !!sccOptions.requireCompat608Placement;

  // SCC is intentionally strict by default for broadcast deliverables (no silent truncation).
  // For MCC: match SCC's behavior when 608 compatibility is enabled (pop-on constraints),
  // while keeping 708-only workflows permissive unless the caller opts into strictness.
  const overflowPolicy = (() => {
    const raw = String(sccOptions?.overflowPolicy || '').trim().toLowerCase();
    if (raw === 'truncate' || raw === 'error') return raw;
    return include608Compat ? 'error' : 'truncate';
  })();

  // Optional 608 text wrapping preferences (speaker labels, punctuation, hyphenation, etc.).
  // Call sites may supply these under sccOptions.wrap608.
  const wrap608UserRaw = (sccOptions && typeof sccOptions === 'object')
    ? (sccOptions.wrap608 || sccOptions.wrap608Options || sccOptions.textWrap608 || sccOptions.cea608Wrap || null)
    : null;
  const wrap608User = (wrap608UserRaw && typeof wrap608UserRaw === 'object') ? { ...wrap608UserRaw } : null;

  let allowExplicitLineBreaks608 = undefined;
  if (wrap608User && wrap608User.allowExplicitLineBreaks != null) {
    allowExplicitLineBreaks608 = wrap608User.allowExplicitLineBreaks;
    delete wrap608User.allowExplicitLineBreaks;
  }

  // --- 708 authoring constraints (independent of 608 compatibility) ----------
  const maxChars708 = Math.max(1, Math.min(63, Math.trunc(Number(maxCharsPerLine) || 42)));
  // Lead AE policy: never author more than 3 lines per subtitle block.
  const maxLines708 = Math.max(1, Math.min(3, Math.trunc(Number(maxLinesPerBlock) || 2)));

  // --- 608 fallback constraints (fixed; safeMargins may reduce usable width) --
  const safeMargins608 = include608Compat ? _normalizeSafeMargins(sccOptions?.safeMargins) : null;
  const safeWidth608 = (safeMargins608 && Number.isFinite(Number(safeMargins608.width))) ? Number(safeMargins608.width) : 32;
  const maxChars608 = Math.max(1, Math.min(32, Math.trunc(safeWidth608)));
  const maxLines608 = 2;

  const useDerived608Track = include608Compat;
  const useInline608Compat = false;

  // --- Milestone 3: derived 608 fallback track (first-class, no mutation) ---
  // We build a *separate* 608-shaped representation of the canonical text so:
  //   - 708 authoring can use richer limits (true708) without breaking the 608 proxy
  //   - per-cue 608 overrides can be applied without touching canonical text
  // Later milestones will shape/split this derived track (possibly changing cue count).
  const derived608ByIndex = (() => {
    if (!useInline608Compat) return null;

    // Allow the caller to supply a pre-derived 608 track (e.g., Milestone 4 splitting).
    const provided = Array.isArray(derived608CuesOption)
      ? derived608CuesOption
      : (Array.isArray(sccOptions?.derived608Cues) ? sccOptions.derived608Cues : null);

    // Fast path: already 1:1 aligned by index.
    if (provided && provided.length === segs.length) {
      return provided;
    }

    // If provided but not index-aligned, try to map it back onto indices.
    if (provided && provided.length) {
      const map = new Array(segs.length).fill(null);
      const indexById = new Map();
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const key = (seg && seg.id != null) ? String(seg.id) : String(i);
        if (!indexById.has(key)) indexById.set(key, i);
      }

      for (const d of provided) {
        if (!d || typeof d !== 'object') continue;
        let idx = Number.isFinite(Number(d.sourceIndex)) ? Math.trunc(Number(d.sourceIndex)) : null;
        if ((idx == null || idx < 0 || idx >= segs.length) && d.sourceCueId != null) {
          const hit = indexById.get(String(d.sourceCueId));
          if (Number.isFinite(Number(hit))) idx = Math.trunc(Number(hit));
        }
        if (idx == null || idx < 0 || idx >= segs.length) continue;
        map[idx] = d;
      }
      return map;
    }

    // Default: derive 608 per canonical segment (primary service text only).
    const pseudo = segs.map((seg, idx) => ({
      id: seg?.id ?? idx,
      start: Number(seg?.start) || (Number(seg?.msStart) ? (Number(seg.msStart) / 1000) : 0),
      end: Number(seg?.end) || (Number(seg?.msEnd) ? (Number(seg.msEnd) / 1000) : (Number(seg?.start) || 0)),
      speaker: seg?.speaker || null,
      text: _getServiceText(seg, primaryService)
    }));

    return derive608CuesFromCanonical(pseudo, { maxCols: maxChars608, maxLines: maxLines608, ...(allowExplicitLineBreaks608 != null ? { allowExplicitLineBreaks: allowExplicitLineBreaks608 } : {}), ...(wrap608User ? { wrap608: wrap608User } : {}) });
  })();

  // Global 708 presentation defaults (can be overridden per-service via `services` configs).
  // Priority order:
  //   1) explicit top-level options (pen/penColor/windowStyle/window)
  //   2) sccOptions.mcc708* / sccOptions.cea708* defaults
  const global708Pen = (pen && typeof pen === 'object')
    ? pen
    : ((sccOptions && typeof sccOptions === 'object')
      ? (sccOptions.mcc708Pen ?? sccOptions.cea708Pen ?? null)
      : null);

  const global708PenColor = (penColor && typeof penColor === 'object')
    ? penColor
    : ((sccOptions && typeof sccOptions === 'object')
      ? (sccOptions.mcc708PenColor ?? sccOptions.cea708PenColor ?? null)
      : null);

  const global708WindowStyle = (windowStyle && typeof windowStyle === 'object')
    ? windowStyle
    : ((sccOptions && typeof sccOptions === 'object')
      ? (sccOptions.mcc708WindowStyle ?? sccOptions.cea708WindowStyle ?? null)
      : null);

  // When exporting MCC from an imported MCC/708 source, we try hard to preserve
  // the original 708 window placement (and basic styling) even if the user edits
  // cue text. This is a "post workflow" expectation (Rev/CaptionMax parity).
  //
  // Disable via:
  //   sccOptions.preserveImported708Layout = false
  const preserveImported708Layout = (sccOptions?.preserveImported708Layout ?? sccOptions?.preserve708Layout) !== false;

  const gridRowsDefault = Math.max(1, Math.min(15, Number(sccOptions?.mcc708GridRows) || 15));
  const gridColsDefault = Math.max(1, Math.min(63, Number(sccOptions?.mcc708GridColumns ?? sccOptions?.mcc708GridCols ?? sccOptions?.mcc708Columns) || Math.max(32, Math.min(63, maxChars708))));

  let useTelestreamCompression = (telestreamCompressionOption == null)
    ? (sccOptions?.mccCompress === true)
    : (telestreamCompressionOption === true);

  // Optional: pad CC_DATA to capacity using invalid filler triplets (0xFA 00 00).
  // Enabled only when explicitly requested.
  const padCcDataToCapacity = (padCcDataToCapacityOption == null)
    ? (sccOptions?.mccPadCcDataToCapacity === true || sccOptions?.padCcDataToCapacity === true)
    : (padCcDataToCapacityOption === true);

  let includeCdpTimecode = (includeCdpTimecodeOption == null && embedCdpTimecodeOption == null)
    ? (sccOptions?.mccEmbedCdpTimecode === true)
    : ((includeCdpTimecodeOption ?? embedCdpTimecodeOption) === true);

  if (compatMode === 'nle') includeCdpTimecode = false;
  if (compatMode === 'nle') useTelestreamCompression = false;
  if (compatMode === 'strict' && includeCdpTimecodeOption == null && embedCdpTimecodeOption == null && sccOptions?.mccEmbedCdpTimecode == null) {
    // Strict defaults to ON (header flags are set correctly), but can still be overridden.
    includeCdpTimecode = true;
  }

  // Guard: Our current SMPTE-12M timecode packing for CDP (0x71) only supports <=30fps.
  // For higher frame rates, the BCD frame digits would be invalid (tens-of-frames field is only 2 bits).
  if (includeCdpTimecode && Number(fps) > 30.0001) {
    throw new Error('Embed CDP SMPTE-12M timecode (0x71) is only supported at <=30fps in this build. Disable "Embed CDP timecode" (or use an <=30fps MCC FPS override).');
  }

  let includeCcsSvcInfo = (includeCcsSvcInfoOption == null)
    ? (sccOptions?.mccIncludeCcsSvcInfo === true)
    : (includeCcsSvcInfoOption === true);

  if (compatMode === 'nle') includeCcsSvcInfo = false;
  if ((compatMode === 'broadcast' || compatMode === 'strict') && includeCcsSvcInfoOption == null && sccOptions?.mccIncludeCcsSvcInfo == null) {
    includeCcsSvcInfo = true;
  }

  const pingPongWindows = (pingPongWindowsOption !== false);

  // 708 window placement (DefineWindow). Defaults are broadcast-safe lower-center.
  const winRaw = (window && typeof window === 'object')
    ? window
    : ((sccOptions && typeof sccOptions === 'object')
      ? (sccOptions.mcc708Window || sccOptions.windowPlacement || sccOptions.window || null)
      : null);

  const mcc708Window = (() => {
    if (!winRaw || typeof winRaw !== 'object') return null;

    // `rel` determines whether anchors are expressed in 0..99 (relative) or
    // 0..209 / 0..74 (absolute). UI/localStorage drift can leave these inconsistent.
    // Normalize by converting (not just clamping) when values clearly belong to the other space.
    const rel = winRaw.rel !== false;

    let anchorId = Number.isFinite(Number(winRaw.anchorId)) ? Math.trunc(Number(winRaw.anchorId)) : 7;
    anchorId = Math.max(0, Math.min(8, anchorId));

    let anchorV = Number.isFinite(Number(winRaw.anchorV)) ? Math.trunc(Number(winRaw.anchorV)) : (rel ? 90 : 67);
    let anchorH = Number.isFinite(Number(winRaw.anchorH)) ? Math.trunc(Number(winRaw.anchorH)) : (rel ? 50 : 105);

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    if (rel) {
      // If H is > 99, it can't be valid relative; treat it as absolute and convert.
      const hLooksAbs = Number.isFinite(anchorH) && anchorH > 99;
      if (hLooksAbs) {
        const hAbs = clamp(anchorH, 0, 209);
        anchorH = Math.round((hAbs / 209) * 99);

        // Convert V only if it also looks like absolute (<=74).
        if (Number.isFinite(anchorV) && anchorV <= 74) {
          const vAbs = clamp(anchorV, 0, 74);
          anchorV = Math.round((vAbs / 74) * 99);
        }
      }

      anchorH = clamp(anchorH, 0, 99);
      anchorV = clamp(anchorV, 0, 99);
      return { rel: true, anchorId, anchorV, anchorH };
    }

    // Absolute positioning
    const vLooksRel = Number.isFinite(anchorV) && anchorV > 74 && anchorV <= 99;
    const hLooksRel = Number.isFinite(anchorH) && anchorH <= 99;

    if (vLooksRel && hLooksRel) {
      // Very likely stored relative values while rel=false.
      const hRel = clamp(anchorH, 0, 99);
      const vRel = clamp(anchorV, 0, 99);
      anchorH = Math.round((hRel / 99) * 209);
      anchorV = Math.round((vRel / 99) * 74);
    } else if (anchorId === 7 && anchorH === 50 && anchorV === 74) {
      // Classic clamped default: user wanted V≈90% but got clamped to 74 in absolute mode.
      anchorH = Math.round((50 / 99) * 209);
      anchorV = Math.round((90 / 99) * 74);
    }

    anchorH = clamp(anchorH, 0, 209);
    anchorV = clamp(anchorV, 0, 74);
    return { rel: false, anchorId, anchorV, anchorH };
  })();
  const creationProgram = (creationProgramOption != null)
    ? String(creationProgramOption)
    : (sccOptions?.creationProgram != null ? String(sccOptions.creationProgram) : null);

  const _normalizeMccV2TimecodeSuffix = (value) => {
    // Accept:
    //  - true                 → default .0,9
    //  - ".0,9" / "0,9"       → parsed
    //  - [0, 9]               → parsed
    //  - { field: 0, line: 9} → parsed
    //  - null/false/''        → disabled
    if (value == null || value === false) return null;
    if (value === true) return { field: 0, line: 9 };

    if (Array.isArray(value)) {
      const f = Math.trunc(Number(value[0]));
      const l = Math.trunc(Number(value[1]));
      if (!Number.isFinite(f) || !Number.isFinite(l)) {
        throw new Error(`Invalid mccTimecodeSuffix array (expected [field,line], got ${JSON.stringify(value)}).`);
      }
      if (f !== 0 && f !== 1) throw new Error(`Invalid mccTimecodeSuffix field ${f} (expected 0 or 1).`);
      if (l < 0 || l > 999) throw new Error(`Invalid mccTimecodeSuffix line ${l} (expected 0..999).`);
      return { field: f, line: l };
    }

    if (typeof value === 'object') {
      const f = Math.trunc(Number(value.field));
      const l = Math.trunc(Number(value.line));
      if (!Number.isFinite(f) || !Number.isFinite(l)) {
        throw new Error('Invalid mccTimecodeSuffix object (expected {field:number,line:number}).');
      }
      if (f !== 0 && f !== 1) throw new Error(`Invalid mccTimecodeSuffix field ${f} (expected 0 or 1).`);
      if (l < 0 || l > 999) throw new Error(`Invalid mccTimecodeSuffix line ${l} (expected 0..999).`);
      return { field: f, line: l };
    }

    const s = String(value || '').trim();
    if (!s) return null;
    const m = s.match(/^\.?\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (!m) throw new Error(`Invalid mccTimecodeSuffix string "${s}" (expected ".<field>,<line>" e.g. ".0,9").`);
    const f = Math.trunc(Number(m[1]));
    const l = Math.trunc(Number(m[2]));
    if (!Number.isFinite(f) || !Number.isFinite(l)) {
      throw new Error(`Invalid mccTimecodeSuffix string "${s}" (field/line not numeric).`);
    }
    if (f !== 0 && f !== 1) throw new Error(`Invalid mccTimecodeSuffix field ${f} (expected 0 or 1).`);
    if (l < 0 || l > 999) throw new Error(`Invalid mccTimecodeSuffix line ${l} (expected 0..999).`);
    return { field: f, line: l };
  };

  const mccTimecodeSuffixRaw = (mccTimecodeSuffixOption != null)
    ? mccTimecodeSuffixOption
    : (sccOptions?.mccTimecodeSuffix ?? sccOptions?.mccV2TimecodeSuffix ?? null);
  const mccTimecodeSuffix = _normalizeMccV2TimecodeSuffix(mccTimecodeSuffixRaw);
  const emitMccTimecodeSuffix = !!mccTimecodeSuffix;

  let headerFileFormatVersion = (sccOptions?.mccFileFormatVersion ?? null);
  if (emitMccTimecodeSuffix) {
    const norm = _normalizeMccFileFormatVersion(headerFileFormatVersion);
    if (headerFileFormatVersion != null && norm === 'V1.0') {
      throw new Error('MacCaption_MCC V1.0 does not support the V2 timecode suffix ".<field>,<line>". Use MacCaption_MCC V2.0.');
    }
    // If the caller did not explicitly request a version, force V2.0 when emitting a V2 suffix.
    if (headerFileFormatVersion == null) headerFileFormatVersion = 'V2.0';
  }

  const lines = [];
  const header = _mccHeader({
    fps,
    dropFrame,
    serviceNumber: primaryServiceNumber,
    language: primaryLanguage,
    creationProgram,
    fileFormatVersion: headerFileFormatVersion,
    uuid: uuidOption,
    creationDate: creationDateOption,
    creationTime: creationTimeOption,
    includeDescriptiveText: includeDescriptiveTextOption
  });
  lines.push(header);

  const warnings = [];

  const frameRateCode = _frameRateCode(fps);
  const cdpCaps = _cdpCapacityForFps(fps, include608Compat);
  let frameIndex = 0;
  let cc608Queue = []; // remaining 608 words to mux into upcoming frames
  const serviceState = new Map();
  for (const svc of serviceConfigs) {
    serviceState.set(svc.serviceNumber, {
      visibleMask: 0,
      pingPongIndex: 0,
      currentBank: 0
    });
  }

  // Precompute "next cue" indices per service so we can schedule clears/hides correctly.
  const nextCueIndexByService = new Map();
  for (const svc of serviceConfigs) {
    const nextIndex = new Array(segs.length).fill(Infinity);
    let next = Infinity;
    for (let i = segs.length - 1; i >= 0; i--) {
      nextIndex[i] = next;
      const t = _getServiceText(segs[i], svc);
      if (t && String(t).trim()) next = i;
    }
    nextCueIndexByService.set(svc.serviceNumber, nextIndex);
  }
  let dtvccSeq = 0; // 2-bit DTVCC packet sequence (should be continuous across the stream)
  let cdpSeq = 0; // CDP 16-bit sequence counter (increments per CDP packet)
  let ccsvcInfoEmitted = false;

  // Derived 608 scheduling hook (Milestone 4): enabled when 608 compatibility is enabled
  // we may emit 608 compatibility as an independent, shaped track.
  let apply608EventsForFrame = null;

  // Optional Start TC offset: used to shift MCC timeline so frame 0 == program start TC.
  // Applied only when segment timing is derived from numeric start/msStart (not when anchoring to df-string labels).
  const baseStartTcMcc =
    (typeof startTc === 'string' && startTc.trim())
      ? startTc.trim()
      : (typeof startTC === 'string' && startTC.trim())
        ? startTC.trim()
        : (typeof sccOptions?.startTc === 'string' && sccOptions.startTc.trim())
          ? sccOptions.startTc.trim()
          : (typeof sccOptions?.startTC === 'string' && sccOptions.startTC.trim())
            ? sccOptions.startTC.trim()
            : null;

  const _normalizeStartTcMcc = (tcLabel) => {
    const raw = String(tcLabel || '').trim();
    const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})(?:\.\d+,\d+)?$/);
    if (!m) return raw;
    // MCC timecode lines typically use ':' even for DF; we accept either on input.
    return `${m[1]}:${m[2]}`;
  };

  const baseStartTcNormMcc = baseStartTcMcc ? _normalizeStartTcMcc(baseStartTcMcc) : null;
  let baseOffsetFramesMcc = 0;
  if (baseStartTcNormMcc && timeSource !== 'df-string') {
    // MCC timecode labels often use ':' even for DF; rely on the DF hint.
    // If DF, validate legality regardless of delimiter.
    if (dropFrame) {
      const mm = String(baseStartTcNormMcc).match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
      if (mm) assertLegalDropFrameLabel(`${mm[1]};${mm[2]}`, fps);
    }
    baseOffsetFramesMcc = framesFromTimecodeLabel(baseStartTcNormMcc, fps, dropFrame);
    if (!Number.isFinite(baseOffsetFramesMcc)) baseOffsetFramesMcc = 0;
  }

  const buildTimecodeBlock = (frame) => _encodeSmpte12MFromFrames(frame + baseOffsetFramesMcc, fps, dropFrame);

  // Optional CCSVCInfo (0x73) metadata (service number, language, etc.).
  // We include it once at the start of the file; most ingest pipelines only need it up-front.
  const ccsvcInfo = includeCcsSvcInfo ? {
    start: true,
    change: true,
    complete: true,
    services: [
      ...(include608Compat ? [{
        serviceNumber: 0,      // legacy/608
        language: primaryLanguage,
        digitalCc: false,
        line21Field: 0
      }] : []),
      ...serviceConfigs.map((svc) => ({
        serviceNumber: svc.serviceNumber,
        language: svc.language,
        digitalCc: true,
        easyReader: false,
        wideAspectRatio: true
      }))
    ]
  } : null;

  const writeCdpLine = (frame, dtvccChunk) => {
    if (typeof apply608EventsForFrame === 'function') {
      try { apply608EventsForFrame(frame); } catch (e) {
        // Do not hard-fail MCC generation on derived-608 scheduling issues.
        warnings.push(`608 event scheduling error at frame ${frame}: ${e?.message || String(e)}`);
      }
    }

    const tcBlock = includeCdpTimecode ? buildTimecodeBlock(frame) : null;
    // Capacity for 608 in this frame = 31 - 708 triplets
    const n708Triplets = Math.ceil((dtvccChunk.length || 0) / 2);
    let roomFor608 = Math.max(0, cdpCaps.maxTriplets - n708Triplets);
    roomFor608 = Math.min(roomFor608, cdpCaps.max608Triplets);
    const cc608Now = cc608Queue.splice(0, roomFor608);
    const includeSvcInfo = !!(ccsvcInfo && !ccsvcInfoEmitted && frame === 0);
    const cdp = _cea708.buildCdpForDtvcc({
      dtvccBytes: dtvccChunk,
      frameRateCode,
      sequenceCounter: cdpSeq & 0xffff,
      timecode: tcBlock,
      ccsvcInfo: includeSvcInfo ? ccsvcInfo : null,
      cc608WordsF1: cc608Now,
      maxTriplets: cdpCaps.maxTriplets,
      padCcDataToCapacity
    });
    const anc = _wrapANC291(Array.from(cdp));
    const tcRaw = formatTimecodeFromFrames(frame + baseOffsetFramesMcc, dropFrame, fps, 'colon');
    // MCC timecode lines typically use ':' even for DF; normalize delimiter for compatibility.
    const tc = String(tcRaw || '').replace(';', ':');
    const tcSuffix = (emitMccTimecodeSuffix && mccTimecodeSuffix)
      ? `.${mccTimecodeSuffix.field},${mccTimecodeSuffix.line}`
      : '';
    const hexBytes = Array.from(anc).map(b => b.toString(16).padStart(2, '0').toUpperCase());
    const hexSpaced = hexBytes.join(' ');
    const hexContig = hexBytes.join('');
    const payload = useTelestreamCompression ? _compressMccLineHex(hexSpaced) : hexContig;
    lines.push(`${tc}${tcSuffix}\t${payload}\r\n`);
    cdpSeq = (cdpSeq + 1) & 0xffff;
    if (includeSvcInfo) ccsvcInfoEmitted = true;
  };

  const writeEmptyCdp = (frame) => writeCdpLine(frame, []);

  const startSecondsForSegment = (seg) => {
    if (!seg) return 0;
    if (timeSource === 'df-string' && seg.timecodes) {
      const pref = dropFrame
        ? (seg.timecodes?.df?.start || seg.timecodes?.ndf?.start)
        : (seg.timecodes?.ndf?.start || seg.timecodes?.df?.start);
      if (pref) {
        if (dropFrame) {
          const mm = String(pref).match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
          if (mm) assertLegalDropFrameLabel(`${mm[1]};${mm[2]}`, fps);
        }
        return parseTimeMs(pref, fps, dropFrame) / 1000;
      }
    }
    if (Number.isFinite(seg.start)) return seg.start;
    if (Number.isFinite(seg.msStart)) return seg.msStart / 1000;
    const fallback = seg.timecodes?.df?.start || seg.timecodes?.ndf?.start;
    return fallback ? (parseTimeMs(fallback, fps, dropFrame) / 1000) : 0;
  };

  const endSecondsForSegment = (seg, startSeconds) => {
    if (!seg) return startSeconds;
    if (Number.isFinite(seg.end)) return seg.end;
    if (Number.isFinite(seg.msEnd)) return seg.msEnd / 1000;
    let label = null;
    if (seg.timecodes) {
      label = (timeSource === 'df-string')
        ? (dropFrame
          ? (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end)
          : (seg.timecodes?.ndf?.end || seg.timecodes?.df?.end))
        : (seg.timecodes?.df?.end || seg.timecodes?.ndf?.end);
    }
    if (label && dropFrame) {
      const mm = String(label).match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
      if (mm) assertLegalDropFrameLabel(`${mm[1]};${mm[2]}`, fps);
    }
    return label ? (parseTimeMs(label, fps, dropFrame) / 1000) : startSeconds;
  };

  const endFrameForSegment = (seg) => {
    const startSeconds = startSecondsForSegment(seg);
    const endSeconds = endSecondsForSegment(seg, startSeconds);
    return Math.max(0, toFrameEnd(endSeconds, fps));
  };

  // 608 wrapping helper (required primitive).
  // This is intentionally conservative and Milestone-0 oriented:
  // - normalize for 608
  // - wrap to maxCols (defaults 32)
  // - clamp to maxLines (defaults 2)
  // Later milestones will replace this with a rule-driven compat generator.
  function wrapTextAndClamp608(inputText, opts = {}) {
    return wrapTextAndClamp608WithMeta(inputText, opts).lines;
  }

  function build608WordsForCue(lines, opts = {}) {
    const ch = Math.max(1, Math.min(4, Number(opts.channel) || 1));
    const alignment = opts.alignment || 'left';
    const words = build608WordsForPopOn(lines, alignment, opts);
    const eocWord = ctrl('2f', ch);
    while (words.length && words[words.length - 1] === eocWord) words.pop();
    return words;
  }

  const cc608Eoc = (channel) => ctrl('2f', channel); // EOC
  const cc608Edm = (channel) => ctrl('2c', channel); // EDM

  const startFrameForSegment = (seg) => {
    if (!seg) return Infinity;
    const startSeconds = startSecondsForSegment(seg);
    if (timeSource === 'df-string' && seg?.timecodes) {
      const labelStart = dropFrame
        ? (seg.timecodes?.df?.start || seg.timecodes?.ndf?.start)
        : (seg.timecodes?.ndf?.start || seg.timecodes?.df?.start);
      const hasStartLabel = typeof labelStart === 'string' && labelStart.length > 0;
      if (dropFrame && hasStartLabel) {
        const mm = String(labelStart).match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
        if (mm) assertLegalDropFrameLabel(`${mm[1]};${mm[2]}`, fps);
      }
      if (hasStartLabel) {
        try {
          const sec = parseTimeMs(labelStart, fps, dropFrame) / 1000;
          if (Number.isFinite(sec)) return Math.max(0, toFrameStart(sec, fps));
        } catch {}
      }
      return Math.max(0, toFrameStart(startSeconds, fps));
    }
    return Math.max(0, toFrameStart(startSeconds, fps));
  };

  // ---------------------------------------------------------------------------
  // Milestone 4: Rule-driven 608 compatibility generation (derived 608 track)
  // ---------------------------------------------------------------------------
  // 708 layout is authored independently and 608 (when enabled) is generated
  // as a separate, compatibility-first track (with optional splitting).
  //
  // This block:
  //  - derives 608 cues from canonical text (or uses provided derived608Cues)
  //  - applies per-cue overrides (seg.compat608 / seg.compat608Text)
  //  - wraps to 32 cols / 2 lines (respecting safe margins)
  //  - auto-splits within the cue window on overflow
  //  - optionally applies bounded ripple to satisfy min duration / CPS / WPM
  //  - schedules 608 preload/EOC/EDM independently of 708 cue boundaries
  let derived608LastEventFrame = null;
  let derived608EventsByFrame = null;
  let derived608EocWordsRef = null;
  let _derived608EdmWordsRef = null;
  let derived608FileStartRippleShifted = false;

  if (useDerived608Track) {
    const rawRules = (compatGenerationRulesOption && typeof compatGenerationRulesOption === 'object')
      ? compatGenerationRulesOption
      : ((sccOptions && typeof sccOptions === 'object') ? (sccOptions.compatGenerationRules || null) : null);

    const _num = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const _bool = (v, d) => (v === undefined || v === null) ? d : !!v;

    // Base compat rules (defaults chosen to be "normal broadcast safe")
    const compatRules = {
      maxCols: Math.max(1, Math.min(32, Math.floor(_num(rawRules?.maxCols ?? rawRules?.maxCols608 ?? rawRules?.maxCharsPerLine ?? maxChars608, maxChars608)))),
      maxLines: Math.max(1, Math.min(2, Math.floor(_num(rawRules?.maxLines ?? rawRules?.maxLines608 ?? rawRules?.maxLinesPerBlock ?? maxLines608, maxLines608)))),
      minDurationSec: Math.max(0, _num(rawRules?.minDurationSec ?? rawRules?.minDurationSeconds ?? 0.8, 0.8)),
      minGapSec: Math.max(0, _num(rawRules?.minGapSec ?? rawRules?.minGapSeconds ?? 0.1, 0.1)),
      maxCps: _num(rawRules?.maxCps ?? rawRules?.maxCPS ?? rawRules?.cps ?? 20, 20),
      maxWpm: _num(rawRules?.maxWpm ?? rawRules?.maxWPM ?? rawRules?.wpm ?? 180, 180),
      preferLinguisticBreaks: _bool(rawRules?.preferLinguisticBreaks, true),
      preserveSpeakerBoundaries: _bool(rawRules?.preserveSpeakerBoundaries, true),
      avoidOrphanWords: _bool(rawRules?.avoidOrphanWords, true),
      // 608 wrap shaping (line breaks, speaker labels, punctuation, hyphenation)
      allowExplicitLineBreaks: _bool(rawRules?.allowExplicitLineBreaks, false),
      smartWrap: _bool(rawRules?.smartWrap ?? rawRules?.wrapSmart, true),
      hyphenateLongWords: _bool(rawRules?.hyphenateLongWords ?? rawRules?.hyphenate, true),
      dontSplitNumbersTimecodes: _bool(rawRules?.dontSplitNumbersTimecodes ?? rawRules?.dontSplitNumbers ?? rawRules?.dontSplitTimecodes, true),
      avoidLeadingPunctuation: _bool(rawRules?.avoidLeadingPunctuation, true),
      preferKeepSpeakerLabelWithFirstWords: _bool(rawRules?.preferKeepSpeakerLabelWithFirstWords ?? rawRules?.preferSpeakerLabelWithFirstWords, true),
      keepLastWordWithPunctuation: _bool(rawRules?.keepLastWordWithPunctuation ?? rawRules?.keepPunctuationWithWord, true),
      // IMPORTANT: default OFF.
      // Ripple shifting the 608 compatibility timings (to satisfy min duration / CPS / WPM)
      // is powerful but surprising when you expect 608 to stay aligned to the 708 authoring.
      // Only enable it explicitly.
      allowBoundedRipple: _bool(rawRules?.allowBoundedRipple ?? rawRules?.allowRipple ?? rawRules?.ripple, false),
      // When allowBoundedRipple is enabled: how far the 608 compatibility track is allowed to drift.
      maxShiftSec: Math.max(0, _num(rawRules?.maxShiftSec ?? rawRules?.maxRippleSec ?? 1.0, 1.0)),
      maxTotalShiftSec: Math.max(0, _num(rawRules?.maxTotalShiftSec ?? rawRules?.maxTotalRippleSec ?? 6.0, 6.0)),
      maxPartsPerCue: Math.max(1, Math.min(10, Math.floor(_num(rawRules?.maxPartsPerCue ?? rawRules?.maxParts ?? 4, 4))))
    };

    // If the caller supplied QC-like settings nested under `qc`, prefer those.
    if (rawRules && typeof rawRules === 'object' && rawRules.qc && typeof rawRules.qc === 'object') {
      compatRules.minDurationSec = Math.max(0, _num(rawRules.qc.minDurationSec ?? rawRules.qc.minDurationSeconds ?? compatRules.minDurationSec, compatRules.minDurationSec));
      compatRules.minGapSec = Math.max(0, _num(rawRules.qc.minGapSec ?? rawRules.qc.minGapSeconds ?? compatRules.minGapSec, compatRules.minGapSec));
      compatRules.maxCps = _num(rawRules.qc.maxCps ?? rawRules.qc.maxCPS ?? compatRules.maxCps, compatRules.maxCps);
      compatRules.maxWpm = _num(rawRules.qc.maxWpm ?? rawRules.qc.maxWPM ?? compatRules.maxWpm, compatRules.maxWpm);
    }

    const minGapFrames = Math.max(0, secondsToFrames(compatRules.minGapSec, fps, 'ceil'));
    const minDurationFrames = Math.max(1, secondsToFrames(compatRules.minDurationSec, fps, 'ceil'));
    const maxShiftFrames = Math.max(0, secondsToFrames(compatRules.maxShiftSec, fps, 'ceil'));
    const maxTotalShiftFrames = Math.max(0, secondsToFrames(compatRules.maxTotalShiftSec, fps, 'ceil'));

    // Phase 1.2: optional per-cue 608 retime overrides (start/end) applied to the derived compatibility track only.
    const _resolveOverrideSeconds = (value) => {
      if (value == null) return null;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      const s = String(value).trim();
      if (!s) return null;
      const ms = parseTimeMs(s, fps, dropFrame);
      if (!Number.isFinite(ms)) return null;
      if (ms === 0) {
        const looksZero = /^(0+(\.0+)?)$/.test(s) || /^00:00:00([:;.]00)?$/.test(s);
        if (!looksZero) return null;
      }
      return ms / 1000;
    };

    const _startSecondsForSeg608 = (seg) => {
      const o608 = (seg && seg.overrides && typeof seg.overrides === 'object') ? (seg.overrides['608'] || null) : null;
      const overrideStart = _resolveOverrideSeconds(o608?.start);
      return (overrideStart != null) ? overrideStart : startSecondsForSegment(seg);
    };

    const _endSecondsForSeg608 = (seg, startSec608) => {
      const o608 = (seg && seg.overrides && typeof seg.overrides === 'object') ? (seg.overrides['608'] || null) : null;
      const overrideEnd = _resolveOverrideSeconds(o608?.end);
      return (overrideEnd != null) ? overrideEnd : endSecondsForSegment(seg, startSec608);
    };

    const startFrameForSegment608 = (seg) => toFrameStart(_startSecondsForSeg608(seg), fps);
    const endFrameForSegment608 = (seg) => {
      const startSec = _startSecondsForSeg608(seg);
      const endSec = _endSecondsForSeg608(seg, startSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        const s0 = startSecondsForSegment(seg);
        const e0 = endSecondsForSegment(seg, s0);
        return toFrameEnd(e0, fps);
      }
      return toFrameEnd(endSec, fps);
    };

    const HANGERS = new Set([
      'a','an','the','to','of','and','or','but','for','in','on','at','with','from','by','as','into','onto','over','under','about','before','after','between','through'
    ]);

    const normalizeCompatText = (s) => _normalizeForCea608(_stripSccPlacementTags(String(s || '')));
    const countWords = (s) => {
      const t = normalizeCompatText(s).trim();
      return t ? t.split(/\s+/).filter(Boolean).length : 0;
    };
    const countCharsNoSpace = (s) => Array.from(normalizeCompatText(s).replace(/\s+/g, '')).length;

    const requiredFramesForText = (s) => {
      const chars = countCharsNoSpace(s);
      const words = countWords(s);
      const maxCps = (Number.isFinite(compatRules.maxCps) && compatRules.maxCps > 0) ? compatRules.maxCps : null;
      const maxWpm = (Number.isFinite(compatRules.maxWpm) && compatRules.maxWpm > 0) ? compatRules.maxWpm : null;
      const cpsReq = maxCps ? (chars / maxCps) : 0;
      const wpmReq = maxWpm ? ((words * 60) / maxWpm) : 0;
      const secReq = Math.max(compatRules.minDurationSec, cpsReq, wpmReq);
      return Math.max(1, secondsToFrames(secReq, fps, 'ceil'));
    };

    const wrap608Meta = (text) => wrapTextAndClamp608WithMeta(text, {
      maxCols: compatRules.maxCols,
      maxLines: compatRules.maxLines,
      allowExplicitLineBreaks: compatRules.allowExplicitLineBreaks,
      wrap608: {
        smartWrap: compatRules.smartWrap,
        hyphenateLongWords: compatRules.hyphenateLongWords,
        dontSplitNumbersTimecodes: compatRules.dontSplitNumbersTimecodes,
        avoidLeadingPunctuation: compatRules.avoidLeadingPunctuation,
        preferKeepSpeakerLabelWithFirstWords: compatRules.preferKeepSpeakerLabelWithFirstWords,
        avoidOrphanWords: compatRules.avoidOrphanWords,
        keepLastWordWithPunctuation: compatRules.keepLastWordWithPunctuation
      }
    });

    // Overrides are authored specifically for 608. Treat explicit "\n" as HARD breaks
    // (editor intent) even if the derived-track policy treats canonical 708 breaks as soft.
    const wrap608MetaOverride = (text) => wrapTextAndClamp608WithMeta(text, {
      maxCols: compatRules.maxCols,
      maxLines: compatRules.maxLines,
      allowExplicitLineBreaks: true,
      wrap608: {
        smartWrap: compatRules.smartWrap,
        hyphenateLongWords: compatRules.hyphenateLongWords,
        dontSplitNumbersTimecodes: compatRules.dontSplitNumbersTimecodes,
        avoidLeadingPunctuation: compatRules.avoidLeadingPunctuation,
        preferKeepSpeakerLabelWithFirstWords: compatRules.preferKeepSpeakerLabelWithFirstWords,
        avoidOrphanWords: compatRules.avoidOrphanWords,
        keepLastWordWithPunctuation: compatRules.keepLastWordWithPunctuation
      }
    });
    const fits608 = (meta) => !!(meta && meta.lines && meta.lines.length && !meta.overflowed && !meta.truncated);

    const chooseSplit = (text) => {
      const t = normalizeCompatText(text).trim();
      const words = t ? t.split(/\s+/).filter(Boolean) : [];
      if (words.length < 2) return [String(text || ''), ''];

      // Candidate breakpoints between words.
      const candidates = [];
      for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1] || '';
        const prevClean = prev.toLowerCase().replace(/[^a-z0-9']+/g, '');
        const isSentenceEnd = /[.!?]["')\]]?$/.test(prev);
        const isClauseEnd = /[;:]["')\]]?$/.test(prev);
        const isComma = /[,]["')\]]?$/.test(prev);

        let score = Math.abs((i / words.length) - 0.5); // balance (lower is better)

        // Prefer punctuation.
        if (isSentenceEnd) score -= 0.25;
        else if (isClauseEnd) score -= 0.18;
        else if (isComma) score -= 0.10;

        // Avoid leaving a hanging function word at the end of the first part.
        if (compatRules.avoidOrphanWords && HANGERS.has(prevClean)) score += 0.35;

        // Avoid microscopic halves.
        if (i < 2 || (words.length - i) < 2) score += 0.40;

        candidates.push({ i, score });
      }

      candidates.sort((a, b) => a.score - b.score);
      const best = candidates[0]?.i ?? Math.floor(words.length / 2);

      const left = words.slice(0, best).join(' ').trim();
      const right = words.slice(best).join(' ').trim();
      return [left, right];
    };

    const splitTextToFit608 = (text, _cueIndex) => {
      const parts = [String(text || '').trim()].filter(Boolean);
      let guard = 0;
      while (guard++ < 200) {
        // Find the worst part that still overflows/truncates.
        let idxToSplit = -1;
        let worstScore = -1;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          const meta = wrap608Meta(p);
          const bad = !fits608(meta);
          if (!bad) continue;
          const score = countCharsNoSpace(p);
          if (score > worstScore) {
            worstScore = score;
            idxToSplit = i;
          }
        }
        if (idxToSplit < 0) break;
        if (parts.length >= compatRules.maxPartsPerCue) break;

        const target = parts[idxToSplit];
        const [a, b] = chooseSplit(target);
        if (!b || !String(b).trim()) break;
        parts.splice(idxToSplit, 1, a.trim(), b.trim());
      }
      return parts.filter(p => String(p).trim().length > 0);
    };

    const allocatePartsWithinWindow = (startFrame, endFrame, partTexts, sourceCtx = {}) => {
      const availableFrames = Math.max(1, (endFrame - startFrame));
      const n = partTexts.length || 1;
      const gapFramesTotal = Math.max(0, (n - 1) * minGapFrames);
      const usableFrames = Math.max(1, availableFrames - gapFramesTotal);

      const reqFrames = partTexts.map(t => Math.max(minDurationFrames, requiredFramesForText(t)));
      const reqSum = reqFrames.reduce((a, b) => a + b, 0);

      // Start with required frames, then proportionally distribute extra if we have it.
      let alloc = new Array(n).fill(1);
      let needsReview = false;

      if (reqSum <= usableFrames) {
        alloc = reqFrames.slice();
        let extra = usableFrames - reqSum;
        if (extra > 0) {
          // Distribute extra proportionally to required frames.
          const denom = Math.max(1, reqSum);
          for (let i = 0; i < n; i++) {
            const add = Math.floor(extra * (reqFrames[i] / denom));
            alloc[i] += add;
          }
          // Fix rounding drift.
          let drift = usableFrames - alloc.reduce((a, b) => a + b, 0);
          while (drift > 0) { alloc[alloc.length - 1] += 1; drift--; }
        }
      } else {
        // Not enough time in-window to satisfy CPS/WPM/minDuration; allocate proportionally and flag.
        needsReview = true;
        const denom = Math.max(1, reqSum);
        let used = 0;
        for (let i = 0; i < n; i++) {
          const share = Math.max(1, Math.floor(usableFrames * (reqFrames[i] / denom)));
          alloc[i] = share;
          used += share;
        }
        // Fix rounding drift.
        let drift = usableFrames - used;
        while (drift > 0) { alloc[alloc.length - 1] += 1; drift--; }
        while (drift < 0) {
          // Take frames from the largest alloc.
          let k = 0;
          for (let i = 1; i < alloc.length; i++) if (alloc[i] > alloc[k]) k = i;
          if (alloc[k] <= 1) break;
          alloc[k] -= 1;
          drift += 1;
        }
      }

      const out = [];
      let cursor = startFrame;
      for (let i = 0; i < n; i++) {
        const partStart = cursor;
        const partEnd = (i === n - 1) ? endFrame : Math.min(endFrame, partStart + alloc[i]);
        cursor = partEnd + minGapFrames;

        out.push({
          ...sourceCtx,
          startFrame: partStart,
          endFrame: Math.max(partStart + 1, partEnd),
          text: partTexts[i],
          requiredFrames: reqFrames[i],
          needsReview
        });
      }
      return out;
    };

    const normalizeProvidedDerivedTrack = (derivedCues) => {
      const out = [];
      for (let i = 0; i < derivedCues.length; i++) {
        const c = derivedCues[i];
        if (!c) continue;

        const startFrame = Number.isFinite(c.startFrame) ? Math.max(0, Math.floor(c.startFrame)) : toFrameStart(Number(c.start) || 0, fps);
        const endFrame = Number.isFinite(c.endFrame) ? Math.max(0, Math.ceil(c.endFrame)) : toFrameEnd(Number(c.end) || 0, fps);
        const sourceIndex = Number.isFinite(c.sourceIndex) ? c.sourceIndex : (Number.isFinite(c.sourceIdx) ? c.sourceIdx : null);
        const sourceCueId = (c.sourceCueId != null) ? c.sourceCueId : (c.cueId != null ? c.cueId : null);

        const rawText = (typeof c.compat608Text === 'string') ? c.compat608Text : (typeof c.text === 'string' ? c.text : null);
        const lines = Array.isArray(c.lines) ? c.lines : (rawText != null ? wrapTextAndClamp608(rawText, { maxCols: compatRules.maxCols, maxLines: compatRules.maxLines }) : []);
        if (!lines || !lines.length) continue;

        out.push({
          sourceIndex,
          sourceCueId,
          startFrame,
          endFrame: Math.max(startFrame + 1, endFrame),
          text: rawText != null ? rawText : lines.join('\n'),
          lines,
          requiredFrames: requiredFramesForText(rawText != null ? rawText : lines.join(' ')),
          needsReview: !!c.needsReview
        });
      }
      return out;
    };

    const generateDerivedTrackFromSegments = () => {
      const out = [];
      for (let segIndex = 0; segIndex < segs.length; segIndex++) {
        const seg = segs[segIndex];
        const rawText = _getServiceText(seg, primaryService);
        if (!rawText || !String(rawText).trim()) continue;

        const startFrame = startFrameForSegment608(seg);
        const endFrame = endFrameForSegment608(seg);
        if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || endFrame <= startFrame) continue;

        const sourceCueId = (seg && typeof seg === 'object') ? (seg.id ?? seg.cueId ?? segIndex) : segIndex;
        const parts = splitTextToFit608(String(rawText), segIndex);
        const sourceCtx = {
          sourceIndex: segIndex,
          sourceCueId,
          sourceWindowStartFrame: startFrame,
          sourceWindowEndFrame: endFrame,
          splitCount: parts.length
        };

        const allocated = allocatePartsWithinWindow(startFrame, endFrame, parts, sourceCtx);
        for (const c of allocated) {
          const meta = wrap608Meta(c.text);
          // If we still overflow after splitting, decide based on overflowPolicy.
          if ((meta.overflowed || meta.truncated) && overflowPolicy === 'error') {
            const err = new Error(`608 overflow after auto-splitting at cue ${segIndex + 1}`);
            err.cueIndex = segIndex + 1;
            throw err;
          }

          out.push({
            ...c,
            lines: meta.lines,
            overflowed: !!meta.overflowed,
            truncated: !!meta.truncated
          });
        }
      }
      return out;
    };

    // Base derived cues: from caller or auto-generated.
    let compatCues = (Array.isArray(derived608CuesOption) && derived608CuesOption.length)
      ? normalizeProvidedDerivedTrack(derived608CuesOption)
      : generateDerivedTrackFromSegments();

    // Apply per-segment 608 overrides (do NOT auto-split overrides).
    // Precedence: mute > parts > text/breaks.

    for (let segIndex = 0; segIndex < segs.length; segIndex++) {
      const seg = segs[segIndex];

      const overrideMute = _extractCompat608OverrideMute(seg);
      const overrideParts = _extractCompat608OverrideParts(seg);

      // If parts exist, ignore any text/break overrides.
      const overrideText = (overrideParts && overrideParts.length)
        ? null
        : _extractCompat608OverrideText(seg);

      // Explicit mute should suppress any derived 608 output for this source, regardless of timing validity.
      if (overrideMute) {
        compatCues = compatCues.filter(c => c.sourceIndex !== segIndex);
        continue;
      }

      if (!(overrideParts && overrideParts.length) && overrideText == null) continue;

      const startFrame = startFrameForSegment608(seg);
      const endFrame = endFrameForSegment608(seg);
      if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || endFrame <= startFrame) continue;

      // Remove any existing derived cues for this source.
      compatCues = compatCues.filter(c => c.sourceIndex !== segIndex);

      const sourceCueId = (seg && typeof seg === 'object') ? (seg.id ?? seg.cueId ?? segIndex) : segIndex;

      if (overrideParts && overrideParts.length) {
        const sourceCtx = {
          sourceIndex: segIndex,
          sourceCueId,
          sourceWindowStartFrame: startFrame,
          sourceWindowEndFrame: endFrame,
          splitCount: overrideParts.length,
          override: true,
          overrideParts: true
        };

        const allocated = allocatePartsWithinWindow(startFrame, endFrame, overrideParts, sourceCtx);
        for (let p = 0; p < allocated.length; p++) {
          const c = allocated[p];
          const meta = wrap608MetaOverride(String(c.text));
          if ((meta.overflowed || meta.truncated) && overflowPolicy === 'error') {
            const err = new Error(`608 override part overflows 32x2 at cue ${segIndex + 1}.${p + 1}`);
            err.cueIndex = segIndex + 1;
            throw err;
          }

          const needsReview = !!c.needsReview || !!meta.overflowed || !!meta.truncated;
          compatCues.push({
            ...c,
            lines: meta.lines,
            overflowed: !!meta.overflowed,
            truncated: !!meta.truncated,
            splitIndex: p,
            splitCount: overrideParts.length,
            needsReview,
            override: true,
            overrideParts: true
          });
        }
        continue;
      }

      if (overrideText != null) {
        const meta = wrap608MetaOverride(String(overrideText));
        if ((meta.overflowed || meta.truncated) && overflowPolicy === 'error') {
          const err = new Error(`608 override overflows 32x2 at cue ${segIndex + 1}`);
          err.cueIndex = segIndex + 1;
          throw err;
        }

        compatCues.push({
          sourceIndex: segIndex,
          sourceCueId,
          sourceWindowStartFrame: startFrame,
          sourceWindowEndFrame: endFrame,
          startFrame,
          endFrame,
          text: String(overrideText),
          lines: meta.lines,
          requiredFrames: requiredFramesForText(String(overrideText)),
          needsReview: !!meta.overflowed || !!meta.truncated,
          override: true
        });
      }
    }

    // Sort and enforce monotonic order (important for scheduling).
    compatCues.sort((a, b) => (a.startFrame - b.startFrame) || (a.endFrame - b.endFrame));

    // Optional bounded ripple: push later cues forward to satisfy min gap + duration.
    if (compatRules.allowBoundedRipple && compatCues.length) {
      const lastOriginalEnd = Math.max(...compatCues.map(c => Number.isFinite(c.sourceWindowEndFrame) ? c.sourceWindowEndFrame : c.endFrame));
      const capEndFrame = lastOriginalEnd + maxTotalShiftFrames;

      let shiftFrames = 0;
      let shiftBudget = maxTotalShiftFrames;
      let prevEnd = -Infinity;

      const adjusted = [];
      for (let i = 0; i < compatCues.length; i++) {
        const c = compatCues[i];
        const req = Math.max(minDurationFrames, Number(c.requiredFrames) || requiredFramesForText(c.text));

        let start = Math.max(0, Math.floor(c.startFrame + shiftFrames));
        let end = Math.max(start + 1, Math.floor(c.endFrame + shiftFrames));

        // Enforce minimum gap vs previous cue.
        const minStart = (Number.isFinite(prevEnd) ? (prevEnd + minGapFrames) : start);
        if (start < minStart) {
          const delta = minStart - start;
          const allow = Math.min(delta, shiftBudget, maxShiftFrames || delta);
          if (allow > 0) {
            shiftFrames += allow;
            shiftBudget -= allow;
            start += allow;
            end += allow;
          }
        }

        // Enforce required duration; if short, extend and ripple-shift subsequent cues.
        let dur = end - start;
        if (dur < req) {
          const extra = Math.min(req - dur, shiftBudget, maxShiftFrames || (req - dur));
          if (extra > 0) {
            end += extra;
            shiftFrames += extra;
            shiftBudget -= extra;
            dur = end - start;
          }
        }

        if (end > capEndFrame) end = capEndFrame;
        if (end <= start) end = start + 1;

        const needsReview = !!c.needsReview || (start !== c.startFrame) || (end !== c.endFrame) || (end - start) < req;
        adjusted.push({ ...c, startFrame: start, endFrame: end, needsReview });
        prevEnd = end;
      }

      compatCues = adjusted;
    }

    // Subtitle Editor: propagate per-cue 608 placement overrides (row/col) from the
    // canonical segments into the derived 608 compatibility cues.
    // Without this, MCC exports ignore manual 608 repositioning and fall back to default alignment.
    try {
      const hasPlacement = (pl) => {
        if (!pl || typeof pl !== 'object') return false;
        if (Array.isArray(pl)) return pl.some(hasPlacement);
        if (Number.isFinite(pl.row) || Number.isFinite(pl.col)) return true;
        for (const v of Object.values(pl)) {
          if (v && typeof v === 'object' && (Number.isFinite(v.row) || Number.isFinite(v.col))) return true;
        }
        return false;
      };

      const clonePlacement = (pl) => {
        if (!pl || typeof pl !== 'object') return null;
        if (Array.isArray(pl)) return pl.map(v => ((v && typeof v === 'object') ? { ...v } : v));
        return { ...pl };
      };

      for (const cue of compatCues) {
        if (!cue || typeof cue !== 'object') continue;
        // Prefer Phase-1 overrides placement when present.
        if (hasPlacement(cue.sccPlacement) || hasPlacement(cue?.overrides?.['608']?.placement)) continue;
        const idx = Number.isFinite(Number(cue.sourceIndex)) ? Math.trunc(Number(cue.sourceIndex)) : null;
        if (idx == null || idx < 0 || idx >= segs.length) continue;
        const src = segs[idx];
        const srcPl = (() => {
          if (!src || typeof src !== 'object') return null;
          const p = src?.overrides?.['608']?.placement;
          if (Array.isArray(p) && p.length) return p;
          return src.sccPlacement;
        })();
        if (!hasPlacement(srcPl)) continue;
        cue.sccPlacement = clonePlacement(srcPl);
      }
    } catch { /* best-effort */ }

    // NEW: Broadcast-safe guard (no guessing).
    // If exporting a corrected MCC from an imported MCC with 608 compatibility enabled,
    // require explicit PAC row/col for each visible 608 line. Fail instead of defaulting.
    if (requireCompat608Placement) {
      const missing = [];
      for (const cue of compatCues) {
        if (!cue) continue;
        const lines = Array.isArray(cue.lines) ? cue.lines : String(cue.text || '').split('\n');
        const nonEmpty = lines.map(l => String(l ?? '').trim()).filter(Boolean);
        const need = Math.max(1, Math.min(2, nonEmpty.length || 1));
        const pl = Array.isArray(cue.sccPlacement) ? cue.sccPlacement : (Array.isArray(cue?.overrides?.['608']?.placement) ? cue.overrides['608'].placement : null);
        let ok = true;
        for (let i = 0; i < need; i++) {
          const p = pl?.[i];
          if (!p || !Number.isFinite(Number(p.row)) || !Number.isFinite(Number(p.col))) { ok = false; break; }
        }
        if (!ok) {
          missing.push(`@${Number(cue.start || 0).toFixed(3)}s`);
          if (missing.length >= 8) break;
        }
      }
      if (missing.length) {
        throw new Error(`MCC export blocked: missing required 608 placement for ${missing.length}+ cue(s) (examples: ${missing.join(', ')}).`);
      }
    }

    // Build frame-based 608 event schedule.
    const eventsByFrame = new Map();
    const ensureFrame = (fr) => {
      const f = Math.max(0, Math.floor(fr));
      let ev = eventsByFrame.get(f);
      if (!ev) {
        ev = { reset: null, enqueue: [] };
        eventsByFrame.set(f, ev);
      }
      return { f, ev };
    };

    const enqueueAt = (fr, words) => {
      if (!words || !words.length) return;
      const { ev } = ensureFrame(fr);
      ev.enqueue.push(words);
    };

    const resetAt = (fr, words) => {
      if (!words || !words.length) return;
      const { ev } = ensureFrame(fr);
      ev.reset = words;
    };

    const cc608Ch = (sccOptions && sccOptions.cc608Channel)
      ? Math.max(1, Math.min(2, Math.floor(Number(sccOptions.cc608Channel) || 1)))
      : 1;

    const eocWord = parseInt(cc608Eoc(cc608Ch), 16) & 0xFFFF;
    const edmWord = parseInt(cc608Edm(cc608Ch), 16) & 0xFFFF;
    const eocWords = repeatControlCodes ? [eocWord, eocWord] : [eocWord];
    const edmWords = repeatControlCodes ? [edmWord, edmWord] : [edmWord];

    let prevShowFrame = null;
    for (let i = 0; i < compatCues.length; i++) {
      const cue = compatCues[i];
      const nextStart = (i + 1 < compatCues.length) ? compatCues[i + 1].startFrame : Infinity;

      // IMPORTANT: When authoringModel === 'true708', the canonical placement is the 708 window.
      // If we always place derived 608 at safe-left (alignment 'left'), captions can look centered
      // in the 708 preview (because the *window* is centered) but hard-left in 608.
      //
      // For the derived 608 fallback track, anchor the *block* using the 708 window anchor
      // (mcc708Window), then apply the requested alignment *within that block*.
      // This makes 608 and 708 previews visually consistent.
      const hasPlacementTags = Array.isArray(cue?.lines)
        ? cue.lines.some((ln) => /\{\s*(?:row|r|col|c|pac)\s*:/i.test(String(ln || '')))
        : false;

      const placementOverride = (
        Array.isArray(cue?.overrides?.['608']?.placement) && cue.overrides['608'].placement.length
      ) ? cue.overrides['608'].placement : (cue?.sccPlacement ?? null);
      const _placementForIndex = (idx) => {
        if (!placementOverride) return null;
        if (Array.isArray(placementOverride)) return placementOverride[idx] || null;
        if (typeof placementOverride === 'object') {
          const looksLikeSingle = Number.isFinite(placementOverride.row)
            || Number.isFinite(placementOverride.col)
            || typeof placementOverride.pac === 'string';
          if (looksLikeSingle) return (idx === 0 ? placementOverride : null);
          return placementOverride[idx] || placementOverride[String(idx)] || null;
        }
        return null;
      };

      let getRowForIndex = null;
      let getColumnStart = null;
      if (!hasPlacementTags && mcc708Window && typeof mcc708Window === 'object') {
        const safe = _normalizeSafeMargins(safeMargins608);
        const usable = Math.max(1, Math.min(32, safe.width));
        const maxIdx = Math.max(0, usable - 1);

        const anchorIdRaw = Number(mcc708Window.anchorId);
        const anchorId = Number.isFinite(anchorIdRaw) ? Math.max(0, Math.min(8, Math.trunc(anchorIdRaw))) : 7;
        const hPos = anchorId % 3; // 0 left, 1 center, 2 right

        const denom = (mcc708Window.rel === false) ? 209 : 99;
        const aHRaw = Number(mcc708Window.anchorH);
        const anchorH = Number.isFinite(aHRaw)
          ? Math.max(0, Math.min(denom, Math.trunc(aHRaw)))
          : (denom === 99 ? 50 : 105);

        // Map 708 anchorH (0..99 rel OR 0..209 abs) into the 608 safe width.
        const anchorCol = safe.left + Math.round((anchorH / denom) * maxIdx);

        // Treat the derived 608 lines as a single “window” whose width is the max line length.
        const windowWidth = (() => {
          const lens = Array.isArray(cue?.lines) ? cue.lines.map((l) => _visible608Length(l)) : [];
          const maxLen = lens.length ? Math.max(1, ...lens) : 1;
          return Math.max(1, Math.min(usable, maxLen));
        })();

        // Convert the anchor point into a requested window-left column.
        const windowLeft = (hPos === 0)
          ? anchorCol
          : (hPos === 1)
            ? (anchorCol - Math.floor(windowWidth / 2))
            : (anchorCol - windowWidth + 1);

        const clampStart = (col, lineLen) => {
          const minStart = safe.left;
          const maxStart = Math.max(minStart, safe.left + usable - Math.max(0, lineLen));
          const requested = Math.trunc(Number(col) || 0);
          return Math.max(minStart, Math.min(maxStart, requested));
        };

        // Apply justification inside the window.
        const justify = _normalizeAlignment(align) || 'left';
        const startColByIndex = new Map();

        const anchorIdV = Number.isFinite(anchorIdRaw) ? Math.max(0, Math.min(8, Math.trunc(anchorIdRaw))) : 7;
        const vPos = Math.floor(anchorIdV / 3); // 0 top, 1 middle, 2 bottom
        const denomV = (mcc708Window.rel === false) ? 74 : 99;
        const anchorVRaw = Number(mcc708Window.anchorV);
        const anchorV = Number.isFinite(anchorVRaw)
          ? Math.max(0, Math.min(denomV, Math.trunc(anchorVRaw)))
          : (denomV === 99 ? 90 : 67);
        const baseRowF = 1 + ((denomV ? anchorV / denomV : 0) * 14);

        const nonEmptyIdx = Array.isArray(cue?.lines)
          ? cue.lines
            .map((ln, idx) => {
              const plain = String(ln ?? '').replace(/\{[^}]+\}/g, '').trim();
              return plain ? idx : null;
            })
            .filter((v) => v != null)
          : [];

        const rowsByIndex = new Map();
        if (nonEmptyIdx.length === 1) {
          const r = Math.max(1, Math.min(15, Math.round(baseRowF)));
          rowsByIndex.set(nonEmptyIdx[0], r);
        } else if (nonEmptyIdx.length >= 2) {
          let top = null;
          let bottom = null;

          if (vPos === 2) {
            bottom = Math.max(2, Math.min(15, Math.round(baseRowF)));
            top = bottom - 1;
          } else if (vPos === 1) {
            top = Math.round(baseRowF - 0.5);
            top = Math.max(1, Math.min(14, top));
            bottom = top + 1;
          } else {
            top = Math.round(baseRowF);
            top = Math.max(1, Math.min(14, top));
            bottom = top + 1;
          }

          const idx0 = nonEmptyIdx[0];
          const idx1 = nonEmptyIdx[1];
          rowsByIndex.set(idx0, top);
          rowsByIndex.set(idx1, bottom);
        }

        getRowForIndex = ({ index }) => {
          const idx = Number.isFinite(index) ? index : 0;
          const ov = _placementForIndex(idx);
          if (ov && Number.isFinite(ov.row)) return ov.row;
          return rowsByIndex.has(idx) ? rowsByIndex.get(idx) : null;
        };

        getColumnStart = ({ text, index }) => {
          const idx = Number.isFinite(index) ? index : 0;
          const ov = _placementForIndex(idx);
          if (ov && Number.isFinite(ov.col)) return ov.col;
          if (startColByIndex.has(idx)) return startColByIndex.get(idx);

          const lineLen = Math.max(0, Math.min(32, _visible608Length(text)));
          const extra = Math.max(0, windowWidth - lineLen);
          let start = windowLeft;
          if (justify === 'center') start = windowLeft + Math.floor(extra / 2);
          else if (justify === 'right') start = windowLeft + extra;
          start = clampStart(start, lineLen);

          startColByIndex.set(idx, start);
          return start;
        };
      }

      // If we couldn't derive from 708, but an explicit 608 placement override exists, still honor it.
      if (!hasPlacementTags && (getRowForIndex == null || getColumnStart == null) && placementOverride) {
        if (getRowForIndex == null) {
          getRowForIndex = ({ index }) => {
            const idx = Number.isFinite(index) ? index : 0;
            const ov = _placementForIndex(idx);
            return (ov && Number.isFinite(ov.row)) ? ov.row : null;
          };
        }
        if (getColumnStart == null) {
          getColumnStart = ({ index }) => {
            const idx = Number.isFinite(index) ? index : 0;
            const ov = _placementForIndex(idx);
            return (ov && Number.isFinite(ov.col)) ? ov.col : null;
          };
        }
      }

      const cc608WordsHex = build608WordsForCue(cue.lines, {
        alignment: align,
        rowPolicy,
        safeMargins: safeMargins608,
        maxCols: compatRules.maxCols,
        maxLines: compatRules.maxLines,
        channel: cc608Ch,
        repeatControlCodes,
        repeatPreambleCodes,
        ...(getColumnStart ? { getColumnStart } : {}),
        ...(getRowForIndex ? { getRowForIndex } : {})
      });
      const cc608Words = cc608WordsHex.map(w => (parseInt(w, 16) & 0xFFFF));

      // Conservative scheduling: start preloading as soon as the non-displayed memory
      // becomes safe to overwrite (i.e., right after the previous cue is shown).
      // This gives maximum slack to absorb frames with reduced/no 608 bandwidth due to 708 packets.
      const earliestPreload = (prevShowFrame == null) ? 0 : (prevShowFrame + 1);
      const preloadStart = earliestPreload;
      if (preloadStart >= cue.startFrame) {
        // Not enough time to preload before EOC; the cue will likely drift. Flag for review.
        warnings.push(`608 compat preload starts too late (frame ${preloadStart} >= show frame ${cue.startFrame}) at derived cue ${i + 1}`);
      }

      enqueueAt(preloadStart, cc608Words);
      enqueueAt(cue.startFrame, eocWords);

      // Clear on gaps (and always on last cue).
      const shouldClear = (cue.endFrame < nextStart) || !Number.isFinite(nextStart);
      if (shouldClear) {
        // Force the clear even if there is leftover preload by *prepending* the clear
        // command at this frame. (Resetting the queue here can discard queued preload
        // for the next cue, causing truncated 608 output in some viewers.)
        resetAt(cue.endFrame, edmWords);
      }

      prevShowFrame = cue.startFrame;
    }

    derived608LastEventFrame = compatCues.length ? Math.max(...compatCues.map(c => c.endFrame)) : null;

    // Expose the schedule map and marker word arrays so we can apply the Phase 2
    // file-start ripple shift (which keeps the earliest preload clamped to frame 0
    // while moving EOC/EDM timing forward).
    derived608EventsByFrame = eventsByFrame;
    derived608EocWordsRef = eocWords;
    _derived608EdmWordsRef = edmWords;

    apply608EventsForFrame = (frame) => {
      const f = Math.floor(Number(frame));
      if (!Number.isFinite(f) || f < 0) return;

      const ev = derived608EventsByFrame ? derived608EventsByFrame.get(f) : null;
      if (!ev) return;
      if (ev.reset && ev.reset.length) {
        // Prepend priority words (EDM clears) without discarding queued preload.
        // Keeping the existing queue prevents truncating the next cue when 608 bandwidth is tight.
        cc608Queue.unshift(...ev.reset);
      }
      if (ev.enqueue && ev.enqueue.length) {
        for (const batch of ev.enqueue) {
          if (batch && batch.length) cc608Queue.push(...batch);
        }
      }
    };
  }

  // Phase 2: If we applied a file-start ripple shift to make room for MCC
  // preload packets (i.e., we inserted a small amount of headroom before the
  // first visible cue), the derived 608 schedule must be adjusted to match.
  //
  // Key nuance: the *earliest* preload is allowed to stay clamped to frame 0,
  // while EOC/EDM timing (and all later preload/show/hide events) shift forward
  // with the 708 timeline.
  const _applyFileStartRippleToDerived608 = () => {
    if (derived608FileStartRippleShifted) return;
    derived608FileStartRippleShifted = true;

    if (!useDerived608Track) return;

    const shift = Math.floor(Number(mccStartRippleShiftFrames));
    if (!Number.isFinite(shift) || shift <= 0) return;

    if (!derived608EventsByFrame || typeof derived608EventsByFrame.get !== 'function') return;

    // If we can't identify EOC batches, shifting safely isn't possible.
    const eocRef = derived608EocWordsRef;
    if (!eocRef) return;

    const shifted = new Map();
    const getOrCreate = (frame) => {
      let ev = shifted.get(frame);
      if (!ev) {
        ev = { reset: null, enqueue: [] };
        shifted.set(frame, ev);
      }
      return ev;
    };

    for (const [k, ev] of derived608EventsByFrame.entries()) {
      const frame = Math.floor(Number(k));
      if (!Number.isFinite(frame) || frame < 0 || !ev) continue;

      // Reset events (EDM) always shift with the timeline.
      if (ev.reset && ev.reset.length) {
        getOrCreate(frame + shift).reset = ev.reset;
      }

      if (ev.enqueue && ev.enqueue.length) {
        for (const batch of ev.enqueue) {
          if (!batch || !batch.length) continue;
          let outFrame;

          if (frame === 0) {
            // Keep the earliest preload clamped to frame 0, but move EOC to the shifted show frame.
            outFrame = (batch === eocRef) ? shift : 0;
          } else {
            outFrame = frame + shift;
          }

          getOrCreate(outFrame).enqueue.push(batch);
        }
      }
    }

    derived608EventsByFrame = shifted;

    // Recompute last event frame from shifted keys.
    let maxFrame = null;
    for (const k of derived608EventsByFrame.keys()) {
      const n = Number(k);
      if (Number.isFinite(n)) {
        if (maxFrame == null || n > maxFrame) maxFrame = n;
      }
    }
    derived608LastEventFrame = maxFrame;
  };

  const _derivePenLocationsFromWindowSnapshot = (windowSnapshot, lineCount) => {
    const w = (windowSnapshot && typeof windowSnapshot === 'object') ? windowSnapshot : null;
    if (!w || !w.hasSPL) return null;
    const grid = Array.isArray(w.grid) ? w.grid : null;
    if (!grid || !grid.length) return null;

    const rows = Math.max(1, Math.min(15, Number(w.rowCount) || grid.length));
    const nonEmpty = [];
    for (let r = 0; r < Math.min(rows, grid.length); r++) {
      const rowStr = String(grid[r] || '');
      if (!rowStr.trim()) continue;
      let c = 0;
      while (c < rowStr.length && rowStr[c] === ' ') c++;
      nonEmpty.push({ row: Math.max(0, Math.min(15, r)), col: Math.max(0, Math.min(63, c)) });
    }
    if (!nonEmpty.length) return null;

    const n = Math.max(0, lineCount | 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i < nonEmpty.length) {
        out.push({ row: nonEmpty[i].row, col: nonEmpty[i].col });
      } else {
        const base = nonEmpty[0];
        out.push({ row: Math.max(0, Math.min(15, base.row + i)), col: base.col });
      }
    }
    return out.length ? out : null;
  };


  const _maskForWindowIds = (ids) => {
    let mask = 0;
    if (!Array.isArray(ids)) return 0;
    for (const id of ids) {
      const wi = Number(id);
      if (!Number.isFinite(wi)) continue;
      const w = Math.max(0, Math.min(7, Math.trunc(wi)));
      mask |= (1 << w);
    }
    return mask & 0xff;
  };

  const _chooseHiddenWindowIds = (st, count, { pingPong = true } = {}) => {
    const need = Math.max(0, Math.min(8, count | 0));
    if (!need) return [];

    if (!pingPong) {
      const ids = [];
      for (let i = 0; i < need; i++) ids.push(i);
      return ids;
    }

    const visibleMask = (st && typeof st.visibleMask === 'number') ? (st.visibleMask & 0xff) : 0;
    const pp = (st && Number.isFinite(st.pingPongIndex)) ? st.pingPongIndex : 0;

    // Prefer a bank of four window IDs. With ping-pong enabled we alternate banks
    // so the next cue can be preloaded while the current cue is visible.
    const bank = pingPong ? (pp % 2) : 0;
    const preferred = [];
    const base = bank * 4;
    for (let i = 0; i < 4; i++) preferred.push(base + i);
    for (let i = 0; i < 8; i++) if (preferred.indexOf(i) === -1) preferred.push(i);

    const chosen = [];
    for (const wid of preferred) {
      if (chosen.length >= need) break;
      if (visibleMask & (1 << wid)) continue;
      chosen.push(wid);
    }
    if (chosen.length < need) return null;
    return chosen;
  };

  const useIndependentServiceTracks = !!segmentsByServiceMap && Object.keys(segmentsByServiceMap).length > 1;

  if (useIndependentServiceTracks) {
    
    // Multi-service export: schedule per-service cues independently into a single DTVCC stream.
    // This prevents service 1+ cues from being dropped when service 1 is silent or misaligned.

    const showBlocksByFrame = new Map(); // frame -> service blocks (arrays of bytes)
    const pendingTasks = []; // { kind, earliestFrame, deadlineFrame, blocks, offset, svcNum, cueStartFrame }

    const _addBlocksToFrame = (frame, blocks) => {
      if (!blocks || !blocks.length) return;
      const arr = showBlocksByFrame.get(frame) || [];
      arr.push(...blocks);
      showBlocksByFrame.set(frame, arr);
    };

    const _canFitSinglePacket = (blocks) => {
      if (!blocks || !blocks.length) return true;
      const pk = _cea708.packDTVCC(blocks, { maxPacketBytes: cdpCaps.maxDtvccPacketBytes, seqStart: 0 });
      return !!(pk && pk.packets && pk.packets.length === 1);
    };

    const _buildPreloadBlocksForPlan = (p) => {
      let preloadBytes = null;

      if (p.snapshotOk && Array.isArray(p.windowSnapshots) && p.windowSnapshots.length) {
        preloadBytes = [];
        for (let wi = 0; wi < p.windowSnapshots.length; wi++) {
          const ws = p.windowSnapshots[wi];
          const wid = (p.targetWindowIds && p.targetWindowIds[wi] != null) ? p.targetWindowIds[wi] : p.targetWindowId;
          preloadBytes.push(..._cea708.buildPreloadBytesForWindowSnapshot(ws, { windowId: wid }));
        }
      } else if (p.layoutSnapshot) {
        preloadBytes = (p.lineRuns && p.lineRuns.length)
          ? _cea708.buildPreloadBytesForLineRunsWithWindowSnapshot(p.lineRuns, p.layoutSnapshot, {
            windowId: p.targetWindowId,
            justify: p.justify708,
            ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
            ...(p.penStyle ? { pen: p.penStyle } : {}),
            ...(p.penColor ? { penColor: p.penColor } : {}),
            ...(p.penLocations ? { penLocations: p.penLocations } : {})
          })
          : _cea708.buildPreloadBytesForLinesWithWindowSnapshot(p.lines, p.layoutSnapshot, {
            windowId: p.targetWindowId,
            justify: p.justify708,
            ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
            ...(p.penStyle ? { pen: p.penStyle } : {}),
            ...(p.penColor ? { penColor: p.penColor } : {}),
            ...(p.penLocations ? { penLocations: p.penLocations } : {})
          });
      } else {
        preloadBytes = (p.lineRuns && p.lineRuns.length)
          ? _cea708.buildPreloadBytesForLineRuns(p.lineRuns, {
            windowId: p.targetWindowId,
            justify: p.justify708,
            colCount: p.colCount,
            ...(p.rowCount != null ? { rowCount: p.rowCount } : {}),
            ...(p.windowOpts || {}),
            ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
            ...(p.penStyle ? { pen: p.penStyle } : {}),
            ...(p.penColor ? { penColor: p.penColor } : {}),
            ...(p.penLocations ? { penLocations: p.penLocations } : {})
          })
          : _cea708.buildPreloadBytesForLines(p.lines, {
            windowId: p.targetWindowId,
            justify: p.justify708,
            colCount: p.colCount,
            ...(p.rowCount != null ? { rowCount: p.rowCount } : {}),
            ...(p.windowOpts || {}),
            ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
            ...(p.penStyle ? { pen: p.penStyle } : {}),
            ...(p.penColor ? { penColor: p.penColor } : {}),
            ...(p.penLocations ? { penLocations: p.penLocations } : {})
          });
      }

      return _cea708.chunkToServiceBlocks(preloadBytes, p.svc.serviceNumber, cdpCaps.maxServiceBlockDataBytes);
    };

    const _buildShowBlocksForPlan = (p) => {
      const bytes = _cea708.buildShowHideBytesForMasks({ showMask: p.showMask, hideMask: p.hideMask });
      return _cea708.chunkToServiceBlocks(bytes, p.svc.serviceNumber, cdpCaps.maxServiceBlockDataBytes);
    };

    const _buildHideBlocksForMask = (svcNum, mask) => {
      const bytes = _cea708.buildHideBytesForMask(mask);
      return _cea708.chunkToServiceBlocks(bytes, svcNum, cdpCaps.maxServiceBlockDataBytes);
    };

    const _queueTask = (task) => {
      if (!task || !task.blocks || !task.blocks.length) return;
      if (!Number.isFinite(task.earliestFrame) || !Number.isFinite(task.deadlineFrame)) return;
      if (task.deadlineFrame < task.earliestFrame) {
        // Impossible window; keep behavior deterministic by dropping the task.
        // (This can happen for extremely tight back-to-back cues.)
        return;
      }
      pendingTasks.push({ ...task, offset: 0 });
    };

    const _build708PlanForCue = (seg, cueIndex, svc, st, nextStartFrame) => {
      // These names are referenced later in the multi-service path.
      // Map them to the actual computed 708 globals so the path cannot crash.
      const maxCharsPerLine708 = maxChars708;
      const maxLinesPerBlock708 = maxLines708;
      const mcc708PenStyle = global708Pen;
      const mcc708PenColor = global708PenColor;
      const mcc708WindowStyle = global708WindowStyle;
      const mcc708Pen = global708Pen;
      // Multi-service path currently treats explicit placement as “absent” unless tags are parsed.
      // Keep it falsy to preserve existing behavior without ReferenceErrors.
      const explicitPenPlacement = null;

      const svcContent = _getServiceContent(seg, svc);
      const rawText = svcContent.text;
      const runs = Array.isArray(svcContent.runs) ? svcContent.runs : null;
      const hasRuns = !!(runs && runs.length);

      if (!rawText || !String(rawText).trim()) return null;

      const startFrame = startFrameForSegment(seg);
      const endFrame = endFrameForSegment(seg);
      if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) return null;

      const align708 = _normalizeAlignment(svc.alignment) || align;
      const maxCharsPerLine = Number.isFinite(svc.maxCharsPerLine) ? svc.maxCharsPerLine : maxCharsPerLine708;
      const maxLinesPerBlock = Number.isFinite(svc.maxLinesPerBlock) ? svc.maxLinesPerBlock : maxLinesPerBlock708;
      const overflowPolicy708 = svc.overflowPolicy || overflowPolicy;

      // Optional per-cue 708 placement override (e.g., subtitle editor click-to-place).
      // We store this as an ASS-style alignment number (\an1..\an9) because the
      // encoder already has a stable mapping from \an to CTA-708 window anchors.
      const anOverride = (() => {
        if (!seg || typeof seg !== 'object') return null;
        const p = (seg.cea708Placement && typeof seg.cea708Placement === 'object') ? seg.cea708Placement : null;
        const anRaw = (p && (p.an ?? p.assAn)) ?? seg.cea708An;
        const n = Number(anRaw);
        if (!Number.isFinite(n)) return null;
        const an = Math.max(1, Math.min(9, Math.trunc(n)));
        return _assAnTo708WindowOverride(an);
      })();

      // Phase 1.2: per-cue 708 overrides (window/style).
      // These are authored as overrides['708'] and carried through as:
      //   seg.mcc708Window (placement) and seg.mcc708WindowStyle (window style).
      const cueWindowOverride = (() => {
        if (!seg || typeof seg !== 'object') return null;
        const raw = (() => {
          if (seg.mcc708Window && typeof seg.mcc708Window === 'object') return seg.mcc708Window;
          const o = seg.overrides;
          const o708 = (o && typeof o === 'object') ? o['708'] : null;
          const w = (o708 && typeof o708 === 'object') ? o708.window : null;
          if (w && typeof w === 'object') return w;
          return null;
        })();
        if (!raw) return null;
        const out = {};
        if (raw.rel != null) out.rel = !!raw.rel;
        if (raw.relative != null) out.rel = !!raw.relative;
        if (raw.anchorId != null) out.anchorId = raw.anchorId;
        if (raw.anchorV != null) out.anchorV = raw.anchorV;
        if (raw.anchorH != null) out.anchorH = raw.anchorH;
        if (raw.justify != null) {
          const j = String(raw.justify).toLowerCase();
          if (j === 'centre') out.justify = 'center';
          else if (j === 'left' || j === 'center' || j === 'right') out.justify = j;
        }
        return Object.keys(out).length ? out : null;
      })();

      const cueWindowStyleOverride = (() => {
        if (!seg || typeof seg !== 'object') return null;
        const raw = (() => {
          if (seg.mcc708WindowStyle && typeof seg.mcc708WindowStyle === 'object') return seg.mcc708WindowStyle;
          const o = seg.overrides;
          const o708 = (o && typeof o === 'object') ? o['708'] : null;
          const w = (o708 && typeof o708 === 'object') ? (o708.windowStyle || o708.mcc708WindowStyle) : null;
          if (w && typeof w === 'object') return w;
          return null;
        })();
        if (!raw) return null;
        try { return _cea708.parseCea708WindowStyle(raw); } catch { return null; }
      })();

      const placementOverride = (anOverride || cueWindowOverride)
        ? { ...(anOverride || {}), ...(cueWindowOverride || {}) }
        : null;

      const wrap708 = hasRuns
        ? (() => {
          const w = _cea708.wrapRunsToLines(runs, maxCharsPerLine, maxLinesPerBlock, {
            overflowPolicy: overflowPolicy708,
            overflowCtx: { cueIndex }
          });
          return { ...w, window: null, justify: null, pen: null };
        })()
        : wrapTextAndClamp708Rich(rawText, maxCharsPerLine, maxLinesPerBlock, {
          overflowPolicy: overflowPolicy708,
          overflowCtx: { cueIndex }
        });

      const cueTextPlain = Array.isArray(wrap708.lines)
        ? wrap708.lines.map((l) => String(l || '').replace(/<[^>]*>/g, '')).join('\n').trim()
        : '';

      const segCea708 = (seg && typeof seg === 'object') ? seg.cea708 : null;
      const segCea708SourceTextPlain = (seg && typeof seg === 'object') ? seg.cea708SourceTextPlain : null;
      const has708Snapshot = !!(segCea708 && Array.isArray(segCea708.windows) && segCea708.windows.length);
      const srcPlain = (segCea708SourceTextPlain || null) != null ? String(segCea708SourceTextPlain).trim() : null;
      // If runs are present, prefer the runs-driven encoder path (so styles are emitted).
      const snapshotOk = hasRuns ? false : !!(has708Snapshot && srcPlain != null && srcPlain === cueTextPlain);

      let windowSnapshots = snapshotOk ? segCea708.windows.slice() : null;

      let layoutSnapshot = (preserveImported708Layout && has708Snapshot) ? segCea708.windows[0] : null;
      if (snapshotOk) layoutSnapshot = null;

      // If a per-cue placement override exists, apply it to any imported snapshots we might reuse.
      // This keeps round-tripped MCC window styling intact while still allowing editorial repositioning.
      const _applyPlacementOverrideToWindowSnapshot = (ws) => {
        const w = (ws && typeof ws === 'object') ? ws : {};
        if (!placementOverride) return w;

        const rel = (placementOverride.rel != null)
          ? !!placementOverride.rel
          : ((placementOverride.relative != null) ? !!placementOverride.relative : true);

        return {
          ...w,
          relative: rel,
          ...(placementOverride.anchorId != null ? { anchorId: placementOverride.anchorId } : {}),
          ...(placementOverride.anchorV != null ? { anchorV: placementOverride.anchorV } : {}),
          ...(placementOverride.anchorH != null ? { anchorH: placementOverride.anchorH } : {}),
          ...(placementOverride.justify != null ? { justify: placementOverride.justify } : {})
        };
      };

      if (placementOverride) {
        if (windowSnapshots && windowSnapshots.length) {
          windowSnapshots = windowSnapshots.map(_applyPlacementOverrideToWindowSnapshot);
        }
        if (layoutSnapshot) {
          layoutSnapshot = _applyPlacementOverrideToWindowSnapshot(layoutSnapshot);
        }
      }

      const svcPenStyle = (svc.penStyle != null) ? _cea708.parseCea708PenStyle(svc.penStyle) : null;
      const svcPenColor = (svc.penColor != null) ? _cea708.parseCea708PenColor(svc.penColor) : null;
      const svcWindowStyle = (svc.windowStyle != null) ? _cea708.parseCea708WindowStyle(svc.windowStyle) : null;

      const penStyle = svcPenStyle != null ? svcPenStyle : mcc708PenStyle;
      const penColor = svcPenColor != null ? svcPenColor : mcc708PenColor;
      const windowStyle = cueWindowStyleOverride != null ? cueWindowStyleOverride : (svcWindowStyle != null ? svcWindowStyle : mcc708WindowStyle);      const pen = (svc.pen != null) ? _cea708.parseCea708Pen(svc.pen) : mcc708Pen;

      const penLocations = (explicitPenPlacement && layoutSnapshot)
        ? _derivePenLocationsFromWindowSnapshot(layoutSnapshot)
        : null;

      // Window override options from wrapping/tag parsing.
      const windowOpts = (() => {
        const out = {};
        const win = (wrap708.window && typeof wrap708.window === 'object') ? wrap708.window : null;
        if (!win) return out;

        // Copy only known window keys used by the 708 encoder.
        if (win.relative != null) out.rel = !!win.relative;
        if (win.anchorId != null) out.anchorId = win.anchorId;
        if (win.anchorV != null) out.anchorV = win.anchorV;
        if (win.anchorH != null) out.anchorH = win.anchorH;

        return out;
      })();

      if (cueWindowOverride) {
        windowOpts.rel = (cueWindowOverride.rel != null) ? !!cueWindowOverride.rel : windowOpts.rel;
        if (cueWindowOverride.anchorId != null) windowOpts.anchorId = cueWindowOverride.anchorId;
        if (cueWindowOverride.anchorV != null) windowOpts.anchorV = cueWindowOverride.anchorV;
        if (cueWindowOverride.anchorH != null) windowOpts.anchorH = cueWindowOverride.anchorH;
        if (layoutSnapshot && typeof layoutSnapshot === 'object') {
          const rel = (cueWindowOverride.rel != null) ? !!cueWindowOverride.rel : (layoutSnapshot.relative !== false);
          const anchorId = (cueWindowOverride.anchorId != null) ? Math.trunc(Number(cueWindowOverride.anchorId)) : layoutSnapshot.anchorId;
          const anchorV = (cueWindowOverride.anchorV != null) ? Math.trunc(Number(cueWindowOverride.anchorV)) : layoutSnapshot.anchorV;
          const anchorH = (cueWindowOverride.anchorH != null) ? Math.trunc(Number(cueWindowOverride.anchorH)) : layoutSnapshot.anchorH;
          layoutSnapshot = { ...layoutSnapshot, relative: rel, anchorId, anchorV, anchorH };
        }
      }

      // Editor-driven per-cue override wins over tag-derived overrides.
      if (placementOverride) {
        windowOpts.rel = (placementOverride.rel != null) ? !!placementOverride.rel : true;
        if (placementOverride.anchorId != null) windowOpts.anchorId = placementOverride.anchorId;
        if (placementOverride.anchorV != null) windowOpts.anchorV = placementOverride.anchorV;
        if (placementOverride.anchorH != null) windowOpts.anchorH = placementOverride.anchorH;
      }

      // Derive relative/absolute placement for layoutSnapshot so we can preserve the intended coordinate space.
      if (layoutSnapshot && layoutSnapshot.relative == null && windowOpts.rel != null) {
        layoutSnapshot.relative = windowOpts.rel;
      }

      let justify708 = (align708 === 'center') ? 'center' : (align708 === 'right') ? 'right' : 'left';
      if (placementOverride && placementOverride.justify) {
        justify708 = placementOverride.justify;
      }

      // Grid sizing.
      const rowCount = Number.isFinite(layoutSnapshot && layoutSnapshot.rowCount) ? layoutSnapshot.rowCount : (gridRowsDefault || 15);
      const colCount = Number.isFinite(layoutSnapshot && layoutSnapshot.colCount) ? layoutSnapshot.colCount : (gridColsDefault || 32);

      // Ping-pong window selection (multi-window aware).
      const svcPingPong = (svc.pingPongWindows !== false);
      const desiredWindowCount = (windowSnapshots && windowSnapshots.length)
        ? Math.min(8, Math.max(1, windowSnapshots.length))
        : 1;

      const fallbackWid = svcPingPong ? (((st.pingPongIndex % 2) * 4) | 0) : 0;
      const targetWindowIds = _chooseHiddenWindowIds(st, desiredWindowCount, { pingPong: svcPingPong }) || [fallbackWid];
      const showMask = _maskForWindowIds(targetWindowIds);
      const hideMask = (st.visibleMask || 0) & (~showMask);
      const targetWindowId = targetWindowIds[0];

      // For non-snapshot cues, apply row/col policies.
      const adjustedRowCount = rowPolicy === 'shrinkToFit'
        ? Math.min(rowCount, Math.max(1, (wrap708.lines || []).length))
        : rowCount;

      return {
        svc,
        st,
        rawText,
        startFrame,
        endFrame,
        nextStartFrame,
        lines: wrap708.lines,
        lineRuns: wrap708.lineRuns,
        justify708,
        rowCount: adjustedRowCount,
        colCount,
        svcPingPong,
        targetWindowIds,
        showMask,
        hideMask,
        targetWindowId,
        windowOpts,
        pen,
        penLocations,
        windowSnapshots,
        snapshotOk,
        layoutSnapshot,
        explicitPenPlacement,
        has708Snapshot,
        windowStyle,
        penStyle,
        penColor
      };
    };

    let maxNeededFrame = 0;

    // Build tasks per service.
    for (const svc of serviceConfigs) {
      const svcNum = svc.serviceNumber;
      const rawSegs = segmentsByServiceMap[svcNum];
      if (!Array.isArray(rawSegs) || !rawSegs.length) continue;

      const cueSegs = rawSegs
        .filter((seg) => {
          const t = _getServiceText(seg, svc);
          return t && String(t).trim();
        })
        .slice()
        .sort((a, b) => {
          const sa = startFrameForSegment(a);
          const sb = startFrameForSegment(b);
          return (Number.isFinite(sa) ? sa : 0) - (Number.isFinite(sb) ? sb : 0);
        });

      if (!cueSegs.length) continue;

      const st = serviceState.get(svcNum) || { visibleMask: 0, pingPongIndex: 0, currentBank: 0 };
      serviceState.set(svcNum, st);

      const bankHiddenSince = [0, 0];

      for (let ci = 0; ci < cueSegs.length; ci++) {
        const seg = cueSegs[ci];
        const startFrame = startFrameForSegment(seg);
        const endFrame = endFrameForSegment(seg);
        if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) continue;

        const nextStartFrame = (ci + 1 < cueSegs.length)
          ? startFrameForSegment(cueSegs[ci + 1])
          : Infinity;

        const p = _build708PlanForCue(seg, ci + 1, svc, st, nextStartFrame);
        if (!p) continue;

        const preloadBlocks = _buildPreloadBlocksForPlan(p);
        const showBlocks = _buildShowBlocksForPlan(p);

        if (!_canFitSinglePacket(showBlocks)) {
          throw new Error(`CEA-708 show/hide blocks exceed one DTVCC packet for service ${svcNum} at frame ${p.startFrame}`);
        }

        _addBlocksToFrame(p.startFrame, showBlocks);

        // Schedule preloads to complete by the frame before the show.
        const planBank = Math.max(0, Math.min(1, Math.floor((p.targetWindowId || 0) / 4)));
        const earliestPreloadFrame = (p.svcPingPong)
          ? (Math.max(0, bankHiddenSince[planBank] | 0) + 1)
          : 0;
        const preloadDeadline = p.startFrame - 1;

        _queueTask({
          kind: 'preload',
          earliestFrame: earliestPreloadFrame,
          deadlineFrame: preloadDeadline,
          blocks: preloadBlocks,
          svcNum,
          cueStartFrame: p.startFrame
        });

        // Optional hide during gaps (can be delayed within the gap if packet budget is tight).
        if (Number.isFinite(p.nextStartFrame) && p.nextStartFrame !== Infinity && p.endFrame < p.nextStartFrame && p.showMask) {
          const hideBlocks = _buildHideBlocksForMask(svcNum, p.showMask);
          const hideDeadline = Math.max(p.endFrame, (p.nextStartFrame - 1));

          _queueTask({
            kind: 'hide',
            earliestFrame: p.endFrame,
            deadlineFrame: hideDeadline,
            blocks: hideBlocks,
            svcNum,
            cueStartFrame: p.startFrame
          });

          maxNeededFrame = Math.max(maxNeededFrame, hideDeadline);
        } else {
          maxNeededFrame = Math.max(maxNeededFrame, p.endFrame);
        }

        // Update per-service bank visibility bookkeeping.
        bankHiddenSince[1 - planBank] = Math.max(bankHiddenSince[1 - planBank], p.startFrame | 0);

        // Update service state for subsequent cue planning.
        st.visibleMask = p.showMask;
        if (p.svcPingPong) st.pingPongIndex += 1;
      }
    }

    maxNeededFrame = Math.max(maxNeededFrame, derived608LastEventFrame || 0);

    // Sort pending tasks by earliestFrame (secondary by deadline).
    pendingTasks.sort((a, b) => (a.earliestFrame - b.earliestFrame) || (a.deadlineFrame - b.deadlineFrame) || ((a.kind === 'hide') ? -1 : 1));

    // Frame-based EDF scheduler: one DTVCC packet per frame.
    const activeTasks = [];
    let taskPtr = 0;

    for (let frame = 0; frame <= maxNeededFrame; frame++) {
      // Activate tasks whose earliestFrame has arrived.
      while (taskPtr < pendingTasks.length && pendingTasks[taskPtr].earliestFrame <= frame) {
        activeTasks.push(pendingTasks[taskPtr]);
        taskPtr += 1;
      }

      const showBlocks = showBlocksByFrame.get(frame) || null;

      // Filter tasks based on whether this is a show frame (no preloads on show frames).
      const candidates = showBlocks
        ? activeTasks.filter((t) => t.kind !== 'preload')
        : activeTasks;

      // Build frame blocks.
      let frameBlocks = [];

      if (showBlocks && showBlocks.length) {
        // Always include show blocks. Try to prepend as many urgent hides as we can without overflowing.
        if (!_canFitSinglePacket(showBlocks)) {
          throw new Error(`CEA-708 show/hide blocks exceed one DTVCC packet at frame ${frame}`);
        }

        const prefix = [];
        const sortedHides = candidates
          .filter((t) => t.kind === 'hide')
          .slice()
          .sort((a, b) => (a.deadlineFrame - b.deadlineFrame) || (a.svcNum - b.svcNum));

        for (const t of sortedHides) {
          while (t.offset < t.blocks.length) {
            const blk = t.blocks[t.offset];
            const candidateBlocks = prefix.concat([blk]).concat(showBlocks);
            if (_canFitSinglePacket(candidateBlocks)) {
              prefix.push(blk);
              t.offset += 1;
              continue;
            }
            break;
          }
        }

        frameBlocks = prefix.concat(showBlocks);
      } else {
        const sorted = candidates.slice().sort((a, b) => {
          if (a.deadlineFrame !== b.deadlineFrame) return a.deadlineFrame - b.deadlineFrame;
          if (a.kind !== b.kind) return (a.kind === 'hide') ? -1 : 1;
          return (a.svcNum - b.svcNum);
        });

        for (const t of sorted) {
          while (t.offset < t.blocks.length) {
            const blk = t.blocks[t.offset];
            const candidateBlocks = frameBlocks.concat([blk]);
            if (_canFitSinglePacket(candidateBlocks)) {
              frameBlocks.push(blk);
              t.offset += 1;
              continue;
            }
            break;
          }
        }
      }

      // Pack and write this frame.
      if (frameBlocks.length) {
        const pk = _cea708.packDTVCC(frameBlocks, { maxPacketBytes: cdpCaps.maxDtvccPacketBytes, seqStart: dtvccSeq });
        if (!pk || !pk.packets || pk.packets.length !== 1) {
          throw new Error(`Could not pack DTVCC blocks into a single packet at frame ${frame}`);
        }
        dtvccSeq = pk.nextSeq & 0x03;
        writeCdpLine(frame, Array.from(pk.packets[0]));
      } else {
        writeEmptyCdp(frame);
      }

      // Drop completed tasks.
      for (let i = activeTasks.length - 1; i >= 0; i--) {
        const t = activeTasks[i];
        if (t.offset >= t.blocks.length) activeTasks.splice(i, 1);
      }

      // Deadline enforcement.
      for (const t of activeTasks) {
        if (t.deadlineFrame <= frame && t.offset < t.blocks.length) {
          throw new Error(`Missed ${t.kind} deadline for service ${t.svcNum} (deadline frame ${t.deadlineFrame}, current frame ${frame})`);
        }
      }
    }

    frameIndex = maxNeededFrame + 1;

  } else {    for (let segIndex = 0; segIndex < segs.length; segIndex++) {
      const seg = segs[segIndex];

      // Collect non-empty cue text per service for this segment.
      const perServiceText = [];
      for (const svc of serviceConfigs) {
        const c = _getServiceContent(seg, svc);
        const raw = c && c.text;
        if (raw && String(raw).trim()) perServiceText.push({ svc, rawText: String(raw), runs: (Array.isArray(c.runs) ? c.runs : null) });
      }
      if (!perServiceText.length) continue;

      const startFrame = startFrameForSegment(seg);
      const endFrame = endFrameForSegment(seg);
      if (startFrame == null || endFrame == null) {
        warnings.push(`Skipping cue with invalid timecodes at index ${segIndex}`);
        continue;
      }

      // Build per-service 708 payload plans.
      const svcPlans = [];
      for (const item of perServiceText) {
        const svc = item.svc;
        const rawText = item.rawText;
        const runs = Array.isArray(item.runs) ? item.runs : null;
        const hasRuns = !!(runs && runs.length);

        // Optional "round-trip" 708 snapshot (imported MCC -> edit timings -> export).
        // We only use it if the user hasn't edited the cue text, otherwise we'd be
        // exporting stale window content.
        const segCea708 = (seg && typeof seg === 'object') ? (seg.cea708 || null) : null;
        const srcPlain = (seg && typeof seg === 'object' && typeof seg.cea708SourceTextPlain === 'string')
          ? String(seg.cea708SourceTextPlain)
          : null;

        const st = serviceState.get(svc.serviceNumber) || { visibleMask: 0, pingPongIndex: 0, currentBank: 0 };
        serviceState.set(svc.serviceNumber, st);

        const svcAlign = _normalizeAlignment(svc.alignment) || align;
        const svcMaxChars = Math.max(1, Math.min(63, Number(svc.maxCharsPerLine) || maxChars708));
        // Lead AE policy: never author more than 3 lines per subtitle block.
        const svcMaxLines = Math.max(1, Math.min(3, Number(svc.maxLinesPerBlock) || maxLines708));

        // Layout-preserving mode: when this segment came from an imported 708/MCC cue,
        // we can keep the original window grid size while re-wrapping edited text.
        const layoutSnapshotRaw = (preserveImported708Layout && segCea708 && Array.isArray(segCea708.windows) && segCea708.windows.length && (Number(segCea708.serviceNumber) === Number(svc.serviceNumber)))
          ? segCea708.windows[0]
          : null;

        const snapColCount = (layoutSnapshotRaw && Number.isFinite(Number(layoutSnapshotRaw.colCount)))
          ? Math.max(1, Math.min(63, Math.trunc(Number(layoutSnapshotRaw.colCount))))
          : null;
        const snapRowCount = (layoutSnapshotRaw && Number.isFinite(Number(layoutSnapshotRaw.rowCount)))
          ? Math.max(1, Math.min(15, Math.trunc(Number(layoutSnapshotRaw.rowCount))))
          : null;

        const svcMaxCharsEffective = (snapColCount != null) ? Math.min(svcMaxChars, snapColCount) : svcMaxChars;
        const svcMaxLinesEffective = (snapRowCount != null) ? Math.min(svcMaxLines, snapRowCount) : svcMaxLines;

        // Optional per-cue 708 placement override (subtitle editor click-to-place).
        // Stored as an ASS-style alignment number (\an1..\an9) and mapped to CTA-708 anchors.
        const anOverride = (() => {
          if (!seg || typeof seg !== 'object') return null;
          const p = (seg.cea708Placement && typeof seg.cea708Placement === 'object') ? seg.cea708Placement : null;
          const anRaw = (p && (p.an ?? p.assAn)) ?? seg.cea708An;
          const n = Number(anRaw);
          if (!Number.isFinite(n)) return null;
          const an = Math.max(1, Math.min(9, Math.trunc(n)));
          return _assAnTo708WindowOverride(an);
        })();

        // Phase 1.2: per-cue 708 overrides (window/style).
        // These are authored as overrides['708'] and carried through as:
        //   seg.mcc708Window (placement) and seg.mcc708WindowStyle (window style).
        const cueWindowOverride = (() => {
          if (!seg || typeof seg !== 'object') return null;
          const raw = (() => {
            if (seg.mcc708Window && typeof seg.mcc708Window === 'object') return seg.mcc708Window;
            const o = seg.overrides;
            const o708 = (o && typeof o === 'object') ? o['708'] : null;
            const w = (o708 && typeof o708 === 'object') ? o708.window : null;
            if (w && typeof w === 'object') return w;
            return null;
          })();
          if (!raw) return null;
          const out = {};
          if (raw.rel != null) out.rel = !!raw.rel;
          if (raw.relative != null) out.rel = !!raw.relative;
          if (raw.anchorId != null) out.anchorId = raw.anchorId;
          if (raw.anchorV != null) out.anchorV = raw.anchorV;
          if (raw.anchorH != null) out.anchorH = raw.anchorH;
          if (raw.justify != null) {
            const j = String(raw.justify).toLowerCase();
            if (j === 'centre') out.justify = 'center';
            else if (j === 'left' || j === 'center' || j === 'right') out.justify = j;
          }
          return Object.keys(out).length ? out : null;
        })();

        const cueWindowStyleOverride = (() => {
          if (!seg || typeof seg !== 'object') return null;
          const raw = (() => {
            if (seg.mcc708WindowStyle && typeof seg.mcc708WindowStyle === 'object') return seg.mcc708WindowStyle;
            const o = seg.overrides;
            const o708 = (o && typeof o === 'object') ? o['708'] : null;
            const w = (o708 && typeof o708 === 'object') ? (o708.windowStyle || o708.mcc708WindowStyle) : null;
            if (w && typeof w === 'object') return w;
            return null;
          })();
          if (!raw) return null;
          try { return _cea708.parseCea708WindowStyle(raw); } catch { return null; }
        })();

        const placementOverride = (anOverride || cueWindowOverride)
          ? { ...(anOverride || {}), ...(cueWindowOverride || {}) }
          : null;

        const wrap708 = hasRuns
          ? (() => {
            const w = _cea708.wrapRunsToLines(runs, svcMaxCharsEffective, svcMaxLinesEffective, {
              overflowPolicy,
              overflowCtx: { cueIndex: segIndex + 1 }
            });
            return { ...w, window: null, justify: null, pen: null };
          })()
          : wrapTextAndClamp708Rich(rawText, svcMaxCharsEffective, svcMaxLinesEffective, {
            overflowPolicy,
            overflowCtx: { cueIndex: segIndex + 1 }
          });
        if (!wrap708.lines || !wrap708.lines.length) continue;

        const currentPlain = String(wrap708.lines.join('\n') || '').replace(/<[^>]*>/g, '');
        // If runs are present, prefer the runs-driven encoder path (so styles are emitted).
        const snapshotOk = hasRuns ? false : !!(
          segCea708 &&
          Array.isArray(segCea708.windows) &&
          segCea708.windows.length &&
          (Number(segCea708.serviceNumber) === Number(svc.serviceNumber)) &&
          (srcPlain != null) &&
          (String(srcPlain).trim() === String(currentPlain).trim())
        );
        let windowSnapshots = snapshotOk ? segCea708.windows.slice() : null;

        // If the cue was imported from MCC and the text has been edited, keep the
        // original window definition + SWA styling, but re-encode new text.
        // (Disabled when user explicitly requests SPL placement via tags/row/col.)
        let layoutSnapshot = (!snapshotOk && layoutSnapshotRaw) ? layoutSnapshotRaw : null;

        // If a per-cue placement override exists, apply it to any imported snapshots we might reuse.
        // This keeps round-tripped MCC window styling intact while still allowing editorial repositioning.
        const _applyPlacementOverrideToWindowSnapshot = (ws) => {
          const w = (ws && typeof ws === 'object') ? ws : {};
          if (!placementOverride) return w;

          const rel = (placementOverride.rel != null)
            ? !!placementOverride.rel
            : ((placementOverride.relative != null) ? !!placementOverride.relative : true);

          return {
            ...w,
            relative: rel,
            ...(placementOverride.anchorId != null ? { anchorId: placementOverride.anchorId } : {}),
            ...(placementOverride.anchorV != null ? { anchorV: placementOverride.anchorV } : {}),
            ...(placementOverride.anchorH != null ? { anchorH: placementOverride.anchorH } : {}),
            ...(placementOverride.justify != null ? { justify: placementOverride.justify } : {})
          };
        };

        if (placementOverride) {
          if (windowSnapshots && windowSnapshots.length) {
            windowSnapshots = windowSnapshots.map(_applyPlacementOverrideToWindowSnapshot);
          }
          if (layoutSnapshot) {
            layoutSnapshot = _applyPlacementOverrideToWindowSnapshot(layoutSnapshot);
          }
        }

        // Determine per-cue pen placement: prefer explicit segment fields, then {row}/{col} tags extracted by wrap708.
        const segPos = (seg && typeof seg === 'object') ? (seg.position || seg.pos || null) : null;
        const segRow = (seg?.row != null) ? Number(seg.row) : (segPos?.row != null ? Number(segPos.row) : null);
        const segCol = (seg?.col != null) ? Number(seg.col) : (segPos?.col != null ? Number(segPos.col) : null);

        const pen = (segRow != null || segCol != null) ? { row: segRow, col: segCol } : (wrap708.pen || null);
        const explicitPenPlacement = !!(pen && (pen.row != null || pen.col != null));
        if (explicitPenPlacement) layoutSnapshot = null;
        // Ping-pong window selection is per-service.
        const svcPingPong = (svc.pingPongWindows != null) ? !!svc.pingPongWindows : !!pingPongWindows;
        const desiredWindowCount = (windowSnapshots && windowSnapshots.length) ? windowSnapshots.length : 1;
        const fallbackWid = svcPingPong ? (((st.pingPongIndex || 0) % 2) * 4) : 0;
        const targetWindowIds = _chooseHiddenWindowIds(st, desiredWindowCount, { pingPong: svcPingPong }) || [fallbackWid];
        const showMask = _maskForWindowIds(targetWindowIds);
        const hideMask = (st.visibleMask || 0) & (~showMask);
        const targetWindowId = targetWindowIds[0];

        // Window placement base:
        //  - If we have an imported layout snapshot and we're in preserve mode, use it.
        //  - Otherwise, fall back to global/per-service defaults.
        //  - Always allow explicit per-cue overrides (ASS \an tags) to win.
        let windowOpts = {};
        if (layoutSnapshot && typeof layoutSnapshot === 'object') {
          windowOpts = {
            rel: (layoutSnapshot.relative !== false),
            anchorId: Number.isFinite(Number(layoutSnapshot.anchorId)) ? Math.trunc(Number(layoutSnapshot.anchorId)) : 7,
            anchorV: Number.isFinite(Number(layoutSnapshot.anchorV)) ? Math.trunc(Number(layoutSnapshot.anchorV)) : 90,
            anchorH: Number.isFinite(Number(layoutSnapshot.anchorH)) ? Math.trunc(Number(layoutSnapshot.anchorH)) : 50
          };
        } else {
          windowOpts = {
            ...(mcc708Window && typeof mcc708Window === 'object' ? mcc708Window : {}),
            ...(svc.window && typeof svc.window === 'object' ? svc.window : {})
          };
        }

        // Apply cue overrides last.
        if (wrap708.window && typeof wrap708.window === 'object') {
          windowOpts = { ...windowOpts, ...wrap708.window };
          if (layoutSnapshot && typeof layoutSnapshot === 'object') {
            // Map override keys to snapshot field names.
            const rel = (wrap708.window.rel != null) ? !!wrap708.window.rel : (layoutSnapshot.relative !== false);
            const anchorId = (wrap708.window.anchorId != null) ? Math.trunc(Number(wrap708.window.anchorId)) : layoutSnapshot.anchorId;
            const anchorV = (wrap708.window.anchorV != null) ? Math.trunc(Number(wrap708.window.anchorV)) : layoutSnapshot.anchorV;
            const anchorH = (wrap708.window.anchorH != null) ? Math.trunc(Number(wrap708.window.anchorH)) : layoutSnapshot.anchorH;
            layoutSnapshot = { ...layoutSnapshot, relative: rel, anchorId, anchorV, anchorH };
          }
        }

        if (cueWindowOverride) {
          windowOpts = { ...windowOpts, ...cueWindowOverride };
          if (layoutSnapshot && typeof layoutSnapshot === 'object') {
            const rel = (cueWindowOverride.rel != null) ? !!cueWindowOverride.rel : (layoutSnapshot.relative !== false);
            const anchorId = (cueWindowOverride.anchorId != null) ? Math.trunc(Number(cueWindowOverride.anchorId)) : layoutSnapshot.anchorId;
            const anchorV = (cueWindowOverride.anchorV != null) ? Math.trunc(Number(cueWindowOverride.anchorV)) : layoutSnapshot.anchorV;
            const anchorH = (cueWindowOverride.anchorH != null) ? Math.trunc(Number(cueWindowOverride.anchorH)) : layoutSnapshot.anchorH;
            layoutSnapshot = { ...layoutSnapshot, relative: rel, anchorId, anchorV, anchorH };
          }
        }

        // Placement override wins over tag-derived/layout-derived overrides.
        if (placementOverride) {
          const rel = (placementOverride.rel != null) ? !!placementOverride.rel : true;

          windowOpts = {
            ...windowOpts,
            rel,
            ...(placementOverride.anchorId != null ? { anchorId: placementOverride.anchorId } : {}),
            ...(placementOverride.anchorV != null ? { anchorV: placementOverride.anchorV } : {}),
            ...(placementOverride.anchorH != null ? { anchorH: placementOverride.anchorH } : {})
          };

          if (layoutSnapshot && typeof layoutSnapshot === 'object') {
            layoutSnapshot = {
              ...layoutSnapshot,
              relative: rel,
              ...(placementOverride.anchorId != null ? { anchorId: placementOverride.anchorId } : {}),
              ...(placementOverride.anchorV != null ? { anchorV: placementOverride.anchorV } : {}),
              ...(placementOverride.anchorH != null ? { anchorH: placementOverride.anchorH } : {}),
              ...(placementOverride.justify != null ? { justify: placementOverride.justify } : {})
            };
          }
        }

        // Compute a tight-ish colCount unless we're in explicit grid placement mode.
        const contentCols = Math.max(1, ...wrap708.lines.map(_visible708Length));
        let colCount = Math.max(1, Math.min(42, contentCols));

        // If SPL placement is requested, force a full-grid window and pass penLocations to the encoder.
        let rowCount = null;
        let penLocations = null;
        if (pen && (pen.row != null || pen.col != null)) {
          const pr = Math.max(0, Math.min(15, Number(pen.row) || 0));
          const pc = Math.max(0, Math.min(63, Number(pen.col) || 0));
          penLocations = { row: pr, col: pc };
          rowCount = gridRowsDefault;
          colCount = gridColsDefault;

          // Full-screen grid window anchored at top-left (row/col becomes "true" placement).
          windowOpts = { ...windowOpts, rel: true, anchorId: 0, anchorV: 0, anchorH: 0 };
        } else if (!mcc708Window && !svc.window && !wrap708.window && rowPolicy === 'bottom2' && svcMaxLines <= 2) {
          // Default MCC 708 window: bottom-ish when we want the "two-line pop-on" feel.
          windowOpts = { ...windowOpts, rel: true, anchorId: 7, anchorV: 90, anchorH: 50 };
        }

        // If this came from an imported MCC window snapshot that used explicit SPL row
        // placement, reuse the original rows/cols for each line when re-encoding.
        if (!penLocations && layoutSnapshot && typeof layoutSnapshot === 'object') {
          const derived = _derivePenLocationsFromWindowSnapshot(layoutSnapshot, wrap708.lines.length);
          if (derived && derived.length) penLocations = derived;
        }

        const justify708 = (placementOverride && placementOverride.justify)
          ? placementOverride.justify
          : (wrap708.justify || (layoutSnapshot ? String(layoutSnapshot.justify || '').toLowerCase() : '') || svcAlign);

        // Presentation styling (snapshot defaults -> global defaults -> per-service overrides)
        const snapshotDom = (layoutSnapshot && typeof layoutSnapshot === 'object' && layoutSnapshot.dominantPen && typeof layoutSnapshot.dominantPen === 'object')
          ? layoutSnapshot.dominantPen
          : null;
        const snapshotPen = (snapshotDom && snapshotDom.pen && typeof snapshotDom.pen === 'object') ? snapshotDom.pen : null;
        const snapshotPenColor = (snapshotDom && snapshotDom.penColor && typeof snapshotDom.penColor === 'object') ? snapshotDom.penColor : null;
        const snapshotWindowStyle = (layoutSnapshot && typeof layoutSnapshot === 'object' && layoutSnapshot.windowStyle && typeof layoutSnapshot.windowStyle === 'object')
          ? layoutSnapshot.windowStyle
          : null;

        const penStyle = (() => {
          const base = (snapshotPen && typeof snapshotPen === 'object') ? snapshotPen : {};
          const g = (global708Pen && typeof global708Pen === 'object') ? global708Pen : null;
          const s = (svc.pen && typeof svc.pen === 'object') ? svc.pen : null;
          const out = { ...base, ...(g || {}), ...(s || {}) };
          return Object.keys(out).length ? out : null;
        })();

        const penColor = (() => {
          const base = (snapshotPenColor && typeof snapshotPenColor === 'object') ? snapshotPenColor : null;
          const g = (global708PenColor && typeof global708PenColor === 'object') ? global708PenColor : null;
          const s = (svc.penColor && typeof svc.penColor === 'object') ? svc.penColor : null;
          if (!base && !g && !s) return null;
          return { ...(base || {}), ...(g || {}), ...(s || {}) };
        })();

        const windowStyle = (cueWindowStyleOverride != null) ? cueWindowStyleOverride : (() => {
          const base = (snapshotWindowStyle && typeof snapshotWindowStyle === 'object') ? snapshotWindowStyle : null;
          const g = (global708WindowStyle && typeof global708WindowStyle === 'object') ? global708WindowStyle : null;
          const s = (svc.windowStyle && typeof svc.windowStyle === 'object') ? svc.windowStyle : null;
          const c = (cueWindowStyleOverride && typeof cueWindowStyleOverride === 'object') ? cueWindowStyleOverride : null;
          if (!base && !g && !s && !c) return null;
          return { ...(base || {}), ...(g || {}), ...(s || {}), ...(c || {}) };
        })();
        const nextIdx = nextCueIndexByService.get(svc.serviceNumber)?.[segIndex];
        const nextStartFrame = Number.isFinite(nextIdx) ? startFrameForSegment(segs[nextIdx]) : Infinity;

        svcPlans.push({
          svc,
          st,
          rawText,
          startFrame,
          endFrame,
          nextStartFrame,
          lines: wrap708.lines,
          lineRuns: wrap708.lineRuns,
          justify708,
          rowCount,
          colCount,
          svcPingPong,
          targetWindowIds,
          showMask,
          hideMask,
          targetWindowId,
          windowOpts,
          pen,
          penLocations,
          windowSnapshots,
          snapshotOk,
          layoutSnapshot,
          explicitPenPlacement,
          windowStyle,
          penStyle,
          penColor
        });
      }

      if (!svcPlans.length) continue;

      // 608 compatibility is sourced from the primary service only.
      const primaryRawText = _getServiceText(seg, primaryService);

      // Milestone 3: derived 608 fallback track + optional per-cue override.
      //  - If cue.compat608 / cue.compat608Text exists, it is used for 608 only.
      //  - Otherwise 608 is derived from canonical 708 text (tags stripped + 32x2 wrap).
      const override608Text = useInline608Compat ? _extractCompat608OverrideText(seg) : null;
      const hasOverride608 = (typeof override608Text === 'string') && override608Text.trim().length > 0;

      // Prefer explicit override, else use the pre-derived 608 for this cue.
      // As a defensive fallback (shouldn't happen in Milestone 3), derive on-demand.
      let wrap608Meta = null;
      if (useInline608Compat) {
        if (hasOverride608) {
          wrap608Meta = wrapTextAndClamp608WithMeta(override608Text, {
            maxCols: maxChars608,
            maxLines: maxLines608,
            rowPolicy,
            overflowPolicy,
            cueIndex: segIndex,
            ...(allowExplicitLineBreaks608 != null ? { allowExplicitLineBreaks: allowExplicitLineBreaks608 } : {}),
            ...(wrap608User ? { wrap608: wrap608User } : {})
          });
        } else if (derived608ByIndex && derived608ByIndex[segIndex]) {
          const d = derived608ByIndex[segIndex];
          const rawLines = Array.isArray(d.lines)
            ? d.lines.map(l => String(l || ''))
            : String(d.text || '').split('\n');
          const clamped = rawLines.slice(0, maxLines608);
          while (clamped.length < maxLines608) clamped.push('');
          wrap608Meta = {
            lines: clamped,
            overflowed: !!(d.flags?.overflowed),
            truncated: !!(d.flags?.truncated),
            derived: true
          };
        } else if (primaryRawText && String(primaryRawText).trim()) {
          wrap608Meta = wrapTextAndClamp608WithMeta(primaryRawText, {
            maxCols: maxChars608,
            maxLines: maxLines608,
            rowPolicy,
            overflowPolicy,
            cueIndex: segIndex,
            ...(allowExplicitLineBreaks608 != null ? { allowExplicitLineBreaks: allowExplicitLineBreaks608 } : {}),
            ...(wrap608User ? { wrap608: wrap608User } : {})
          });
        }
      }

      const wrap608 = wrap608Meta ? wrap608Meta.lines : null;
      const has608Text = !!(wrap608 && wrap608.some(ln => String(ln || '').trim().length > 0));

      const cc608Words = (useInline608Compat && has608Text)
        ? build608WordsForCue(wrap608, {
            channel: ch,
            rowPolicy,
            alignment: align,
            safeMargins: safeMargins608,
            strictCharacterEncoding: sccOptions?.strictCharacterEncoding,
            repeatControlCodes,
            repeatPreambleCodes
          })
        : [];

      const nextPrimaryIdx = nextCueIndexByService.get(primaryServiceNumber)?.[segIndex];
      const nextPrimaryStartFrame = Number.isFinite(nextPrimaryIdx)
        ? startFrameForSegment(segs[nextPrimaryIdx])
        : Infinity;

      const shouldHideAfter608 = useInline608Compat && has608Text && (endFrame < nextPrimaryStartFrame);

      // --- 708 PRELOAD (all services, combined) --------------------------------
      const preloadBlocks = [];
      for (const p of svcPlans) {
        let preloadBytes = null;

        // If this cue originated from an imported 708 snapshot and the text hasn't changed,
        // preserve *all* visible windows (not just the top-priority one).
        if (p.snapshotOk && Array.isArray(p.windowSnapshots) && p.windowSnapshots.length) {
          preloadBytes = [];
          for (let wi = 0; wi < p.windowSnapshots.length; wi++) {
            const ws = p.windowSnapshots[wi];
            const wid = (p.targetWindowIds && p.targetWindowIds[wi] != null) ? p.targetWindowIds[wi] : p.targetWindowId;
            preloadBytes.push(..._cea708.buildPreloadBytesForWindowSnapshot(ws, { windowId: wid }));
          }
        } else if (p.layoutSnapshot) {
          preloadBytes = (p.lineRuns && p.lineRuns.length)
            ? _cea708.buildPreloadBytesForLineRunsWithWindowSnapshot(p.lineRuns, p.layoutSnapshot, {
              windowId: p.targetWindowId,
              justify: p.justify708,
              ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
              ...(p.penStyle ? { pen: p.penStyle } : {}),
              ...(p.penColor ? { penColor: p.penColor } : {}),
              ...(p.penLocations ? { penLocations: p.penLocations } : {})
            })
            : _cea708.buildPreloadBytesForLinesWithWindowSnapshot(p.lines, p.layoutSnapshot, {
              windowId: p.targetWindowId,
              justify: p.justify708,
              ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
              ...(p.penStyle ? { pen: p.penStyle } : {}),
              ...(p.penColor ? { penColor: p.penColor } : {}),
              ...(p.penLocations ? { penLocations: p.penLocations } : {})
            });
        } else {
          preloadBytes = (p.lineRuns && p.lineRuns.length)
            ? _cea708.buildPreloadBytesForLineRuns(p.lineRuns, {
              windowId: p.targetWindowId,
              justify: p.justify708,
              colCount: p.colCount,
              ...(p.rowCount != null ? { rowCount: p.rowCount } : {}),
              ...(p.windowOpts || {}),
              ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
              ...(p.penStyle ? { pen: p.penStyle } : {}),
              ...(p.penColor ? { penColor: p.penColor } : {}),
              ...(p.penLocations ? { penLocations: p.penLocations } : {})
            })
            : _cea708.buildPreloadBytesForLines(p.lines, {
              windowId: p.targetWindowId,
              justify: p.justify708,
              colCount: p.colCount,
              ...(p.rowCount != null ? { rowCount: p.rowCount } : {}),
              ...(p.windowOpts || {}),
              ...(p.windowStyle ? { windowStyle: p.windowStyle } : {}),
              ...(p.penStyle ? { pen: p.penStyle } : {}),
              ...(p.penColor ? { penColor: p.penColor } : {}),
              ...(p.penLocations ? { penLocations: p.penLocations } : {})
            });
        }

        const blocks = _cea708.chunkToServiceBlocks(preloadBytes, p.svc.serviceNumber, cdpCaps.maxServiceBlockDataBytes);
        preloadBlocks.push(...blocks);
      }
      const preload708Packets = _cea708.packDTVCC(preloadBlocks, { maxPacketBytes: cdpCaps.maxDtvccPacketBytes, seqStart: dtvccSeq });
      dtvccSeq = preload708Packets.nextSeq & 0x03;

      // --- 708 SHOW/HIDE (all services, combined) ------------------------------
      const showBlocks = [];
      for (const p of svcPlans) {
        const bytes = _cea708.buildShowHideBytesForMasks({ showMask: p.showMask, hideMask: p.hideMask });
        const blocks = _cea708.chunkToServiceBlocks(bytes, p.svc.serviceNumber, cdpCaps.maxServiceBlockDataBytes);
        showBlocks.push(...blocks);
      }

      const show708Packets = _cea708.packDTVCC(showBlocks, { maxPacketBytes: cdpCaps.maxDtvccPacketBytes, seqStart: dtvccSeq });
      dtvccSeq = show708Packets.nextSeq & 0x03;

      // --- Scheduling ----------------------------------------------------------
      // Determine how many frames we need before the show frame to legally emit
      // the 708 preload packets (and optional inline 608 preload words).
      //
      // Note: We can carry some 608 triplets in the same frames as 708 CDP/DTVCC,
      // so we compute an explicit capacity-based lead time rather than the older
      // conservative "1 word per frame" assumption.
      const _roomFor608WithDtvccChunk = (dtvccChunkBytes) => {
        const len = Array.isArray(dtvccChunkBytes) ? dtvccChunkBytes.length : 0;
        const n708Triplets = Math.ceil(len / 2);
        const roomTotal = Math.max(0, cdpCaps.maxTriplets - n708Triplets);
        return Math.min(roomTotal, cdpCaps.max608Triplets);
      };

      let preloadLeadFramesNeeded = preload708Packets.length;
      // Consider 608 preload payload if we are emitting either:
      //  - inline 608 compatibility words, or
      //  - a derived 608 fallback track (scheduled) that must also preload before show.
      let n608WordsForPreload = 0;
      if (useInline608Compat && cc608Words.length) {
        n608WordsForPreload = cc608Words.length;
      } else if (useDerived608Track) {
        // Approximate 608 preload payload for this cue using the primary service rawText.
        // This matches the derived 608 track behavior (pop-on), and is only used
        // to size the initial file-start ripple shift.
        try {
          const primaryPlanFor608 = svcPlans.find(p => p && p.svc && Number(p.svc.serviceNumber) === 1) || svcPlans[0];
          const rawFor608 = (primaryPlanFor608 && typeof primaryPlanFor608.rawText === 'string') ? primaryPlanFor608.rawText : '';
          const lines608 = wrapTextAndClamp608(rawFor608, { maxCols: 32, maxLines: 2 });
          const derivedWords = build608WordsForCue(lines608, { channel: ch, alignment: 'left' });
          n608WordsForPreload = Array.isArray(derivedWords) ? derivedWords.length : 0;
        } catch {
          n608WordsForPreload = 0;
        }
      }

      if (n608WordsForPreload > 0) {
        const max608 = Math.max(0, Number(cdpCaps.max608Triplets) || 0);
        if (max608 > 0) {
          let capacityDuringPreload = 0;
          for (const pkt of preload708Packets) capacityDuringPreload += _roomFor608WithDtvccChunk(pkt);
          const remainingWords = Math.max(0, n608WordsForPreload - capacityDuringPreload);
          const extraEmptyFrames = Math.ceil(remainingWords / max608);
          preloadLeadFramesNeeded = Math.max(preloadLeadFramesNeeded, preload708Packets.length + extraEmptyFrames);
        } else {
          // If there is no permitted 608 capacity for this FPS, keep the legacy
          // conservative behavior to avoid under-estimating lead time.
          preloadLeadFramesNeeded = Math.max(preloadLeadFramesNeeded, preload708Packets.length + n608WordsForPreload);
        }
      }

      // Phase 2: if the first caption starts too close to frame 0 to preload,
      // apply a bounded, file-start ripple shift (and then keep it constant).
      if (!mccStartRippleComputed) {
        const requiredShift = Math.max(0, preloadLeadFramesNeeded - startFrame);
        mccStartRippleShiftFrames = requiredShift;
        mccStartRippleComputed = true;

        if (requiredShift > 0) {
          const shiftSec = requiredShift / fps;
          mccTimingMeta.applied = true;
          mccTimingMeta.shiftFrames = requiredShift;
          mccTimingMeta.shiftSec = shiftSec;
          mccTimingMeta.firstCueIndex = segIndex;
          mccTimingMeta.firstCueOriginalStartFrame = startFrame;
          mccTimingMeta.firstCueRequiredLeadFrames = preloadLeadFramesNeeded;
          mccTimingMeta.exceededBudget = shiftSec > (mccStartRippleMaxSec + 1e-9);
        }
      }

      // If we’re emitting a derived 608 fallback track, apply the same file-start
      // ripple shift to its event schedule *before* we write any frames.
      _applyFileStartRippleToDerived608();

      const showFrame = startFrame + mccStartRippleShiftFrames;
      const cueEndFrame = endFrame + mccStartRippleShiftFrames;

      const desiredPreloadStart = Math.max(0, showFrame - preloadLeadFramesNeeded);

      while (frameIndex < desiredPreloadStart) {
        writeEmptyCdp(frameIndex++);
      }

      // Inline 608 preload words should be enqueued before we start emitting
      // 708 preload packets, so they can transmit concurrently.
      if (useInline608Compat && cc608Words.length) {
        cc608Queue.push(...cc608Words.map(w => parseInt(w, 16) & 0xFFFF));
      }

      // Emit 708 preload packets (one packet per frame)
      for (const pkt of preload708Packets) {
        writeCdpLine(frameIndex++, Array.from(pkt));
      }

      while (frameIndex < showFrame) {
        writeEmptyCdp(frameIndex++);
      }

      // On the show frame, pop-on needs an EOC to swap non-displayed → displayed memory.
      if (useInline608Compat && cc608Words.length) {
        const eoc = cc608Eoc(ch);
        const eocWords = (repeatControlCodes !== false) ? [eoc, eoc] : [eoc];
        cc608Queue.push(...eocWords.map(w => parseInt(w, 16) & 0xFFFF));
      }

      // Emit 708 show/hide packets.
      for (const pkt of show708Packets) {
        writeCdpLine(frameIndex++, Array.from(pkt));
      }

      // Update per-service visible window state.
      for (const p of svcPlans) {
        p.st.visibleMask = p.showMask;
        if (p.svcPingPong) p.st.pingPongIndex += 1;
      }

      // --- Optional HIDE (per service) ----------------------------------------
      const servicesToHide = [];
      for (const p of svcPlans) {
        const nextIdx = nextCueIndexByService.get(p.svc.serviceNumber)?.[segIndex];
        const nextStartFrame = Number.isFinite(nextIdx) ? startFrameForSegment(segs[nextIdx]) : Infinity;
        if (endFrame < nextStartFrame && p.st.visibleMask) servicesToHide.push(p);
      }

      if (servicesToHide.length) {
        const hideFrame = Math.max(cueEndFrame, frameIndex);
        while (frameIndex < hideFrame) {
          writeEmptyCdp(frameIndex++);
        }

        // 608 clear on gaps (primary service only)
        if (useInline608Compat && cc608Words.length && shouldHideAfter608) {
          const edm = cc608Edm(ch);
          const edmWords = (repeatControlCodes !== false) ? [edm, edm] : [edm];
          cc608Queue = edmWords.map(w => parseInt(w, 16) & 0xFFFF);
        }

        const hideBlocks = [];
        for (const p of servicesToHide) {
          if (!p.st.visibleMask) continue;
          const hideBytes = _cea708.buildHideBytesForMask(p.st.visibleMask);
          const blocks = _cea708.chunkToServiceBlocks(hideBytes, p.svc.serviceNumber, cdpCaps.maxServiceBlockDataBytes);
          hideBlocks.push(...blocks);
        }

        const hide708Packets = _cea708.packDTVCC(hideBlocks, { maxPacketBytes: cdpCaps.maxDtvccPacketBytes, seqStart: dtvccSeq });
        dtvccSeq = hide708Packets.nextSeq & 0x03;

        for (const pkt of hide708Packets) {
          writeCdpLine(frameIndex++, Array.from(pkt));
        }

        for (const p of servicesToHide) {
          p.st.visibleMask = 0;
        }
      }

      // Fill until the cue end (assumes non-overlapping cues).
      const targetEndFrame = Math.max(cueEndFrame, frameIndex);
      while (frameIndex < targetEndFrame) {
        writeEmptyCdp(frameIndex++);
      }
    }
  }

  // If the derived 608 schedule extends past the final 708 cue, keep writing empty
  // CDP frames so queued 608 words (including final EDM) can flush.
  if (Number.isFinite(derived608LastEventFrame) && frameIndex <= derived608LastEventFrame) {
    while (frameIndex <= derived608LastEventFrame) {
      writeEmptyCdp(frameIndex++);
    }
  }

  // Attach encoding meta (useful for QC/reporting) without changing the emitted
  // file text. Returning a String object preserves backward compatibility for
  // all callers that coerce to a primitive string.
  const outText = lines.join('');
  const out = new String(outText);
  out._mccMeta = {
    timingPolicy: { ...mccTimingMeta },
  };
  return out;
}

function verifyMCC(
  fileOrText,
  {
    maxErrors = 100,
    fps: fpsOption = null,
    dropFrame: dropFrameOption = null,
    checkHeader = true,
    requireHeader = true,
    checkTimecode = true,
    checkMonotonic = true,
    checkUnitStep = false,
    unitStepAsError = false,
    strictTimeCodeRateFormat = false,
    strictPayloadParse = false,
    checkAncChecksum = true,
    checkCdpChecksum = true,
    checkCdpLength = true,
    checkCcCount = true,
    checkSequence = true,
    checkSmpte12M = true
  } = {}
) {
  const fs = require('fs');
  const path = require('path');

  let source = fileOrText || '';
  let filePath = null;
  try {
    if (typeof source === 'string' && fs.existsSync(source)) {
      filePath = path.resolve(source);
      source = fs.readFileSync(filePath, 'utf8');
    }
  } catch { /* fall through */ }

  let text = String(source || '').replace(/\uFEFF/g, '').replace(/\r/g, '');
  const allLines = text.split('\n');

  const errors = [];
  const warnings = [];

  const _assignMccIssueCode = (issue, kind) => {
    const isWarn = kind === 'warn';
    const t = String(issue?.type ?? issue?.kind ?? '').trim().toLowerCase();
    const msg = String(issue?.message ?? '').toLowerCase();

    // Header
    if (t === 'header') {
      if (msg.includes('missing mcc header')) return 'E_MCC_HEADER_MISSING';
      if (msg.includes('missing/invalid "file format')) return 'E_MCC_HEADER_FILE_FORMAT';
      if (msg.includes('missing/invalid "time code rate')) return 'E_MCC_HEADER_TIME_CODE_RATE';
      if (msg.includes('invalid time code rate format')) return 'E_MCC_HEADER_TIME_CODE_RATE_FORMAT';
      if (msg.includes('invalid mcc header combination')) return 'E_MCC_HEADER_VERSION_RATE_COMBO';
      if (msg.includes('missing "drop frame="')) return 'W_MCC_HEADER_DROP_FRAME_MISSING';
      if (msg.includes('drop frame=true but fps')) return 'W_MCC_HEADER_DF_RATE_UNUSUAL';
      if (msg.includes('v2 timecode suffix') && msg.includes('v1.0')) return 'W_MCC_HEADER_V2_SUFFIX_WITH_V1';
      if (msg.includes('v2 timecode suffix') && msg.includes('file format')) return 'W_MCC_HEADER_V2_SUFFIX_FILE_FORMAT_RECOMMENDED';
      return isWarn ? 'W_MCC_HEADER' : 'E_MCC_HEADER';
    }

    // Timecode + label integrity
    if (t === 'timecode') {
      if (msg.includes('mixed timecode delimiters')) return 'W_MCC_TIMECODE_MIXED_DELIMS';
      if (msg.includes('uses ";"') && msg.includes('non-drop-frame')) return 'W_MCC_TIMECODE_SEMICOLON_WITH_NDF';
      if (msg.includes('invalid timecode delimiter')) return 'E_MCC_TIMECODE_DELIM';
      return isWarn ? 'W_MCC_TIMECODE' : 'E_MCC_TIMECODE';
    }
    if (t === 'monotonic') return isWarn ? 'W_MCC_TIMECODE_MONOTONIC' : 'E_MCC_TIMECODE_MONOTONIC';
    if (t === 'timecode-step') return isWarn ? 'W_MCC_TIMECODE_STEP' : 'E_MCC_TIMECODE_STEP';

    // MCC V2 timecode suffixes
    if (t === 'timecode-suffix') {
      if (msg.includes('multiple mcc v2 timecode suffix values')) return 'W_MCC_V2_SUFFIX_MULTIPLE_VALUES';
      if (msg.includes('invalid mcc v2 timecode suffix')) return 'W_MCC_V2_SUFFIX_INVALID';
      if (msg.includes('unusual mcc v2 timecode suffix field')) return 'W_MCC_V2_SUFFIX_FIELD_UNUSUAL';
      if (msg.includes('unusual mcc v2 timecode suffix line')) return 'W_MCC_V2_SUFFIX_LINE_UNUSUAL';
      return 'W_MCC_V2_SUFFIX';
    }

    // Payload tokenization / parse
    if (t === 'payload') return isWarn ? 'W_MCC_PAYLOAD' : 'E_MCC_PAYLOAD_PARSE';

    // ANC packet
    if (t === 'anc') {
      if (msg.includes('too short')) return 'E_MCC_ANC_TOO_SHORT';
      if (msg.includes('unexpected anc did/sdid')) return 'E_MCC_ANC_DID_SDID';
      return isWarn ? 'W_MCC_ANC' : 'E_MCC_ANC';
    }
    if (t === 'anc-length') return isWarn ? 'W_MCC_ANC_LENGTH' : 'E_MCC_ANC_LENGTH';
    if (t === 'anc-checksum') return isWarn ? 'W_MCC_ANC_CHECKSUM' : 'E_MCC_ANC_CHECKSUM';

    // CDP packet
    if (t === 'cdp') {
      if (msg.includes('payload too short')) return 'E_MCC_CDP_TOO_SHORT';
      if (msg.includes('missing cdp identifier')) return 'E_MCC_CDP_IDENTIFIER';
      if (msg.includes('cc_data section truncated')) return 'E_MCC_CDP_CC_DATA_TRUNCATED';
      if (msg.includes('expected cc_data section id')) return 'E_MCC_CDP_CC_DATA_SECTION_ID';
      if (msg.includes('cc_data triplets truncated')) return 'E_MCC_CDP_CC_TRIPLETS_TRUNCATED';
      if (msg.includes('cdp flags indicate ccdata_present=0')) return 'E_MCC_CDP_CC_DATA_MISSING';
      if (msg.includes('cc_data count marker bits')) return 'E_MCC_CDP_CC_COUNT_MARKER_BITS';
      if (msg.includes('cdp footer (0x74) not found')) return 'E_MCC_CDP_FOOTER_MISSING';
      if (msg.includes('cdp footer truncated')) return 'E_MCC_CDP_FOOTER_TRUNCATED';
      if (msg.includes('unexpected trailing bytes after footer')) return 'E_MCC_CDP_TRAILING_BYTES';
      if (msg.includes('footer not at expected position')) return 'E_MCC_CDP_FOOTER_POSITION';
      return isWarn ? 'W_MCC_CDP' : 'E_MCC_CDP';
    }
    if (t === 'cdp-length') {
      if (msg.includes('non-standard cdp length')) return 'W_MCC_CDP_LENGTH_LEGACY';
      return isWarn ? 'W_MCC_CDP_LENGTH' : 'E_MCC_CDP_LENGTH';
    }
    if (t === 'cdp-checksum') return isWarn ? 'W_MCC_CDP_CHECKSUM' : 'E_MCC_CDP_CHECKSUM';
    if (t === 'cdp-flags') return isWarn ? 'W_MCC_CDP_FLAGS' : 'E_MCC_CDP_FLAGS';
    if (t === 'cdp-timecode') return isWarn ? 'W_MCC_CDP_TIMECODE' : 'E_MCC_CDP_TIMECODE';
    if (t === 'cdp-ccsvc') return isWarn ? 'W_MCC_CDP_CCSVC' : 'E_MCC_CDP_CCSVC';

    // cc_count limits
    if (t === 'cc_count' || t === 'cc-count') return isWarn ? 'W_MCC_CC_COUNT' : 'E_MCC_CC_COUNT';

    // Sequence counters
    if (t === 'sequence') {
      if (msg.includes('non-contiguous cdp sequence counter')) return 'W_MCC_CDP_SEQUENCE_NONCONTIG';
      if (msg.includes('footer sequence counter')) return 'E_MCC_CDP_SEQUENCE_FOOTER_MISMATCH';
      return isWarn ? 'W_MCC_SEQUENCE' : 'E_MCC_SEQUENCE';
    }

    // SMPTE-12M packed timecode section
    if (t === 'smpte12m') return isWarn ? 'W_MCC_SMPTE12M' : 'E_MCC_SMPTE12M';

    // 708 diagnostics
    if (t === 'cea708') return 'W_MCC_CEA708';

    // Fallback
    return isWarn ? 'W_MCC' : 'E_MCC';
  };

  const _normalizeIssue = (issue, kind) => {
    if (!issue || typeof issue !== 'object') return issue;
    const out = { ...issue };
    const code = (typeof out.code === 'string' && out.code.trim()) ? out.code.trim() : '';
    if (!code) out.code = _assignMccIssueCode(out, kind);
    return out;
  };

  const pushErr = (e) => { if (errors.length < maxErrors) errors.push(_normalizeIssue(e, 'error')); };
  const pushWarn = (w) => { if (warnings.length < maxErrors) warnings.push(_normalizeIssue(w, 'warn')); };

  // ---- Parse MCC header (key=value until first timecode line) ----
  const header = {};
  let headerEndLine = 0;
  let sawAnyHeader = false;

  for (let i = 0; i < allLines.length; i++) {
    const raw = allLines[i] ?? '';
    const trimmed = String(raw).trim();
    if (!trimmed) { headerEndLine = i + 1; continue; }

    const firstTok = trimmed.split(/\s+/)[0] || '';
    if (_parseMccV2TimecodeToken(firstTok)) {
      // First timecode line → body starts here.
      headerEndLine = i;
      break;
    }

    // Common MCC comment style is // (including separator bars made of slashes).
    if (/^(\/\/|#)/.test(trimmed)) { headerEndLine = i + 1; continue; }

    const kv = /^([^=]+)=(.*)$/.exec(trimmed);
    if (kv) {
      sawAnyHeader = true;
      header[String(kv[1] || '').trim().toLowerCase()] = String(kv[2] || '').trim();
      headerEndLine = i + 1;
      continue;
    }

    // Unknown/decorative line: treat as header noise, keep scanning until first timecode.
    headerEndLine = i + 1;
  }

  const fileFormat = header['file format'] || header['fileformat'] || '';
  const fileFormatMatch = /^MacCaption_MCC\s+V(1\.0|2\.0)$/i.exec(String(fileFormat).trim());
  const fileFormatOk = !!fileFormatMatch;
  const fileFormatVersion = fileFormatMatch ? `V${fileFormatMatch[1]}` : '';

  const rateVal = header['time code rate'] || header['timecode rate'] || '';
  const rateValRaw = String(rateVal || '').trim();
  // Strict MCC interoperability: Time Code Rate should be an integer base with optional DF suffix.
  // Examples: 24, 25, 30, 30DF, 50, 60, 60DF
  const strictRateOk = /^(24|25|30|50|60)(DF)?$/i.test(rateValRaw);
  const rateInfo = _parseMccTimeCodeRateValue(rateValRaw);

  let headerDropFrame = rateInfo.dropFrame;
  if (typeof header['drop frame'] === 'string') {
    const v = String(header['drop frame']).trim();
    if (/^true$/i.test(v)) headerDropFrame = true;
    else if (/^false$/i.test(v)) headerDropFrame = false;
  }

  let headerFps = rateInfo.fps;

  // The MCC header frequently uses nominal DF rates (30DF/60DF) to mean 29.97/59.94.
  if (headerDropFrame === true && Number.isFinite(headerFps)) {
    if (Math.abs(headerFps - 30) < 0.06) headerFps = 29.97;
    if (Math.abs(headerFps - 60) < 0.12) headerFps = 59.94;
  }

  // fpsOption should only override header fps if explicitly provided and > 0.
  const fpsOptionNum = (fpsOption != null) ? Number(fpsOption) : NaN;
  const fpsOverride = (Number.isFinite(fpsOptionNum) && fpsOptionNum > 0) ? fpsOptionNum : null;

  let fps = (fpsOverride != null) ? fpsOverride : headerFps;
  const fpsNum = Number(fps);
  fps = (Number.isFinite(fpsNum) && fpsNum > 0) ? fpsNum : 29.97;

  let dropFrame = null;
  if (dropFrameOption != null) dropFrame = !!dropFrameOption;
  else if (headerDropFrame != null) dropFrame = !!headerDropFrame;
  else dropFrame = isDropFrameRate(fps);

  // If DF but fps is nominal, normalize it.
  if (dropFrame && Number.isFinite(fps)) {
    if (Math.abs(fps - 30) < 0.06) fps = 29.97;
    if (Math.abs(fps - 60) < 0.12) fps = 59.94;
  }

  if (dropFrame && !isDropFrameRate(fps)) {
    pushWarn({ line: 0, timecode: '', type: 'header', message: `Drop Frame=True but fps=${fps} is not a common DF rate. Verify Time Code Rate/Drop Frame header fields.` });
  }

  // Header validation (broadcast-QC friendly)
  let headerErrors = 0;
  if (checkHeader && requireHeader) {
    if (!sawAnyHeader) {
      headerErrors += 1;
      pushErr({ line: 1, timecode: '', type: 'header', message: 'Missing MCC header (expected key=value lines at top of file).' });
    }
    if (!fileFormatOk) {
      headerErrors += 1;
      pushErr({ line: 1, timecode: '', type: 'header', message: 'Missing/invalid "File Format=MacCaption_MCC V1.0" or "File Format=MacCaption_MCC V2.0" header line.' });
    }
    if (!rateInfo.fps) {
      headerErrors += 1;
      pushErr({ line: 1, timecode: '', type: 'header', message: 'Missing/invalid "Time Code Rate=" header line.' });
    }
    if (strictTimeCodeRateFormat && !strictRateOk) {
      headerErrors += 1;
      pushErr({
        line: 1,
        timecode: '',
        type: 'header',
        message: `Invalid Time Code Rate format (expected 24/25/30/50/60 with optional DF; got "${rateValRaw}").`
      });
    }
    // MacCaption MCC V1.0 does not support 60DF timecode rate in common ingest/QC tooling.
    if (fileFormatVersion === 'V1.0' && /^60DF$/i.test(rateValRaw)) {
      headerErrors += 1;
      pushErr({
        line: 1,
        timecode: '',
        type: 'header',
        message: 'Invalid MCC header combination: MacCaption_MCC V1.0 with Time Code Rate=60DF. Use MacCaption_MCC V2.0 for 59.94 DF.'
      });
    }
    if (header['drop frame'] == null) {
      // Not strictly required by all importers, but helps QC determinism.
      pushWarn({ line: 1, timecode: '', type: 'header', message: 'Missing "Drop Frame=" header line (recommended for broadcast QC).' });
    }
  }

  // ---- Parse data lines ----
  let parsedLines = 0;
  let tokenErrors = 0;
  let timecodeErrors = 0;
  let monotonicErrors = 0;
  let ancErrors = 0;
  let cdpErrors = 0;
  let ccCountErrors = 0;
  let seqErrors = 0;

  let prevFrame = null;
  let prevSeq = null;
  let mixedDelimiter = false;
  let lastTimecodeDelim = null;

  // Track whether the file ever contains any CEA-708 (DTVCC) packet data, and whether
  // we see any explicit "packet start" triplets (cc_type=3). Some decoders (including
  // certain NLE importers) will ignore 708 data unless packet-start markers are present.
  let sawAnyDtvcc = false;
  let sawAnyDtvccStart = false;

  // MCC V2.0 optional timecode suffixes: ".<field>,<line>"
  let sawV2TimecodeSuffix = false;
  const v2TimecodeSuffixes = new Set();

  for (let i = headerEndLine; i < allLines.length; i++) {
    const raw = allLines[i] ?? '';
    if (!String(raw).trim()) continue;

    const m = /^(\d{2}:\d{2}:\d{2}[:;]\d{2})(?:\.(\d+),(\d+))?\s+(.+)$/.exec(String(raw).trim());
    if (!m) continue;

    const tcBase = m[1];
    const tc = (m[2] != null) ? `${tcBase}.${m[2]},${m[3]}` : tcBase;
    const tcSuffixField = (m[2] != null) ? Math.trunc(Number(m[2])) : null;
    const tcSuffixLine = (m[3] != null) ? Math.trunc(Number(m[3])) : null;
    const payload = String(m[4] || '').trim();
    parsedLines += 1;

    if (tcSuffixField != null || tcSuffixLine != null) {
      sawV2TimecodeSuffix = true;
      if (Number.isFinite(tcSuffixField) && Number.isFinite(tcSuffixLine)) {
        v2TimecodeSuffixes.add(`${tcSuffixField},${tcSuffixLine}`);
        if (tcSuffixField !== 0 && tcSuffixField !== 1) {
          pushWarn({ line: i + 1, timecode: tc, type: 'timecode-suffix', message: `Unusual MCC V2 timecode suffix field=${tcSuffixField} (expected 0 or 1).` });
        }
        if (tcSuffixLine < 0 || tcSuffixLine > 999) {
          pushWarn({ line: i + 1, timecode: tc, type: 'timecode-suffix', message: `Unusual MCC V2 timecode suffix line=${tcSuffixLine} (expected 0..999).` });
        }
      } else {
        pushWarn({ line: i + 1, timecode: tc, type: 'timecode-suffix', message: 'Invalid MCC V2 timecode suffix (expected ".<field>,<line>").' });
      }
    }

    // ---- Timecode checks ----
    let frame = null;
    if (checkTimecode) {
      try {
        const delim = tcBase[8] || '';
        if (delim !== ':' && delim !== ';') {
          timecodeErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'timecode', message: `Invalid timecode delimiter "${delim}". Expected ":" or ";".` });
        } else {
          if (dropFrame === false && delim === ';') {
            // MCC parsers should rely on header DF flags, but some ingest tools still treat ';' specially.
            pushWarn({ line: i + 1, timecode: tc, type: 'timecode', message: 'Timecode uses ";" but header indicates non-drop-frame. Some ingest/QC tools may flag or misinterpret this.' });
          }
          if (lastTimecodeDelim && delim !== lastTimecodeDelim) mixedDelimiter = true;
          if (!lastTimecodeDelim) lastTimecodeDelim = delim;
        }

        // If DF, validate legality regardless of delimiter (MCC commonly uses ':' even for DF).
        if (dropFrame) {
          const mm = String(tcBase).match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
          if (mm) assertLegalDropFrameLabel(`${mm[1]};${mm[2]}`, fps);
        }

        frame = framesFromTimecodeLabel(tcBase, fps, dropFrame);
        if (!Number.isFinite(frame)) throw new Error('Unable to parse timecode');
      } catch (e) {
        timecodeErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'timecode', message: e?.message || String(e) });
      }
    }

    if (checkMonotonic && Number.isFinite(frame)) {
      if (prevFrame != null && frame < prevFrame) {
        monotonicErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'monotonic', message: `Timecode is earlier than previous line (${frame} < ${prevFrame}).` });
      }
      if (checkUnitStep && prevFrame != null && frame !== (prevFrame + 1)) {
        const msg = `Non-contiguous timecode step (${frame} != ${prevFrame + 1}).`;
        if (unitStepAsError) {
          monotonicErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'timecode-step', message: msg });
        } else {
          pushWarn({ line: i + 1, timecode: tc, type: 'timecode-step', message: msg });
        }
      }
      prevFrame = frame;
    }

    // ---- Payload parse (raw hex or Telestream compression) ----
    const parsed = _parseMccPayloadToBytes(payload, { strict: strictPayloadParse, reportWhitespace: true });
    if (parsed.errors.length) {
      tokenErrors += parsed.errors.length;
      const sample = parsed.errors.slice(0, 3).map(e => e?.message || 'payload parse error').join(' | ');
      pushErr({ line: i + 1, timecode: tc, type: 'payload', message: `Unparseable MCC payload: ${sample}` });
    }
    const bytes = parsed.bytes || [];

    if (bytes.length < 4) {
      ancErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'anc', message: `ANC packet too short (${bytes.length} byte(s)).` });
      continue;
    }

    // ---- ANC (SMPTE-291) validation ----
    const did = bytes[0] & 0xff;
    const sdid = bytes[1] & 0xff;
    const dc = bytes[2] & 0xff;

    if (did !== 0x61 || sdid !== 0x01) {
      ancErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'anc', message: `Unexpected ANC DID/SDID (got 0x${did.toString(16).padStart(2, '0')} 0x${sdid.toString(16).padStart(2, '0')}, expected 0x61 0x01).` });
    }

    const expectedAncLen = dc + 4; // DID+SDID+DC + UDW(dc) + checksum
    if (bytes.length !== expectedAncLen) {
      ancErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'anc-length', message: `ANC length mismatch (DC=${dc} expects ${expectedAncLen} bytes, got ${bytes.length}).` });
    }

    if (checkAncChecksum) {
      const actual = bytes[bytes.length - 1] & 0xff;
      const expected = (256 - _sum8(bytes.slice(0, -1))) & 0xff;
      if (actual !== expected) {
        ancErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'anc-checksum', message: `ANC checksum mismatch (got 0x${actual.toString(16).padStart(2, '0').toUpperCase()}, expected 0x${expected.toString(16).padStart(2, '0').toUpperCase()}).` });
      }
    }

    // ---- CDP validation ----
    const cdp = bytes.slice(3, Math.min(bytes.length - 1, 3 + dc));
    if (cdp.length < 7) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: `CDP payload too short (${cdp.length} byte(s)).` });
      continue;
    }

    if ((cdp[0] & 0xff) !== 0x96 || (cdp[1] & 0xff) !== 0x69) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: `Missing CDP identifier (expected 0x96 0x69).` });
    }

    const cdpLenField = cdp[2] & 0xff;
    // Per SMPTE ST 334-2, cdp_length is the number of bytes in the *entire* CDP,
    // from the first byte of cdp_identifier (0x96) through packet_checksum inclusive.
    // Some non-compliant encoders historically wrote cdp_length excluding the first 3 bytes
    // (cdp_identifier + cdp_length field) — detect that as a compatibility warning.
    const expectedCdpLen = cdpLenField;
    if (checkCdpLength && expectedCdpLen !== cdp.length) {
      const legacyExpected = cdpLenField + 3;
      if (legacyExpected === cdp.length) {
        // Keep as a warning by default; strict export policies can treat any warning as fatal upstream.
        pushWarn({ line: i + 1, timecode: tc, type: 'cdp-length', message: `Non-standard CDP length: cdp_length=${cdpLenField} appears to exclude the 3-byte identifier/length header (legacy total=${legacyExpected}, actual=${cdp.length}).` });
      } else {
        cdpErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'cdp-length', message: `CDP length mismatch (cdp_length=${cdpLenField} expects ${expectedCdpLen} bytes, got ${cdp.length}).` });
      }
    }

    if (checkCdpChecksum) {
      const sum = _sum8(cdp);
      if (sum !== 0) {
        cdpErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'cdp-checksum', message: `CDP checksum invalid (sum mod 256 = 0x${sum.toString(16).padStart(2, '0').toUpperCase()}, expected 0x00).` });
      }
    }

    const headerSeq = ((cdp[5] << 8) | cdp[6]) & 0xffff;

    if (checkSequence) {
      if (prevSeq != null) {
        const exp = (prevSeq + 1) & 0xffff;
        if (headerSeq !== exp) {
          // Not always fatal in the wild (MCC can be sparse or start at an arbitrary sequence).
          pushWarn({ line: i + 1, timecode: tc, type: 'sequence', message: `Non-contiguous CDP sequence counter (${headerSeq} != ${exp}).` });
        }
      }
      prevSeq = headerSeq;
    }

    const flags = cdp[4] & 0xff;
    const flagTimecodePresent = !!(flags & 0x80);
    const flagCcDataPresent = !!(flags & 0x40);
    const flagSvcInfoPresent = !!(flags & 0x20);
    const flagSvcInfoStart = !!(flags & 0x10);
    const flagSvcInfoChange = !!(flags & 0x08);
    const flagSvcInfoComplete = !!(flags & 0x04);
    const flagReservedOk = ((flags & 0x01) === 0x01);

    if (strictPayloadParse && !flagReservedOk) {
      cdpErrors += 1;
      pushErr({
        line: i + 1,
        timecode: tc,
        type: 'cdp-flags',
        message: `CDP flags reserved bit0 must be 1 (got 0x${flags.toString(16).padStart(2, '0')}).`
      });
    }

    let pos = 7;

    // ---- Optional Time Code (0x71) ----
    const hasTimecodeSection = ((cdp[pos] & 0xff) === 0x71);

    if (strictPayloadParse) {
      if (flagTimecodePresent && !hasTimecodeSection) {
        cdpErrors += 1;
        pushErr({
          line: i + 1,
          timecode: tc,
          type: 'cdp-timecode',
          message: `CDP flags indicate timecode_present=1, but 0x71 section is missing at byte ${pos}.`
        });
      }
      if (!flagTimecodePresent && hasTimecodeSection) {
        cdpErrors += 1;
        pushErr({
          line: i + 1,
          timecode: tc,
          type: 'cdp-timecode',
          message: `CDP flags indicate timecode_present=0, but 0x71 timecode section is present at byte ${pos}.`
        });
      }
    }

    if (hasTimecodeSection) {
      // SMPTE ST 334-2 time_code_section is 0x71 followed by 4 packed bytes.
      if (pos + 5 > cdp.length) {
        cdpErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'cdp-timecode', message: 'CDP timecode section truncated.' });
        continue;
      }

      const b1 = cdp[pos + 1] & 0xff;
      const b2 = cdp[pos + 2] & 0xff;
      const b3 = cdp[pos + 3] & 0xff;
      const b4 = cdp[pos + 4] & 0xff;

      if (checkSmpte12M) {
        // Reserved bits sanity (per Tektronix / ST 334-2 diagrams)
        if ((b1 & 0xC0) !== 0xC0) {
          timecodeErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'smpte12m', message: `Timecode byte1 reserved bits must be 0b11 (got 0x${b1.toString(16).padStart(2, '0')}).` });
        }
        if ((b2 & 0x80) !== 0x80) {
          timecodeErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'smpte12m', message: `Timecode byte2 reserved bit7 must be 1 (got 0x${b2.toString(16).padStart(2, '0')}).` });
        }
        if ((b4 & 0x40) !== 0x00) {
          timecodeErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'smpte12m', message: `Timecode byte4 bit6 must be 0 (got 0x${b4.toString(16).padStart(2, '0')}).` });
        }

        const tc10h = (b1 >> 4) & 0x03;
        const tc1h  = b1 & 0x0F;
        const tc10m = (b2 >> 4) & 0x07;
        const tc1m  = b2 & 0x0F;
        const tc10s = (b3 >> 4) & 0x07;
        const tc1s  = b3 & 0x0F;
        const tc10f = (b4 >> 4) & 0x03;
        const tc1f  = b4 & 0x0F;

        const tcHours   = tc10h * 10 + tc1h;
        const tcMinutes = tc10m * 10 + tc1m;
        const tcSeconds = tc10s * 10 + tc1s;
        const tcFrames  = tc10f * 10 + tc1f;

        const tcDropFrame = !!(b4 & 0x80);
        if (tcDropFrame !== dropFrame) {
          timecodeErrors += 1;
          pushErr({
            line: i + 1,
            timecode: tc,
            type: 'smpte12m',
            message: `Timecode drop-frame mismatch. Expected ${dropFrame ? 'DF' : 'NDF'}, got ${tcDropFrame ? 'DF' : 'NDF'}.`
          });
        }

        if (Number.isFinite(frame)) {
          const expectedTc = framesToTcString(frame, fps, dropFrame);
          const actualTc = `${tcHours.toString().padStart(2,'0')}:${tcMinutes.toString().padStart(2,'0')}:${tcSeconds.toString().padStart(2,'0')}${dropFrame ? ';' : ':'}${tcFrames.toString().padStart(2,'0')}`;
          if (actualTc !== expectedTc) {
            timecodeErrors += 1;
            pushErr({ line: i + 1, timecode: tc, type: 'smpte12m', message: `Timecode mismatch. Expected ${expectedTc}, got ${actualTc}.` });
          }
        }
      }

      pos += 5;
    }

    // ---- CC Data (0x72) ----
    if (strictPayloadParse && !flagCcDataPresent) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: 'CDP flags indicate ccdata_present=0, but MCC requires CC data for captions.' });
      continue;
    }

    if ((cdp[pos] & 0xff) !== 0x72) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: `Expected CC_DATA section id 0x72 at byte ${pos}, found 0x${(cdp[pos] & 0xff).toString(16)}.` });
      continue;
    }

    if (pos + 2 > cdp.length) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: 'CC_DATA section truncated.' });
      continue;
    }

    const ccCountByte = cdp[pos + 1] & 0xff;
    if ((ccCountByte & 0xE0) !== 0xE0) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: `CC_DATA count marker bits must be 0xE0 (got 0x${ccCountByte.toString(16)}).` });
      continue;
    }

    const ccCount = ccCountByte & 0x1F;
    if (checkCcCount) {
      try {
        // Max triplets is governed by frame rate (see ST 334-2 / CTA-708). It is independent
        // of whether you include 608 compatibility bytes.
        const maxTriplets = _cdpCapacityForFps(fps, true).maxTriplets;
        if (ccCount > maxTriplets) {
          ccCountErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'cc_count', message: `cc_count=${ccCount} exceeds max triplets for FPS (${fps}) (max=${maxTriplets}).` });
        }
      } catch {
        // If caps can't be computed, skip the check.
      }
    }
    const tripStart = pos + 2;
    const tripEndExpected = tripStart + (ccCount * 3);

    if (tripEndExpected > cdp.length) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: `CC_DATA triplets truncated: cc_count=${ccCount}, need ${ccCount * 3} bytes.` });
      continue;
    }

    // ---- Inspect cc_data() triplets for basic 708/DTVCC sanity ----
    // Triplet header byte layout (A/53 / SCTE-128):
    //   bits 7..3: reserved (typically all 1s)
    //   bit 2: cc_valid
    //   bits 1..0: cc_type
    // Where DTVCC uses cc_type=3 for "packet start" and cc_type=2 for "packet data".
    for (let t = tripStart; t < tripEndExpected; t += 3) {
      const b0 = cdp[t] & 0xff;
      const ccValid = !!(b0 & 0x04);
      const ccType = (b0 & 0x03);
      if (ccValid && (ccType === 2 || ccType === 3)) {
        sawAnyDtvcc = true;
        if (ccType === 3) sawAnyDtvccStart = true;
      }
    }

    let cursor = tripEndExpected;

    // ---- Optional CCSVCInfo (0x73) ----
    if (cursor < cdp.length && (cdp[cursor] & 0xff) === 0x73) {
      if (!flagSvcInfoPresent && strictPayloadParse) {
        cdpErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'cdp-ccsvc', message: 'CCSVCInfo section present but CDP flags service_info_present=0.' });
        continue;
      }

      if (cursor + 2 > cdp.length) {
        cdpErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'cdp-ccsvc', message: 'CCSVCInfo section truncated.' });
        continue;
      }

      const svcHdr = cdp[cursor + 1] & 0xff;
      const svcStart = !!(svcHdr & 0x40);
      const svcChange = !!(svcHdr & 0x20);
      const svcComplete = !!(svcHdr & 0x10);
      const svcCount = svcHdr & 0x0F;

      if (strictPayloadParse) {
        if ((svcHdr & 0x80) !== 0x80) {
          cdpErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'cdp-ccsvc', message: `CCSVCInfo header reserved bit7 must be 1 (got 0x${svcHdr.toString(16)}).` });
        }

        if (svcStart !== flagSvcInfoStart || svcChange !== flagSvcInfoChange || svcComplete !== flagSvcInfoComplete) {
          cdpErrors += 1;
          pushErr({ line: i + 1, timecode: tc, type: 'cdp-ccsvc', message: `CCSVCInfo start/change/complete bits (0x${svcHdr.toString(16)}) do not match CDP flags (0x${flags.toString(16)}).` });
        }
      }

      const svcLen = 2 + (svcCount * 7);
      if (cursor + svcLen > cdp.length) {
        cdpErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'cdp-ccsvc', message: `CCSVCInfo service entries truncated: count=${svcCount}, need ${svcLen} bytes.` });
        continue;
      }

      cursor += svcLen;
    } else if (flagSvcInfoPresent && strictPayloadParse) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp-ccsvc', message: 'CDP flags indicate service_info_present=1, but no 0x73 CCSVCInfo section found after CC_DATA.' });
      continue;
    }

    // ---- Footer (0x74) ----
    let footerPos = cursor;
    if (footerPos >= cdp.length || (cdp[footerPos] & 0xff) !== 0x74) {
      // Fall back to a search (useful for diagnosing malformed packets).
      const found = cdp.indexOf(0x74, footerPos);
      if (found === -1) {
        cdpErrors += 1;
        pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: 'CDP footer (0x74) not found.' });
        continue;
      }
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: `CDP footer not at expected position (expected ${footerPos}, found ${found}).` });
      footerPos = found;
    }

    if (footerPos + 3 > cdp.length) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: 'CDP footer truncated.' });
      continue;
    }

    const footerSeq = ((cdp[footerPos + 1] << 8) | cdp[footerPos + 2]) & 0xffff;
    if (footerSeq !== headerSeq) {
      seqErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'sequence', message: `Footer sequence counter (${footerSeq}) does not match header sequence counter (${headerSeq}).` });
    }

    // Structural sanity: footer (3 bytes) + checksum (1 byte) should end the CDP.
    if (checkCdpLength && (footerPos + 4) !== cdp.length) {
      cdpErrors += 1;
      pushErr({ line: i + 1, timecode: tc, type: 'cdp', message: `Unexpected trailing bytes after footer (footerPos=${footerPos}, cdpLen=${cdp.length}).` });
    }
  }

  if (mixedDelimiter) {
    pushWarn({ line: 0, timecode: '', type: 'timecode', message: 'Mixed timecode delimiters found (":" and ";"). Mixed delimiters may confuse some QC/ingest tools.' });
  }

  if (sawV2TimecodeSuffix) {
    if (fileFormatVersion === 'V1.0') {
      pushWarn({ line: 1, timecode: '', type: 'header', message: 'MCC contains V2 timecode suffixes (".<field>,<line>") but File Format is V1.0. Some tools may reject this; use MacCaption_MCC V2.0 for strict compliance.' });
    } else if (!fileFormatOk) {
      pushWarn({ line: 1, timecode: '', type: 'header', message: 'MCC contains V2 timecode suffixes (".<field>,<line>"). For best interoperability, include a valid "File Format=MacCaption_MCC V2.0" header.' });
    }
    if (v2TimecodeSuffixes.size > 1) {
      const list = Array.from(v2TimecodeSuffixes).slice(0, 5).join(' | ');
      const more = v2TimecodeSuffixes.size > 5 ? ` (+${v2TimecodeSuffixes.size - 5} more)` : '';
      pushWarn({ line: 0, timecode: '', type: 'timecode-suffix', message: `Multiple MCC V2 timecode suffix values were found: ${list}${more}.` });
    }
  }

  if (sawAnyDtvcc && !sawAnyDtvccStart) {
    pushWarn({
      line: 0,
      timecode: '',
      type: 'cea708',
      message: 'CEA-708 (DTVCC) data was detected, but no DTVCC "packet start" triplets (cc_type=3) were found anywhere in the file. Some decoders/NLE importers will ignore 708 captions unless packet-start markers are present.'
    });
  }

  const ok =
    (headerErrors === 0) &&
    (timecodeErrors === 0) &&
    (monotonicErrors === 0) &&
    (tokenErrors === 0) &&
    (ancErrors === 0) &&
    (cdpErrors === 0) &&
    (ccCountErrors === 0) &&
    (seqErrors === 0);

  const summary = ok
    ? `OK — ${parsedLines} MCC frame line(s) • 0 header errors • 0 timecode issues • 0 ANC issues • 0 CDP issues`
    : `FAIL — ${parsedLines} MCC frame line(s) • ${headerErrors} header error(s) • ${timecodeErrors} timecode issue(s) • ${ancErrors} ANC issue(s) • ${cdpErrors} CDP issue(s) • ${ccCountErrors} cc_count issue(s) • ${seqErrors} sequence issue(s) • ${tokenErrors} token issue(s)`;

  return {
    ok,
    file: filePath || undefined,
    totalLines: allLines.length,
    parsedLines,
    fps,
    dropFrame,
    header,
    headerErrors,
    timecodeErrors,
    monotonicErrors,
    tokenErrors,
    ancErrors,
    cdpErrors,
    ccCountErrors,
    seqErrors,
    errors,
    warnings,
    summary
  };
}

// ---------------------------------------------------------------------------
// Verify/QC helpers (shared by export paths)
// ---------------------------------------------------------------------------

function _safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatVerifyErrors(errors, limit = 8) {
  const arr = Array.isArray(errors) ? errors : [];
  const lim = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 8;
  const out = [];

  const typeToCode = (t) => {
    const raw = String(t || '').trim();
    if (!raw) return 'E_VERIFY';
    const up = raw.toUpperCase().replace(/[^A-Z0-9_-]+/g, '_');
    // Common MCC verifier buckets → more descriptive codes.
    if (up === 'HEADER') return 'E_MCC_HEADER';
    if (up === 'TIMECODE') return 'E_MCC_TIMECODE';
    if (up === 'MONOTONIC') return 'E_MCC_MONOTONIC';
    if (up === 'PAYLOAD') return 'E_MCC_PAYLOAD';
    if (up === 'ANC') return 'E_ANC_CHECKSUM';
    if (up === 'CDP') return 'E_CDP_CHECKSUM';
    if (up === 'SEQUENCE') return 'E_CDP_SEQUENCE';
    if (up === 'CC_COUNT') return 'E_CDP_CC_COUNT';
    if (up === 'TIMECODE_SUFFIX') return 'E_MCC_TIMECODE_SUFFIX';
    return up.startsWith('E_') ? up : `E_${up}`;
  };

  for (const err of arr.slice(0, lim)) {
    if (typeof err === 'string') {
      const s = err.trim();
      if (s) out.push(s);
      continue;
    }
    if (!err || typeof err !== 'object') {
      const s = String(err || '').trim();
      if (s) out.push(s);
      continue;
    }

    const code = (typeof err.code === 'string' && err.code.trim())
      ? err.code.trim()
      : typeToCode(err.type || err.kind);

    const msg = (typeof err.message === 'string' && err.message.trim())
      ? err.message.trim()
      : (typeof err.detail === 'string' && err.detail.trim())
        ? err.detail.trim()
        : '';

    const tc = (typeof err.timecode === 'string' && err.timecode.trim()) ? err.timecode.trim() : '';
    const line = Number.isFinite(Number(err.line)) ? Number(err.line) : null;
    const field = (typeof err.field === 'string' && err.field.trim()) ? err.field.trim() : '';

    const where = tc
      ? ` @ ${tc}`
      : (line != null && line > 0)
        ? ` line ${line}`
        : '';

    const fieldPart = field ? ` (${field})` : '';

    if (msg) {
      out.push(`${code}${where}${fieldPart}: ${msg}`);
    } else {
      out.push(`${code}${where}${fieldPart}: ${_safeJsonStringify(err)}`);
    }
  }

  return out;
}

module.exports = {
  // Builders + QC
  wrapTextAndClamp,
  wrapTextAndClamp608,
  wrapTextAndClamp608WithMeta,
  derive608CuesFromCanonical,
  derive608TrackFromCanonical,
  encode608Line, encode608StyledLine, pacForRow, ctrl,
  computeCea608PlacementAudit,
  SCC_MODEL,
  // Encoders
  generateSCC,
  // Verifier
  verifySCC,
  // CTA-708 / MCC
  generateDTVCC, verifyDTVCC,
  generateMCC,
  verifyMCC,
  formatVerifyErrors
};

// ------------------------ CTA-708 glue (service blocks + DTVCC)
// Use a static require so bundlers (esbuild/webpack) don't drop the module.
const _cea708 = require('./cea708Encoder');

function _wrapLines608Compat(text, maxCharsPerLine, maxLinesPerBlock, opts) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const o = (opts && typeof opts === 'object') ? opts : undefined;
  return wrapTextAndClamp(clean, maxCharsPerLine || 32, maxLinesPerBlock || 2, o);
}

function generateDTVCC(
  segments,
  {
    maxCharsPerLine = 32,
    maxLinesPerBlock = 2,
    serviceNumber = 1,
    pen = null,
    penColor = null,
    windowStyle = null,
    window = null,
    sccOptions = {},
    returnPackets = true   // true: return array of packets per segment; false: return Buffer of all packets
  } = {}
) {
  // _cea708 is guaranteed by the static require above.
  if (!Array.isArray(segments) || !segments.length) return returnPackets ? [] : Buffer.alloc(0);

  const align = _normalizeAlignment(sccOptions.alignment) || 'left';
  // Global styling / placement defaults (mirror generateMCC priority order).
  const globalWindowPlacement = (window && typeof window === 'object')
    ? window
    : (sccOptions?.mcc708Window ?? sccOptions?.cea708Window ?? sccOptions?.windowPlacement ?? sccOptions?.window ?? null);
  const globalWindowStyle = (windowStyle && typeof windowStyle === 'object')
    ? windowStyle
    : (sccOptions?.mcc708WindowStyle ?? sccOptions?.cea708WindowStyle ?? null);
  const globalPen = (pen && typeof pen === 'object')
    ? pen
    : (sccOptions?.mcc708Pen ?? sccOptions?.cea708Pen ?? null);
  const globalPenColor = (penColor && typeof penColor === 'object')
    ? penColor
    : (sccOptions?.mcc708PenColor ?? sccOptions?.cea708PenColor ?? null);
  const packetsOut = [];

  const _runsToTextLocal = (runs) => Array.isArray(runs)
    ? runs.map(r => String((r && typeof r === 'object') ? (r.text ?? '') : '')).join('')
    : '';

  for (const seg of segments) {
    if (!seg) continue;
    const segRuns = Array.isArray(seg?.runs)
      ? seg.runs
      : (seg?.text && typeof seg.text === 'object' && Array.isArray(seg.text.runs))
        ? seg.text.runs
        : null;
    const rawText = (typeof seg?.text === 'string')
      ? String(seg.text)
      : (segRuns ? _runsToTextLocal(segRuns) : '');
    if (!rawText || !rawText.trim()) continue;

    const hasRuns = !!(segRuns && segRuns.length);
    const wrap708 = hasRuns
      ? (() => {
        const w = _cea708.wrapRunsToLines(segRuns, maxCharsPerLine, maxLinesPerBlock, {
          overflowPolicy: 'truncate',
          overflowCtx: { cueIndex: null }
        });
        return { ...w, window: null, justify: null, pen: null };
      })()
      : wrapTextAndClamp708Rich(rawText, maxCharsPerLine, maxLinesPerBlock, { overflowPolicy: 'truncate', overflowCtx: { cueIndex: null } });

    const lines = wrap708.lines;
    const lineRuns = wrap708.lineRuns;
    if (!lines.length) continue;

    let colCount = Math.min(42, Math.max(...lines.map(l => Math.min(42, _visible708Length(l)))) || 32);

    const svcOpts = {
      justify: wrap708.justify || align,
      colCount,
      ...(globalWindowPlacement && typeof globalWindowPlacement === 'object' ? globalWindowPlacement : {}),
      ...(globalWindowStyle && typeof globalWindowStyle === 'object' ? { windowStyle: globalWindowStyle } : {}),
      ...(globalPen && typeof globalPen === 'object' ? { pen: globalPen } : {}),
      ...(globalPenColor && typeof globalPenColor === 'object' ? { penColor: globalPenColor } : {})
    };

    // If the cue requested explicit pen location, use SPL placement (full-grid window).
    if (wrap708.pen && (wrap708.pen.row != null || wrap708.pen.col != null)) {
      const pr = Math.max(0, Math.min(15, Number(wrap708.pen.row) || 0));
      const pc = Math.max(0, Math.min(63, Number(wrap708.pen.col) || 0));
      svcOpts.penLocations = { row: pr, col: pc };
      svcOpts.rowCount = 15;
      svcOpts.colCount = Math.max(32, Math.min(63, svcOpts.colCount || 42));
      svcOpts.rel = true;
      svcOpts.anchorId = 0;
      svcOpts.anchorV = 0;
      svcOpts.anchorH = 0;
    }

    const svcBytes = (lineRuns && lineRuns.length)
      ? _cea708.buildServiceBytesForLineRuns(lineRuns, svcOpts)
      : _cea708.buildServiceBytesForLines(lines, svcOpts);
    const svcBlocks = _cea708.chunkToServiceBlocks(svcBytes, Math.max(1, Math.min(63, Number(serviceNumber) || 1)));
    const dtvccPackets = _cea708.packDTVCC(svcBlocks);

    if (returnPackets) {
      packetsOut.push({ start: seg.start, end: seg.end, packets: dtvccPackets });
    } else {
      packetsOut.push(...dtvccPackets);
    }
  }

  if (returnPackets) return packetsOut;
  // Concatenate raw packets into a single Buffer
  const flat = packetsOut.reduce((acc, arr) => acc.concat(Array.from(arr)), []);
  return Buffer.from(flat);
}

// Pragmatic verifier: sizes/headers and command arities we generate
function verifyDTVCC(input, { maxErrors = 100 } = {}) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Array.isArray(input)
      ? Buffer.from(input.flat ? input.flat() : input)
      : Buffer.from(input || []);

  const errors = [];
  let pos = 0;
  let packets = 0, serviceBlocks = 0;

  function err(msg, at) { if (errors.length < maxErrors) errors.push({ pos: at ?? pos, msg }); }

  while (pos < buf.length) {
    // DTVCC packet header: [ seq(2) | packet_size(6) ]
    const header = buf[pos++];
    if (header == null) { err('EOF before DTVCC header'); break; }
    const pktSize = header & 0x3f;
    if (pktSize === 0) { err('Packet size = 0', pos - 1); break; }
    if ((pos + pktSize) > buf.length) { err('Packet size exceeds buffer', pos - 1); break; }
    const end = pos + pktSize;
    packets++;

    // Parse service blocks inside this payload
    while (pos < end) {
      const sbHdr = buf[pos++];
      if (sbHdr == null) { err('EOF in service block header', pos - 1); break; }
      let service = (sbHdr & 0xe0) >> 5;
      let blockLen = sbHdr & 0x1f;
      if (service === 7) { // extended
        const ext = buf[pos++];
        if (ext == null) { err('EOF in extended service number', pos - 1); break; }
        service = 7 + (ext & 0x3f);
      }
      if ((pos + blockLen) > end) { err('Service block length exceeds packet', pos - 1); break; }

      // Shallow command scan (only the ones we emit)
      const stop = pos + blockLen;
      while (pos < stop) {
        const b = buf[pos++];
        if (b == null) { err('EOF inside service block', pos - 1); break; }
        if (b === 0x03 || b === 0x0d) continue; // ETX/CR
        if ((b >= 0x20 && b <= 0x7e) || b === 0x7f || (b >= 0xa0 && b <= 0xff)) continue;   // G0/G1 text (+ music note)
        // Commands we emit and their arg sizes:
        if (b >= 0x80 && b <= 0x87) { /* CWx */ continue; }
        else if (b === 0x88 || b === 0x89 || b === 0x8a || b === 0x8c) { // CLW/DSW/HDW/DLW +1
          if ((pos + 1) > stop) { err('Truncated window-bitmap param', pos - 1); break; }
          pos += 1;
        } else if (b === 0x92) { // SPL +2
          if ((pos + 2) > stop) { err('Truncated SPL params', pos - 1); break; }
          pos += 2;
        } else if (b === 0x97) { // SWA +4
          if ((pos + 4) > stop) { err('Truncated SWA params', pos - 1); break; }
          pos += 4;
        } else if (b === 0x90) { // SPA +3
          if ((pos + 3) > stop) { err('Truncated SPA params', pos - 1); break; }
          pos += 3;
        } else if (b === 0x91) { // SPC +3
          if ((pos + 3) > stop) { err('Truncated SPC params', pos - 1); break; }
          pos += 3;
        } else if (b >= 0x98 && b <= 0x9f) { // DFx +6
          if ((pos + 6) > stop) { err('Truncated DFx params', pos - 1); break; }
          pos += 6;
        } else {
          err(`Unexpected/unsupported byte 0x${b.toString(16)}`, pos - 1);
          // bail to avoid loops
          break;
        }
      }
      serviceBlocks++;
    }
    pos = end;
  }

  return {
    ok: errors.length === 0,
    packets, serviceBlocks, errors,
    summary: errors.length
      ? `FAIL — ${packets} packet(s), ${serviceBlocks} service block(s), ${errors.length} error(s)`
      : `OK — ${packets} packet(s), ${serviceBlocks} service block(s) • 0 errors`
  };
}
