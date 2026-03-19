// modules/cea708Decoder.js
'use strict';

/**
 * Minimal-but-practical CEA-708 (DTVCC) decoder for MCC import + editor preview.
 *
 * Scope:
 *  - Reassemble DTVCC packets from raw dtvcc bytes (cc_type 2/3 payload)
 *  - Parse service blocks (incl. extended service numbers)
 *  - Decode a useful subset of C0/C1 commands:
 *      CW0-7, CLW, DSW, HDW, DLW, RST,
 *      DF0-DF7, SWA, SPL,
 *      CR, BS, ETX, plus basic G0 ASCII text
 *  - Track window state + text buffers
 *  - Produce "composite" cues: one cue per on-screen state (set of visible windows)
 *
 * This is intentionally conservative: it focuses on windowed pop-on style captions
 * (what our encoder emits) and common real-world MCCs. Unsupported bytes are ignored
 * with warnings; decoding continues.
 */

function _clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function _makeGrid(rows, cols) {
  const r = Math.max(1, rows | 0);
  const c = Math.max(1, cols | 0);
  const grid = new Array(r);
  for (let i = 0; i < r; i++) {
    const row = new Array(c);
    for (let j = 0; j < c; j++) row[j] = ' ';
    grid[i] = row;
  }
  return grid;
}

function _makeStyleGrid(rows, cols) {
  // Per-cell pen styling snapshot.
  // Bitmask values:
  //   0x01 = italic
  //   0x02 = underline
  const r = Math.max(1, rows | 0);
  const c = Math.max(1, cols | 0);
  const grid = new Array(r);
  for (let i = 0; i < r; i++) {
    const row = new Array(c);
    for (let j = 0; j < c; j++) row[j] = 0;
    grid[i] = row;
  }
  return grid;
}

function _makeByteGrid(rows, cols, fill = 0) {
  const r = Math.max(1, rows | 0);
  const c = Math.max(1, cols | 0);
  const v = (Number(fill) & 0xff) >>> 0;
  const grid = new Array(r);
  for (let i = 0; i < r; i++) {
    const row = new Array(c);
    for (let j = 0; j < c; j++) row[j] = v;
    grid[i] = row;
  }
  return grid;
}

function _makeNibbleGrid(rows, cols, fill = 0) {
  const r = Math.max(1, rows | 0);
  const c = Math.max(1, cols | 0);
  const v = (Number(fill) & 0x0f) >>> 0;
  const grid = new Array(r);
  for (let i = 0; i < r; i++) {
    const row = new Array(c);
    for (let j = 0; j < c; j++) row[j] = v;
    grid[i] = row;
  }
  return grid;
}

function _decode708ColorByte(byteVal) {
  const b = Number(byteVal) & 0xff;
  return {
    opacity: (b >> 6) & 0x03,
    r: (b >> 4) & 0x03,
    g: (b >> 2) & 0x03,
    b: b & 0x03,
    raw: b
  };
}

// CTA-708 defaults (good interop baseline; aligns with our encoder defaults).
// Foreground: solid white; Background: transparent black; Edge: black.
const DEFAULT_PEN_FG = 0x3F; // 00 11 11 11
const DEFAULT_PEN_BG = 0xC0; // 11 00 00 00
const DEFAULT_PEN_EDGE = 0x00;
const DEFAULT_EDGE_TYPE = 0;

function _ensureGrid(win) {
  const rows = _clampInt(win.rowCount, 1, 15, 15);
  const cols = _clampInt(win.colCount, 1, 63, 42);
  if (!win.grid || win.grid.length !== rows || (win.grid[0] && win.grid[0].length !== cols)) {
    win.grid = _makeGrid(rows, cols);
  }
  if (!win.styleGrid || win.styleGrid.length !== rows || (win.styleGrid[0] && win.styleGrid[0].length !== cols)) {
    win.styleGrid = _makeStyleGrid(rows, cols);
  }

  // Per-cell color/edge snapshots (SPC + SPA edgeType). These are used for
  // accurate preview and round-tripping.
  if (!win.fgGrid || win.fgGrid.length !== rows || (win.fgGrid[0] && win.fgGrid[0].length !== cols)) {
    win.fgGrid = _makeByteGrid(rows, cols, DEFAULT_PEN_FG);
  }
  if (!win.bgGrid || win.bgGrid.length !== rows || (win.bgGrid[0] && win.bgGrid[0].length !== cols)) {
    win.bgGrid = _makeByteGrid(rows, cols, DEFAULT_PEN_BG);
  }
  if (!win.edgeGrid || win.edgeGrid.length !== rows || (win.edgeGrid[0] && win.edgeGrid[0].length !== cols)) {
    win.edgeGrid = _makeByteGrid(rows, cols, DEFAULT_PEN_EDGE);
  }
  if (!win.edgeTypeGrid || win.edgeTypeGrid.length !== rows || (win.edgeTypeGrid[0] && win.edgeTypeGrid[0].length !== cols)) {
    win.edgeTypeGrid = _makeNibbleGrid(rows, cols, DEFAULT_EDGE_TYPE);
  }
}

