// ai/srtValidator.js
// Lightweight SRT QC validator + report formatter.
//
// Goals:
//  - Provide a human-readable sidecar QC report for SRT exports (parity with VTT/SCC/MCC).
//  - Validate the *written* SRT (post-shaping/retiming) so QC reflects deliverable reality.
//  - Keep dependencies zero (Node built-ins only).

'use strict';

const EPS_SEC = 1e-6;

function clampNum(n, lo, hi, defVal) {
  const v = Number(n);
  if (!Number.isFinite(v)) return defVal;
  return Math.max(lo, Math.min(hi, v));
}

function _decodeBasicEntity(m) {
  const s = String(m || '');
  const low = s.toLowerCase();
  if (low === '&nbsp;') return ' ';
  if (low === '&amp;') return '&';
  if (low === '&lt;') return '<';
  if (low === '&gt;') return '>';
  if (low === '&quot;') return '"';
  if (low === '&#39;' || low === '&apos;') return "'";

  // Numeric entities: treat as a single character for counting.
  if (/^&#\d+;$/i.test(s)) return 'X';
  if (/^&#x[0-9a-f]+;$/i.test(s)) return 'X';
  return 'X';
}

function stripSrtMarkup(line) {
  // SRT commonly uses simple HTML-ish tags (<i>, <b>, <u>, <font>, <c>, etc.).
  // Strip tags and internal {..} tokens so CPS/line-length estimates represent visible output.
  let out = String(line ?? '');
  out = out.replace(/\uFEFF/g, '');
  out = out.replace(/<[^>]*>/g, '');
  out = out.replace(/\{[^}]*\}/g, '');
  // Collapse entities to single chars.
  out = out.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, _decodeBasicEntity);
  return out;
}

function visibleCharCount(line) {
  return Array.from(stripSrtMarkup(line)).length;
}

function parseSrtTimestampToMs(ts) {
  const m = String(ts || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  let ms = parseInt(m[4], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ms)) return null;
  // Normalize 1–2 digit ms: "1" => 100, "12" => 120 (common loose SRT style)
  const msStr = m[4];
  if (msStr.length === 1) ms = ms * 100;
  else if (msStr.length === 2) ms = ms * 10;
  return (((hh * 60 + mm) * 60) + ss) * 1000 + ms;
}

function parseSrtText(srtText) {
  const text = String(srtText ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n{2,}/g);
  const cues = [];
  const errors = [];

  let cueIndex = 0;
  for (const rawBlock of blocks) {
    const block = String(rawBlock || '').trim();
    if (!block) continue;
    const lines = block.split('\n');
    let timeLineIdx = -1;

    // Find the time line (sometimes the first line is a numeric counter).
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      if (/-->/.test(lines[i])) { timeLineIdx = i; break; }
    }
    if (timeLineIdx < 0) {
      errors.push({
        code: 'MISSING_TIMECODE',
        message: 'Block is missing a timecode line ("-->" not found)',
        blockPreview: lines.slice(0, 2).join(' | ')
      });
      continue;
    }

    const timeLine = String(lines[timeLineIdx] || '').trim();
    const m = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!m) {
      errors.push({
        code: 'BAD_TIMECODE',
        message: `Could not parse SRT timecode line: ${timeLine}`,
        cueIndex
      });
      continue;
    }

    const startMs = parseSrtTimestampToMs(m[1]);
    const endMs = parseSrtTimestampToMs(m[2]);
    if (startMs == null || endMs == null) {
      errors.push({
        code: 'BAD_TIMESTAMP',
        message: `Invalid timestamp(s) in line: ${timeLine}`,
        cueIndex
      });
      continue;
    }

    const textLines = lines.slice(timeLineIdx + 1);
    cues.push({
      cueIndex,
      start: startMs / 1000,
      end: endMs / 1000,
      textLines,
      rawTimeLine: timeLine
    });
    cueIndex++;
  }

  return { cues, errors };
}

