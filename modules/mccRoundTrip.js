'use strict';

// modules/mccRoundTrip.js
//
// Round-trip sanity checks for MCC:
//  - decode what we just encoded
//  - compare timing + text against the intended segments
//
// This is a DEV/QA tool. It should never hard-fail export by default; instead it
// produces a machine-parseable diff object and lets the caller decide policy.

const fs = require('fs');

const scc = require('./sccEncoder');
const { decodeMccText } = require('./mccDecoder');
const { formatTimecode, isDropFrameRate } = require('../utils/timeUtils');

// Phase C: style QC (708). We keep this conservative: if the caller asked for styling
// via runs[], we assert that decoded cues contain the corresponding pen attributes/
// colors somewhere in the rendered snapshot.
const _SAFE_PALETTE = {
  black:   { r: 0, g: 0, b: 0 },
  red:     { r: 3, g: 0, b: 0 },
  green:   { r: 0, g: 3, b: 0 },
  yellow:  { r: 3, g: 3, b: 0 },
  blue:    { r: 0, g: 0, b: 3 },
  magenta: { r: 3, g: 0, b: 3 },
  cyan:    { r: 0, g: 3, b: 3 },
  white:   { r: 3, g: 3, b: 3 }
};

function _opacityTo2bitLocal(op) {
  if (op == null) return 0;
  if (typeof op === 'number' && Number.isFinite(op)) {
    return Math.max(0, Math.min(3, Math.round(op)));
  }
  const s = String(op).trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return 3;
  if (s === 'translucent' || s === 'semi' || s === 'semi-transparent') return 2;
  if (s === 'solid' || s === 'opaque') return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(0, Math.min(3, Math.round(n)));
  return 0;
}

function _normalizePaletteNameLocal(spec, fallback) {
  const fb = (fallback && _SAFE_PALETTE[String(fallback).toLowerCase()])
    ? String(fallback).toLowerCase()
    : 'white';
  if (!spec) return fb;
  const s = String(spec).trim().toLowerCase();
  if (_SAFE_PALETTE[s]) return s;
  // Minimal robustness: accept CSS-ish hex and map to nearest of the 8.
  const hex = s.match(/^#?([0-9a-f]{6})$/i);
  if (hex) {
    const v = hex[1];
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    let best = fb;
    let bestD = Infinity;
    for (const [name, rgb] of Object.entries(_SAFE_PALETTE)) {
      const rr = rgb.r * 85;
      const gg = rgb.g * 85;
      const bb = rgb.b * 85;
      const d = (r - rr) * (r - rr) + (g - gg) * (g - gg) + (b - bb) * (b - bb);
      if (d < bestD) {
        bestD = d;
        best = name;
      }
    }
    return best;
  }
  return fb;
}

function _cea708ColorByteLocal(colorName, opacity2bit) {
  const name = _normalizePaletteNameLocal(colorName, 'white');
  const rgb = _SAFE_PALETTE[name] || _SAFE_PALETTE.white;
  const op = _opacityTo2bitLocal(opacity2bit);
  return ((op & 3) << 6) | ((rgb.r & 3) << 4) | ((rgb.g & 3) << 2) | (rgb.b & 3);
}

function _extractRunsFromSeg(seg) {
  if (!seg || typeof seg !== 'object') return null;
  if (Array.isArray(seg.runs) && seg.runs.length) return seg.runs;
  if (seg.text && typeof seg.text === 'object' && Array.isArray(seg.text.runs) && seg.text.runs.length) return seg.text.runs;
  return null;
}

function _summarizeExpectedStyleFromRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) return null;

  const baseFg = _cea708ColorByteLocal('white', 0);
  const baseBg = _cea708ColorByteLocal('black', 3); // transparent black

  const fgWanted = new Set();
  const bgWanted = new Set();
  let wantsItalic = false;
  let wantsUnderline = false;

  for (const run of runs) {
    if (!run || typeof run !== 'object') continue;
    const s = (run.style && typeof run.style === 'object') ? run.style : run;

    if (s.italic === true || s.i === true) wantsItalic = true;
    if (s.underline === true || s.u === true) wantsUnderline = true;

    const fgSpec = (s.fg != null) ? s.fg : (s.color != null ? s.color : s.foreground);
    const fgOp = (s.fgOpacity != null) ? s.fgOpacity : (s.opacity != null ? s.opacity : 0);
    if (fgSpec != null) {
      const fgByte = _cea708ColorByteLocal(fgSpec, fgOp);
      if (fgByte !== baseFg) fgWanted.add(fgByte);
    }

    const bgSpecRaw = (s.bg != null) ? s.bg : (s.background != null ? s.background : s.bgColor);
    const bgOpRaw = (s.bgOpacity != null) ? s.bgOpacity : (s.backgroundOpacity != null ? s.backgroundOpacity : null);

    // Treat explicit "none" as transparent black.
    if (bgSpecRaw != null || bgOpRaw != null) {
      const bgSpec = (bgSpecRaw == null || String(bgSpecRaw).toLowerCase() === 'none' || String(bgSpecRaw).toLowerCase() === 'transparent')
        ? 'black'
        : bgSpecRaw;
      const bgOp = (bgSpecRaw == null || String(bgSpecRaw).toLowerCase() === 'none' || String(bgSpecRaw).toLowerCase() === 'transparent')
        ? 3
        : (bgOpRaw != null ? bgOpRaw : 3);

      const bgByte = _cea708ColorByteLocal(bgSpec, bgOp);
      if (bgByte !== baseBg) bgWanted.add(bgByte);
    }
  }

  const wanted = wantsItalic || wantsUnderline || fgWanted.size || bgWanted.size;
  if (!wanted) return null;

  return {
    wantsItalic,
    wantsUnderline,
    fgBytes: Array.from(fgWanted),
    bgBytes: Array.from(bgWanted)
  };
}

