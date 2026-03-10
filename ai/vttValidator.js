'use strict';

/**
 * WebVTT QC validator (dependency-light).
 *
 * Phase 5 goals:
 * - Validate generated WebVTT for structural correctness
 * - Provide a QC report with errors + warnings + summary stats
 * - Focus on practical deliverable checks: timing, overlaps, line length, lines per cue, CPS, unsafe markup
 *
 * Notes:
 * - WebVTT support differs across players. This validator is opinionated and tuned for post workflows.
 * - It is NOT a full spec parser; it is strict on common deliverable requirements and forgiving elsewhere.
 */

const { resolveVttOptions } = require('./vttWriter');
const { parseVTT, decodeEntities } = require('./vttParser');
const { toMs } = require('../utils/timeUtils');

const EPS_SEC = 0.001; // 1ms tolerance

function stripVttTags(s) {
  // Remove WebVTT cue text tags for visible-length calculations.
  // This is intentionally broad; we validate tag safety separately.
  return String(s || '').replace(/<[^>]*>/g, '');
}

function visibleCharCount(s) {
  const decoded = decodeEntities(stripVttTags(s));
  // Count Unicode code points (not UTF-16 code units).
  return Array.from(decoded).length;
}

function cueVisibleTextLines(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  return arr.map(l => decodeEntities(stripVttTags(String(l || ''))));
}

function isAllowedVttTag(tagRaw) {
  const tag = String(tagRaw || '').trim();
  // Allow a safe subset of WebVTT cue text tags:
  // <i>, <b>, <u>, <c.class>, </c>, <v.name>, <lang xx>, <ruby>, <rt>
  // Keep conservative: accept dot-class forms we generate.
  if (!tag.startsWith('<') || !tag.endsWith('>')) return false;

  const inner = tag.slice(1, -1).trim();
  if (!inner) return false;

  // Strip leading slash for end tags
  const isEnd = inner.startsWith('/');
  const body = isEnd ? inner.slice(1).trim() : inner;

  // Split on whitespace for tags like <v Fred> or <lang en>
  const parts = body.split(/\s+/).filter(Boolean);
  const head = parts[0] || '';
  const name = head.split(/[.\s]/)[0]; // c / v / i / u etc (ignoring .class)
  if (!name) return false;

  const allowed = new Set(['i', 'b', 'u', 'c', 'v', 'lang', 'ruby', 'rt']);
  if (!allowed.has(name)) return false;

  // For c/v tags, allow dot-classes (c.class1.class2)
  if ((name === 'c' || name === 'v') && head.includes('.')) {
    const segs = head.split('.');
    if (!segs.length || segs[0] !== name) return false;
    for (const cls of segs.slice(1)) {
      if (!cls || !/^[A-Za-z0-9_-]+$/.test(cls)) return false;
    }
  }

  // End tags cannot have attributes/classes beyond name/.classes
  if (isEnd) {
    return parts.length === 1;
  }

  // For lang/v, allow one attribute token (e.g., <lang en>, <v Fred>)
  if (name === 'lang' || name === 'v') {
    return parts.length <= 2;
  }

  // Others: no attributes
  if (name === 'i' || name === 'b' || name === 'u' || name === 'ruby' || name === 'rt') {
    return parts.length === 1;
  }

  // c tag: no attributes (classes already in head)
  if (name === 'c') {
    return parts.length === 1;
  }

  return true;
}

function findUnsafeTags(textLine) {
  const s = String(textLine || '');
  const tags = s.match(/<[^>]*>/g) || [];
  const unsafe = [];
  for (const t of tags) {
    if (!isAllowedVttTag(t)) unsafe.push(t);
  }
  return unsafe;
}

// parseVTT is now sourced from ai/vttParser.js so both validation and import share
// one robust parsing implementation.

function severityFor(code, baseSeverity, { qcStrict } = {}) {
  if (baseSeverity === 'error') return 'error';
  if (!qcStrict) return baseSeverity;

  const escalate = new Set([
    'OVERLAP',
    'CPS_TOO_HIGH',
    'LINE_TOO_LONG',
    'TOO_MANY_LINES',
    'DURATION_TOO_SHORT',
    'DURATION_TOO_SHORT_HARD',
    'DURATION_TOO_LONG',
    'UNSUPPORTED_TAG',
    'UNKNOWN_CUE_SETTING'
  ]);
  return escalate.has(code) ? 'error' : baseSeverity;
}