function _clearWindow(win) {
  win.defined = win.defined !== false;
  win.visible = !!win.visible;
  win.penRow = 0;
  win.penCol = 0;
  win.hasSPL = false;
  _ensureGrid(win);
  for (let r = 0; r < win.grid.length; r++) {
    for (let c = 0; c < win.grid[r].length; c++) win.grid[r][c] = ' ';
  }
  for (let r = 0; r < win.styleGrid.length; r++) {
    for (let c = 0; c < win.styleGrid[r].length; c++) win.styleGrid[r][c] = 0;
  }

  // Clear per-cell pen colors/edge.
  for (let r = 0; r < win.fgGrid.length; r++) {
    for (let c = 0; c < win.fgGrid[r].length; c++) win.fgGrid[r][c] = DEFAULT_PEN_FG;
  }
  for (let r = 0; r < win.bgGrid.length; r++) {
    for (let c = 0; c < win.bgGrid[r].length; c++) win.bgGrid[r][c] = DEFAULT_PEN_BG;
  }
  for (let r = 0; r < win.edgeGrid.length; r++) {
    for (let c = 0; c < win.edgeGrid[r].length; c++) win.edgeGrid[r][c] = DEFAULT_PEN_EDGE;
  }
  for (let r = 0; r < win.edgeTypeGrid.length; r++) {
    for (let c = 0; c < win.edgeTypeGrid[r].length; c++) win.edgeTypeGrid[r][c] = DEFAULT_EDGE_TYPE;
  }
}

function _defaultWindow() {
  return {
    defined: false,
    visible: false,
    priority: 0,
    rowLock: 1,
    colLock: 1,
    windowStyleId: 1,
    penStyleId: 1,
    relative: true,
    anchorV: 90,
    anchorH: 50,
    anchorId: 7, // LOWER_CENTER
    rowCount: 15,
    colCount: 42,
    justify: 'left',
    // SetWindowAttributes (SWA) decoded state.
    windowStyle: {
      fillOpacity: 3,
      fillColor: { r: 0, g: 0, b: 0 },
      borderType: 0,
      borderColor: { r: 0, g: 0, b: 0 },
      wordWrap: false,
      printDirection: 0,
      scrollDirection: 2,
      effectDirection: 0,
      displayEffect: 0,
      effectSpeed: 0
    },
    penRow: 0,
    penCol: 0,
    penItalic: false,
    penUnderline: false,
    // SetPenColor (SPC) decoded state (8-bit packed color bytes).
    penFg: DEFAULT_PEN_FG,
    penBg: DEFAULT_PEN_BG,
    // Edge color is 6-bit in-spec (top two bits should be 0), but we keep a byte for convenience.
    penEdge: DEFAULT_PEN_EDGE,
    // SetPenAttributes (SPA) edge type + edge color (6-bit).
    penEdgeType: DEFAULT_EDGE_TYPE,
    penEdgeColor: 0,
    // True when the stream uses explicit SetPenLocation (SPL) to place text.
    // In this mode, the *grid coordinates* matter for preview (torture tests).
    hasSPL: false,
    grid: _makeGrid(15, 42),
    styleGrid: _makeStyleGrid(15, 42),
    fgGrid: _makeByteGrid(15, 42, DEFAULT_PEN_FG),
    bgGrid: _makeByteGrid(15, 42, DEFAULT_PEN_BG),
    edgeGrid: _makeByteGrid(15, 42, DEFAULT_PEN_EDGE),
    edgeTypeGrid: _makeNibbleGrid(15, 42, DEFAULT_EDGE_TYPE)
  };
}

function _justifyFromBits(j) {
  switch (j & 0x03) {
    // CTA-708 SWA justify mapping (LTR): LEFT=0, RIGHT=1, CENTER=2, FULL=3
    // (Our encoder follows this mapping via buildSWA.)
    case 1: return 'right';
    case 2: return 'center';
    case 3: return 'full';
    default: return 'left';
  }
}

