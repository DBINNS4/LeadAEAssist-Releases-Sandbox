// ai/sccShaper.js
//
// SCC "caption shaping" pass: takes rough segments (ASR-style) and nudges them toward
// broadcast-friendly 608 pop-on blocks.
//
// Goals:
//  - Merge micro-cues (too short / too close)
//  - Enforce minimum duration + minimum gap (optionally, without ripple-shifting later cues)
//  - Reduce CPS/WPM by extending time when possible (within available gaps), or (aggressive mode)
//    by small ripple shifts (bounded) and optional splitting.
//  - When Start TC is set and preStartTransmitSec=0, optionally delay the FIRST cue so the encoder
//    doesn't need to transmit before Start TC (prevents late-EOC warnings).
//
// This is intentionally heuristic. It should make files *more* likely to pass QC,
// but it must never silently destroy timing accuracy, cross speaker boundaries, or
// lengthen beyond the source duration.
//
// Callers should always treat shaping as best-effort (never block file creation).

const scc = require('../modules/sccEncoder');

function normalizeSccChannel(value) {
  const s = String(value ?? '').trim().toUpperCase();
  const m = s.match(/^CC\s*([1-4])$/);
  const n = m ? parseInt(m[1], 10) : parseInt(s, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, n));
}

function _mergeSccOptionsForClamp(opts, startTc) {
  const fromOpts =
    opts && opts.sccOptions && typeof opts.sccOptions === 'object' ? opts.sccOptions : {};

  const baseDefaults = {
    alignment: 'center',
    rowPolicy: 'bottom2',
    safeMargins: { left: 1, right: 1 }
  };

  const merged = { ...baseDefaults, ...fromOpts };
  merged.mode = 'pop-on';
  merged.channel = normalizeSccChannel(opts?.channel ?? merged.channel);
  merged.timeSource =
    typeof merged.timeSource === 'string' && merged.timeSource ? merged.timeSource : opts?.timeSource || 'auto';
  merged.startTc = startTc;
  merged.preStartTransmitSec = 0;
  return merged;
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function _clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// Rough 608 tag stripper (matches validateSccContentQc intent)
function _strip608Tags(text) {
  const s = String(text || '');
  return s
    .replace(/\{(?:row|col)\s*:\s*[-+]?\d+\s*\}/gi, '')
    .replace(/\{pac\s*:\s*[-+]?\d+\s*,\s*[-+]?\d+\s*,\s*[-+]?\d+\s*\}/gi, '')
    .replace(/\{rcl\d+\}/gi, '')
    .replace(/\{(?:midrow|pos|nl|clr|cr|eoc|edm|en|it|noit|speed\d+)\}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _countWords(text) {
  const t = _strip608Tags(text);
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function _countCharsNoSpace(text) {
  const t = _strip608Tags(text);
  return t.replace(/\s+/g, '').length;
}

function _joinText(a, b) {
  const A = String(a || '').trim();
  const B = String(b || '').trim();
  if (!A) return B;
  if (!B) return A;
  // If A ends with a hyphen, join without an extra space.
  if (/-$/.test(A)) return (A + B).replace(/\s+/g, ' ').trim();
  return (A + ' ' + B).replace(/\s+/g, ' ').trim();
}

function _hasInline608Tags(text) {
  return /\{(?:row|col|pac|rcl\d+|midrow|pos|nl|clr|cr|eoc|edm|en|it|noit|speed\d+)\b/i.test(String(text || ''));
}

// ── Speaker boundary helpers ────────────────────────────────────────────────

function _normSpeakerLabel(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.toLowerCase();
}

// If the caller didn't provide seg.speaker, try a conservative inference from the text.
// This is intentionally picky: we only infer if it's a short-ish leading label ending in ":".
function _inferSpeakerFromText(text) {
  const t = String(text || '').trim();
  // Common caption convention: "NAME: dialogue..."
  // NOTE: use /i so Title Case labels like "John:" / "Speaker 1:" are detected.
  // Also allow '_' because diarization labels often look like "SPEAKER_1:".
  const m = t.match(/^([A-Z0-9][A-Z0-9 ._'-]{1,30})\s*:\s+\S/i);
  if (!m) return '';
  const label = String(m[1] || '').trim();
  // Require at least one letter to avoid catching "12:30" etc.
  if (!/[A-Z]/i.test(label)) return '';
  return label.toLowerCase();
}

function _speakerKey(seg) {
  const explicit = _normSpeakerLabel(seg?.speaker);
  if (explicit) return explicit;
  return _inferSpeakerFromText(seg?.text);
}

// Speaker relationship helper used by the micro-merge pass.
// Returns:
//   1  => strong evidence both are the same speaker
//  -1  => strong evidence they are different speakers
//   0  => unknown (no speaker metadata and no inferable inline label)
function _speakerRelation(a, b) {
  const expA = _normSpeakerLabel(a?.speaker);
  const expB = _normSpeakerLabel(b?.speaker);
  if (expA || expB) return (expA && expB && expA === expB) ? 1 : -1;

  const infA = _inferSpeakerFromText(a?.text);
  const infB = _inferSpeakerFromText(b?.text);
  if (infA || infB) return (infA && infB && infA === infB) ? 1 : -1;

  return 0;
}

// ── Text splitting + wrapping helpers ──────────────────────────────────────

function _findSplitPoint(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return -1;

  const mid = Math.floor(t.length / 2);
  const candidates = [];

  // Strong punctuation preferred
  const punctRe = /[.!?]\s+/g;
  let m;
  while ((m = punctRe.exec(t)) !== null) candidates.push(m.index + 1);

  // Softer punctuation
  const softRe = /[,;:—]\s+/g;
  while ((m = softRe.exec(t)) !== null) candidates.push(m.index + 1);

  // Any whitespace
  const wsRe = /\s+/g;
  while ((m = wsRe.exec(t)) !== null) candidates.push(m.index + 1);

  if (!candidates.length) return -1;

  // Pick the candidate closest to the midpoint, but avoid tiny fragments.
  let best = -1;
  let bestDist = Infinity;
  for (const idx of candidates) {
    const leftLen = idx;
    const rightLen = t.length - idx;
    if (leftLen < 8 || rightLen < 8) continue;
    const d = Math.abs(idx - mid);
    if (d < bestDist) {
      bestDist = d;
      best = idx;
    }
  }
  return best >= 0 ? best : candidates[Math.floor(candidates.length / 2)];
}

function _splitText(text) {
  const t = String(text || '').trim();
  const idx = _findSplitPoint(t);
  if (idx < 0) return null;
  const a = t.slice(0, idx).trim();
  const b = t.slice(idx).trim();
  if (!a || !b) return null;
  return [a, b];
}

function _wrapFits(text, maxCharsPerLine, maxLinesPerBlock) {
  try {
    scc.wrapTextAndClamp(String(text || ''), maxCharsPerLine, maxLinesPerBlock, { overflowPolicy: 'error' });
    return true;
  } catch {
    return false;
  }
}

// Split a cue into 2 cues within its existing time window (no extension).
// Ensures strictly monotonic time with at least 1 frame per part.
function _splitWithinWindow(seg, parts, { minGapSec, frameSec }) {
  const start = Number(seg.start) || 0;
  const end = Number(seg.end) || 0;
  const dur = Math.max(0, end - start);
  if (!(dur > 2 * frameSec + 1e-9)) return null;

  // Prefer a real minGap if we have room, otherwise 1 frame, otherwise 0.
  let gap = (dur > (2 * frameSec + minGapSec)) ? minGapSec : frameSec;
  gap = Math.max(0, Math.min(gap, dur - 2 * frameSec));

  const available = Math.max(0, dur - gap);
  if (!(available > 2 * frameSec + 1e-9)) {
    gap = 0;
  }

  const avail2 = Math.max(0, dur - gap);
  if (!(avail2 > 2 * frameSec + 1e-9)) return null;

  const aLen = Math.max(1, String(parts?.[0] ?? '').length);
  const bLen = Math.max(1, String(parts?.[1] ?? '').length);
  const ratio = aLen / (aLen + bLen);

  let aDur = avail2 * ratio;
  aDur = _clamp(aDur, frameSec, Math.max(frameSec, avail2 - frameSec));

  const firstEnd = start + aDur;
  const secondStart = firstEnd + gap;

  if (!(secondStart < end - 1e-9)) return null;

  const first = { ...seg, text: parts[0], end: firstEnd };
  const second = { ...seg, text: parts[1], start: secondStart, end };
  return { first, second };
}

function _computeRequiredDuration(text, { minDurationSec, maxCps, maxWpm }) {
  const chars = _countCharsNoSpace(text);
  const words = _countWords(text);
  const needCps = chars / Math.max(1e-6, maxCps);
  const needWpm = words > 0 ? (words * 60) / Math.max(1e-6, maxWpm) : 0;
  return Math.max(minDurationSec, needCps, needWpm);
}

function _computeFirstCueClampDelaySec(firstSeg, opts) {
  const startTc = opts.startTc;
  const preStartTransmitSec = _num(opts.preStartTransmitSec) > 0 ? _num(opts.preStartTransmitSec) : 0;
  if (!startTc || !String(startTc).trim()) return 0;
  if (preStartTransmitSec > 0) return 0; // allowing pre-roll means no need to delay

  // If the cue already starts late enough, no delay required.
  // We rely on the encoder's own clamp warning (it encodes leadWords + timing exactly).
  try {
    const res = scc.generateSCC([{
      start: Number(firstSeg.start) || 0,
      end: Number(firstSeg.end) || (Number(firstSeg.start) || 0) + 1,
      text: String(firstSeg.text || '')
    }], {
      fps: opts.fps,
      dropFrame: opts.dropFrame,
      startTc,
      maxCharsPerLine: opts.maxCharsPerLine,
      maxLinesPerBlock: opts.maxLinesPerBlock,
      includeSpeakerNames: Boolean(opts.includeSpeakerNames),
      sccOptions: _mergeSccOptionsForClamp(opts, startTc),
      returnStats: true
    });

    const warnings = Array.isArray(res?.stats?.warnings) ? res.stats.warnings : [];
    const w = warnings.find(x => /Start TC clamp: first caption transmit delayed by/i.test(String(x)));
    if (!w) return 0;
    const m = String(w).match(/delayed by\s+([0-9.]+)s/i);
    const delta = m ? Number(m[1]) : 0;
    return Number.isFinite(delta) ? delta : 0;
  } catch {
    return 0;
  }
}

function shapeSegmentsForScc(inputSegments, opts = {}) {
  const fps = Number.isFinite(_num(opts.fps)) ? _num(opts.fps) : 29.97;
  const frameSec = fps > 0 ? (1 / fps) : (1 / 29.97);

  const maxCharsPerLine = Number.isFinite(_num(opts.maxCharsPerLine)) ? Math.floor(_num(opts.maxCharsPerLine)) : 28;
  const maxLinesPerBlock = Number.isFinite(_num(opts.maxLinesPerBlock)) ? _clamp(Math.floor(_num(opts.maxLinesPerBlock)), 1, 2) : 2;

  const qc = opts.qc || {};
  const maxCps = Number.isFinite(_num(qc.maxCps)) ? _num(qc.maxCps) : 20;
  const maxWpm = Number.isFinite(_num(qc.maxWpm)) ? _num(qc.maxWpm) : 180;
  const minDurationSec = Number.isFinite(_num(qc.minDurationSec)) ? _num(qc.minDurationSec) : 0.8;

  // SCC/MCC end/start on the *same frame* is a common QC failure (butt-cut / inclusive-end overlap).
  // Even if the caller requests a 0 gap, enforcing at least a 1-frame gap prevents the
  // classic "end==next start" issue after frame quantization.
  const minGapSecRaw = Number.isFinite(_num(qc.minGapSec)) ? _num(qc.minGapSec) : 0.1;
  const minGapSec = Math.max(minGapSecRaw, frameSec);

  const maxDurationSec = Number.isFinite(_num(opts.maxDurationSec)) ? _num(opts.maxDurationSec) : 6;

  const mode = String(opts.mode || 'conservative').toLowerCase();
  // Conservative mode MUST NOT ripple-shift later cues (preserve alignment).
  // Aggressive mode may ripple, but it must be bounded.
  const allowShift = mode === 'aggressive';

  // Hard caps / safeguards
  const maxShiftSec = Number.isFinite(_num(opts.maxShiftSec)) ? Math.max(0, _num(opts.maxShiftSec)) : 0.25;
  const preserveSpeakerBoundaries = opts.preserveSpeakerBoundaries !== false;
  const clampToMaxEnd = opts.clampToMaxEnd !== false;

  const microCueSec = Number.isFinite(_num(opts.microCueSec)) ? Math.max(0, _num(opts.microCueSec)) : 0.40;
  const microGapSec = Number.isFinite(_num(opts.microGapSec)) ? Math.max(0, _num(opts.microGapSec)) : 0.12;

  const fixStartTcClamp = opts.fixStartTcClamp !== false;

  const report = {
    ok: true,
    summary: {
      originalCues: 0,
      finalCues: 0,
      changedCues: 0,
      mergedCues: 0,
      splitCues: 0,
      retimedCues: 0,
      firstCueDelayedSec: 0
    },
    warnings: [],
    errors: []
  };

  if (!Array.isArray(inputSegments) || inputSegments.length === 0) {
    report.summary.originalCues = 0;
    report.summary.finalCues = 0;
    return { segments: [], report };
  }

  // ---- Normalize + sort ----
  let segs = inputSegments
    .filter(Boolean)
    .map((s, i) => {
      const start = Number.isFinite(_num(s.start)) ? _num(s.start) : (Number.isFinite(_num(s.msStart)) ? _num(s.msStart) / 1000 : 0);
      const end = Number.isFinite(_num(s.end)) ? _num(s.end) : (Number.isFinite(_num(s.msEnd)) ? _num(s.msEnd) / 1000 : NaN);
      return {
        ...s,
        __shapeIdx: i,
        start,
        end,
        text: String(s.text || '')
      };
    })
    .sort((a, b) => (a.start - b.start) || (a.__shapeIdx - b.__shapeIdx));

  report.summary.originalCues = segs.length;

  // Fill missing/invalid ends using next start or minDurationSec
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const next = segs[i + 1];
    const minEnd = s.start + Math.max(frameSec, 0.01);
    if (!Number.isFinite(s.end) || s.end <= minEnd) {
      const fallback = next ? Math.max(minEnd, next.start) : (s.start + Math.max(minDurationSec, 0.5));
      s.end = fallback;
    }
  }

  // Establish a hard cap so shaping cannot lengthen past the source runtime.
  // If the caller supplies maxEndSec (e.g. video duration), use it; otherwise use the original last cue end.
  const explicitMaxEndSec = Number.isFinite(_num(opts.maxEndSec)) ? _num(opts.maxEndSec) : NaN;
  const derivedMaxEndSec = segs.reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
  const capEndSec = clampToMaxEnd
    ? ((Number.isFinite(explicitMaxEndSec) && explicitMaxEndSec > 0) ? explicitMaxEndSec : derivedMaxEndSec)
    : Infinity;

  // ---- Pass 1: merge micro-cues (speaker-safe) ----
  if (microCueSec > 0 || microGapSec > 0) {
    // If the transcript clearly contains multiple distinct speakers, do NOT merge
    // cues when speaker identity is unknown — that is the fast path to
    // "two speakers in one pop-on".
    //
    // (If we have *no* speaker info anywhere, we keep the previous best-effort
    // behavior and allow merges, because we can't reliably infer boundaries.)
    let multiSpeakerContext = false;
    if (preserveSpeakerBoundaries) {
      const keys = new Set();
      for (const s of segs) {
        const k = _speakerKey(s);
        if (k) keys.add(k);
        if (keys.size > 1) { multiSpeakerContext = true; break; }
      }
    }

    const merged = [];
    for (const s of segs) {
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (!prev) { merged.push(s); continue; }

      // Never merge across speaker boundaries.
      if (preserveSpeakerBoundaries) {
        const rel = _speakerRelation(prev, s);
        if (rel === -1) { merged.push(s); continue; }
        // If we know this is a multi-speaker transcript, treat "unknown" as a hard boundary.
        if (rel === 0 && multiSpeakerContext) { merged.push(s); continue; }
      }

      const durPrev = prev.end - prev.start;
      const durCur = s.end - s.start;
      const gap = s.start - prev.end;

      // Merging must never bridge a real gap.
      const gapOk = microGapSec > 0 && gap >= 0 && gap < microGapSec;
      const isMicroPrev = microCueSec > 0 && durPrev > 0 && durPrev < microCueSec;
      const isMicroCur  = microCueSec > 0 && durCur > 0 && durCur < microCueSec;

      // Conservative: only merge when there's a tiny gap AND at least one cue is "micro".
      // Aggressive: merge whenever there's a tiny gap (even if neither is micro).
      const shouldMerge = gapOk && (mode === 'aggressive' || isMicroPrev || isMicroCur);
      if (!shouldMerge) {
        merged.push(s);
        continue;
      }

      // Do not merge if either cue contains inline control tags (keep user intent),
      // or has explicit line breaks (keep user formatting).
      if (_hasInline608Tags(prev.text) || _hasInline608Tags(s.text) ||
          String(prev.text || '').includes('\n') || String(s.text || '').includes('\n')) {
        merged.push(s);
        continue;
      }

      const mergedText = _joinText(prev.text, s.text);
      // Avoid merges that would immediately force an overflow split/truncation downstream.
      if (!_wrapFits(mergedText, maxCharsPerLine, maxLinesPerBlock)) {
        merged.push(s);
        continue;
      }

      prev.text = mergedText;
      prev.end = Math.max(prev.end, s.end);
      report.summary.mergedCues += 1;
    }
    segs = merged;
  }

  // ---- Pass 2: split cues that can't fit at the configured width ----
  // Note: this is separate from wrap-time overflow policy; shaping aims to avoid truncation.
  const splitQueue = [];
  for (const s of segs) splitQueue.push(s);
  segs = [];

  const maxSplitDepth = 10;
  while (splitQueue.length) {
    const s = splitQueue.shift();
    const txt = String(s.text || '').trim();

    if (!txt) { segs.push(s); continue; }

    // If the cue includes inline 608 tags, avoid text surgery (we can't safely split those).
    if (_hasInline608Tags(txt)) {
      segs.push(s);
      continue;
    }

    if (_wrapFits(txt, maxCharsPerLine, maxLinesPerBlock)) {
      segs.push(s);
      continue;
    }

    const parts = _splitText(txt);
    if (!parts) {
      // Can't split (single mega-token). We'll leave it; caller's draft fallback can truncate.
      report.warnings.push(`Unable to split overflow cue (no breakpoint): "${txt.slice(0, 60)}${txt.length > 60 ? '…' : ''}"`);
      segs.push(s);
      continue;
    }

    const timing = _splitWithinWindow(s, parts, { minGapSec, frameSec });
    if (!timing) {
      report.warnings.push(`Unable to split overflow cue (timing too tight): "${txt.slice(0, 60)}${txt.length > 60 ? '…' : ''}"`);
      segs.push(s);
      continue;
    }

    report.summary.splitCues += 1;

    // Recursively ensure each split part fits.
    const depth = (s.__splitDepth || 0) + 1;
    if (depth > maxSplitDepth) {
      report.warnings.push(`Exceeded split depth while fitting cue: "${txt.slice(0, 60)}…"`);
      segs.push(timing.first, timing.second);
      continue;
    }

    timing.first.__splitDepth = depth;
    timing.second.__splitDepth = depth;

    // Breadth-first-ish
    splitQueue.unshift(timing.second);
    splitQueue.unshift(timing.first);
  }

  // ---- Pass 3: enforce max duration by splitting long cues (no time extension) ----
  let i = 0;
  while (i < segs.length) {
    const s = segs[i];
    const dur = s.end - s.start;
    if (!(dur > maxDurationSec + frameSec)) { i++; continue; }

    if (_hasInline608Tags(s.text)) { i++; continue; }

    const parts = _splitText(s.text);
    if (!parts) { i++; continue; }

    const timing = _splitWithinWindow(s, parts, { minGapSec, frameSec });
    if (!timing) { i++; continue; }

    segs.splice(i, 1, timing.first, timing.second);
    report.summary.splitCues += 1;
    // don't advance i, we may still be too long
  }

  // ---- Pass 4: timing fixes (bounded) ----
  // Conservative mode:
  //  - NO ripple-shift
  //  - Prefer trimming previous cue ends over moving later cue starts
  // Aggressive mode:
  //  - Allows limited ripple-shift (bounded by maxShiftSec and capEndSec slack)
  const baseLastEnd = segs.length ? segs[segs.length - 1].end : 0;
  const totalShiftBudget = (allowShift && Number.isFinite(capEndSec))
    ? Math.max(0, capEndSec - baseLastEnd)
    : Infinity;

  let shift = 0;

  const canShiftBy = (delta) => {
    if (!allowShift) return 0;
    if (!(delta > 0)) return 0;
    const rem = totalShiftBudget - shift;
    if (!(rem > 1e-9)) return 0;
    return Math.min(delta, maxShiftSec, rem);
  };

  for (let idx = 0; idx < segs.length; idx++) {
    const s = segs[idx];

    // Apply accumulated ripple shift (aggressive only)
    if (shift) {
      s.start += shift;
      s.end += shift;
    }

    // Clamp into [0, capEndSec]
    if (s.start < 0) {
      const delta = -s.start;
      s.start += delta;
      s.end += delta;
      report.summary.retimedCues += 1;
    }
    if (clampToMaxEnd && Number.isFinite(capEndSec) && s.end > capEndSec) {
      s.end = capEndSec;
      report.summary.retimedCues += 1;
    }

    // Enforce ordering / gaps by trimming the previous cue first
    if (idx > 0) {
      const prev = segs[idx - 1];

      // Ensure no overlap (primary), then minGap (secondary).
      if (prev.end > s.start) {
        const target = Math.max(prev.start + frameSec, s.start);
        if (target < prev.end) {
          prev.end = target;
          report.summary.retimedCues += 1;
        }
      }

      // Try to satisfy minGap by trimming prev (without going below 1 frame).
      const desiredPrevEnd = s.start - minGapSec;
      const minPrevEnd = prev.start + frameSec;
      const newPrevEnd = Math.max(minPrevEnd, Math.min(prev.end, desiredPrevEnd));
      if (newPrevEnd < prev.end - 1e-9) {
        prev.end = newPrevEnd;
        report.summary.retimedCues += 1;
      }

      // If we still violate minGap:
      //  - Aggressive: ripple-shift forward (bounded by maxShiftSec + slack)
      //  - Conservative: shorten this cue by delaying its start (no ripple)
      const minStart = prev.end + minGapSec;
      if (s.start < minStart - 1e-9) {
        const need = minStart - s.start;
        if (allowShift) {
          const applied = canShiftBy(need);
          if (applied > 0) {
            s.start += applied;
            s.end += applied;
            shift += applied;
            report.summary.retimedCues += 1;
            if (applied + 1e-9 < need) {
              report.warnings.push(`Needed ${need.toFixed(3)}s shift to satisfy minGap; applied ${applied.toFixed(3)}s (capped).`);
            }
          }
        } else {
          // Conservative mode: do not ripple. Try to satisfy the gap by trimming the cue's start.
          const maxStart = s.end - frameSec;
          const newStart = Math.min(minStart, maxStart);
          if (newStart > s.start + 1e-9) {
            s.start = newStart;
            report.summary.retimedCues += 1;
          }
        }
      }
    }

    // Ensure minimum duration (extend end only within available gap; aggressive may ripple-shift)
    let dur = s.end - s.start;
    if (dur < minDurationSec - 1e-9) {
      const need = (minDurationSec - dur);
      const next = segs[idx + 1];
      const nextStartFuture = next ? (next.start + shift) : Infinity;
      const maxEndWithoutShift = next ? (nextStartFuture - minGapSec) : capEndSec;

      // Extend without affecting later cues (within gap)
      const targetEnd = Math.min(s.end + need, maxEndWithoutShift, capEndSec);
      if (targetEnd > s.end + 1e-9) {
        s.end = targetEnd;
        report.summary.retimedCues += 1;
      }

      dur = s.end - s.start;

      // If still short and aggressive, allow limited ripple extension.
      if (allowShift && dur < minDurationSec - 1e-9) {
        const remaining = minDurationSec - dur;
        const applied = canShiftBy(remaining);
        if (applied > 0) {
          s.end += applied;
          shift += applied;
          report.summary.retimedCues += 1;
          dur = s.end - s.start;
          if (applied + 1e-9 < remaining) {
            report.warnings.push(`minDuration needed ${remaining.toFixed(3)}s; applied ${applied.toFixed(3)}s (capped).`);
          }
        }
      }
    }

    // Speed thresholds:
    // - Conservative: attempt non-ripple extension only; never split for speed.
    // - Aggressive: may split when required duration exceeds maxDurationSec.
    const req = _computeRequiredDuration(s.text, { minDurationSec, maxCps, maxWpm });

    if (allowShift && req > maxDurationSec + 1e-6) {
      // Too much text to ever meet speed thresholds within maxDuration: split.
      if (!_hasInline608Tags(s.text)) {
        const parts = _splitText(s.text);
        if (parts) {
          const timing = _splitWithinWindow(s, parts, { minGapSec, frameSec });
          if (timing) {
            segs.splice(idx, 1, timing.first, timing.second);
            report.summary.splitCues += 1;
            // Re-run this index on the newly inserted first part
            idx -= 1;
            continue;
          }
        }
      }
    }

    if (dur + 1e-6 < req) {
      const need = req - dur;
      const next = segs[idx + 1];
      const nextStartFuture = next ? (next.start + shift) : Infinity;
      const maxEndWithoutShift = next ? (nextStartFuture - minGapSec) : capEndSec;

      // Extend within existing gap
      const targetEnd = Math.min(s.end + need, maxEndWithoutShift, capEndSec);
      if (targetEnd > s.end + 1e-9) {
        s.end = targetEnd;
        report.summary.retimedCues += 1;
        dur = s.end - s.start;
      }

      // Aggressive: ripple a little if needed
      if (allowShift && dur + 1e-6 < req) {
        const remaining = req - dur;
        const applied = canShiftBy(remaining);
        if (applied > 0) {
          s.end += applied;
          shift += applied;
          report.summary.retimedCues += 1;
          dur = s.end - s.start;
          if (applied + 1e-9 < remaining) {
            report.warnings.push(`CPS/WPM needed ${remaining.toFixed(3)}s; applied ${applied.toFixed(3)}s (capped).`);
          }
        }
      }
    }
  }



  // ---- Pass 5: Start-TC clamp fix for FIRST cue (aggressive only) ----
  // This can reduce alignment accuracy (by definition it delays the cue), so we do not
  // apply it in conservative mode.
  if (allowShift && fixStartTcClamp && segs.length) {
    const first = segs[0];
    const delta = _computeFirstCueClampDelaySec(first, {
      fps,
      dropFrame: !!opts.dropFrame,
      startTc: opts.startTc,
      preStartTransmitSec: opts.preStartTransmitSec,
      maxCharsPerLine,
      maxLinesPerBlock,
      timeSource: opts.timeSource || 'auto'
    });

    if (delta > 1e-6) {
      const slack = (Number.isFinite(capEndSec) ? (capEndSec - segs[segs.length - 1].end) : Infinity);
      const applied = (Number.isFinite(slack) ? Math.max(0, Math.min(delta, slack)) : delta);

      if (applied > 1e-6) {
        first.start += applied;
        first.end += applied;
        report.summary.firstCueDelayedSec = applied;
        report.summary.retimedCues += 1;

        // Ripple forward to preserve ordering/minGap (bounded by remaining slack)
        for (let j = 1; j < segs.length; j++) {
          const prev = segs[j - 1];
          const cur = segs[j];
          const minStart = prev.end + minGapSec;
          if (cur.start < minStart - 1e-9) {
            const need = minStart - cur.start;
            const allow = canShiftBy(need);
            if (allow > 0) {
              cur.start += allow;
              cur.end += allow;
              shift += allow;
              report.summary.retimedCues += 1;
            }
          }
        }
      } else {
        report.warnings.push('Start-TC clamp delay requested, but no slack available within maxEndSec; skipped.');
      }
    }
  }

  // ---- Final sanitize (speaker-safe, cap-safe) ----
  // Ensure strictly increasing cues, non-negative, and cap end time.
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (!Number.isFinite(s.start)) s.start = 0;
    if (!Number.isFinite(s.end)) s.end = s.start + Math.max(frameSec, 0.01);

    if (s.start < 0) {
      const delta = -s.start;
      s.start += delta;
      s.end += delta;
      report.summary.retimedCues += 1;
    }

    if (clampToMaxEnd && Number.isFinite(capEndSec) && s.end > capEndSec) {
      s.end = capEndSec;
      report.summary.retimedCues += 1;
    }

    // Ensure positive duration
    if (s.end <= s.start + frameSec) {
      const targetEnd = s.start + Math.max(frameSec, Math.min(minDurationSec, 2 * frameSec));
      s.end = (clampToMaxEnd && Number.isFinite(capEndSec)) ? Math.min(capEndSec, targetEnd) : targetEnd;
      report.summary.retimedCues += 1;
    }

    // Enforce monotonic ordering by trimming previous end first
    if (k > 0) {
      const prev = segs[k - 1];
      if (prev.end > s.start) {
        const targetPrevEnd = Math.max(prev.start + frameSec, s.start);
        if (targetPrevEnd < prev.end) {
          prev.end = targetPrevEnd;
          report.summary.retimedCues += 1;
        }
      }
      if (prev.end > s.start) {
        // Absolute last resort: shift current start (should be rare)
        s.start = prev.end + frameSec;
        if (s.end <= s.start + frameSec) s.end = s.start + frameSec;
        report.summary.retimedCues += 1;
      }
    }
  }

  // Strip temp fields
  segs = segs.map(s => {
    const o = { ...s };
    delete o.__shapeIdx;
    delete o.__splitDepth;
    return o;
  });

  report.summary.finalCues = segs.length;
  report.summary.changedCues =
    report.summary.mergedCues +
    report.summary.splitCues +
    report.summary.retimedCues;

  return { segments: segs, report };
}

// ---------------------------------------------------------------------------
// Milestone 4: Derived 608 compatibility cue generation (with auto-splitting)
// ---------------------------------------------------------------------------
// This is a thin wrapper around the encoder's derive608CuesFromCanonical(), which:
//  - wraps to 32x2
//  - auto-splits on overflow
//  - optionally bounded-ripples to satisfy reading-speed constraints
//  - sets { needsReview: true } when shaping becomes non-trivial
function deriveCompat608Track(segments = [], opts = {}) {
  const rules = (opts && typeof opts === 'object') ? (opts.compatGenerationRules || opts.rules || {}) : {};
  const derived608Cues = scc.derive608TrackFromCanonical(segments, rules);
  return { derived608Cues };
}

module.exports = { shapeSegmentsForScc, deriveCompat608Track };