function _summarizeActual708StyleFromCue(cue) {
  const out = {
    hasItalic: false,
    hasUnderline: false,
    fgBytes: new Set(),
    bgBytes: new Set()
  };

  const windows = cue?.cea708?.windows;
  if (!Array.isArray(windows) || !windows.length) return out;

  for (const w of windows) {
    const ls = Array.isArray(w?.lineStyles) ? w.lineStyles : [];
    for (const s of ls) {
      if (!out.hasItalic && /[13]/.test(String(s))) out.hasItalic = true;
      if (!out.hasUnderline && /[23]/.test(String(s))) out.hasUnderline = true;
      if (out.hasItalic && out.hasUnderline) break;
    }

    const lfg = Array.isArray(w?.lineFg) ? w.lineFg : [];
    for (const row of lfg) {
      if (!Array.isArray(row)) continue;
      for (const b of row) {
        if (Number.isFinite(b)) out.fgBytes.add((Number(b)) & 0xFF);
      }
    }

    const lbg = Array.isArray(w?.lineBg) ? w.lineBg : [];
    for (const row of lbg) {
      if (!Array.isArray(row)) continue;
      for (const b of row) {
        if (Number.isFinite(b)) out.bgBytes.add((Number(b)) & 0xFF);
      }
    }
  }

  return {
    hasItalic: out.hasItalic,
    hasUnderline: out.hasUnderline,
    fgBytes: Array.from(out.fgBytes),
    bgBytes: Array.from(out.bgBytes)
  };
}

function _compareStyleWantedSeen(wanted, seen) {
  if (!wanted) return { ok: true, issues: [] };
  const issues = [];

  if (wanted.wantsItalic && !seen?.hasItalic) {
    issues.push({ kind: 'italic_missing' });
  }
  if (wanted.wantsUnderline && !seen?.hasUnderline) {
    issues.push({ kind: 'underline_missing' });
  }

  const seenFg = seen?.fgBytes instanceof Set ? seen.fgBytes : new Set(Array.isArray(seen?.fgBytes) ? seen.fgBytes : []);
  const seenBg = seen?.bgBytes instanceof Set ? seen.bgBytes : new Set(Array.isArray(seen?.bgBytes) ? seen.bgBytes : []);

  for (const b of Array.isArray(wanted.fgBytes) ? wanted.fgBytes : []) {
    if (!seenFg.has(b & 0xFF)) issues.push({ kind: 'fg_missing', byte: b & 0xFF });
  }
  for (const b of Array.isArray(wanted.bgBytes) ? wanted.bgBytes : []) {
    if (!seenBg.has(b & 0xFF)) issues.push({ kind: 'bg_missing', byte: b & 0xFF });
  }

  return { ok: issues.length === 0, issues };
}