function resolveSrtQcOptions(config = {}) {
  const fmt = (config && config.formats && config.formats.srt && typeof config.formats.srt === 'object')
    ? config.formats.srt
    : {};
  const legacy = (config && config.srtOptions && typeof config.srtOptions === 'object')
    ? config.srtOptions
    : {};

  const maxCharsPerLine = clampNum(
    fmt.maxCharsPerLine ?? legacy.maxCharsPerLine ?? config.maxCharsPerLine,
    1,
    200,
    42
  );
  const maxLinesPerBlock = clampNum(
    fmt.maxLinesPerBlock ?? legacy.maxLinesPerBlock ?? config.maxLinesPerBlock,
    1,
    10,
    2
  );
  const maxDurationSeconds = clampNum(
    fmt.maxDurationSeconds ?? legacy.maxDurationSeconds ?? config.maxDurationSeconds,
    0.1,
    60,
    6.0
  );

  const maxCps = clampNum(
    fmt.maxCps ?? fmt.maxCPS ?? legacy.maxCps ?? legacy.maxCPS ?? config.maxCps,
    1,
    200,
    20
  );
  const minDurationSeconds = clampNum(
    fmt.minDurationSeconds ?? legacy.minDurationSeconds ?? config.minDurationSeconds,
    0,
    60,
    1.0
  );
  const minSplitDurationSeconds = clampNum(
    fmt.minSplitDurationSeconds ?? legacy.minSplitDurationSeconds ?? config.minSplitDurationSeconds,
    0,
    60,
    0.5
  );
  const preventOverlaps = (fmt.preventOverlaps ?? legacy.preventOverlaps ?? config.preventOverlaps) === true;

  return {
    maxCharsPerLine,
    maxLinesPerBlock,
    maxDurationSeconds,
    maxCps,
    minDurationSeconds,
    minSplitDurationSeconds,
    preventOverlaps
  };
}