function _windowLines(win) {
  _ensureGrid(win);
  const rows = Math.max(1, Math.min(15, win.rowCount | 0));
  const out = [];
  for (let r = 0; r < Math.min(rows, win.grid.length); r++) {
    const s = win.grid[r].join('').replace(/\s+$/g, '');
    out.push(s);
  }
  // Trim leading/trailing empty rows (keep internal empties)
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

// Trimmed lines with per-character style (italics/underline) preserved.
// Returns: { lines: string[], lineStyles: string[] }
// Each entry in lineStyles is a compact digit string (same length as the
// corresponding line), where each digit is a bitmask:
//   0=normal, 1=italic, 2=underline, 3=italic+underline
function _windowLinesWithStyles(win) {
  _ensureGrid(win);
  const rows = Math.max(1, Math.min(15, win.rowCount | 0));
  const rowCount = Math.min(rows, win.grid.length);

  const texts = [];
  for (let r = 0; r < rowCount; r++) {
    const s = win.grid[r].join('').replace(/\s+$/g, '');
    texts.push(s);
  }

  // Identify the first and last non-empty rows (by visible text).
  let first = 0;
  let last = texts.length - 1;
  while (first < texts.length && !String(texts[first] || '').trim()) first++;
  while (last >= first && !String(texts[last] || '').trim()) last--;

  if (first >= texts.length || last < first) {
    return { lines: [], lineStyles: [] };
  }

  const lines = [];
  const lineStyles = [];
  for (let r = first; r <= last; r++) {
    const line = String(texts[r] || '');
    lines.push(line);
    const stRow = (win.styleGrid && win.styleGrid[r]) ? win.styleGrid[r] : [];
    const digits = [];
    for (let c = 0; c < line.length; c++) {
      const v = (stRow && typeof stRow[c] === 'number') ? (stRow[c] & 0x03) : 0;
      digits.push(String(v));
    }
    lineStyles.push(digits.join(''));
  }
  return { lines, lineStyles };
}

// Same as _windowLinesWithStyles(), but also returns per-character pen colors and
// edge type for each visible character.
//
// Returns:
//   {
//     lines: string[], lineStyles: string[],
//     lineFg: number[][], lineBg: number[][], lineEdge: number[][],
//     lineEdgeType: number[][]
//   }
function _windowLinesWithStylesAndColors(win) {
  _ensureGrid(win);
  const rows = Math.max(1, Math.min(15, win.rowCount | 0));
  const rowCount = Math.min(rows, win.grid.length);

  const texts = [];
  for (let r = 0; r < rowCount; r++) {
    const s = win.grid[r].join('').replace(/\s+$/g, '');
    texts.push(s);
  }

  let first = 0;
  let last = texts.length - 1;
  while (first < texts.length && !String(texts[first] || '').trim()) first++;
  while (last >= first && !String(texts[last] || '').trim()) last--;

  if (first >= texts.length || last < first) {
    return { lines: [], lineStyles: [], lineFg: [], lineBg: [], lineEdge: [], lineEdgeType: [] };
  }

  const lines = [];
  const lineStyles = [];
  const lineFg = [];
  const lineBg = [];
  const lineEdge = [];
  const lineEdgeType = [];

  for (let r = first; r <= last; r++) {
    const s = String(texts[r] || '');
    const len = s.length;
    let styleRow = '';
    const fgRow = new Array(len);
    const bgRow = new Array(len);
    const edgeRow = new Array(len);
    const edgeTypeRow = new Array(len);

    for (let c = 0; c < len; c++) {
      const bits = (win.styleGrid && win.styleGrid[r] && win.styleGrid[r][c]) ? (win.styleGrid[r][c] | 0) : 0;
      styleRow += String.fromCharCode(48 + (bits & 3));
      fgRow[c] = (win.fgGrid && win.fgGrid[r] && win.fgGrid[r][c] != null) ? (win.fgGrid[r][c] & 0xff) : DEFAULT_PEN_FG;
      bgRow[c] = (win.bgGrid && win.bgGrid[r] && win.bgGrid[r][c] != null) ? (win.bgGrid[r][c] & 0xff) : DEFAULT_PEN_BG;
      edgeRow[c] = (win.edgeGrid && win.edgeGrid[r] && win.edgeGrid[r][c] != null) ? (win.edgeGrid[r][c] & 0xff) : DEFAULT_PEN_EDGE;
      edgeTypeRow[c] = (win.edgeTypeGrid && win.edgeTypeGrid[r] && win.edgeTypeGrid[r][c] != null)
        ? (win.edgeTypeGrid[r][c] & 0x0f)
        : DEFAULT_EDGE_TYPE;
    }

    lines.push(s);
    lineStyles.push(styleRow);
    lineFg.push(fgRow);
    lineBg.push(bgRow);
    lineEdge.push(edgeRow);
    lineEdgeType.push(edgeTypeRow);
  }

  return { lines, lineStyles, lineFg, lineBg, lineEdge, lineEdgeType };
}

// Full-grid snapshot that preserves vertical offsets (leading empty rows).
// This is critical for accurate 708 preview (torture tests placing text at top/bottom rows).
function _windowGridLines(win) {
  _ensureGrid(win);
  const rows = Math.max(1, Math.min(15, win.rowCount | 0));
  const cols = Math.max(1, Math.min(63, win.colCount | 0));
  const out = [];
  for (let r = 0; r < Math.min(rows, win.grid.length); r++) {
    const row = win.grid[r] || [];
    const s = row.slice(0, cols).join('').replace(/\s+$/g, '');
    out.push(s);
  }
  // Ensure stable rowCount length (preserves leading empties as explicit blank lines).
  while (out.length < rows) out.push('');
  return out;
}

function _windowGridStyleLines(win) {
  _ensureGrid(win);
  const rows = Math.max(1, Math.min(15, win.rowCount | 0));
  const cols = Math.max(1, Math.min(63, win.colCount | 0));
  const out = [];
  for (let r = 0; r < Math.min(rows, win.grid.length); r++) {
    const row = win.grid[r] || [];
    const s = row.slice(0, cols).join('').replace(/\s+$/g, '');
    const len = s.length;
    const stRow = (win.styleGrid && win.styleGrid[r]) ? win.styleGrid[r] : [];
    const digits = [];
    for (let c = 0; c < len; c++) {
      const v = (stRow && typeof stRow[c] === 'number') ? (stRow[c] & 0x03) : 0;
      digits.push(String(v));
    }
    out.push(digits.join(''));
  }
  while (out.length < rows) out.push('');
  return out;
}

function _windowGridByteRows(win, gridLines, field, fillDefault = 0, mask = 0xff) {
  _ensureGrid(win);
  const rows = Math.max(1, Math.min(15, win.rowCount | 0));
  const out = [];
  for (let r = 0; r < rows; r++) {
    const s = String(gridLines && gridLines[r] != null ? gridLines[r] : '');
    const len = s.length;
    const srcRow = (win && win[field] && win[field][r]) ? win[field][r] : null;
    const row = new Array(len);
    for (let c = 0; c < len; c++) {
      const v = (srcRow && srcRow[c] != null) ? (srcRow[c] & mask) : (fillDefault & mask);
      row[c] = v;
    }
    out.push(row);
  }
  while (out.length < rows) out.push([]);
  return out;
}

function _dominantPenFromGrid(win) {
  // Derive a "dominant" pen style/color for this window snapshot.
  // This is used as a reasonable per-window base when re-encoding.
  _ensureGrid(win);

  const counts = {
    fg: new Map(),
    bg: new Map(),
    edge: new Map(),
    edgeType: new Map()
  };

  const add = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const rows = Math.max(1, Math.min(15, win.rowCount | 0));
  const cols = Math.max(1, Math.min(63, win.colCount | 0));

  for (let r = 0; r < Math.min(rows, win.grid.length); r++) {
    for (let c = 0; c < Math.min(cols, win.grid[r].length); c++) {
      const ch = win.grid[r][c];
      if (ch === ' ' || ch == null) continue;
      add(counts.fg, (win.fgGrid && win.fgGrid[r] && win.fgGrid[r][c] != null) ? (win.fgGrid[r][c] & 0xff) : DEFAULT_PEN_FG);
      add(counts.bg, (win.bgGrid && win.bgGrid[r] && win.bgGrid[r][c] != null) ? (win.bgGrid[r][c] & 0xff) : DEFAULT_PEN_BG);
      add(counts.edge, (win.edgeGrid && win.edgeGrid[r] && win.edgeGrid[r][c] != null) ? (win.edgeGrid[r][c] & 0xff) : DEFAULT_PEN_EDGE);
      add(counts.edgeType, (win.edgeTypeGrid && win.edgeTypeGrid[r] && win.edgeTypeGrid[r][c] != null) ? (win.edgeTypeGrid[r][c] & 0x0f) : DEFAULT_EDGE_TYPE);
    }
  }

  const pick = (map, fallback) => {
    let bestK = fallback;
    let bestN = -1;
    for (const [k, n] of map.entries()) {
      if (n > bestN) {
        bestN = n;
        bestK = k;
      }
    }
    return bestK;
  };

  const fgByte = pick(counts.fg, win.penFg != null ? (win.penFg & 0xff) : DEFAULT_PEN_FG);
  const bgByte = pick(counts.bg, win.penBg != null ? (win.penBg & 0xff) : DEFAULT_PEN_BG);
  const edgeByte = pick(counts.edge, win.penEdge != null ? (win.penEdge & 0xff) : DEFAULT_PEN_EDGE);
  const edgeType = pick(counts.edgeType, win.penEdgeType != null ? (win.penEdgeType & 0x0f) : DEFAULT_EDGE_TYPE);

  return {
    pen: {
      edgeType,
      edgeColor: (edgeByte & 0x3f)
    },
    penColor: {
      foreground: _decode708ColorByte(fgByte),
      background: _decode708ColorByte(bgByte),
      edge: {
        ..._decode708ColorByte(edgeByte),
        // Edge opacity shares with foreground (CTA-708); keep raw anyway.
        opacity: ((fgByte >> 6) & 0x03)
      }
    }
  };
}

function _snapshotVisibleWindows(state) {
  const wins = [];
  for (let id = 0; id < 8; id++) {
    const w = state.windows[id];
    if (!w || !w.visible) continue;
    // Use full-grid lines to preserve row offsets for keying and preview.
    const grid = _windowGridLines(w);
    const hasText = grid.some(r => String(r || '').trim().length > 0);
    if (!hasText) continue;

    const { lines, lineStyles, lineFg, lineBg, lineEdge, lineEdgeType } = _windowLinesWithStylesAndColors(w);
    const gridStyles = _windowGridStyleLines(w);
    const gridFg = _windowGridByteRows(w, grid, 'fgGrid', DEFAULT_PEN_FG, 0xff);
    const gridBg = _windowGridByteRows(w, grid, 'bgGrid', DEFAULT_PEN_BG, 0xff);
    const gridEdge = _windowGridByteRows(w, grid, 'edgeGrid', DEFAULT_PEN_EDGE, 0xff);
    const gridEdgeType = _windowGridByteRows(w, grid, 'edgeTypeGrid', DEFAULT_EDGE_TYPE, 0x0f);

    const dominantPen = _dominantPenFromGrid(w);

    wins.push({
      id,
      priority: w.priority | 0,
      rowLock: w.rowLock | 0,
      colLock: w.colLock | 0,
      windowStyleId: w.windowStyleId | 0,
      penStyleId: w.penStyleId | 0,
      relative: !!w.relative,
      anchorV: w.anchorV | 0,
      anchorH: w.anchorH | 0,
      anchorId: w.anchorId | 0,
      rowCount: w.rowCount | 0,
      colCount: w.colCount | 0,
      justify: w.justify || 'left',
      windowStyle: (w.windowStyle && typeof w.windowStyle === 'object') ? { ...w.windowStyle } : null,
      hasSPL: !!w.hasSPL,
      grid,
      gridStyles,
      gridFg,
      gridBg,
      gridEdge,
      gridEdgeType,
      lines,
      lineStyles,
      lineFg,
      lineBg,
      lineEdge,
      lineEdgeType,
      dominantPen
    });
  }
  wins.sort((a, b) => (a.priority - b.priority) || (a.id - b.id));

  const _gridKey = (gridRows) => {
    if (!Array.isArray(gridRows)) return '';
    return gridRows.map(row => Array.isArray(row) ? row.join(',') : '').join(';');
  };

  const key = wins.map(w => {
    return [
      w.id,
      w.priority,
      w.rowLock,
      w.colLock,
      w.windowStyleId,
      w.penStyleId,
      w.relative ? 1 : 0,
      w.anchorV, w.anchorH, w.anchorId,
      w.rowCount, w.colCount,
      w.justify,
      // Window-level styling
      (w.windowStyle && typeof w.windowStyle === 'object') ? JSON.stringify(w.windowStyle) : '',
      // Key on full grid snapshot so SPL-based placement changes create a new cue.
      w.grid.join('\\n'),
      // Key on per-cell pen styling + colors so "same characters, different style" creates distinct cues.
      Array.isArray(w.gridStyles) ? w.gridStyles.join('\\n') : '',
      _gridKey(w.gridFg),
      _gridKey(w.gridBg),
      _gridKey(w.gridEdge),
      _gridKey(w.gridEdgeType)
    ].join('|');
  }).join('||');
  return { windows: wins, key };
}

function _combineWindowsText(windows) {
  if (!Array.isArray(windows) || !windows.length) return { text: '', lines: [] };
  const _stackFor = (bits) => {
    const b = (bits | 0) & 0x03;
    if (b === 3) return ['i', 'u'];
    if (b === 1) return ['i'];
    if (b === 2) return ['u'];
    return [];
  };

  const _applyLineStyles = (line, styleDigits) => {
    const text = String(line ?? '');
    const st = String(styleDigits ?? '');
    let out = '';
    let prev = [];
    for (let i = 0; i < text.length; i++) {
      const code = (i < st.length) ? (st.charCodeAt(i) - 48) : 0;
      const bits = (code >= 0 && code <= 3) ? code : 0;
      const next = _stackFor(bits);

      // Longest common prefix (to preserve proper nesting and minimize tags).
      let common = 0;
      while (common < prev.length && common < next.length && prev[common] === next[common]) common++;
      for (let j = prev.length - 1; j >= common; j--) out += `</${prev[j]}>`;
      for (let j = common; j < next.length; j++) out += `<${next[j]}>`;

      prev = next;
      out += text[i];
    }
    for (let j = prev.length - 1; j >= 0; j--) out += `</${prev[j]}>`;
    return out;
  };

  const blocksPlain = [];
  const blocksRich = [];
  for (const w of windows) {
    const lines = Array.isArray(w?.lines) ? w.lines.map(v => String(v ?? '')) : [];
    if (!lines.length) continue;
    blocksPlain.push(lines.join('\n'));
    const styles = Array.isArray(w?.lineStyles) ? w.lineStyles : [];
    const richLines = lines.map((ln, idx) => _applyLineStyles(ln, styles[idx] || ''));
    blocksRich.push(richLines.join('\n'));
  }
  const textPlain = blocksPlain.filter(Boolean).join('\n\n');
  const textRich = blocksRich.filter(Boolean).join('\n\n');
  return {
    text: textRich,
    lines: textRich.split(/\n/g),
    textPlain,
    linesPlain: textPlain.split(/\n/g)
  };
}

function _parseServiceBlocks(payloadBytes, seenServices) {
  const blocks = [];
  let i = 0;
  const len = payloadBytes.length | 0;
  while (i < len) {
    const sbHdr = payloadBytes[i++] & 0xff;
    if (sbHdr === 0x00) continue; // padding
    let service = (sbHdr & 0xE0) >> 5;
    const blockLen = (sbHdr & 0x1F);
    if (service === 0) {
      // service 0 is reserved; skip but still advance by blockLen
      i += blockLen;
      continue;
    }
    if (service === 7) {
      if (i >= len) break;
      const ext = payloadBytes[i++] & 0xff;
      service = 7 + (ext & 0x3F);
    }
    if (service >= 1 && service <= 63) seenServices.add(service);
    const end = Math.min(len, i + blockLen);
    const data = payloadBytes.slice(i, end);
    i = end;
    blocks.push({ service, data });
  }
  return blocks;
}

function _feedDtvccReassembler(rs, bytes) {
  if (!bytes || !bytes.length) return [];
  for (let i = 0; i < bytes.length; i++) rs.buf.push(bytes[i] & 0xff);

  const packets = [];
  // Drop padding zeros between packets (common)
  while (rs.cursor < rs.buf.length && rs.buf[rs.cursor] === 0x00) rs.cursor++;

  while (rs.cursor < rs.buf.length) {
    const hdr = rs.buf[rs.cursor] & 0xff;
    const pktSize = hdr & 0x3F;
    if (pktSize === 0) {
      rs.cursor++;
      while (rs.cursor < rs.buf.length && rs.buf[rs.cursor] === 0x00) rs.cursor++;
      continue;
    }
    const need = 1 + pktSize;
    if ((rs.buf.length - rs.cursor) < need) break;
    const pkt = rs.buf.slice(rs.cursor, rs.cursor + need);
    rs.cursor += need;
    while (rs.cursor < rs.buf.length && rs.buf[rs.cursor] === 0x00) rs.cursor++;
    packets.push(pkt);
  }

  // Trim consumed bytes occasionally
  if (rs.cursor > 4096) {
    rs.buf = rs.buf.slice(rs.cursor);
    rs.cursor = 0;
  }
  return packets;
}

function _ensureWindow(state, id) {
  if (!state.windows[id]) state.windows[id] = _defaultWindow();
  return state.windows[id];
}

function _putChar(win, ch) {
  _ensureGrid(win);
  const rows = win.grid.length;
  const cols = win.grid[0] ? win.grid[0].length : 0;
  const r = Math.max(0, Math.min(rows - 1, win.penRow | 0));
  const c = Math.max(0, Math.min(cols - 1, win.penCol | 0));
  win.grid[r][c] = ch;
  // Snapshot the current pen styling into the cell so we can round-trip italics/
  // underline and render accurate previews.
  const ital = win.penItalic ? 1 : 0;
  const und = win.penUnderline ? 2 : 0;
  if (win.styleGrid && win.styleGrid[r] && typeof win.styleGrid[r][c] === 'number') {
    win.styleGrid[r][c] = (ital | und) & 0x03;
  }

  // Snapshot per-cell pen colors + edge type so we can preview and round-trip.
  if (win.fgGrid && win.fgGrid[r] && win.fgGrid[r][c] != null) win.fgGrid[r][c] = (win.penFg & 0xff);
  if (win.bgGrid && win.bgGrid[r] && win.bgGrid[r][c] != null) win.bgGrid[r][c] = (win.penBg & 0xff);
  // Edge color is 6-bit in-spec (top 2 bits should be 0), but keep a byte for simplicity.
  if (win.edgeGrid && win.edgeGrid[r] && win.edgeGrid[r][c] != null) win.edgeGrid[r][c] = (win.penEdge & 0xff);
  if (win.edgeTypeGrid && win.edgeTypeGrid[r] && win.edgeTypeGrid[r][c] != null) win.edgeTypeGrid[r][c] = (win.penEdgeType & 0x0f);
  win.penCol = Math.min(cols, (win.penCol | 0) + 1);
}

function _newline(win) {
  _ensureGrid(win);
  const rows = win.grid.length;
  win.penRow = Math.min(rows - 1, (win.penRow | 0) + 1);
  win.penCol = 0;
}

function _backspace(win) {
  _ensureGrid(win);
  const cols = win.grid[0] ? win.grid[0].length : 0;
  if ((win.penCol | 0) > 0) win.penCol = (win.penCol | 0) - 1;
  const r = Math.max(0, Math.min(win.grid.length - 1, win.penRow | 0));
  const c = Math.max(0, Math.min(cols - 1, win.penCol | 0));
  win.grid[r][c] = ' ';
  if (win.styleGrid && win.styleGrid[r] && typeof win.styleGrid[r][c] === 'number') {
    win.styleGrid[r][c] = 0;
  }

  if (win.fgGrid && win.fgGrid[r] && win.fgGrid[r][c] != null) win.fgGrid[r][c] = DEFAULT_PEN_FG;
  if (win.bgGrid && win.bgGrid[r] && win.bgGrid[r][c] != null) win.bgGrid[r][c] = DEFAULT_PEN_BG;
  if (win.edgeGrid && win.edgeGrid[r] && win.edgeGrid[r][c] != null) win.edgeGrid[r][c] = DEFAULT_PEN_EDGE;
  if (win.edgeTypeGrid && win.edgeTypeGrid[r] && win.edgeTypeGrid[r][c] != null) win.edgeTypeGrid[r][c] = DEFAULT_EDGE_TYPE;
}

function _decodeServiceBytes(bytes, state, warnings) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++] & 0xff;

    // C0 controls
    if (b <= 0x1F) {
      if (b === 0x03) { // ETX
        // no-op for our cue model
      } else if (b === 0x0D) { // CR
        _newline(_ensureWindow(state, state.curWin));
      } else if (b === 0x08) { // BS
        _backspace(_ensureWindow(state, state.curWin));
      } else if (b === 0x0C) { // FF (treat as clear current window)
        _clearWindow(_ensureWindow(state, state.curWin));
      }
      continue;
    }

    // G0 (printable ASCII) + music note at 0x7F
    if (b >= 0x20 && b <= 0x7F) {
      const ch = (b === 0x7F) ? '♪' : String.fromCharCode(b);
      _putChar(_ensureWindow(state, state.curWin), ch);
      continue;
    }

    // G1 (Latin-1 supplement, 0xA0..0xFF)
    if (b >= 0xA0 && b <= 0xFF) {
      const ch = (b === 0xA0) ? ' ' : String.fromCharCode(b);
      _putChar(_ensureWindow(state, state.curWin), ch);
      continue;
    }

    // C1 commands / window ops
    if (b >= 0x80 && b <= 0x87) { // CW0..CW7
      state.curWin = b - 0x80;
      _ensureWindow(state, state.curWin);
      continue;
    }

    if (b === 0x88) { // CLW mask
      const mask = (bytes[i++] ?? 0) & 0xff;
      for (let w = 0; w < 8; w++) {
        if (mask & (1 << w)) _clearWindow(_ensureWindow(state, w));
      }
      continue;
    }

    if (b === 0x89) { // DSW mask
      const mask = (bytes[i++] ?? 0) & 0xff;
      for (let w = 0; w < 8; w++) {
        if (mask & (1 << w)) _ensureWindow(state, w).visible = true;
      }
      continue;
    }

    if (b === 0x8A) { // HDW mask
      const mask = (bytes[i++] ?? 0) & 0xff;
      for (let w = 0; w < 8; w++) {
        if (mask & (1 << w)) _ensureWindow(state, w).visible = false;
      }
      continue;
    }

    if (b === 0x8B) { // TGW mask (toggle windows)
      const mask = (bytes[i++] ?? 0) & 0xff;
      for (let w = 0; w < 8; w++) {
        if (mask & (1 << w)) {
          const win = _ensureWindow(state, w);
          win.visible = !win.visible;
        }
      }
      continue;
    }

    if (b === 0x8C) { // DLW mask
      const mask = (bytes[i++] ?? 0) & 0xff;
      for (let w = 0; w < 8; w++) {
        if (mask & (1 << w)) state.windows[w] = _defaultWindow();
      }
      continue;
    }

    if (b === 0x8F) { // RST
      state.curWin = 0;
      state.windows = new Array(8).fill(null);
      continue;
    }

    if (b === 0x92) { // SPL row, col
      const row = (bytes[i++] ?? 0) & 0xff;
      const col = (bytes[i++] ?? 0) & 0xff;
      const win = _ensureWindow(state, state.curWin);
      win.penRow = _clampInt(row, 0, 14, 0);
      win.penCol = _clampInt(col, 0, 62, 0);
      win.hasSPL = true;
      continue;
    }

    if (b === 0x97) { // SWA (4 bytes)
      const b1 = (bytes[i++] ?? 0) & 0xff;
      const b2 = (bytes[i++] ?? 0) & 0xff;
      const b3 = (bytes[i++] ?? 0) & 0xff;
      const b4 = (bytes[i++] ?? 0) & 0xff;
      // CTA-708 SWA layout (see cea708Encoder.buildSWA):
      //  b1: FOP + fill color
      //  b2: BTP (lower 2 bits) + border color
      //  b3: wordwrap + BTP high bit + print dir + scroll dir + justify
      //  b4: effect speed/dir/type
      const win = _ensureWindow(state, state.curWin);

      const fillOpacity = (b1 >> 6) & 0x03;
      const fillColor = { r: (b1 >> 4) & 0x03, g: (b1 >> 2) & 0x03, b: b1 & 0x03 };

      const borderTypeLow = (b2 >> 6) & 0x03;
      const borderColor = { r: (b2 >> 4) & 0x03, g: (b2 >> 2) & 0x03, b: b2 & 0x03 };
      const wordWrap = ((b3 >> 7) & 0x01) === 1;
      const borderTypeHigh = (b3 >> 6) & 0x01;
      const borderType = ((borderTypeHigh << 2) | borderTypeLow) & 0x07;
      const printDirection = (b3 >> 4) & 0x03;
      const scrollDirection = (b3 >> 2) & 0x03;
      const justifyBits = b3 & 0x03;
      const effectSpeed = (b4 >> 6) & 0x03;
      const effectDirection = (b4 >> 4) & 0x03;
      const displayEffect = (b4 >> 2) & 0x03;

      win.justify = _justifyFromBits(justifyBits);
      win.windowStyle = {
        fillOpacity,
        fillColor,
        borderType,
        borderColor,
        wordWrap,
        printDirection,
        scrollDirection,
        effectDirection,
        displayEffect,
        effectSpeed
      };
      continue;
    }

    if (b >= 0x98 && b <= 0x9F) { // DF0..DF7 (6 bytes)
      const winId = b - 0x98;
      const p1 = (bytes[i++] ?? 0) & 0xff;
      const p2 = (bytes[i++] ?? 0) & 0xff;
      const p3 = (bytes[i++] ?? 0) & 0xff;
      const p4 = (bytes[i++] ?? 0) & 0xff;
      const p5 = (bytes[i++] ?? 0) & 0xff;
      const p6 = (bytes[i++] ?? 0) & 0xff;
      const win = _ensureWindow(state, winId);
      win.defined = true;
      // DefineWindow is not a toggle; it *sets* the window state.
      // Some streams always set V=0 and then use DSW/HDW to control visibility.
      // We still honor the bit as-is for correctness.
      win.visible = (((p1 >> 5) & 0x01) === 1);
      win.rowLock = (p1 >> 4) & 0x01;
      win.colLock = (p1 >> 3) & 0x01;
      win.priority = (p1 & 0x07) | 0;
      win.relative = (((p2 >> 7) & 0x01) === 1);
      win.anchorV = p2 & 0x7F;
      win.anchorH = p3 & 0xFF;
      win.anchorId = (p4 >> 4) & 0x0F;
      win.rowCount = ((p4 & 0x0F) + 1);
      {
        const cc = (p5 & 0x3F) | 0;
        win.colCount = cc > 0 ? cc : 1;
      }
      // Redefining a window resets the "explicit pen positioning" assumption.
      win.hasSPL = false;
      _ensureGrid(win);
      // p6: window style + pen style indices
      win.windowStyleId = (p6 >> 3) & 0x07;
      win.penStyleId = p6 & 0x07;
      continue;
    }

    // Common pen commands
    // IMPORTANT: Command payload lengths differ:
    //   0x90 SPA (SetPenAttributes) = 3 bytes
    //   0x91 SPC (SetPenColor)      = 3 bytes
    // Skipping the wrong length will desync parsing and can drop the first printable
    // character that follows the command sequence.
    if (b === 0x90) { // SPA
      const _p1 = (bytes[i++] ?? 0) & 0xff;
      const p2 = (bytes[i++] ?? 0) & 0xff;
      const p3 = (bytes[i++] ?? 0) & 0xff;
      const win = _ensureWindow(state, state.curWin);
      // CTA-708: underline is bit 1, italics is bit 0 of SPA byte 2.
      win.penUnderline = (((p2 >> 1) & 0x01) === 1);
      win.penItalic = ((p2 & 0x01) === 1);
      // Edge type is bits 4..2 of SPA byte 2.
      win.penEdgeType = (p2 >> 2) & 0x07;
      // Edge color is 6-bit in SPA byte 3.
      win.penEdgeColor = p3 & 0x3F;
      // p1 carries size/offset/text tag; we currently ignore.
      continue;
    }
    if (b === 0x91) { // SPC
      const p1 = (bytes[i++] ?? 0) & 0xff;
      const p2 = (bytes[i++] ?? 0) & 0xff;
      const p3 = (bytes[i++] ?? 0) & 0xff;
      const win = _ensureWindow(state, state.curWin);
      win.penFg = p1;
      win.penBg = p2;
      win.penEdge = p3;
      // Keep SPA and SPC edge-color views roughly consistent.
      win.penEdgeColor = (p3 & 0x3F);
      continue;
    }

    // Unknown / unsupported
    if (warnings && warnings.length < 50) {
      warnings.push(`Unsupported CEA-708 byte 0x${b.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  }
}

function decodeDtvccFramesToCues(dtvccFrames, opts = {}) {
  const fps = Number(opts.fps) || 29.97;

  const _normalizeServiceRequest = (o) => {
    // Supported inputs:
    //  - opts.serviceNumber: number (1..63)
    //  - opts.serviceNumber: 'all' (decode every service encountered)
    //  - opts.serviceNumbers: number[] (decode these services)
    //  - opts.allServices: true (alias for serviceNumber='all')
    const rawSvc = (o && Object.prototype.hasOwnProperty.call(o, 'serviceNumber')) ? o.serviceNumber : undefined;
    const rawList = (o && Array.isArray(o.serviceNumbers)) ? o.serviceNumbers : null;

    const isAll = (o && o.allServices === true) || (typeof rawSvc === 'string' && rawSvc.trim().toLowerCase() === 'all');
    if (isAll) {
      return { mode: 'all', primary: 1, list: null };
    }

    if (rawList && rawList.length) {
      const uniq = new Set();
      for (const v of rawList) {
        const n = _clampInt(v, 1, 63, null);
        if (n != null) uniq.add(n);
      }
      const list = Array.from(uniq).sort((a, b) => a - b);
      const primary = _clampInt(o.primaryServiceNumber, 1, 63, list[0] || 1);
      return { mode: list.length <= 1 ? 'single' : 'multi', primary, list: list.length ? list : [primary] };
    }

    const n = _clampInt(rawSvc, 1, 63, 1);
    return { mode: 'single', primary: n, list: [n] };
  };

  const req = _normalizeServiceRequest(opts);
  const serviceNumber = req.primary;

  const frames = Array.isArray(dtvccFrames) ? dtvccFrames.slice() : [];
  frames.sort((a, b) => (Number(a.sec) || 0) - (Number(b.sec) || 0));

  const rs = { buf: [], cursor: 0 };
  const warnings = [];
  const seenServices = new Set();

  // Per-service decode state. We keep services isolated because CTA-708 windows are scoped
  // per service number.
  const perSvc = new Map();

  const _ensureSvc = (svc) => {
    const sn = _clampInt(svc, 1, 63, null);
    if (sn == null) return null;
    let s = perSvc.get(sn);
    if (!s) {
      s = {
        serviceNumber: sn,
        state: { curWin: 0, windows: new Array(8).fill(null) },
        cues: [],
        active: null,
        lastKey: ''
      };
      perSvc.set(sn, s);
    }
    return s;
  };

  const _closeActiveFor = (svcState, endSec) => {
    if (!svcState || !svcState.active) return;
    const end = Number.isFinite(endSec) ? endSec : svcState.active.start;
    const snap = svcState.active.snapshot;
    const combined = _combineWindowsText(snap.windows);
    svcState.cues.push({
      id: svcState.cues.length,
      start: svcState.active.start,
      end,
      text: combined.text,
      lines: combined.lines,
      textPlain: combined.textPlain,
      linesPlain: combined.linesPlain,
      cea708: {
        serviceNumber: svcState.serviceNumber,
        windows: snap.windows
      }
    });
    svcState.active = null;
  };

  const wantAll = req.mode === 'all';
  const wantedList = (req.mode === 'single' || req.mode === 'multi') ? (req.list || [serviceNumber]) : null;
  const wantedSet = wantedList ? new Set(wantedList.map(v => _clampInt(v, 1, 63, null)).filter(v => v != null)) : null;

  let lastSec = 0;
  for (const f of frames) {
    const sec = Number(f?.sec) || 0;
    lastSec = sec;
    const bytes = Array.isArray(f?.dtvccBytes) ? f.dtvccBytes : (Array.isArray(f?.bytes) ? f.bytes : []);
    const packets = _feedDtvccReassembler(rs, bytes);
    for (const pkt of packets) {
      if (!pkt || pkt.length < 2) continue;
      const payload = pkt.slice(1); // drop header
      const blocks = _parseServiceBlocks(payload, seenServices);
      for (const b of blocks) {
        const svc = _clampInt(b.service, 1, 63, null);
        if (svc == null) continue;
        if (!wantAll && wantedSet && !wantedSet.has(svc)) continue;
        const svcState = _ensureSvc(svc);
        if (!svcState) continue;
        _decodeServiceBytes(b.data, svcState.state, warnings);
      }
    }

    // Evaluate cue boundaries for each tracked service after processing this frame.
    // For 'all' mode, this runs only across services we've actually seen/created.
    // For 'single'/'multi', we also ensure requested services exist even if empty.
    if (!wantAll && wantedSet) {
      for (const svc of wantedSet) _ensureSvc(svc);
    }

    for (const svcState of perSvc.values()) {
      const snap = _snapshotVisibleWindows(svcState.state);
      const key = snap.key || '';
      if (key !== svcState.lastKey) {
        _closeActiveFor(svcState, sec);
        if (snap.windows.length) {
          svcState.active = { start: sec, snapshot: snap };
        }
        svcState.lastKey = key;
      }
    }
  }

  // Close any remaining cues (give them 1 frame of tail).
  const tail = lastSec + (1 / Math.max(1, fps));
  for (const svcState of perSvc.values()) {
    _closeActiveFor(svcState, tail);
  }

  const cuesByService = {};
  for (const [svc, svcState] of perSvc.entries()) {
    cuesByService[svc] = Array.isArray(svcState.cues) ? svcState.cues : [];
  }

  // Backward compatibility: expose a primary `cues` array.
  // - single: that service
  // - multi/all: choose the requested primary if it has cues, else choose the service
  //   with the most cues, else empty.
  let primarySvc = serviceNumber;
  if (req.mode !== 'single') {
    const primaryCues = cuesByService[primarySvc] || [];
    if (!primaryCues.length) {
      let bestSvc = primarySvc;
      let bestLen = primaryCues.length;
      for (const k of Object.keys(cuesByService)) {
        const s = Number(k);
        const len = (cuesByService[k] || []).length;
        if (len > bestLen) {
          bestLen = len;
          bestSvc = s;
        }
      }
      primarySvc = bestSvc;
    }
  }

  return {
    cues: Array.isArray(cuesByService[primarySvc]) ? cuesByService[primarySvc] : [],
    cuesByService,
    primaryServiceNumber: primarySvc,
    seenServices: Array.from(seenServices).sort((a, b) => a - b),
    warnings
  };
}

module.exports = {
  decodeDtvccFramesToCues
};
