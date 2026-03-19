'use strict';

const fs = require('fs');
const path = require('path');
const { parseTime: parseTimeMs, isDropFrameRate } = require('../utils/timeUtils');
const { extendedGlyphMap } = require('./sccGlyphMap');
const { SCC_MODEL } = require('./sccEncoder');

// Reverse lookup for CEA-608 two-byte glyph pairs (parity-stripped 7-bit bytes).
// Key: (hi7 << 8) | lo7  -> unicode glyph
const _TWO_BYTE_GLYPH_BY_WORD = (() => {
  const m = new Map();
  try {
    for (const [glyph, spec] of Object.entries(extendedGlyphMap || {})) {
      const hiCh1 = Number(spec?.hiCh1);
      const hiCh2 = Number(spec?.hiCh2);
      const lo = Number(spec?.lo);
      if (Number.isFinite(lo)) {
        if (Number.isFinite(hiCh1)) m.set(((hiCh1 & 0x7f) << 8) | (lo & 0x7f), glyph);
        if (Number.isFinite(hiCh2)) m.set(((hiCh2 & 0x7f) << 8) | (lo & 0x7f), glyph);
      }
    }
  } catch {
    // Defensive: decoding should still work for plain ASCII if map is missing.
  }
  return m;
})();

// CEA-608 single-byte (printable) exceptions — NOT ASCII.
// Must mirror the encoder's table.
const _CEA608_SINGLE_BYTE_EXCEPTIONS = {
  0x2A: 'á',
  0x5C: 'é',
  0x5E: 'í',
  0x5F: 'ó',
  0x60: 'ú',
  0x7B: 'ç',
  0x7C: '÷',
  0x7D: 'Ñ',
  0x7E: 'ñ',
  0x7F: '█'
};

// Mid-row style tags (parity-stripped).
// We emit the encoder's tag format so the editor can round-trip styling.
const _MIDROW_TAG_BY_LO = {
  0x20: 'Wh',
  0x21: 'WhU',
  0x22: 'Gr',
  0x23: 'GrU',
  0x24: 'Bl',
  0x25: 'BlU',
  0x26: 'Cy',
  0x27: 'CyU',
  0x28: 'R',
  0x29: 'RU',
  0x2A: 'Y',
  0x2B: 'YU',
  0x2C: 'Ma',
  0x2D: 'MaU',
  0x2E: 'I',
  // CTA-608 also defines italics+underline as 0x2F.
  // The encoder represents this as {IU} (expanded during encode).
  0x2F: 'IU'
};

// CEA-608 pop-on buffers are 32-column grids.
// The decoder must operate in *cell units* (not JS string indices) so that
// mid-row tags (e.g. "{Wh}") and 2-byte glyph overwrites don't corrupt column
// accounting or placement.
const CEA608_COLS = 32;

