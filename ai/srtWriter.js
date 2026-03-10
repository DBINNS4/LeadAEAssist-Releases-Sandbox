// SRT writer with basic shaping + QC-oriented timing hygiene.
//
// Features:
// - Shaping: max chars/line, max lines/block, max duration (optional clamp)
// - QC: max CPS, min duration, min split duration
// - Prevent overlaps (default ON for SRT)
// - Allow end-extension into gaps with max end-extension
// - Output hygiene: UTF-8 BOM toggle + LF/CRLF line endings

'use strict';

const { toMs, frameDurationMs } = require('../utils/timeUtils');

const MIDROW_TOKEN_RE = /\{\s*(WhU|Wh|GrU|Gr|BlU|Bl|CyU|Cy|RU|R|YU|Y|MaU|Ma|IU|I)\s*\}/g;

function boolish(v, defVal) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return defVal;
}

function clampNumber(n, lo, hi) {
  let v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (typeof lo === 'number') v = Math.max(lo, v);
  if (typeof hi === 'number') v = Math.min(hi, v);
  return v;
}

function normalizeNewlines(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n');
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

function wrapParagraphsToLines(paragraphs, limit, firstLineLimit = null) {
  const out = [];
  let firstLineUsed = false;

  for (const pRaw of (Array.isArray(paragraphs) ? paragraphs : [])) {
    const raw = normalizeNewlines(String(pRaw ?? '')).trim();
    if (!raw) continue;

    // IMPORTANT: never emit blank lines inside an SRT cue; a blank line terminates a cue.
    const normalized = raw.replace(/[\t ]+/g, ' ').trim();
    if (!normalized) continue;

    const limFirst = (!firstLineUsed && firstLineLimit != null)
      ? Math.max(1, Math.trunc(firstLineLimit))
      : Math.max(1, Math.trunc(limit));

    const limOther = Math.max(1, Math.trunc(limit));

    const lines = wrapOneParagraphToLines(normalized, limFirst, limOther);
    for (const ln of lines) out.push(ln);

    if (lines.length && !firstLineUsed) firstLineUsed = true;
  }

  return out;
}

function chunkLines(lines, maxLines) {
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

function formatSpeaker(name, style = 'title') {
  const s = String(name || '').trim();
  if (!s) return '';
  if (style === 'caps') return s.toUpperCase();
  if (style === 'title') return s.replace(/\b\w/g, c => c.toUpperCase());
  return s;
}

// Strip common editor/encoder tags that should NOT appear in subtitle formats like SRT.
function stripInternalTags(input) {
  let s = String(input || '');

  // Remove placement tags.
  s = s.replace(/\{\s*(row|r|col|c|pac)\s*:\s*[^}]+\}\s*/gi, '');

  // Remove "no-operation" and command-like tokens.
  s = s.replace(/\{\s*(NOP)\s*\}\s*/gi, '');
  s = s.replace(/\{(?:rcl\d+)\}/gi, '');
  s = s.replace(/\{(?:midrow|pos|nl|clr|cr|eoc|edm|en|it|noit|speed\d+)\}/gi, '');

  // Remove common 608 style tokens.
  s = s.replace(MIDROW_TOKEN_RE, '');

  // Normalize line breaks.
  s = normalizeNewlines(s);
  return s;
}

function toSrtTimestampFromMs(ms) {
  let t = Math.round(Number(ms));
  if (!Number.isFinite(t) || t < 0) t = 0;

  const totalSeconds = Math.floor(t / 1000);
  const msec = t % 1000;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;

  const pad2 = (v) => String(v).padStart(2, '0');
  const pad3 = (v) => String(v).padStart(3, '0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(msec)}`;
}

function resolveSrtOptions(config = {}) {
  const fmt = (config?.formats && typeof config.formats.srt === 'object') ? config.formats.srt : {};
  const legacy = (config?.srtOptions && typeof config.srtOptions === 'object') ? config.srtOptions : {};

  const strictTiming = boolish(
    fmt.strictTiming ?? legacy.strictTiming ?? config.strictTiming ?? config.exactTiming,
    false
  );

  const maxCharsPerLine = (() => {
    const v = clampNumber(fmt.maxCharsPerLine ?? legacy.maxCharsPerLine ?? config.maxCharsPerLine ?? 42, 1, 200);
    return v == null ? 42 : Math.trunc(v);
  })();

  const maxLinesPerBlock = (() => {
    const v = clampNumber(fmt.maxLinesPerBlock ?? legacy.maxLinesPerBlock ?? config.maxLinesPerBlock ?? 2, 1, 10);
    return v == null ? 2 : Math.trunc(v);
  })();

  const maxDurationSecondsRaw = Number(fmt.maxDurationSeconds ?? legacy.maxDurationSeconds ?? config.maxDurationSeconds ?? 6.0);
  const maxDurationSeconds = (Number.isFinite(maxDurationSecondsRaw) && maxDurationSecondsRaw > 0)
    ? maxDurationSecondsRaw
    : Infinity;

  const includeSpeakerNames = boolish(
    fmt.includeSpeakers ?? fmt.includeSpeakerNames ?? legacy.includeSpeakers ?? legacy.includeSpeakerNames ?? config.includeSpeakerNames,
    false
  );

  const speakerLabelStyle = String(
    fmt.speakerLabelStyle ?? legacy.speakerLabelStyle ?? config.speakerLabelStyle ?? 'title'
  ).toLowerCase();

  const preventOverlaps = boolish(
    fmt.preventOverlaps ?? fmt.noOverlaps ?? legacy.preventOverlaps ?? legacy.noOverlaps ?? config.preventOverlaps ?? config.noOverlaps,
    true
  );

  const maxCpsRaw = Number(fmt.maxCps ?? fmt.maxCPS ?? legacy.maxCps ?? legacy.maxCPS ?? config.maxCps ?? 20);
  const maxCps = (Number.isFinite(maxCpsRaw) && maxCpsRaw > 0) ? maxCpsRaw : Infinity;

  const minDurationSeconds = (() => {
    const v = clampNumber(fmt.minDurationSeconds ?? legacy.minDurationSeconds ?? config.minDurationSeconds ?? 1.0, 0, 60);
    return v == null ? 1.0 : v;
  })();

  const minSplitDurationSeconds = (() => {
    const v = clampNumber(fmt.minSplitDurationSeconds ?? legacy.minSplitDurationSeconds ?? config.minSplitDurationSeconds ?? 0.5, 0, 60);
    return v == null ? 0.5 : v;
  })();

  const allowTimeExtension = (() => {
    const v = boolish(
      fmt.allowTimeExtension ?? fmt.allowExtension ?? legacy.allowTimeExtension ?? legacy.allowExtension ?? config.allowTimeExtension,
      undefined
    );
    if (typeof v === 'boolean') return v;
    // Default policy: ON for non-strict SRT, OFF for strict exports.
    return !strictTiming;
  })();

  const maxEndExtensionSeconds = (() => {
    const v = clampNumber(fmt.maxEndExtensionSeconds ?? legacy.maxEndExtensionSeconds ?? config.maxEndExtensionSeconds ?? 1.5, 0, 60);
    return v == null ? 1.5 : v;
  })();

  const utf8Bom = boolish(
    fmt.utf8Bom ?? fmt.utf8BOM ?? fmt.bom ?? legacy.utf8Bom ?? legacy.bom ?? config.utf8Bom ?? config.bom,
    false
  );

  const lineEndingRaw = String(fmt.lineEnding ?? legacy.lineEnding ?? config.lineEnding ?? 'lf').trim().toLowerCase();
  const lineEnding = (lineEndingRaw === 'crlf' || lineEndingRaw === 'windows') ? 'CRLF' : 'LF';

  const fpsRaw = Number(config?.fpsOverride ?? config?.fps ?? config?.system?.fps ?? 30);
  const fps = (Number.isFinite(fpsRaw) && fpsRaw > 0) ? fpsRaw : 30;
  const minCueDurationMs = frameDurationMs(fps, 'ceil');

  const maxCueDurationMs = (strictTiming || maxDurationSeconds === Infinity)
    ? Infinity
    : Math.max(minCueDurationMs, toMs(maxDurationSeconds));

  const minReadableCueDurationMs = Math.max(
    minCueDurationMs,
    strictTiming ? minCueDurationMs : toMs(minDurationSeconds)
  );

  const minSplitCueDurationMs = Math.max(
    minCueDurationMs,
    strictTiming ? minCueDurationMs : toMs(minSplitDurationSeconds)
  );

  const maxEndExtensionMs = (!allowTimeExtension || strictTiming)
    ? 0
    : Math.max(0, toMs(maxEndExtensionSeconds));

  return {
    // shaping
    strictTiming,
    maxCharsPerLine,
    maxLinesPerBlock,
    minCueDurationMs,
    maxCueDurationMs,

    // speaker
    includeSpeakerNames,
    speakerLabelStyle,

    // QC-ish
    preventOverlaps,
    maxCps,
    minReadableCueDurationMs,
    minSplitCueDurationMs,
    allowTimeExtension,
    maxEndExtensionMs,

    // output
    utf8Bom,
    lineEnding
  };
}

function generateSRT(segments, config = {}) {
  const opts = resolveSrtOptions(config);
  const sorted = stableSortSegments(segments);

  const cuesOut = [];
  let cueId = 1;
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

    // Enforce a hard minimum cue duration.
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

    for (const rawLine of rawLines) {
      const ln0 = String(rawLine || '');
      if (!ln0.trim()) continue;

      const stripped = stripInternalTags(ln0);
      const cleaned = normalizeNewlines(stripped).replace(/\n+/g, ' ').replace(/[\t ]+/g, ' ').trim();
      if (cleaned) paragraphs.push(cleaned);
    }

    if (!paragraphs.length) continue;

    const speakerRaw = (typeof seg?.speaker === 'string') ? seg.speaker : '';
    const speaker = (opts.includeSpeakerNames && speakerRaw)
      ? formatSpeaker(speakerRaw, opts.speakerLabelStyle)
      : '';
    const speakerPrefix = speaker ? `${speaker}:` : '';

    // Speaker label cohesion: reserve space on the first line for "SPEAKER:".
    let speakerInline = false;
    let firstLineLimit = null;

    if (speakerPrefix) {
      const reserved = measureChars(speakerPrefix) + 1; // +1 for space after colon
      if (reserved < opts.maxCharsPerLine) {
        speakerInline = true;
        firstLineLimit = Math.max(1, opts.maxCharsPerLine - reserved);
      }
    }

    let lines = wrapParagraphsToLines(paragraphs, opts.maxCharsPerLine, firstLineLimit);
    if (!Array.isArray(lines) || !lines.length) continue;

    if (speakerPrefix && !speakerInline) {
      // Extremely long speaker label: put label on its own line (best-effort).
      lines = [speakerPrefix, ...lines];
    }

    // Readability timing assist: try to extend cue end into available gap.
    if (opts.allowTimeExtension && !opts.strictTiming) {
      const measureLines = lines.map((ln, idx) => {
        if (speakerInline && idx === 0 && speakerPrefix) return `${speakerPrefix} ${ln}`;
        return ln;
      });

      const visibleJoined = measureLines.join(' ');
      const charCount = Math.max(0, countCharsNoSpace(visibleJoined));
      const durMs = Math.max(opts.minCueDurationMs, endMs - startMs);

      const requiredForCpsMs = (Number.isFinite(opts.maxCps) && opts.maxCps > 0)
        ? Math.ceil((charCount / opts.maxCps) * 1000)
        : 0;

      const targetDurMs = Math.max(durMs, opts.minReadableCueDurationMs, requiredForCpsMs);

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
    let chunks = chunkLines(lines, opts.maxLinesPerBlock);

    // If chunking would require more cues than we can allocate even the hard minimum time for,
    // collapse into a single cue block.
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
        if (speakerInline && speakerPrefix && g === 0) return `${speakerPrefix} ${ln}`;
        return ln;
      });
      globalLineOffset += ch.length;
      weights.push(countCharsNoSpace(texts.join(' ')) || 1);
    }

    const desiredMinSpan = opts.minSplitCueDurationMs;
    const minSpan = (durMsFinal >= chunks.length * desiredMinSpan)
      ? desiredMinSpan
      : opts.minCueDurationMs;

    let spans = allocateSpansByWeightsMs(startMs, endMs, weights, minSpan);
    if (spans.length !== chunks.length && chunks.length > 1) {
      spans = allocateSpansByWeightsMs(startMs, endMs, weights, opts.minCueDurationMs);
    }
    if (spans.length !== chunks.length) {
      chunks = [lines];
      spans = [[startMs, endMs]];
    }

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

      const startLabel = toSrtTimestampFromMs(sMs);
      const endLabel = toSrtTimestampFromMs(eMs);

      const textLines = [];

      for (let li = 0; li < ch.length; li++) {
        const ln = String(ch[li] ?? '').trimEnd();
        const g = globalLineOffset + li;

        if (speakerPrefix) {
          if (speakerInline && g === 0) {
            textLines.push(ln ? `${speakerPrefix} ${ln}` : speakerPrefix);
            continue;
          }
          if (!speakerInline && g === 0 && ln === speakerPrefix) {
            textLines.push(speakerPrefix);
            continue;
          }
        }

        if (ln) textLines.push(ln);
      }

      globalLineOffset += ch.length;

      const cueText = textLines.join('\n');
      if (!cueText.trim()) continue;

      cuesOut.push(
        `${cueId}\n` +
        `${startLabel} --> ${endLabel}\n` +
        `${cueText}`
      );
      cueId += 1;

      lastEndMs = eMs;
    }
  }

  let out = cuesOut.join('\n\n');
  if (out && !out.endsWith('\n')) out += '\n';

  // Output hygiene.
  if (opts.lineEnding === 'CRLF') {
    out = out.replace(/\n/g, '\r\n');
  }
  if (opts.utf8Bom) {
    out = `\uFEFF${out}`;
  }

  return out;
}

module.exports = {
  generateSRT,
  resolveSrtOptions
};