function validateVTT(vttText, config = {}, context = {}) {
  const opts = resolveVttOptions(config);
  const qcStrict = Boolean(opts.profileKey === 'strict' || opts.qcStrict || (config && config.qcStrict));

  const parsed = parseVTT(vttText);

  const report = {
    kind: 'WebVTT_QC_Report',
    version: 1,
    generatedAt: new Date().toISOString(),
    output: {
      path: context.outPath || ''
    },
    options: {
      profileKey: opts.profileKey || '',
      maxCharsPerLine: opts.maxCharsPerLine,
      maxLinesPerBlock: opts.maxLinesPerBlock,
      maxDurationSeconds: opts.maxDurationSeconds,
      minDurationSeconds: opts.minDurationSeconds,
      minSplitDurationSeconds: opts.minSplitDurationSeconds,
      maxCps: opts.maxCps,
      preventOverlaps: opts.preventOverlaps,
      allowTimeExtension: opts.allowTimeExtension,
      maxEndExtensionSeconds: opts.maxEndExtensionSeconds,
      includeStyleMetadata: opts.includeStyleMetadata,
      qcStrict
    },
    stats: {
      cueCount: 0,
      earliestStart: null,
      latestEnd: null,
      totalDurationSeconds: null,
      worstCps: 0,
      worstCpsCueIndex: null,
      maxLinesObserved: 0,
      maxLineCharsObserved: 0
    },
    errors: [],
    warnings: []
  };

  const pushIssue = (severity, issue) => {
    const sev = severityFor(issue.code || 'UNKNOWN', severity, { qcStrict });
    const arr = (sev === 'error') ? report.errors : report.warnings;
    arr.push(issue);
  };

  if (!parsed.headerValid) {
    pushIssue('error', {
      code: 'INVALID_HEADER',
      message: 'Missing or invalid WEBVTT header',
      line: parsed.headerLineNo
    });
  }

  // STYLE/REGION blocks after cues should be warnings.
  for (const b of parsed.headerBlocks || []) {
    if ((b.type === 'STYLE' || b.type === 'REGION') && b.inHeader === false) {
      pushIssue('warning', {
        code: 'LATE_HEADER_BLOCK',
        message: `${b.type} block appears after cues; some players may ignore it`,
        line: b.startLineNo
      });
    }
  }

  const cues = parsed.cues || [];
  report.stats.cueCount = cues.length;

  let prevEnd = null;
  let prevEndCue = null;

  for (let idx = 0; idx < cues.length; idx++) {
    const cue = cues[idx];
    const cueIndex = idx + 1;

    if (!cue.ok) {
      pushIssue('error', {
        code: 'INVALID_CUE_TIMING',
        message: `Invalid cue timing line: ${cue.reason || 'parse error'}`,
        cueIndex,
        line: cue.timingLineNo,
        timingLine: cue.timingLine
      });
      continue;
    }

    const start = cue.start;
    const end = cue.end;

    if (typeof start !== 'number' || typeof end !== 'number') {
      pushIssue('error', {
        code: 'INVALID_CUE_TIMING',
        message: 'Cue timing timestamps could not be parsed',
        cueIndex,
        line: cue.timingLineNo,
        timingLine: cue.timingLine
      });
      continue;
    }

    if (!(start + EPS_SEC < end)) {
      pushIssue('error', {
        code: 'INVERTED_TIMECODE',
        message: 'Cue start must be strictly less than cue end',
        cueIndex,
        start,
        end,
        line: cue.timingLineNo
      });
      continue;
    }

    // Track earliest/latest
    if (report.stats.earliestStart == null || start < report.stats.earliestStart) report.stats.earliestStart = start;
    if (report.stats.latestEnd == null || end > report.stats.latestEnd) report.stats.latestEnd = end;

    // Overlap check
    if (prevEnd != null && start + EPS_SEC < prevEnd) {
      const overlap = prevEnd - start;
      pushIssue('warning', {
        code: 'OVERLAP',
        message: `Cue overlaps previous cue by ${(overlap).toFixed(3)}s`,
        cueIndex,
        start,
        end,
        prevCueIndex: prevEndCue,
        prevEnd
      });
    }
    prevEnd = end;
    prevEndCue = cueIndex;

    // Empty cue check (visible)
    const visibleLines = cueVisibleTextLines(cue.textLines);
    const visibleJoined = visibleLines.join('\n').trim();
    if (!visibleJoined) {
      pushIssue('error', {
        code: 'EMPTY_CUE',
        message: 'Cue has no visible text after stripping tags/entities',
        cueIndex,
        start,
        end,
        line: cue.textStartLineNo
      });
    }

    // Line count check
    const lineCount = (cue.textLines || []).length;
    if (lineCount > report.stats.maxLinesObserved) report.stats.maxLinesObserved = lineCount;
    if (lineCount > opts.maxLinesPerBlock) {
      pushIssue('warning', {
        code: 'TOO_MANY_LINES',
        message: `Cue has ${lineCount} line(s); exceeds maxLinesPerBlock=${opts.maxLinesPerBlock}`,
        cueIndex,
        start,
        end,
        lineCount,
        maxLinesPerBlock: opts.maxLinesPerBlock
      });
    }

    // Line length checks
    for (let li = 0; li < (cue.textLines || []).length; li++) {
      const rawLine = String((cue.textLines || [])[li] ?? '');
      const visLen = visibleCharCount(rawLine);
      if (visLen > report.stats.maxLineCharsObserved) report.stats.maxLineCharsObserved = visLen;
      if (visLen > opts.maxCharsPerLine) {
        pushIssue('warning', {
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

      // Unsafe tag check
      const unsafeTags = findUnsafeTags(rawLine);
      if (unsafeTags.length) {
        pushIssue('warning', {
          code: 'UNSUPPORTED_TAG',
          message: `Cue line contains unsupported/unsafe tag(s): ${unsafeTags.join(', ')}`,
          cueIndex,
          start,
          end,
          lineIndex: li + 1,
          unsafeTags
        });
      }

      // Internal token leakage check
      if (/\{[^}]*\}/.test(rawLine)) {
        pushIssue('warning', {
          code: 'INTERNAL_TAG_LEAK',
          message: 'Cue line appears to contain internal {…} tags',
          cueIndex,
          start,
          end,
          lineIndex: li + 1
        });
      }
    }

    // CPS checks
    const dur = end - start;
    const charCount = visibleLines.reduce((acc, l) => acc + Array.from(l).length, 0);
    const cps = dur > 0 ? (charCount / dur) : Infinity;

    if (Number.isFinite(cps) && cps > report.stats.worstCps) {
      report.stats.worstCps = cps;
      report.stats.worstCpsCueIndex = cueIndex;
    }

    if (Number.isFinite(cps) && cps > opts.maxCps + 0.01) {
      pushIssue('warning', {
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

    // Duration checks
    if (dur + EPS_SEC < opts.minSplitDurationSeconds) {
      pushIssue('warning', {
        code: 'DURATION_TOO_SHORT_HARD',
        message: `Cue duration ${dur.toFixed(3)}s is below minSplitDurationSeconds=${opts.minSplitDurationSeconds}`,
        cueIndex,
        start,
        end,
        duration: dur,
        minSplitDurationSeconds: opts.minSplitDurationSeconds
      });
    } else if (dur + EPS_SEC < opts.minDurationSeconds) {
      pushIssue('warning', {
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
      pushIssue('warning', {
        code: 'DURATION_TOO_LONG',
        message: `Cue duration ${dur.toFixed(3)}s exceeds maxDurationSeconds=${opts.maxDurationSeconds}`,
        cueIndex,
        start,
        end,
        duration: dur,
        maxDurationSeconds: opts.maxDurationSeconds
      });
    }

    // Cue settings validation
    const settings = cue.settings || {};
    const unknown = cue.unknownSettings || [];
    if (unknown.length) {
      pushIssue('warning', {
        code: 'UNKNOWN_CUE_SETTING',
        message: `Unknown cue setting token(s): ${unknown.join(' ')}`,
        cueIndex,
        start,
        end,
        unknownSettings: unknown
      });
    }

    const validatePercent = (v) => {
      const m = String(v || '').match(/^(-?\d+(?:\.\d+)?)%$/);
      if (!m) return null;
      const num = Number(m[1]);
      return Number.isFinite(num) ? num : null;
    };

    if (settings.line != null) {
      // line may be "90%" or "90%,start"; handle comma suffix
      const raw = String(settings.line);
      const core = raw.split(',')[0].trim();
      const pct = validatePercent(core);
      if (pct == null || pct < 0 || pct > 100) {
        pushIssue('warning', {
          code: 'INVALID_CUE_SETTING',
          message: `Invalid line setting: ${raw}`,
          cueIndex,
          start,
          end,
          setting: 'line',
          value: raw
        });
      }
    }
    if (settings.position != null) {
      const raw = String(settings.position);
      const core = raw.split(',')[0].trim();
      const pct = validatePercent(core);
      if (pct == null || pct < 0 || pct > 100) {
        pushIssue('warning', {
          code: 'INVALID_CUE_SETTING',
          message: `Invalid position setting: ${raw}`,
          cueIndex,
          start,
          end,
          setting: 'position',
          value: raw
        });
      }
    }
    if (settings.size != null) {
      const raw = String(settings.size);
      const pct = validatePercent(raw.trim());
      if (pct == null || pct < 0 || pct > 100) {
        pushIssue('warning', {
          code: 'INVALID_CUE_SETTING',
          message: `Invalid size setting: ${raw}`,
          cueIndex,
          start,
          end,
          setting: 'size',
          value: raw
        });
      }
    }
    if (settings.align != null) {
      const raw = String(settings.align).trim().toLowerCase();
      const ok = ['start', 'center', 'end', 'left', 'right'].includes(raw);
      if (!ok) {
        pushIssue('warning', {
          code: 'INVALID_CUE_SETTING',
          message: `Invalid align setting: ${settings.align}`,
          cueIndex,
          start,
          end,
          setting: 'align',
          value: settings.align
        });
      }
    }
  }

  // Finalize stats
  if (report.stats.earliestStart != null && report.stats.latestEnd != null) {
    report.stats.totalDurationSeconds = report.stats.latestEnd - report.stats.earliestStart;
  }

  return report;
}

function formatSecondsAsTimestamp(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) sec = 0;
  const ms = Math.max(0, toMs(sec));
  const totalSeconds = Math.floor(ms / 1000);
  const msec = ms % 1000;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;

  const pad2 = (v) => String(v).padStart(2, '0');
  const pad3 = (v) => String(v).padStart(3, '0');

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(msec)}`;
}

function formatVttQcReportText(report) {
  const r = report || {};
  const lines = [];
  lines.push('=== VTT QC REPORT ===');
  if (r.output && r.output.path) lines.push(`Output: ${r.output.path}`);
  const opt = r.options || {};
  if (opt.profileKey) lines.push(`Profile: ${opt.profileKey}${opt.qcStrict ? ' (QC strict)' : ''}`);
  lines.push(
    `Constraints: ${opt.maxLinesPerBlock} lines • ${opt.maxCharsPerLine} CPL • maxCPS=${opt.maxCps} • ` +
    `minDur=${opt.minDurationSeconds}s • minSplit=${opt.minSplitDurationSeconds}s • maxDur=${opt.maxDurationSeconds}s • ` +
    `overlaps=${opt.preventOverlaps ? 'ON' : 'OFF'} • gapExtend=${opt.allowTimeExtension ? 'ON' : 'OFF'}`
  );

  const st = r.stats || {};
  if (st.cueCount != null) lines.push(`Cues: ${st.cueCount}`);
  if (st.earliestStart != null && st.latestEnd != null) {
    lines.push(`Timeline: ${formatSecondsAsTimestamp(st.earliestStart)} → ${formatSecondsAsTimestamp(st.latestEnd)} (${(st.totalDurationSeconds ?? 0).toFixed(3)}s)`);
  }
  lines.push(`Worst CPS: ${(st.worstCps ?? 0).toFixed(2)}${st.worstCpsCueIndex ? ` (cue #${st.worstCpsCueIndex})` : ''}`);
  lines.push(`Max lines observed: ${st.maxLinesObserved ?? 0}`);
  lines.push(`Max line chars observed: ${st.maxLineCharsObserved ?? 0}`);
  lines.push('');

  const errs = Array.isArray(r.errors) ? r.errors : [];
  const warns = Array.isArray(r.warnings) ? r.warnings : [];

  lines.push(`Errors: ${errs.length}`);
  for (const e of errs.slice(0, 200)) {
    const where = e.cueIndex ? `cue #${e.cueIndex}` : (e.line ? `line ${e.line}` : '');
    const ts = (e.start != null && e.end != null) ? `${formatSecondsAsTimestamp(e.start)} → ${formatSecondsAsTimestamp(e.end)}` : '';
    lines.push(`  [E] ${e.code}${where ? ` (${where})` : ''}${ts ? ` ${ts}` : ''} — ${e.message}`);
  }
  if (errs.length > 200) lines.push(`  … ${errs.length - 200} more error(s) omitted`);

  lines.push('');
  lines.push(`Warnings: ${warns.length}`);
  for (const w of warns.slice(0, 300)) {
    const where = w.cueIndex ? `cue #${w.cueIndex}` : (w.line ? `line ${w.line}` : '');
    const ts = (w.start != null && w.end != null) ? `${formatSecondsAsTimestamp(w.start)} → ${formatSecondsAsTimestamp(w.end)}` : '';
    lines.push(`  [W] ${w.code}${where ? ` (${where})` : ''}${ts ? ` ${ts}` : ''} — ${w.message}`);
  }
  if (warns.length > 300) lines.push(`  … ${warns.length - 300} more warning(s) omitted`);

  lines.push('');
  lines.push('Notes:');
  lines.push('- “Errors” typically indicate invalid or risky deliverables (bad header/timing/empty cues).');
  lines.push('- “Warnings” indicate QC/house-style violations (CPS/line length/duration/overlaps).');
  lines.push('- WebVTT styling/placement support varies by player; keep “style metadata” optional.');

  return lines.join('\n') + '\n';
}

module.exports = {
  parseVTT,
  validateVTT,
  formatVttQcReportText
};