function stripSccComments(raw) {
  let s = String(raw || '').replace(/\uFEFF/g, '').replace(/\r/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
  const out = [];
  for (const line of s.split('\n')) {
    const cleaned = line.replace(/\/\/.*$/, '').trim(); // line comments
    if (!cleaned) continue;
    if (/^Scenarist_SCC\b/i.test(cleaned)) continue;    // header
    out.push(cleaned);
  }
  return out.join('\n');
}

function detectSccDropFrame(lines = []) {
  // SCC differentiates DF vs NDF by the *last* separator in the timecode:
  //   HH:MM:SS;FF  -> drop-frame
  //   HH:MM:SS:FF  -> non-drop-frame
  // Requested rule: if ANY timecode uses ';' => DF, else if timecodes use ':' => NDF.
  let sawTimecode = false;
  let sawSemicolon = false;
  let sawColon = false;

  for (const line of lines) {
    const m = /^(\d{2}:\d{2}:\d{2})([:;])(\d{2})\b/.exec(String(line || '').trim());
    if (!m) continue;
    sawTimecode = true;
    if (m[2] === ';') sawSemicolon = true;
    else if (m[2] === ':') sawColon = true;
  }

  if (sawSemicolon) return { dropFrame: true, mixed: sawColon };
  if (sawTimecode && sawColon) return { dropFrame: false, mixed: false };
  return { dropFrame: null, mixed: false };
}

function normalizeSccTimecodeDelimiter(tcLabel, dropFrame) {
  const raw = String(tcLabel || '').trim();
  const m = raw.match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
  if (!m) return raw;
  const sep = dropFrame ? ';' : ':';
  return `${m[1]}${sep}${m[2]}`;
}

function _tcToSeconds(tc, fps) {
  // IMPORTANT: SCC explicitly differentiates DF vs NDF using the delimiter.
  //  - ';' => DF
  //  - ':' => NDF
  // Do NOT pass a DF hint that could coerce ':' into DF.
  const ms = parseTimeMs(tc, fps, null);
  return (typeof ms === 'number' && !Number.isNaN(ms)) ? (ms / 1000) : 0;
}

// After parity stripping, all CTA‑608 control/PAC bytes are 0x10–0x1F.
function _isCtrl608(hi7) {
  return hi7 >= 0x10 && hi7 <= 0x1f;
}
function _isMidRow(hi7, lo7) { return (hi7 === 0x11 || hi7 === 0x19) && lo7 >= 0x20 && lo7 <= 0x2f; }
// TO1/TO2/TO3 tab offsets: 0x17/0x1F, 0x21..0x23
function _isTabOffset(hi7, lo7) {
  return (hi7 === 0x17 || hi7 === 0x1f) && lo7 >= 0x21 && lo7 <= 0x23;
}

// Decode a CEA‑608 PAC (F1/F2) into a 1‑based row and 0‑based column.
// This is the inverse of modules/sccEncoder.js: pacForRow().
function _decodePacRowCol(hi7, lo7) {
  // Only PAC / extended-address pairs live in this range after parity strip.
  if (hi7 < 0x10 || hi7 > 0x1f) return null;
  if (lo7 < 0x40 || lo7 > 0x7f) return null;

  // Row lookup tables for data channel 1 and 2 (CTA‑608 Table 53).
  const rowsLowCh1 = {
    0x11: 1, 0x12: 3, 0x15: 5, 0x16: 7, 0x17: 9,
    0x10: 11,
    0x13: 12,
    0x14: 14,
  };
  const rowsHighCh1 = {
    0x11: 2, 0x12: 4, 0x15: 6, 0x16: 8, 0x17: 10,
    0x13: 13,
    0x14: 15,
  };
  const rowsLowCh2 = {
    0x19: 1, 0x1a: 3, 0x1d: 5, 0x1e: 7, 0x1f: 9,
    0x18: 11,
    0x1b: 12,
    0x1c: 14,
  };
  const rowsHighCh2 = {
    0x19: 2, 0x1a: 4, 0x1d: 6, 0x1e: 8, 0x1f: 10,
    0x1b: 13,
    0x1c: 15,
  };

  const isCh1 = hi7 <= 0x17;
  const isLow = lo7 <= 0x5f; // 0x40–0x5F vs 0x60–0x7F

  const rows = isCh1
    ? (isLow ? rowsLowCh1 : rowsHighCh1)
    : (isLow ? rowsLowCh2 : rowsHighCh2);

  const row = rows[hi7];
  if (!row) return null;

  // Invert the encoder’s PAC indent logic:
  //   pacIndex = secondByte - 0x40 (or -0x60)
  //   indentNibble = floor((pacIndex - 0x10) / 2)
  //   col = indentNibble * 4
  let pacIndex = lo7 > 0x5f ? lo7 - 0x60 : lo7 - 0x40;
  let col = 0;
  if (pacIndex >= 0x10) {
    const indentNibble = Math.floor((pacIndex - 0x10) / 2);
    col = indentNibble * 4;
  }

  return { row, col };
}

function _byteTo608Char(b7) {
  // CTA-608 is *not* ASCII. Several byte values map to accented glyphs.
  // We must mirror the encoder table or round-tripping breaks.
  const ex = _CEA608_SINGLE_BYTE_EXCEPTIONS[b7];
  if (ex) return ex;
  if (b7 >= 0x20 && b7 <= 0x7e) return String.fromCharCode(b7);
  return '';
}

function _decodeTwoByteGlyph(hi7, lo7) {
  const key = ((hi7 & 0x7f) << 8) | (lo7 & 0x7f);
  return _TWO_BYTE_GLYPH_BY_WORD.get(key) || null;
}

function _decodeMidRowTag(hi7, lo7) {
  if (!_isMidRow(hi7, lo7)) return null;
  const tok = _MIDROW_TAG_BY_LO[lo7];
  return tok ? `{${tok}}` : null;
}

function _overwriteLastCharCell(lineStr, glyph) {
  const arr = Array.from(String(lineStr || ''));
  if (!arr.length) return String(glyph || '');
  arr[arr.length - 1] = String(glyph || '');
  return arr.join('');
}

function decodeScc(rawInput, opts = {}) {
  const cleaned = stripSccComments(rawInput);
  const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const fps = Number(opts.fps || 29.97) || 29.97;
  const model = opts.model || SCC_MODEL || { maxLinesPerCue: 2, maxCharsPerLine: 32 };
  const modelOverflowPolicy = String(opts.modelOverflowPolicy || 'warn').toLowerCase();

  // DF/NDF detection (SCC rule):
  //   If ANY timecode uses ';' -> DF
  //   Else if timecodes use ':' -> NDF
  // This must override any caller-provided hint because SCC encodes DF/NDF in the delimiter.
  const det = detectSccDropFrame(lines);
  let dropFrame = (det.dropFrame != null)
    ? det.dropFrame
    : ((opts.dropFrame == null) ? true : !!opts.dropFrame);

  // Caption service detection (CC1–CC4). SCC files are usually authored as a single service.
  // We infer service from field-specific control code prefixes (0x14/0x15/0x1C/0x1D after parity strip).
  let captionService = null; // 1..4
  let captionServiceMixed = false;

  const EOC = 0x2f;
  const EDM = 0x2c;
  const CR = 0x2d;
  const RCL = 0x20;
  const RDC = 0x29;
  const ENM = 0x2e;

  const cues = [];
  const modelIssues = [];
  const importWarnings = [];
  const importErrors = [];
  let lastEocSec = null;

  // A single CEA-608 row is a fixed-width Array(32) of *cell tokens*.
  // Tokens are either:
  //  • visible chars like "H"
  //  • style tokens like "{Wh}" (mid-row attributes)
  //  • blank spaces " "
  const blankRowCells = () => Array(CEA608_COLS).fill(' ');
  const isBlankCell = (tok) => tok == null || tok === '' || tok === ' ';
  const coerceCellToken = (tok) => {
    const s = String(tok ?? '');
    return s.length ? s : ' ';
  };

  const createBuffer = () => ({
    rows: new Map(), // rowNumber -> Array(32) cell tokens
    cursorRow: null,
    cursorCol: 0
  });
  const clearBuffer = (buf) => {
    buf.rows.clear();
    buf.cursorRow = null;
    buf.cursorCol = 0;
  };

  const displayed = createBuffer();
  const nonDisplayed = createBuffer();
  let writeBuffer = nonDisplayed;
  let activeCueIndex = null;

  const getCursorRow = (buf) => {
    const row = Number(buf.cursorRow);
    return Number.isFinite(row) && row > 0 ? row : 15;
  };
  const getCursorCol = (buf) => {
    const col = Number(buf.cursorCol);
    return Number.isFinite(col) ? Math.max(0, Math.min(CEA608_COLS - 1, col)) : 0;
  };

  const setCursor = (buf, row, col) => {
    buf.cursorRow = row;
    buf.cursorCol = col;
  };

  const getRowCells = (buf, row) => {
    const r = Math.max(1, Math.min(15, row || 15));
    let cells = buf.rows.get(r);
    if (!cells) {
      cells = blankRowCells();
      buf.rows.set(r, cells);
    }
    // Defensive: tolerate any legacy/foreign shape.
    if (!Array.isArray(cells)) {
      const s = String(cells || '');
      cells = blankRowCells();
      for (let i = 0; i < Math.min(CEA608_COLS, s.length); i++) cells[i] = s[i];
      buf.rows.set(r, cells);
    } else if (cells.length !== CEA608_COLS) {
      const fixed = blankRowCells();
      for (let i = 0; i < Math.min(CEA608_COLS, cells.length); i++) fixed[i] = coerceCellToken(cells[i]);
      cells = fixed;
      buf.rows.set(r, cells);
    }
    return cells;
  };

  const writeCharAt = (buf, row, col, ch) => {
    const r = Math.max(1, Math.min(15, row || 15));
    const c = Math.max(0, Math.min(CEA608_COLS - 1, col || 0));
    const glyph = coerceCellToken(ch);
    const cells = getRowCells(buf, r);
    cells[c] = glyph;
    return c + 1;
  };

  const overwriteCharAt = (buf, row, col, ch) => {
    return writeCharAt(buf, row, Math.max(0, col - 1), ch);
  };

  const cellsToText = (cells) => {
    if (!Array.isArray(cells) || !cells.length) return '';
    // Join tokens into a single text line. Blank cells become spaces.
    return cells.map((t) => (isBlankCell(t) ? ' ' : String(t))).join('');
  };

  const trimRightBlankCells = (cells) => {
    if (!Array.isArray(cells) || !cells.length) return [];
    let last = -1;
    for (let i = 0; i < cells.length; i++) {
      if (!isBlankCell(cells[i])) last = i;
    }
    if (last < 0) return [];
    const out = cells.slice(0, last + 1).map(coerceCellToken);
    return out;
  };

  const buildCueFromDisplayed = (sec) => {
    // Keep only rows with at least one non-blank cell.
    //
    // Important: preserve *insertion order* (i.e., the order rows were first written in the
    // SCC stream) to enable byte-for-byte SCC round-trips.
    let rowMeta = Array.from(displayed.rows.entries())
      .map(([row, cells]) => {
        const r = Number(row);
        const arr = Array.isArray(cells) ? cells : null;
        if (!Number.isFinite(r) || r < 1 || r > 15 || !arr) return null;

        let first = -1;
        let last = -1;
        for (let i = 0; i < Math.min(CEA608_COLS, arr.length); i++) {
          if (!isBlankCell(arr[i])) {
            if (first === -1) first = i;
            last = i;
          }
        }
        if (last < 0) return null;

        const trimmedCells = trimRightBlankCells(arr.slice(0, CEA608_COLS));
        return {
          row: r,
          firstCol: first,
          usedCols: last + 1,
          cells: trimmedCells,
          text: cellsToText(trimmedCells)
        };
      })
      .filter(Boolean);

    if (!rowMeta.length) return null;

    // Apply model constraints *in cell units*.
    if (Number.isFinite(model?.maxLinesPerCue) && rowMeta.length > model.maxLinesPerCue) {
      const issue = {
        code: 'MODEL_MAX_LINES_EXCEEDED',
        severity: modelOverflowPolicy === 'error' ? 'error' : 'warning',
        message: `Caption has ${rowMeta.length} rows (max ${model.maxLinesPerCue}).`
      };
      modelIssues.push(issue);
      importWarnings.push(`Model overflow: maxLinesPerCue=${model.maxLinesPerCue} rows=${rowMeta.length}`);
      if (modelOverflowPolicy === 'error') {
        const err = new Error(`MODEL_MAX_LINES_EXCEEDED: ${issue.message}`);
        err.code = issue.code;
        throw err;
      }
      const keepFrom = Math.max(0, rowMeta.length - model.maxLinesPerCue);
      rowMeta = rowMeta.slice(keepFrom);
    }

    if (Number.isFinite(model?.maxCharsPerLine)) {
      const maxCols = Math.max(1, Math.min(CEA608_COLS, Number(model.maxCharsPerLine) || CEA608_COLS));
      rowMeta = rowMeta.map((r) => {
        if (r.usedCols <= maxCols) return r;
        const issue = {
          code: 'MODEL_MAX_CHARS_EXCEEDED',
          severity: modelOverflowPolicy === 'error' ? 'error' : 'warning',
          message: `Caption row exceeds maxCols ${maxCols}: ${r.usedCols}`
        };
        modelIssues.push(issue);
        importWarnings.push(`Model overflow: maxCharsPerLine=${maxCols} cols=${r.usedCols}`);
        if (modelOverflowPolicy === 'error') {
          const err = new Error(`MODEL_MAX_CHARS_EXCEEDED: ${issue.message}`);
          err.code = issue.code;
          throw err;
        }
        const truncatedCells = trimRightBlankCells((r.cells || []).slice(0, maxCols));
        let last = -1;
        for (let i = 0; i < truncatedCells.length; i++) {
          if (!isBlankCell(truncatedCells[i])) last = i;
        }
        const usedCols = Math.max(0, last + 1);
        return {
          ...r,
          cells: truncatedCells,
          text: cellsToText(truncatedCells),
          usedCols
        };
      });
    }

    const lines = rowMeta.map(r => r.text);
    const placements = rowMeta.map(r => ({ row: r.row, col: Math.max(0, r.firstCol) }));

    // (maxLinesPerCue / maxCharsPerLine enforced above in cell units)

    return {
      start: sec,
      end: null,
      text: lines.join('\n'),
      lines,
      sccPlacement: placements
    };
  };

  const closeActiveCue = (sec) => {
    if (activeCueIndex == null) return;
    const cue = cues[activeCueIndex];
    if (cue && cue.end == null) cue.end = sec;
    activeCueIndex = null;
  };

  const swapDisplayedFromNon = (sec) => {
    closeActiveCue(sec);
    const tempRows = displayed.rows;
    const tempRow = displayed.cursorRow;
    const tempCol = displayed.cursorCol;
    displayed.rows = nonDisplayed.rows;
    displayed.cursorRow = nonDisplayed.cursorRow;
    displayed.cursorCol = nonDisplayed.cursorCol;
    nonDisplayed.rows = tempRows;
    nonDisplayed.cursorRow = tempRow;
    nonDisplayed.cursorCol = tempCol;
    clearBuffer(nonDisplayed);
    const cue = buildCueFromDisplayed(sec);
    if (cue) {
      cues.push(cue);
      activeCueIndex = cues.length - 1;
    }
  };

  // Track earliest timecode label in the file. Used as the "media start TC" offset so
  // SCC captions can be previewed against 0-based media time in the editor.
  let timecodeBaseSec = null;
  let timecodeBaseLabel = null;

  for (const line of lines) {
    if (!line) continue;
    if (/^Scenarist_SCC/i.test(line)) continue;
    if (/^\/\//.test(line)) continue;

    const m = /^(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(.+)$/.exec(line);
    if (!m) continue;
    const tc = m[1];
    const sec = _tcToSeconds(tc, fps);

    if (timecodeBaseSec == null || sec < timecodeBaseSec) {
      timecodeBaseSec = sec;
      timecodeBaseLabel = normalizeSccTimecodeDelimiter(tc, dropFrame);
    }

    const words = m[2].trim().split(/\s+/).filter(w => /^[0-9A-Fa-f]{4}$/.test(w));
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      const wordSec = sec + (wi / fps);
      const word = parseInt(w, 16) & 0xffff;
      const hi = (word >> 8) & 0xff;
      const lo = word & 0xff;
      const hi7 = hi & 0x7f;
      const lo7 = lo & 0x7f;

      if (_isCtrl608(hi7)) {
        // Caption service inference:
        //   CC1: hi7=0x14 (field 1, channel 1) + control-byte range
        //   CC2: hi7=0x1C (field 1, channel 2) + control-byte range
        //   CC3: hi7=0x15 (field 2, channel 1) + control-byte range
        //   CC4: hi7=0x1D (field 2, channel 2) + control-byte range
        // Note: PAC bytes for rows 14–15 also use hi7=0x14/0x1C, so we require lo7 in 0x20..0x2F.
        if ((lo7 >= 0x20 && lo7 <= 0x2f) && (hi7 === 0x14 || hi7 === 0x15 || hi7 === 0x1c || hi7 === 0x1d)) {
          const isField2 = (hi7 === 0x15 || hi7 === 0x1d);
          const isSecond = (hi7 === 0x1c || hi7 === 0x1d);
          const svc = (isField2 ? 3 : 1) + (isSecond ? 1 : 0); // -> 1..4
          if (captionService == null) captionService = svc;
          else if (captionService !== svc) captionServiceMixed = true;
        }

        // SCC/608 redundancy: control/PAC/TO words are often repeated back-to-back.
        // Treat an immediate duplicate as the redundant copy (apply once, skip next).
        const nextHex = words[wi + 1];
        if (nextHex) {
          const nextWord = parseInt(nextHex, 16) & 0xffff;
          const nextHi7 = (nextWord >> 8) & 0x7f;
          const nextLo7 = nextWord & 0x7f;
          if (nextHi7 === hi7 && nextLo7 === lo7) {
            wi += 1;
          }
        }

        // Mid-row styling codes share lo7 values with several "main" control codes (e.g. 0x2E is
        // ENM on 0x14/0x1C, but {I} on 0x11/0x19). Always decode mid-row first.
        const midTag = _decodeMidRowTag(hi7, lo7);
        if (midTag) {
          const row = getCursorRow(writeBuffer);
          const col = getCursorCol(writeBuffer);
          const nextCol = writeCharAt(writeBuffer, row, col, midTag);
          setCursor(writeBuffer, row, nextCol);
          continue;
        }

        // TO1/TO2/TO3 tab offsets – bump current line's column by 1–3 cells.
        if (_isTabOffset(hi7, lo7)) {
          const n = (lo7 & 0x7f) - 0x20; // 1..3
          setCursor(writeBuffer, getCursorRow(writeBuffer), getCursorCol(writeBuffer) + n);
          continue;
        }

        // 0x11/0x19 0x39 is "transparent space". Many encoders emit it as a placeholder
        // before sending a two-byte glyph, which overwrites the previous character cell.
        if ((hi7 === 0x11 || hi7 === 0x19) && lo7 === 0x39) {
          const row = getCursorRow(writeBuffer);
          const col = getCursorCol(writeBuffer);
          const nextCol = writeCharAt(writeBuffer, row, col, ' ');
          setCursor(writeBuffer, row, nextCol);
          continue;
        }

        // Special/extended two-byte glyph pairs (®½¿…)
        const glyph = _decodeTwoByteGlyph(hi7, lo7);
        if (glyph) {
          const row = getCursorRow(writeBuffer);
          const col = getCursorCol(writeBuffer);
          overwriteCharAt(writeBuffer, row, col, glyph);
          continue;
        }

        // Only treat these as "main" control codes when the hi7 prefix matches a caption
        // service control word (0x14/0x1C/0x15/0x1D after parity strip).
        const isSvcCtrl = (hi7 === 0x14 || hi7 === 0x15 || hi7 === 0x1c || hi7 === 0x1d);

        if (isSvcCtrl && lo7 === EOC) {
          swapDisplayedFromNon(wordSec);
          lastEocSec = wordSec;
          continue;
        }
        if (isSvcCtrl && lo7 === EDM) {
          closeActiveCue(wordSec);
          clearBuffer(displayed);
          continue;
        }
        if (isSvcCtrl && lo7 === ENM) {
          clearBuffer(nonDisplayed);
          continue;
        }
        if (isSvcCtrl && lo7 === CR) {
          const row = Math.min(15, getCursorRow(writeBuffer) + 1);
          setCursor(writeBuffer, row, 0);
          continue;
        }
        if (isSvcCtrl && lo7 === RCL) {
          writeBuffer = nonDisplayed;
          continue;
        }
        if (isSvcCtrl && lo7 === RDC) {
          writeBuffer = displayed;
          continue;
        }

        const pac = _decodePacRowCol(hi7, lo7);
        if (pac) {
          setCursor(writeBuffer, pac.row, pac.col);
          continue;
        }
        continue;
      }

      if (hi7 >= 0x20) {
        const row = getCursorRow(writeBuffer);
        let col = getCursorCol(writeBuffer);
        col = writeCharAt(writeBuffer, row, col, _byteTo608Char(hi7));

        // SCC encoders commonly pad odd-length byte streams with 0x00 in the *second* byte
        // of the last word. That padding byte should not consume a cell.
        if (lo7 !== 0x00) {
          col = writeCharAt(writeBuffer, row, col, _byteTo608Char(lo7));
        }
        setCursor(writeBuffer, row, col);
      }
    }
  }

  if (cues.length && cues[cues.length - 1].end == null) {
    const start = cues[cues.length - 1].start;
    const tail = Math.max(1 / (Number(fps) || 30), 0.5);
    const base = (typeof lastEocSec === 'number') ? lastEocSec : start;
    cues[cues.length - 1].end = (typeof base === 'number' ? base + 2 : start + tail);
  }

  // Normalize SCC cues for editor:
  // - numeric start/end (seconds)
  // - sorted by start
  // - enforce monotonic start and non-zero duration
  cues.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const frame = 1 / (Number(fps) || 30);
  const minTail = Math.max(frame, 0.5);
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    let s = Number(cue.start);
    if (!Number.isFinite(s)) s = 0;
    let e = Number(cue.end);

    // If we don't have a usable end, or it's collapsed onto the start,
    // try to extend to the first *later* cue start; fall back to a small tail.
    if (!Number.isFinite(e) || e <= s) {
      let nextStart = NaN;
      for (let j = i + 1; j < cues.length; j++) {
        const ns = Number(cues[j].start);
        if (Number.isFinite(ns) && ns > s) {
          nextStart = ns;
          break;
        }
      }
      if (Number.isFinite(nextStart)) {
        e = nextStart;
      } else {
        e = s + minTail;
      }
    }

    // Keep starts monotonic to avoid overlaps in the editor.
    if (i > 0) {
      const prevEnd = Number(cues[i - 1].end);
      if (Number.isFinite(prevEnd) && s < prevEnd) {
        s = prevEnd;
        if (e <= s) e = s + minTail;
      }
    }

    cue.start = s;
    cue.end = e;
  }

  const dropFrameOut = !!dropFrame && isDropFrameRate(fps);
  const baseSecOut = (typeof timecodeBaseSec === 'number' && Number.isFinite(timecodeBaseSec))
    ? timecodeBaseSec
    : 0;
  const baseLabelOut =
    (typeof timecodeBaseLabel === 'string' && timecodeBaseLabel.trim())
      ? normalizeSccTimecodeDelimiter(timecodeBaseLabel, dropFrameOut)
      : null;

  return {
    cues,
    fps,
    dropFrame: dropFrameOut,
    timecodeBaseSec: baseSecOut,
    timecodeBaseLabel: baseLabelOut,
    timecodeMixed: !!det.mixed,
    captionService: captionService == null ? null : captionService,
    captionServiceMixed: !!captionServiceMixed,
    modelIssues,
    importWarnings,
    importErrors
  };
}

function decodeSccText(rawText, opts = {}) {
  const decoded = decodeScc(rawText, opts);

  // SCC timecodes are typically authored in "program time" (often starting at 01:00:00;00).
  // For editing/preview against 0-based media time, we can shift the decoded cues so that
  // the earliest SCC timecode becomes t=0. This mirrors decodeSccFile() behavior.
  const baseSec = (typeof decoded.timecodeBaseSec === 'number' && Number.isFinite(decoded.timecodeBaseSec))
    ? decoded.timecodeBaseSec
    : 0;
  const baseLabel = (typeof decoded.timecodeBaseLabel === 'string' && decoded.timecodeBaseLabel.trim())
    ? decoded.timecodeBaseLabel.trim()
    : null;

  const keepAbsoluteTimecode =
    opts.keepAbsoluteTimecode === true ||
    opts.shiftToZero === false;

  const shiftSec = (!keepAbsoluteTimecode && baseSec > 0) ? baseSec : 0;
  const startTc = (!keepAbsoluteTimecode && baseLabel) ? baseLabel : null;

  const cues = (decoded.cues || []).map((c, idx) => {
    const lines = Array.isArray(c.lines) && c.lines.length
      ? c.lines
      : String(c.text || '').split(/\r?\n/).slice(0, 2);
    return {
      id: c.id ?? idx,
      start: Math.max(0, (Number(c.start) || 0) - shiftSec),
      end: Math.max(0, (Number(c.end) || 0) - shiftSec),
      text: c.text,
      speaker: c.speaker || null,
      lines,
      sccPlacement: Array.isArray(c.sccPlacement) ? c.sccPlacement : null
    };
  });

  // If we imported an NDF SCC, allow round-trip export without forcing the user
  // through hidden feature flags. The file itself is the explicit request.
  const sccOptions = { ...(opts.sccOptions || {}) };
  if (decoded.dropFrame === false) sccOptions.allowNdf = true;
  // Preserve caption service on round-trip (CC1–CC4) when possible.
  if (sccOptions.channel == null || String(sccOptions.channel).trim() === '') {
    sccOptions.channel = decoded.captionService == null ? 1 : decoded.captionService;
  }
  if (decoded.captionServiceMixed) sccOptions.channelMixed = true;

  const sourcePath = opts.sourcePath || null;
  const displayName = opts.displayName || (sourcePath ? path.basename(sourcePath) : 'SCC');

  return {
    sourcePath,
    displayName,
    fps: decoded.fps,
    dropFrame: decoded.dropFrame,
    startTc,
    timecodeBaseSec: baseSec,
    timecodeBaseLabel: baseLabel,
    timecodeMixed: !!decoded.timecodeMixed,
    keepAbsoluteTimecode,
    mediaPath: opts.mediaPath || null,
    cues,
    sccOptions,
    modelIssues: decoded.modelIssues || [],
    importWarnings: decoded.importWarnings || [],
    importErrors: decoded.importErrors || []
  };
}

function decodeSccFile(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return decodeSccText(raw, {
    ...opts,
    sourcePath: filePath,
    displayName: path.basename(filePath)
  });
}

module.exports = {
  decodeScc,
  decodeSccText,
  decodeSccFile
};