function validateSRT(srtText, config = {}, meta = {}) {
  const opts = resolveSrtQcOptions(config);
  const parsed = parseSrtText(srtText);

  const report = {
    format: 'srt',
    ok: true,
    errors: [],
    warnings: [],
    stats: {
      cues: 0,
      worstCps: 0,
      worstCpsCueIndex: null,
      maxLineCharsObserved: 0,
      maxLinesObserved: 0,
      overlaps: 0
    },
    options: opts,
    meta: {
      outPath: meta?.outPath || '',
      srcLabel: meta?.srcLabel || ''
    }
  };

  if (Array.isArray(parsed.errors) && parsed.errors.length) {
    for (const e of parsed.errors.slice(0, 200)) {
      report.errors.push({
        code: e.code || 'PARSE_ERROR',
        message: e.message || String(e),
        cueIndex: e.cueIndex
      });
    }
  }

  const cues = Array.isArray(parsed.cues) ? parsed.cues : [];
  report.stats.cues = cues.length;

  let prevEnd = null;
  let prevCueIndex = null;
  let prevStart = null;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const cueIndex = cue.cueIndex ?? i;
    const start = Number(cue.start);
    const end = Number(cue.end);
    const textLines = Array.isArray(cue.textLines) ? cue.textLines : [];

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      report.errors.push({
        code: 'BAD_CUE_TIME',
        message: 'Cue has non-numeric start/end time',
        cueIndex
      });
      continue;
    }

    if (start < -EPS_SEC) {
      report.errors.push({
        code: 'NEGATIVE_START',
        message: `Cue starts before 0 (${start.toFixed(3)}s)`,
        cueIndex,
        start,
        end
      });
    }
    if (end + EPS_SEC < start) {
      report.errors.push({
        code: 'NEGATIVE_DURATION',
        message: `Cue end precedes start (${start.toFixed(3)}–${end.toFixed(3)}s)`,
        cueIndex,
        start,
        end
      });
    }

    // Order sanity
    if (prevStart != null && start + EPS_SEC < prevStart) {
      report.warnings.push({
        code: 'OUT_OF_ORDER',
        message: 'Cue starts before the previous cue start (non-monotonic order)',
        cueIndex,
        start,
        end,
        prevCueIndex
      });
    }
    prevStart = start;

    // Overlap check
    if (prevEnd != null && start + EPS_SEC < prevEnd) {
      const overlap = prevEnd - start;
      report.stats.overlaps++;
      report[(opts.preventOverlaps ? 'errors' : 'warnings')].push({
        code: 'OVERLAP',
        message: `Cue overlaps previous cue by ${overlap.toFixed(3)}s`,
        cueIndex,
        start,
        end,
        prevCueIndex,
        prevEnd
      });
    }
    prevEnd = end;
    prevCueIndex = cueIndex;

    // Visible text checks
    const visibleLines = textLines.map(stripSrtMarkup);
    const visibleJoined = visibleLines.join('\n').trim();
    if (!visibleJoined) {
      report.errors.push({
        code: 'EMPTY_CUE',
        message: 'Cue has no visible text after stripping tags/entities',
        cueIndex,
        start,
        end
      });
    }

    // Line count
    const lineCount = textLines.length;
    if (lineCount > report.stats.maxLinesObserved) report.stats.maxLinesObserved = lineCount;
    if (lineCount > opts.maxLinesPerBlock) {
      report.warnings.push({
        code: 'TOO_MANY_LINES',
        message: `Cue has ${lineCount} line(s); exceeds maxLinesPerBlock=${opts.maxLinesPerBlock}`,
        cueIndex,
        start,
        end,
        lineCount,
        maxLinesPerBlock: opts.maxLinesPerBlock
      });
    }

    // Line lengths + tag leakage
    for (let li = 0; li < textLines.length; li++) {
      const rawLine = String(textLines[li] ?? '');
      const visLen = visibleCharCount(rawLine);
      if (visLen > report.stats.maxLineCharsObserved) report.stats.maxLineCharsObserved = visLen;
      if (visLen > opts.maxCharsPerLine) {
        report.warnings.push({
          code: 'LINE_TOO_LONG',
          message: `Line exceeds maxCharsPerLine=${opts.maxCharsPerLine} (got ${visLen})`,
          cueIndex,
          start,
          end,
          lineIndex: li + 1,
          visibleChars: visLen,
          maxCharsPerLine: opts.maxCharsPerLine
        });
      }
      if (/\{[^}]*\}/.test(rawLine)) {
        report.warnings.push({
          code: 'INTERNAL_TAG_LEAK',
          message: 'Cue line appears to contain internal {…} tags',
          cueIndex,
          start,
          end,
          lineIndex: li + 1
        });
      }
    }

    // CPS
    const dur = end - start;
    const charCount = visibleLines.reduce((acc, l) => acc + Array.from(String(l)).length, 0);
    const cps = dur > 0 ? (charCount / dur) : Infinity;
    if (Number.isFinite(cps) && cps > report.stats.worstCps) {
      report.stats.worstCps = cps;
      report.stats.worstCpsCueIndex = cueIndex;
    }
    if (Number.isFinite(cps) && cps > opts.maxCps + 0.01) {
      report.warnings.push({
        code: 'CPS_TOO_HIGH',
        message: `CPS ${cps.toFixed(2)} exceeds maxCps=${opts.maxCps}`,
        cueIndex,
        start,
        end,
        cps,
        maxCps: opts.maxCps,
        charCount
      });
    }

    // Durations
    if (dur + EPS_SEC < opts.minSplitDurationSeconds) {
      report.warnings.push({
        code: 'DURATION_TOO_SHORT_HARD',
        message: `Cue duration ${dur.toFixed(3)}s is below minSplitDurationSeconds=${opts.minSplitDurationSeconds}`,
        cueIndex,
        start,
        end,
        duration: dur,
        minSplitDurationSeconds: opts.minSplitDurationSeconds
      });
    } else if (dur + EPS_SEC < opts.minDurationSeconds) {
      report.warnings.push({
        code: 'DURATION_TOO_SHORT',
        message: `Cue duration ${dur.toFixed(3)}s is below minDurationSeconds=${opts.minDurationSeconds}`,
        cueIndex,
        start,
        end,
        duration: dur,
        minDurationSeconds: opts.minDurationSeconds
      });
    }
    if (dur - EPS_SEC > opts.maxDurationSeconds) {
      report.warnings.push({
        code: 'DURATION_TOO_LONG',
        message: `Cue duration ${dur.toFixed(3)}s exceeds maxDurationSeconds=${opts.maxDurationSeconds}`,
        cueIndex,
        start,
        end,
        duration: dur,
        maxDurationSeconds: opts.maxDurationSeconds
      });
    }
  }

  report.ok = report.errors.length === 0;
  return report;
}