function _normalizeText(s) {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function _normalizeSafeMargins(safe) {
  // Keep logic aligned with sccEncoder's internal _normalizeSafeMargins().
  if (safe === false) return { left: 0, right: 0, width: 32 };

  if (
    safe &&
    typeof safe === 'object' &&
    Number.isFinite(safe.left) &&
    Number.isFinite(safe.right) &&
    Number.isFinite(safe.width)
  ) {
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

  if ((left + right) > 31) {
    const over = (left + right) - 31;
    right = Math.max(0, right - over);
    if ((left + right) > 31) {
      left = Math.max(0, left - ((left + right) - 31));
    }
  }

  const width = Math.max(1, 32 - left - right);
  return { left, right, width };
}

function _extractCompat608OverrideText(seg) {
  if (!seg || typeof seg !== 'object') return null;

  // Phase 1: per-cue overrides schema
  const o = seg.overrides;
  if (o && typeof o === 'object') {
    const o608 = o['608'];
    if (o608 && typeof o608 === 'object') {
      if (typeof o608.text === 'string' && o608.text.trim()) return o608.text;
      if (Array.isArray(o608.breaks) && o608.breaks.length) {
        const joined = o608.breaks.map((l) => String(l || '')).join('\n');
        if (joined.trim()) return joined;
      }
    }
  }

  const direct = seg.compat608Text ?? seg.compat608_override ?? seg.compat608OverrideText;
  if (typeof direct === 'string' && direct.trim()) return direct;

  const container = seg.compat608;
  if (container && typeof container === 'object') {
    if (typeof container.text === 'string' && container.text.trim()) return container.text;
    if (Array.isArray(container.lines) && container.lines.length) {
      const joined = container.lines.map((l) => String(l || '')).join('\n');
      if (joined.trim()) return joined;
    }
  }

  if (Array.isArray(seg.compat608Lines) && seg.compat608Lines.length) {
    const joined = seg.compat608Lines.map((l) => String(l || '')).join('\n');
    if (joined.trim()) return joined;
  }

  return null;
}

function _segText(seg) {
  if (!seg) return '';
  if (typeof seg.text === 'string') return seg.text;
  if (Array.isArray(seg.lines) && seg.lines.length) return seg.lines.map((l) => String(l || '')).join('\n');
  return '';
}

function _buildExpected(segments, mode, {
  fps = 29.97,
  dropFrame = true,
  safeMargins = null,
  overflowPolicy = 'truncate',
  wrap608Options = null,
  allowExplicitLineBreaks = undefined,
  maxCols608 = undefined
} = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const expected = [];

  const dfCapable = isDropFrameRate(Number(fps) || 29.97);
  const useDf = !!dropFrame && dfCapable;

  const safe = _normalizeSafeMargins(safeMargins);
  const safeWidth = Math.max(1, Math.min(32, safe.width));

  const cols608 = Number.isFinite(Number(maxCols608))
    ? Math.max(1, Math.min(32, Math.trunc(Number(maxCols608))))
    : safeWidth;

  const lines608 = 2;

  // Prepare wrap cfg for 608 shaping; mirror generateMCC behavior:
  // - allowExplicitLineBreaks is a top-level option (not inside wrapCfg)
  let allowBreaks = (allowExplicitLineBreaks !== undefined)
    ? (allowExplicitLineBreaks !== false)
    : true;

  let wrap608 = null;
  if (wrap608Options && typeof wrap608Options === 'object') {
    wrap608 = { ...wrap608Options };
    if (wrap608.allowExplicitLineBreaks != null) {
      allowBreaks = (wrap608.allowExplicitLineBreaks !== false);
      delete wrap608.allowExplicitLineBreaks;
    }
  }

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg || typeof seg !== 'object') continue;

    const start = Number.isFinite(Number(seg.start))
      ? Number(seg.start)
      : (Number.isFinite(Number(seg.msStart)) ? (Number(seg.msStart) / 1000) : NaN);
    const end = Number.isFinite(Number(seg.end))
      ? Number(seg.end)
      : (Number.isFinite(Number(seg.msEnd)) ? (Number(seg.msEnd) / 1000) : NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    let text = _segText(seg);
    if (mode === 'cea608') {
      const override = _extractCompat608OverrideText(seg);
      if (override != null) text = String(override);
      const meta = scc.wrapTextAndClamp608WithMeta(text, {
        maxCols: cols608,
        maxLines: lines608,
        overflowPolicy,
        allowExplicitLineBreaks: allowBreaks,
        ...(wrap608 ? { wrap608 } : {})
      });
      text = meta.lines.join('\n');
    }

    const runs = (mode === 'cea708') ? _extractRunsFromSeg(seg) : null;
    const styleWanted = (mode === 'cea708') ? _summarizeExpectedStyleFromRuns(runs) : null;

    expected.push({
      index: i,
      start,
      end,
      startTc: formatTimecode(start, useDf, fps, 'colon'),
      endTc: formatTimecode(end, useDf, fps, 'colon'),
      text: _normalizeText(text),
      ...(styleWanted ? { styleWanted } : {})
    });
  }

  expected.sort((a, b) => a.start - b.start);
  return expected;
}

function _buildActual(decoded, {
  fps = 29.97,
  dropFrame = true
} = {}) {
  const cues = decoded?.cues || decoded?.doc?.cues || [];
  const dfCapable = isDropFrameRate(Number(fps) || 29.97);
  const useDf = !!dropFrame && dfCapable;

  return (Array.isArray(cues) ? cues : [])
    .filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && typeof c.text === 'string')
    .map((c) => {
      const styleSeen = _summarizeActual708StyleFromCue(c);
      return {
        start: Number(c.start),
        end: Number(c.end),
        startTc: formatTimecode(Number(c.start), useDf, fps, 'colon'),
        endTc: formatTimecode(Number(c.end), useDf, fps, 'colon'),
        text: _normalizeText(c.text),
        ...(styleSeen ? { styleSeen } : {})
      };
    })
    .sort((a, b) => a.start - b.start);
}

