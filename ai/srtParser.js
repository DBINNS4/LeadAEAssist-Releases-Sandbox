// ai/srtParser.js
// Robust, dependency-light SRT parser.
//
// Design goals:
//  - Parse real-world SRT reliably (BOM, CRLF, optional cue index lines).
//  - Follow standard SRT timing syntax: HH:MM:SS,mmm --> HH:MM:SS,mmm
//  - Be tolerant on ingest: accept '.' as a millisecond separator and 1–3 ms digits.
//    (Writers still emit canonical ',mmm'.)
//  - Preserve cue text line breaks (preview + editor correctness).

'use strict';

function normalizeNewlines(input) {
  return String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripBom(input) {
  const s = String(input ?? '');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function _msFromFraction(fracRaw) {
  const frac = String(fracRaw ?? '').replace(/\D/g, '');
  if (!frac) return 0;
  // 1 digit => 100ms, 2 digits => 10ms, 3+ digits => first 3 digits
  if (frac.length === 1) return Number(frac) * 100;
  if (frac.length === 2) return Number(frac) * 10;
  return Number(frac.slice(0, 3));
}

function parseSrtTimestampToMs(tsRaw) {
  // Common SRT: HH:MM:SS,mmm
  // Tolerant ingest:
  //  - allow 1+ digit hours
  //  - allow '.' or ','
  //  - allow 1–3 ms digits
  const ts = String(tsRaw ?? '').trim();
  const m = ts.match(/^(\d{1,}):(\d{2}):(\d{2})[.,](\d{1,})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = _msFromFraction(m[4]);
  if (![hh, mm, ss, ms].every(Number.isFinite)) return null;
  if (mm > 59 || ss > 59 || ms > 999) return null;
  return (((hh * 60 + mm) * 60) + ss) * 1000 + ms;
}

function parseSrtTimingLine(lineRaw) {
  const line = String(lineRaw ?? '').trim();
  if (!line.includes('-->')) return { ok: false, reason: 'Missing --> delimiter' };

  // Allow extra tokens after end timestamp (non-standard but appears in the wild).
  // Example: "00:00:01,000 --> 00:00:02,000 X1:0 X2:0"
  const parts = line.split('-->');
  const left = String(parts[0] ?? '').trim();
  const right = String(parts.slice(1).join('-->') ?? '').trim();
  const endTok = right.split(/\s+/).filter(Boolean)[0] || '';

  const startMs = parseSrtTimestampToMs(left);
  const endMs = parseSrtTimestampToMs(endTok);

  if (startMs == null || endMs == null) {
    return { ok: false, reason: 'Invalid timestamp format', startRaw: left, endRaw: endTok };
  }
  return { ok: true, startMs, endMs, startRaw: left, endRaw: endTok };
}

function splitBlocks(lines) {
  const blocks = [];
  let cur = [];
  let curStartLineNo = 1;

  const flush = () => {
    if (cur.length) blocks.push({ startLineNo: curStartLineNo, lines: cur });
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = String(lines[i] ?? '');
    if (!ln.trim()) {
      flush();
      continue;
    }
    if (!cur.length) curStartLineNo = i + 1;
    cur.push(ln);
  }
  flush();
  return blocks;
}

/**
 * Parse SRT text into a list of cues.
 *
 * @returns {{ cues: Array<{id?: string|null, start: number, end: number, text: string, textLines: string[], sourceLineNo: number}>, errors: any[] }}
 */
function parseSRT(srtText) {
  const text = normalizeNewlines(stripBom(srtText));
  const lines = text.split('\n');

  const blocks = splitBlocks(lines);
  const cues = [];
  const errors = [];

  for (const b of blocks) {
    const rawLines = Array.isArray(b.lines) ? b.lines : [];
    if (!rawLines.length) continue;

    // Optional numeric index / cue id line.
    let idx = 0;
    let id = null;
    let timingLine = String(rawLines[0] ?? '');

    if (!timingLine.includes('-->') && rawLines.length >= 2 && String(rawLines[1]).includes('-->')) {
      id = String(rawLines[0] ?? '').trim() || null;
      idx = 1;
      timingLine = String(rawLines[1] ?? '');
    }

    const timing = parseSrtTimingLine(timingLine);
    if (!timing.ok) {
      errors.push({
        code: 'BAD_TIMING',
        message: timing.reason || 'Bad SRT timing line',
        line: b.startLineNo + idx,
        timingLine
      });
      continue;
    }

    // Convert to seconds.
    const start = timing.startMs / 1000;
    const end = timing.endMs / 1000;
    if (!(end > start)) {
      errors.push({
        code: 'NON_POSITIVE_DURATION',
        message: `Cue end must be > start (${start.toFixed(3)} -> ${end.toFixed(3)})`,
        line: b.startLineNo + idx,
        timingLine
      });
      continue;
    }

    // Payload lines (preserve line breaks; trim only trailing CR already normalized).
    const textLines = rawLines.slice(idx + 1).map((l) => String(l ?? ''));
    // Drop leading/trailing empty lines inside the payload (defensive; SRT doesn't allow blank lines within cues).
    while (textLines.length && !String(textLines[0]).trim()) textLines.shift();
    while (textLines.length && !String(textLines[textLines.length - 1]).trim()) textLines.pop();

    const textJoined = textLines.join('\n');
    if (!String(textJoined || '').trim()) {
      errors.push({
        code: 'EMPTY_CUE',
        message: 'Cue has no text payload',
        line: b.startLineNo + idx,
        timingLine
      });
      continue;
    }

    cues.push({
      id,
      start,
      end,
      text: textJoined,
      textLines,
      sourceLineNo: b.startLineNo
    });
  }

  // Stable-ish sort by time so editor navigation is sane even on out-of-order files.
  cues.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.sourceLineNo - b.sourceLineNo));

  return { cues, errors };
}

module.exports = {
  parseSRT,
  parseSrtTimestampToMs
};