function formatSrtQcReportText(report) {
  const rep = (report && typeof report === 'object') ? report : { errors: [], warnings: [], stats: {} };
  const errs = Array.isArray(rep.errors) ? rep.errors : [];
  const warns = Array.isArray(rep.warnings) ? rep.warnings : [];
  const stats = rep.stats || {};
  const meta = rep.meta || {};
  const opts = rep.options || {};

  const lines = [];
  lines.push('SRT QC REPORT');
  if (meta.srcLabel) lines.push(`Source: ${meta.srcLabel}`);
  if (meta.outPath) lines.push(`Output: ${meta.outPath}`);
  lines.push('');
  lines.push(`Result: ${rep.ok ? 'PASS' : 'FAIL'} • ${errs.length} error(s), ${warns.length} warning(s)`);
  lines.push('');
  lines.push('--- Options ---');
  lines.push(`maxCharsPerLine: ${opts.maxCharsPerLine}`);
  lines.push(`maxLinesPerBlock: ${opts.maxLinesPerBlock}`);
  lines.push(`maxDurationSeconds: ${opts.maxDurationSeconds}`);
  lines.push(`maxCps: ${opts.maxCps}`);
  lines.push(`minDurationSeconds: ${opts.minDurationSeconds}`);
  lines.push(`minSplitDurationSeconds: ${opts.minSplitDurationSeconds}`);
  lines.push(`preventOverlaps: ${opts.preventOverlaps ? 'true' : 'false'}`);
  lines.push('');
  lines.push('--- Stats ---');
  lines.push(`cues: ${stats.cues ?? 0}`);
  lines.push(`worstCps: ${Number.isFinite(stats.worstCps) ? stats.worstCps.toFixed(2) : 'n/a'}${stats.worstCpsCueIndex != null ? ` (cue ${stats.worstCpsCueIndex})` : ''}`);
  lines.push(`maxLineCharsObserved: ${stats.maxLineCharsObserved ?? 0}`);
  lines.push(`maxLinesObserved: ${stats.maxLinesObserved ?? 0}`);
  lines.push(`overlaps: ${stats.overlaps ?? 0}`);

  const fmtRange = (it) => {
    if (!it || typeof it !== 'object') return '';
    if (Number.isFinite(it.start) && Number.isFinite(it.end)) return `${it.start.toFixed(3)}–${it.end.toFixed(3)}s`;
    return '';
  };
  const fmtIdx = (it) => (it && it.cueIndex != null) ? `cue ${it.cueIndex}` : 'cue';

  const pushIssues = (title, list) => {
    if (!list.length) return;
    lines.push('');
    lines.push(`--- ${title} (${list.length}) ---`);
    for (const it of list.slice(0, 80)) {
      const code = it.code ? String(it.code) : 'ISSUE';
      const msg = it.message ? String(it.message) : '';
      lines.push(`- [${code}] ${fmtIdx(it)} ${fmtRange(it)} ${msg}`.trim());
    }
    if (list.length > 80) lines.push(`… ${list.length - 80} more`);
  };

  pushIssues('ERRORS', errs);
  pushIssues('WARNINGS', warns);
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  validateSRT,
  formatSrtQcReportText
};