function _compareByStart(expected, actual, {
  fps = 29.97,
  toleranceFrames = 1.5,
  compareEndTimes = true
} = {}) {
  const tolSec = (Number(toleranceFrames) || 1.5) / (Number(fps) || 30);

  let ai = 0;
  const mismatches = [];

  for (let ei = 0; ei < expected.length; ei++) {
    const e = expected[ei];

    while (ai < actual.length && actual[ai].start < e.start - tolSec) ai++;

    let best = null;
    let bestIdx = -1;

    for (let j = ai; j < actual.length; j++) {
      const a = actual[j];
      if (a.start > e.start + tolSec) break;

      const dt = Math.abs(a.start - e.start);
      if (dt <= tolSec) {
        best = a;
        bestIdx = j;
        break;
      }
    }

    if (!best) {
      mismatches.push({
        kind: 'missing',
        expected: e
      });
      continue;
    }

    ai = bestIdx + 1;

    const dtEnd = (Number.isFinite(best.end) && Number.isFinite(e.end))
      ? Math.abs(best.end - e.end)
      : 0;

    const textOk = best.text === e.text;

    const styleCmp = _compareStyleWantedSeen(e.styleWanted, best.styleSeen);
    const styleOk = styleCmp.ok;

    if (!textOk || (compareEndTimes && dtEnd > tolSec) || !styleOk) {
      mismatches.push({
        kind: 'mismatch',
        expected: e,
        actual: best,
        dtEnd,
        textOk,
        endOk: (dtEnd <= tolSec),
        styleOk,
        styleIssues: styleCmp.issues,
        expectedStyle: styleCmp.expected,
        actualStyle: styleCmp.actual
      });
    }
  }

  // "Extra" cues: anything not consumed and not within tolerance of any expected.
  // (Best-effort; mostly useful for debugging splits/duplication.)
  const consumedStarts = new Set(
    mismatches
      .filter((m) => m.kind === 'mismatch' && m.actual)
      .map((m) => `${m.actual.start.toFixed(6)}`)
  );

  const extras = [];
  for (const a of actual) {
    if (consumedStarts.has(`${a.start.toFixed(6)}`)) continue;
    const close = expected.find((e) => Math.abs(e.start - a.start) <= tolSec);
    if (!close) extras.push(a);
  }

  return {
    ok: mismatches.length === 0,
    mismatchCount: mismatches.length,
    extraCount: extras.length,
    expectedCount: expected.length,
    actualCount: actual.length,
    mismatches,
    extras
  };
}

function _sampleMismatchText(mismatches, max = 5) {
  const out = [];
  for (const m of mismatches.slice(0, max)) {
    if (!m || typeof m !== 'object') continue;
    if (m.kind === 'missing') {
      out.push(`Missing @ ${m.expected?.startTc || ''}: "${m.expected?.text || ''}"`);
      continue;
    }
    const bits = [];
    if (m.textOk === false) bits.push('text');
    if (Number.isFinite(m.dtEnd) && m.dtEnd > 0) bits.push('end');
    out.push(`Mismatch @ ${m.expected?.startTc || ''} (${bits.join('+')}): expected "${m.expected?.text || ''}" got "${m.actual?.text || ''}"`);
  }
  return out.join(' | ');
}

function roundTripCompareMccText(mccText, segments, opts = {}) {
  const fps = Number(opts.fps ?? 29.97);
  const dropFrame = !!opts.dropFrame && isDropFrameRate(fps);

  const include608Compatibility = (opts.include608Compatibility !== false);
  const compare708 = (opts.compare708 !== false);
  const compare608 = include608Compatibility && (opts.compare608 !== false);

  const overflowPolicy = (typeof opts.overflowPolicy === 'string' && opts.overflowPolicy.trim())
    ? String(opts.overflowPolicy).trim().toLowerCase()
    : 'truncate';

  const safeMargins = (opts.safeMargins !== undefined) ? opts.safeMargins : null;
  const wrap608Options = (opts.wrap608Options && typeof opts.wrap608Options === 'object') ? opts.wrap608Options : null;

  const out = {
    ok: true,
    fps,
    dropFrame,
    compare708: null,
    compare608: null
  };

  let decoded708 = null;
  let decoded608 = null;

  try {
    if (compare708) {
      decoded708 = decodeMccText(mccText, { fps, dropFrame, keepAbsoluteTimecode: false });
      const expected = _buildExpected(segments, 'cea708', { fps, dropFrame });
      const actual = _buildActual(decoded708, { fps, dropFrame });
      const cmp = _compareByStart(expected, actual, { fps, toleranceFrames: opts.toleranceFrames ?? 1.5, compareEndTimes: (opts.compareEndTimes708 !== false) });
      out.compare708 = {
        ...cmp,
        sample: cmp.ok ? '' : _sampleMismatchText(cmp.mismatches)
      };
      if (!cmp.ok) out.ok = false;
    }
  } catch (e) {
    out.ok = false;
    out.compare708 = {
      ok: false,
      error: e?.message || String(e),
      mismatchCount: null,
      expectedCount: null,
      actualCount: null,
      mismatches: [],
      extras: [],
      sample: ''
    };
  }

  try {
    if (compare608) {
      decoded608 = decodeMccText(mccText, { fps, dropFrame, keepAbsoluteTimecode: false, force608Compatibility: true });
      const expected = _buildExpected(segments, 'cea608', {
        fps,
        dropFrame,
        safeMargins,
        overflowPolicy,
        wrap608Options,
        allowExplicitLineBreaks: opts.allowExplicitLineBreaks
      });
      const actual = _buildActual(decoded608, { fps, dropFrame });
      const cmp = _compareByStart(expected, actual, { fps, toleranceFrames: opts.toleranceFrames ?? 1.5, compareEndTimes: (opts.compareEndTimes608 === true) });
      out.compare608 = {
        ...cmp,
        sample: cmp.ok ? '' : _sampleMismatchText(cmp.mismatches)
      };
      if (!cmp.ok) out.ok = false;
    }
  } catch (e) {
    out.ok = false;
    out.compare608 = {
      ok: false,
      error: e?.message || String(e),
      mismatchCount: null,
      expectedCount: null,
      actualCount: null,
      mismatches: [],
      extras: [],
      sample: ''
    };
  }

  // Optional: include decoded metadata for debugging (but keep it small).
  if (opts.includeDecodeMetadata === true) {
    out.decoded = {
      header: decoded708?.header || decoded708?.doc?.header || null,
      mccOptions: decoded708?.mccOptions || decoded708?.doc?.mccOptions || null,
      availableServices: decoded708?.availableServices || decoded708?.doc?.availableServices || null
    };
  }

  return out;
}

function roundTripCompareMccFile(filePath, segments, opts = {}) {
  const p = String(filePath || '');
  if (!p) throw new Error('No MCC file path provided');
  const mccText = fs.readFileSync(p, 'utf8');
  return roundTripCompareMccText(mccText, segments, opts);
}

module.exports = {
  roundTripCompareMccText,
  roundTripCompareMccFile,
  _normalizeSafeMargins
};
