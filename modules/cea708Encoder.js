'use strict';

// Minimal CTA-708 builder focused on: one bottom-anchored window (id=0),
// pop-on semantics, and service-1 DTVCC packets.
//
// Command codes + arities follow CTA-708 (C1/C0/G0) basics:
//   CWx(0x80-0x87), CLW(0x88)+mask, DSW(0x89)+mask, HDW(0x8A)+mask, DLW(0x8C)+mask
//   SPA(0x90)+3, SPC(0x91)+3, SPL(0x92)+2, SWA(0x97)+4, DFx(0x98-0x9F)+6, CR(0x0D), ETX(0x03)

const C0 = { ETX: 0x03, CR: 0x0d };
const C1 = {
  CW0: 0x80, CLW: 0x88, DSW: 0x89, HDW: 0x8a, DLW: 0x8c,
  SPA: 0x90, SPC: 0x91, SPL: 0x92, SWA: 0x97, DF0: 0x98
};

function _sanitize708(text) {
  // Keep captions broadcast-safe by normalizing punctuation and stripping markup.
  // Encoder supports CTA-708 G0 (printable ASCII + music note) and G1 (Latin-1).
  let s = String(text || '');
  s = s.replace(/\r\n?/g, '\n');
  // Remove any HTML-ish tags so layout QC == encoded output.
  s = s.replace(/<[^>]*>/g, '');
  // Normalize “smart” punctuation to plain equivalents.
  s = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/•/g, '*')
    .replace(/`/g, "'")
    // 608 maps ~ to ∼; for 708 we keep the plain tilde.
    .replace(/∼/g, '~');

  // Preserve line breaks, but collapse internal whitespace per-line.
  s = s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n');

  const music = new Set(['♪', '♫', '♩', '♬']);

  // Filter characters to what our encoder can represent (G0/G1).
  let out = '';
  for (const ch of s) {
    if (ch === '\n') { out += ch; continue; }
    const cp = ch.codePointAt(0);
    if ((cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF) || music.has(ch)) {
      out += ch;
      continue;
    }

    // For anything else (e.g., Latin Extended), try a conservative transliteration:
    // NFKD-decompose and strip combining marks, then keep what becomes representable.
    let d = ch;
    try {
      d = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    } catch {}
    for (const dc of d) {
      if (dc === '\n') { out += dc; continue; }
      const dcp = dc.codePointAt(0);
      if ((dcp >= 0x20 && dcp <= 0x7E) || (dcp >= 0xA0 && dcp <= 0xFF) || music.has(dc)) out += dc;
      else out += ' ';
    }
  }

  // Final whitespace cleanup per line.
  out = out.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n');
  return out;
}


function encodeG0(text) {
  // NOTE: despite the name, this emits both G0 (ASCII) and G1 (Latin-1) bytes,
  // plus the CTA-708 G0 music-note at 0x7F.
  const t = _sanitize708(text);
  const bytes = [];
  for (const ch of t) {
    if (ch === '\n') continue;
    if (ch === '♪' || ch === '♫' || ch === '♩' || ch === '♬') {
      bytes.push(0x7F);
      continue;
    }
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7E) bytes.push(c);
    else if (c >= 0xA0 && c <= 0xFF) bytes.push(c);
    else bytes.push(0x20);
  }
  return bytes;
}

// ---- Pen/style helpers -----------------------------------------------------
//
// Pro-grade styling support: preserve basic markup (italics/underline) instead of
// stripping it. We emit SetPenAttributes (SPA) when style state changes.
//
// CTA-708 Set Pen Attributes (SPA, 0x90) parameter byte layout:
//   b1: pen_size(2) | pen_offset(2) | text_tag(4)
//   b2: font_tag(3) | edge_type(3) | underline(1) | italics(1)
//   b3: edge_color (6 bits RGB; keep 0 = black by default)
function buildSPA({
  italic = false,
  underline = false,
  penSize = 1,
  penOffset = 1,
  textTag = 0,
  fontTag = 3,
  edgeType = 0,
  edgeColor = 0
} = {}) {
  const ps = Math.max(0, Math.min(3, Number(penSize) || 0)) & 0x03;
  const po = Math.max(0, Math.min(3, Number(penOffset) || 0)) & 0x03;
  const tt = Math.max(0, Math.min(15, Number(textTag) || 0)) & 0x0f;
  const ft = Math.max(0, Math.min(7, Number(fontTag) || 0)) & 0x07;
  const et = _parseEdgeType(edgeType);
  const u = underline ? 1 : 0;
  const i = italic ? 1 : 0;
  const b1 = (ps << 6) | (po << 4) | tt;
  const b2 = (ft << 5) | (et << 2) | (u << 1) | i;
  // Edge color is 2-bit RGB (RR GG BB) in the low 6 bits. Default 0 = black.
  const ec = _parseEdgeColor6(edgeColor);
  const b3 = ec;
  return [C1.SPA, b1 & 0xff, b2 & 0xff, b3 & 0xff];
}


// ---- Pen/window color helpers ---------------------------------------------
//
// CTA-708 colors are 2-bit per channel (0..3). For convenience we accept:
//   - Named colors: black, white, red, green, blue, yellow, cyan, magenta
//   - Hex strings: #RRGGBB / #RGB
//   - 6-bit packed RGB: 0..63 (RR GG BB)
//   - Objects: { r, g, b } with values 0..3 or 0..255
// Opacity is 2-bit:
//   0=solid, 1=flash, 2=translucent, 3=transparent
function _clampInt(v, min, max, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function _opacityTo2bit(v, fallback = 0) {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    const s = String(v).trim().toLowerCase();
    if (s === 'solid' || s === 'opaque') return 0;
    if (s === 'flash' || s === 'flashing') return 1;
    if (s === 'translucent' || s === 'semi' || s === 'semi-transparent' || s === 'semtransparent') return 2;
    if (s === 'transparent' || s === 'none') return 3;
    const asNum = Number(s);
    if (Number.isFinite(asNum)) return _clampInt(asNum, 0, 3, fallback);
    return fallback;
  }
  return _clampInt(v, 0, 3, fallback);
}

function _channelTo2bit(v, fallback = 0) {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // Accept 0..3 directly, or 0..255 and quantize.
  if (n <= 3) return _clampInt(n, 0, 3, fallback);
  return _clampInt(Math.round(n / 85), 0, 3, fallback);
}

function _parseRgb2bit(spec) {
  if (spec == null) return { r: 0, g: 0, b: 0 };

  // Packed RR GG BB (6-bit) shortcut.
  if (typeof spec === 'number' && Number.isFinite(spec) && spec >= 0 && spec <= 63) {
    const n = spec | 0;
    return { r: (n >> 4) & 3, g: (n >> 2) & 3, b: n & 3 };
  }

  if (typeof spec === 'string') {
    const s = String(spec).trim().toLowerCase();
    const named = {
      black:   { r: 0, g: 0, b: 0 },
      white:   { r: 3, g: 3, b: 3 },
      red:     { r: 3, g: 0, b: 0 },
      green:   { r: 0, g: 3, b: 0 },
      blue:    { r: 0, g: 0, b: 3 },
      yellow:  { r: 3, g: 3, b: 0 },
      cyan:    { r: 0, g: 3, b: 3 },
      magenta: { r: 3, g: 0, b: 3 }
    };
    if (named[s]) return named[s];

    const hex = s.replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      const r8 = parseInt(hex.slice(0, 2), 16);
      const g8 = parseInt(hex.slice(2, 4), 16);
      const b8 = parseInt(hex.slice(4, 6), 16);
      return { r: _channelTo2bit(r8), g: _channelTo2bit(g8), b: _channelTo2bit(b8) };
    }
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      const r8 = parseInt(hex[0] + hex[0], 16);
      const g8 = parseInt(hex[1] + hex[1], 16);
      const b8 = parseInt(hex[2] + hex[2], 16);
      return { r: _channelTo2bit(r8), g: _channelTo2bit(g8), b: _channelTo2bit(b8) };
    }
  }

  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    const r = _channelTo2bit(spec.r ?? spec.red, 0);
    const g = _channelTo2bit(spec.g ?? spec.green, 0);
    const b = _channelTo2bit(spec.b ?? spec.blue, 0);
    return { r, g, b };
  }

  return { r: 0, g: 0, b: 0 };
}

// ---- Restricted palette helpers (Phase A)
//
// UI / JSON styling inputs should be normalized into the 8-color CEA-708 "safe" palette.
// This avoids the subtle "close enough" RGB→2-bit mapping bugs that show up when
// arbitrary colors are quantized.
//
// Allowed palette (foreground/background):
//   white / yellow / cyan / green / magenta / red / blue / black (+ 2-bit opacity)
const _CEA708_SAFE_8 = {
  black:   { r: 0, g: 0, b: 0 },
  white:   { r: 3, g: 3, b: 3 },
  red:     { r: 3, g: 0, b: 0 },
  green:   { r: 0, g: 3, b: 0 },
  blue:    { r: 0, g: 0, b: 3 },
  yellow:  { r: 3, g: 3, b: 0 },
  cyan:    { r: 0, g: 3, b: 3 },
  magenta: { r: 3, g: 0, b: 3 }
};

function _decodeBasicEntities708(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function _sanitizeRunText708(text) {
  // NOTE: Runs should be plain text, but we defensively strip common markup/tags.
  let s = String(text || '');
  s = s.replace(/\r\n?/g, '\n');
  s = _decodeBasicEntities708(s);
  s = s.replace(/<br\s*\/?>/gi, '\n');

  // Non-rendering placement tags used elsewhere in the app.
  s = s.replace(/\{(?:row|r|col|c)\s*:\s*-?\d+\}/gi, '');

  // Strip ASS/SSA override blocks with backslash tags (e.g. {\an8}).
  s = s.replace(/\{[^}]*\\[a-zA-Z][^}]*\}/g, '');

  // Strip any HTML-ish tags. (Runs carry styling out-of-band.)
  s = s.replace(/<[^>]*>/g, '');

  // Normalize smart punctuation.
  s = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/•/g, '*')
    .replace(/`/g, "'")
    .replace(/∼/g, '~');

  return s;
}

function _normalizeToSafePaletteName(spec, fallback = 'white') {
  if (spec == null) return fallback;

  // Accept already-normalized names.
  if (typeof spec === 'string') {
    const s = String(spec).trim().toLowerCase();
    if (_CEA708_SAFE_8[s]) return s;
    if (s === 'none' || s === 'transparent') return 'black';
  }

  // Parse the color to 8-bit RGB so we can choose the closest palette entry.
  const rgb2 = _parseRgb2bit(spec);
  const r8 = (rgb2.r & 3) * 85;
  const g8 = (rgb2.g & 3) * 85;
  const b8 = (rgb2.b & 3) * 85;

  let bestName = fallback;
  let bestDist = Infinity;
  for (const [name, c] of Object.entries(_CEA708_SAFE_8)) {
    const pr = (c.r & 3) * 85;
    const pg = (c.g & 3) * 85;
    const pb = (c.b & 3) * 85;
    const dr = r8 - pr;
    const dg = g8 - pg;
    const db = b8 - pb;
    const d2 = (dr * dr) + (dg * dg) + (db * db);
    if (d2 < bestDist) {
      bestDist = d2;
      bestName = name;
    }
  }
  return bestName;
}

function _safePaletteByte(colorSpec, opacity, fallbackName) {
  const name = _normalizeToSafePaletteName(colorSpec, fallbackName);
  const { r, g, b } = _CEA708_SAFE_8[name] || _CEA708_SAFE_8[fallbackName] || _CEA708_SAFE_8.white;
  const a = _opacityTo2bit(opacity, 0);
  return ((a & 3) << 6) | ((r & 3) << 4) | ((g & 3) << 2) | (b & 3);
}

function _extractRunStyle(run) {
  if (!run || typeof run !== 'object') return {};
  const style = (run.style && typeof run.style === 'object') ? run.style : null;
  // Allow style properties either on run.style or directly on the run.
  return { ...(run || {}), ...(style || {}) };
}

function _coerceRunStyleToPenState(styleIn, base) {
  const s = (styleIn && typeof styleIn === 'object') ? styleIn : {};
  const baseItalic = !!base?.italic;
  const baseUnderline = !!base?.underline;
  const baseFg = (base && Number.isFinite(base.fgByte)) ? (base.fgByte & 0xff) : 0x3f;

  const italic = (s.italic != null) ? !!s.italic : baseItalic;
  const underline = (s.underline != null) ? !!s.underline : baseUnderline;

  // Foreground
  const fgSpec = (s.fg ?? s.foreground ?? s.color ?? s.fill ?? s.textColor);
  const fgOpacity = (s.fgOpacity ?? s.foregroundOpacity ?? s.opacity);
  const fgByte = (fgSpec != null)
    ? _safePaletteByte(fgSpec, fgOpacity != null ? fgOpacity : 0, 'white')
    : baseFg;

  // Background
  const bgSpecRaw = (s.bg ?? s.background ?? s.backgroundColor ?? s.bgColor);
  const bgOpacityRaw = (s.bgOpacity ?? s.backgroundOpacity ?? s.bgAlpha);
  const bgSpec = (typeof bgSpecRaw === 'string') ? String(bgSpecRaw).trim().toLowerCase() : bgSpecRaw;

  // "none" is transparent background.
  if (bgSpec == null || bgSpec === '' || bgSpec === 'none' || bgSpec === 'transparent') {
    return { italic, underline, fgByte, bgByte: 0xC0 };
  }

  // Convenience shorthands from the Phase B UI.
  if (bgSpec === 'black75' || bgSpec === 'black_75' || bgSpec === 'black 75%') {
    return { italic, underline, fgByte, bgByte: _safePaletteByte('black', 2, 'black') };
  }
  if (bgSpec === 'black100' || bgSpec === 'black_100' || bgSpec === 'black 100%') {
    return { italic, underline, fgByte, bgByte: _safePaletteByte('black', 0, 'black') };
  }

  const bgOpacity = (bgOpacityRaw != null) ? bgOpacityRaw : 3;
  const bgByte = _safePaletteByte(bgSpec, bgOpacity, 'black');
  return { italic, underline, fgByte, bgByte };
}

function wrapRunsToLines(runs, maxChars, maxLines, opts = {}) {
  const limitChars = Math.max(1, Number(maxChars) || 32);
  const limitLines = (maxLines == null) ? null : Math.max(1, Number(maxLines) || 2);
  const overflowPolicyRaw = (opts && typeof opts.overflowPolicy === 'string') ? opts.overflowPolicy : 'truncate';
  const overflowPolicy = String(overflowPolicyRaw || '').trim().toLowerCase() || 'truncate';
  const cueIndex = Number.isFinite(Number(opts?.overflowCtx?.cueIndex)) ? Number(opts.overflowCtx.cueIndex) : null;
  const cueLabel = cueIndex ? `Cue ${cueIndex}` : 'Cue';

  const runList = Array.isArray(runs) ? runs : [];

  // Tokenize into paragraphs -> words (styled char arrays)
  const paragraphs = [];
  let words = [];
  let word = [];

  const flushWord = () => {
    if (word.length) {
      words.push(word);
      word = [];
    }
  };
  const flushPara = () => {
    flushWord();
    if (words.length) paragraphs.push(words);
    words = [];
  };

  for (const run of runList) {
    const tRaw = (run && typeof run === 'object') ? (run.text ?? run.value ?? run.t ?? '') : '';
    const s = _sanitizeRunText708(tRaw);
    const style = _extractRunStyle(run);
    const chars = Array.from(String(s || ''));
    for (const ch of chars) {
      if (ch === '\n') {
        flushPara();
        continue;
      }
      if (/\s/.test(ch)) {
        flushWord();
        continue;
      }
      word.push({ ch, style });
    }
  }
  flushPara();

  if (!paragraphs.length) return { lines: [], lineRuns: [] };

  // Wrap paragraphs using the same logic as wrapText(): join words with single spaces.
  const wrappedLinesWords = [];
  for (const paraWords of paragraphs) {
    let current = [];
    let curLen = 0;
    for (const w of paraWords) {
      const wlen = w.length;
      const candidateLen = current.length ? (curLen + 1 + wlen) : wlen;
      if (candidateLen > limitChars) {
        if (current.length) wrappedLinesWords.push(current);
        current = [w];
        curLen = wlen;
      } else {
        current.push(w);
        curLen = candidateLen;
      }
    }
    if (current.length) wrappedLinesWords.push(current);
  }

  // Check overlong tokens (single word longer than limit).
  const lineTooLong = wrappedLinesWords.find((lineWords) => {
    const len = lineWords.reduce((acc, w, idx) => acc + w.length + (idx ? 1 : 0), 0);
    return len > limitChars;
  });
  if (lineTooLong && overflowPolicy === 'error') {
    throw new Error(`${cueLabel} exceeds ${limitChars} chars/line. Split the cue or reduce text.`);
  }

  if (limitLines && wrappedLinesWords.length > limitLines) {
    if (overflowPolicy === 'error') {
      throw new Error(`${cueLabel} exceeds ${limitLines} lines at ${limitChars} chars/line. Split the cue or reduce text.`);
    }
  }

  const clamped = limitLines ? wrappedLinesWords.slice(0, limitLines) : wrappedLinesWords;
  const lineRuns = [];
  const lines = [];

  for (const lineWords of clamped) {
    // Build styled char stream for this line.
    const chars = [];
    for (let wi = 0; wi < lineWords.length; wi++) {
      const w = lineWords[wi];
      if (wi > 0) {
        const prev = lineWords[wi - 1];
        const prevStyle = prev && prev.length ? prev[prev.length - 1].style : {};
        chars.push({ ch: ' ', style: prevStyle });
      }
      for (const ce of w) chars.push(ce);
    }

    // Coalesce into runs by style identity (stringified shallow keys only).
    const runsOut = [];
    let curStyle = null;
    let curText = '';
    const styleKey = (st) => {
      const s = (st && typeof st === 'object') ? st : {};
      // Keep this stable but cheap.
      return JSON.stringify({
        italic: !!s.italic,
        underline: !!s.underline,
        fg: (s.fg ?? s.foreground ?? s.color ?? s.fill ?? s.textColor) ?? null,
        fgOpacity: (s.fgOpacity ?? s.foregroundOpacity ?? s.opacity) ?? null,
        bg: (s.bg ?? s.background ?? s.backgroundColor ?? s.bgColor) ?? null,
        bgOpacity: (s.bgOpacity ?? s.backgroundOpacity ?? s.bgAlpha) ?? null
      });
    };
    let curKey = null;
    for (const ce of chars) {
      const k = styleKey(ce.style);
      if (curKey == null) {
        curKey = k;
        curStyle = ce.style;
        curText = ce.ch;
        continue;
      }
      if (k === curKey) {
        curText += ce.ch;
        continue;
      }
      runsOut.push({ text: curText, style: curStyle });
      curKey = k;
      curStyle = ce.style;
      curText = ce.ch;
    }
    if (curKey != null && curText) runsOut.push({ text: curText, style: curStyle });

    lineRuns.push(runsOut);
    lines.push(chars.map(c => c.ch).join(''));
  }

  return { lines, lineRuns };
}

function _encodeLineRuns(lineRuns, state) {
  const bytes = [];
  let st = { ...(state || {}) };

  const base = {
    italic: !!st.italic,
    underline: !!st.underline,
    fgByte: (Number.isFinite(st.fgByte) ? (st.fgByte & 0xff) : 0x3f),
    bgByte: (Number.isFinite(st.bgByte) ? (st.bgByte & 0xff) : 0xC0)
  };

  for (const run of (Array.isArray(lineRuns) ? lineRuns : [])) {
    const text = (run && typeof run === 'object') ? String(run.text ?? '') : '';
    if (!text) continue;
    const target = _coerceRunStyleToPenState(_extractRunStyle(run), base);

    if (target.italic !== !!st.italic || target.underline !== !!st.underline) {
      bytes.push(...buildSPA({ ...(st.basePenAttrs || {}), italic: target.italic, underline: target.underline }));
      st.italic = target.italic;
      st.underline = target.underline;
    }

    if ((target.fgByte & 0xff) !== (st.fgByte & 0xff) || (target.bgByte & 0xff) !== (st.bgByte & 0xff)) {
      bytes.push(...buildSPCFromBytes(target.fgByte & 0xff, target.bgByte & 0xff, (st.edgeColor6 != null ? st.edgeColor6 : 0) & 0x3f));
      st.fgByte = target.fgByte & 0xff;
      st.bgByte = target.bgByte & 0xff;
    }

    for (const ch of Array.from(text)) _push708Char(bytes, ch);
  }

  return { bytes, state: st };
}

function buildPreloadBytesForLineRuns(
  lineRuns,
  {
    windowId = 0,
    justify = 'left',
    colCount = 32,
    rowCount = null,
    windowStyle: _windowStyle = null,
    pen = null,
    penColor = null,
    penLocations = null,
    windowOpts = null
  } = {}
) {
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));
  const bytes = [];

  const lineList = Array.isArray(lineRuns) ? lineRuns : [];
  const plainLines = lineList.map((lr) => (Array.isArray(lr) ? lr.map(r => String(r?.text || '')).join('') : String(lr || '')));
  const rc = (rowCount != null) ? _clampInt(rowCount, 1, 15, 15) : _clampInt(plainLines.length || 1, 1, 15, 15);
  const cc = _clampInt(colCount, 1, 63, 32);

  bytes.push((C1.CW0 + wid) & 0xff);
  const mask = (1 << wid) & 0xff;
  bytes.push(C1.HDW, mask);
  bytes.push(C1.CLW, mask);

  const w = (windowOpts && typeof windowOpts === 'object') ? windowOpts : {};
  bytes.push(...buildDefineWindow(wid, {
    rowCount: rc,
    colCount: cc,
    ...w
  }));
  bytes.push(...buildSWA({ justify }));

  // Base pen style.
  const basePen = (pen && typeof pen === 'object') ? pen : {};
  const basePenAttrs = {
    penSize: basePen.penSize,
    penOffset: basePen.penOffset,
    textTag: basePen.textTag,
    fontTag: basePen.fontTag,
    edgeType: basePen.edgeType,
    edgeColor: basePen.edgeColor
  };

  const initialItalic = !!basePen.italic;
  const initialUnderline = !!basePen.underline;
  bytes.push(...buildSPA({ ...basePenAttrs, italic: initialItalic, underline: initialUnderline }));

  // Base pen color.
  let baseFgByte = 0x3f;
  let baseBgByte = 0xC0;
  if (penColor && typeof penColor === 'object') {
    // If caller provided a penColor object, honor it as the base.
    try {
      bytes.push(...buildSPC(penColor));
      baseFgByte = _colorTo708OpacityByte(penColor.foreground, penColor.foregroundOpacity, 'white') & 0xff;
      baseBgByte = _colorTo708OpacityByte(penColor.background, penColor.backgroundOpacity, 'black') & 0xff;
    } catch {
      // Ignore; fall back to defaults.
    }
  }

  let st = {
    basePenAttrs,
    italic: initialItalic,
    underline: initialUnderline,
    fgByte: baseFgByte,
    bgByte: baseBgByte,
    edgeColor6: (basePen.edgeColor != null) ? (_parseEdgeColor6(basePen.edgeColor) & 0x3f) : 0
  };

  const locs = _normalizePenLocations(penLocations, lineList.length);
  const last = lineList.length - 1;
  for (let i = 0; i < lineList.length; i++) {
    if (locs && locs[i]) bytes.push(...buildSPL(locs[i].row, locs[i].col));
    const enc = _encodeLineRuns(lineList[i], st);
    bytes.push(...enc.bytes);
    st = enc.state;
    if (!locs && i !== last) bytes.push(C0.CR);
  }

  bytes.push(C0.ETX);
  return bytes;
}

function buildPreloadBytesForLineRunsWithWindowSnapshot(
  lineRuns,
  windowSnapshot,
  {
    windowId = 0,
    justify = null,
    windowStyle = null,
    pen = null,
    penColor = null,
    penLocations = null
  } = {}
) {
  const w = (windowSnapshot && typeof windowSnapshot === 'object') ? windowSnapshot : {};
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));

  const rc = _clampInt(w.rowCount, 1, 15, 15);
  const cc = _clampInt(w.colCount, 1, 63, 42);
  const rel = (w.relative !== false);
  const anchorId = _clampInt(w.anchorId, 0, 8, 7);
  const anchorV = _clampInt(w.anchorV, 0, rel ? 99 : 74, 90);
  const anchorH = _clampInt(w.anchorH, 0, rel ? 99 : 209, 50);

  const priority = _clampInt(w.priority, 0, 7, 4);
  const rowLock = _clampInt(w.rowLock, 0, 1, 1);
  const colLock = _clampInt(w.colLock, 0, 1, 1);
  const windowStyleId = _clampInt(w.windowStyleId, 0, 7, 1);
  const penStyleId = _clampInt(w.penStyleId, 0, 7, 1);

  const bytes = [];
  bytes.push((C1.CW0 + wid) & 0xff);
  const mask = (1 << wid) & 0xff;
  bytes.push(C1.HDW, mask);
  bytes.push(C1.CLW, mask);

  bytes.push(...buildDefineWindowExact(wid, {
    rowCount: rc,
    colCount: cc,
    rel,
    anchorId,
    anchorV,
    anchorH,
    visible: 0,
    priority,
    rowLock,
    colLock,
    windowStyleId,
    penStyleId
  }));

  const justifyEff = String((justify != null) ? justify : (w.justify || 'left')).toLowerCase();
  const wsSnapshot = (w.windowStyle && typeof w.windowStyle === 'object') ? w.windowStyle : null;
  const ws = (windowStyle && typeof windowStyle === 'object') ? windowStyle : wsSnapshot;
  bytes.push(...buildSWA({ justify: justifyEff, ...(ws || {}) }));

  // Base pen style/color from snapshot dominant pen unless overridden.
  const dom = (w.dominantPen && typeof w.dominantPen === 'object') ? w.dominantPen : null;
  const domPen = (dom && dom.pen && typeof dom.pen === 'object') ? dom.pen : null;
  const domColor = (dom && dom.penColor && typeof dom.penColor === 'object') ? dom.penColor : null;

  const basePen = (pen && typeof pen === 'object') ? pen : (domPen || {});
  const basePenAttrs = {
    penSize: basePen.penSize,
    penOffset: basePen.penOffset,
    textTag: basePen.textTag,
    fontTag: basePen.fontTag,
    edgeType: basePen.edgeType,
    edgeColor: basePen.edgeColor
  };
  const initialItalic = !!basePen.italic;
  const initialUnderline = !!basePen.underline;
  bytes.push(...buildSPA({ ...basePenAttrs, italic: initialItalic, underline: initialUnderline }));

  const pc = (penColor && typeof penColor === 'object') ? penColor : domColor;
  let baseFgByte = 0x3f;
  let baseBgByte = 0xC0;
  if (pc) {
    try {
      bytes.push(...buildSPC(pc));
      baseFgByte = _colorTo708OpacityByte(pc.foreground, pc.foregroundOpacity, 'white') & 0xff;
      baseBgByte = _colorTo708OpacityByte(pc.background, pc.backgroundOpacity, 'black') & 0xff;
    } catch {}
  }

  let st = {
    basePenAttrs,
    italic: initialItalic,
    underline: initialUnderline,
    fgByte: baseFgByte,
    bgByte: baseBgByte,
    edgeColor6: (basePen.edgeColor != null) ? (_parseEdgeColor6(basePen.edgeColor) & 0x3f) : 0
  };

  const lineList = Array.isArray(lineRuns) ? lineRuns : [];
  const locs = _normalizePenLocations(penLocations, lineList.length);
  const last = lineList.length - 1;
  for (let i = 0; i < lineList.length; i++) {
    if (locs && locs[i]) bytes.push(...buildSPL(locs[i].row, locs[i].col));
    const enc = _encodeLineRuns(lineList[i], st);
    bytes.push(...enc.bytes);
    st = enc.state;
    if (!locs && i !== last) bytes.push(C0.CR);
  }

  bytes.push(C0.ETX);
  return bytes;
}

function _parseEdgeColor6(spec) {
  const { r, g, b } = _parseRgb2bit(spec);
  return (((r & 3) << 4) | ((g & 3) << 2) | (b & 3)) & 0x3f;
}

function _parseEdgeType(spec) {
  if (spec == null) return 0;
  if (typeof spec === 'number' && Number.isFinite(spec)) return _clampInt(spec, 0, 7, 0) & 0x07;
  const s = String(spec).trim().toLowerCase();
  const map = {
    none: 0,
    no: 0,
    off: 0,
    raised: 1,
    depress: 2,
    depressed: 2,
    uniform: 3,
    shadow_left: 4,
    left_shadow: 4,
    leftshadow: 4,
    shadow_right: 5,
    right_shadow: 5,
    rightshadow: 5
  };
  if (map[s] != null) return map[s] & 0x07;
  const asNum = Number(s);
  if (Number.isFinite(asNum)) return _clampInt(asNum, 0, 7, 0) & 0x07;
  return 0;
}

function _colorTo708OpacityByte(spec, { defaultColor = 'black', defaultOpacity = 0 } = {}) {
  let colorSpec = spec;
  let opacitySpec = null;

  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    // If caller provided { color, opacity }, use color; if they provided
    // { opacity } or { r,g,b,opacity }, keep colorSpec as-is and use opacity.
    if (spec.color != null) {
      colorSpec = spec.color;
      opacitySpec = spec.opacity;
    } else if (spec.opacity != null) {
      opacitySpec = spec.opacity;
    }
  }

  const { r, g, b } = _parseRgb2bit(colorSpec != null ? colorSpec : defaultColor);
  const op = _opacityTo2bit(opacitySpec, _opacityTo2bit(defaultOpacity, 0));
  return (((op & 3) << 6) | ((r & 3) << 4) | ((g & 3) << 2) | (b & 3)) & 0xff;
}

// SetPenColor (SPC, 0x91) — 3 parameter bytes:
//   foreground_color, background_color, edge_color (each: opacity(2) + RGB(2/2/2))
function buildSPC({ foreground = null, background = null, edge = null } = {}) {
  const fg = _colorTo708OpacityByte(foreground, { defaultColor: 'white', defaultOpacity: 0 });
  const bg = _colorTo708OpacityByte(background, { defaultColor: 'black', defaultOpacity: 3 }); // transparent background by default
  // Per CTA-708, the edge color field is 6-bit RGB only (top 2 bits must be 0).
  // Some encoders treat those bits as opacity; we mask them off for interop.
  const ec = _colorTo708OpacityByte(edge, { defaultColor: 'black', defaultOpacity: 0 }) & 0x3f;
  return [C1.SPC, fg & 0xff, bg & 0xff, ec & 0xff];
}

// Build SPC from already-packed CTA-708 color bytes.
//
// NOTE: Per CTA-708, the "edge color" byte is 6-bit color only (top 2 bits should
// be 0). Some encoders treat those bits as opacity; we mask them off for interop.
function buildSPCFromBytes(fgByte, bgByte, edgeByte) {
  const fg = (Number(fgByte) & 0xff) >>> 0;
  const bg = (Number(bgByte) & 0xff) >>> 0;
  const ec = (Number(edgeByte) & 0x3f) >>> 0;
  return [C1.SPC, fg & 0xff, bg & 0xff, ec & 0xff];
}

function _decodeBasicEntities(s) {
  // Keep this tiny and predictable; we don't want a full HTML parser here.
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function _normalize708ForStyledEncoding(text) {
  let s = String(text || '');
  s = s.replace(/\r\n?/g, '\n');
  s = _decodeBasicEntities(s);
  s = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/•/g, '*')
    .replace(/`/g, "'")
    .replace(/∼/g, '~');
  return s;
}

const _MUSIC_708 = new Set(['♪', '♫', '♩', '♬']);

function _push708Char(bytes, ch) {
  if (!ch || ch === '\n') return;
  if (_MUSIC_708.has(ch)) { bytes.push(0x7F); return; }
  const cp = ch.codePointAt(0);
  if ((cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF)) {
    bytes.push(cp & 0xff);
    return;
  }
  // Conservative transliteration: strip diacritics, then keep representable chars.
  let d = ch;
  try {
    d = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  } catch {}
  for (const dc of d) {
    if (dc === '\n') continue;
    if (_MUSIC_708.has(dc)) { bytes.push(0x7F); continue; }
    const dcp = dc.codePointAt(0);
    if ((dcp >= 0x20 && dcp <= 0x7E) || (dcp >= 0xA0 && dcp <= 0xFF)) bytes.push(dcp & 0xff);
    else bytes.push(0x20);
  }
}

function _ensurePenState(state) {
  const normalizeBase = (base) => {
    const b = (base && typeof base === 'object') ? base : {};
    const ps = Math.max(0, Math.min(3, Number(b.penSize) || 1)) & 0x03;
    const po = Math.max(0, Math.min(3, Number(b.penOffset) || 1)) & 0x03;
    const tt = Math.max(0, Math.min(15, Number(b.textTag) || 0)) & 0x0f;
    const ft = Math.max(0, Math.min(7, Number(b.fontTag) || 3)) & 0x07;
    const et = _parseEdgeType(b.edgeType);
    const ec = _parseEdgeColor6(b.edgeColor);
    return { penSize: ps, penOffset: po, textTag: tt, fontTag: ft, edgeType: et, edgeColor: ec };
  };

  if (!state || typeof state !== 'object') {
    return { italicDepth: 0, underlineDepth: 0, italic: false, underline: false, basePenAttrs: normalizeBase(null) };
  }
  if (!Number.isFinite(state.italicDepth)) state.italicDepth = 0;
  if (!Number.isFinite(state.underlineDepth)) state.underlineDepth = 0;
  state.italicDepth = Math.max(0, state.italicDepth | 0);
  state.underlineDepth = Math.max(0, state.underlineDepth | 0);
  state.italic = !!state.italic;
  state.underline = !!state.underline;
  state.basePenAttrs = normalizeBase(state.basePenAttrs);
  return state;
}

function _maybeEmitSpa(bytes, state, nextItalic, nextUnderline) {
  const ni = !!nextItalic;
  const nu = !!nextUnderline;
  if (state.italic === ni && state.underline === nu) return;
  state.italic = ni;
  state.underline = nu;
  bytes.push(...buildSPA({ ...(state.basePenAttrs || {}), italic: ni, underline: nu }));
}

// Encode 708 text while preserving *basic* styling markup.
//
// Supported markup:
//   - HTML-ish: <i>...</i> and <u>...</u> (case-insensitive)
//   - ASS/SSA overrides: {\i1}/{\i0} and {\u1}/{\u0}
//
// Unknown tags are stripped (not rendered) to avoid leaking raw markup into output.
function encodeStyledText(text, penState) {
  const state = _ensurePenState(penState);
  const bytes = [];

  const s = _normalize708ForStyledEncoding(text);

  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    // --- HTML-ish tags
    if (ch === '<') {
      const close = s.indexOf('>', i + 1);
      if (close !== -1) {
        const innerRaw = s.slice(i + 1, close);
        const inner = innerRaw.trim().toLowerCase();

        const isKnown =
          inner === 'i' || inner === '/i' ||
          inner === 'u' || inner === '/u' ||
          inner === 'br' || inner === 'br/' || inner.startsWith('br ');

        // Treat as "real tag" if it looks like HTML (letter or slash+letter).
        const looksLikeHtml = /^[/]?[a-z]/i.test(innerRaw.trim());

        if (isKnown) {
          if (inner === 'i') {
            state.italicDepth++;
            _maybeEmitSpa(bytes, state, state.italicDepth > 0, state.underlineDepth > 0);
          } else if (inner === '/i') {
            state.italicDepth = Math.max(0, state.italicDepth - 1);
            _maybeEmitSpa(bytes, state, state.italicDepth > 0, state.underlineDepth > 0);
          } else if (inner === 'u') {
            state.underlineDepth++;
            _maybeEmitSpa(bytes, state, state.italicDepth > 0, state.underlineDepth > 0);
          } else if (inner === '/u') {
            state.underlineDepth = Math.max(0, state.underlineDepth - 1);
            _maybeEmitSpa(bytes, state, state.italicDepth > 0, state.underlineDepth > 0);
          }
          // <br> becomes a hard line break upstream; at the encoding layer we ignore '\n'
          // and let the caller place CRs between lines.
          i = close + 1;
          continue;
        }

        if (looksLikeHtml) {
          // Strip unknown HTML tags completely.
          i = close + 1;
          continue;
        }
        // Otherwise: treat '<' as literal and fall through to character encoding.
      }
    }

    // --- ASS/SSA override blocks: { ... }
    if (ch === '{') {
      const close = s.indexOf('}', i + 1);
      if (close !== -1) {
        const inner = s.slice(i + 1, close);

        // Only treat as overrides if it contains a backslash tag.
        if (/\\[a-z]/i.test(inner)) {
          // \i0/\i1
          const mi = inner.match(/\\i([01])/i);
          if (mi) {
            if (mi[1] === '1') state.italicDepth = Math.max(1, state.italicDepth);
            else state.italicDepth = 0;
          }
          // \u0/\u1
          const mu = inner.match(/\\u([01])/i);
          if (mu) {
            if (mu[1] === '1') state.underlineDepth = Math.max(1, state.underlineDepth);
            else state.underlineDepth = 0;
          }

          _maybeEmitSpa(bytes, state, state.italicDepth > 0, state.underlineDepth > 0);

          // Strip the whole override block.
          i = close + 1;
          continue;
        }
      }
    }

    // Normal character
    _push708Char(bytes, ch);
    i += 1;
  }

  return { bytes, state };
}


// ---- Window builders -------------------------------------------------------
// DefineWindow (DFx 0x98..0x9F) + 6 bytes (see CTA-708)
function buildDefineWindow(windowId = 0, { rowCount = 2, colCount = 32, rel = true, anchorId = 7, anchorV = 90, anchorH = 50 } = {}) {
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));
  const DFx = (C1.DF0 + wid) & 0xff;
  const PRIOR = 4;     // mid priority (0..7)
  const C = 1, R = 1;  // lock cols/rows for stable behavior
  const V = 0;         // not visible at create
  const b1 = ((V & 1) << 5) | ((R & 1) << 4) | ((C & 1) << 3) | (PRIOR & 0x07);
  const P  = rel ? 1 : 0;
  const b2 = ((P & 1) << 7) | (Math.max(0, Math.min(rel ? 99 : 74, anchorV)) & 0x7f);
  const b3 = Math.max(0, Math.min(rel ? 99 : 209, anchorH)) & 0xff;
  const ANCHOR_ID = Math.max(0, Math.min(8, Number.isFinite(Number(anchorId)) ? Math.trunc(Number(anchorId)) : 7)); // LOWER_CENTER
  const rowsNibble = Math.max(0, Math.min(15, (rowCount | 0) - 1));
  const b4 = ((ANCHOR_ID & 0x0f) << 4) | (rowsNibble & 0x0f);
  const cols6 = Math.max(1, Math.min(63, colCount | 0));
  const b5 = cols6 & 0x3f; // top two bits 00
  const WNSTY = 1, PNSTY = 1;
  const b6 = ((WNSTY & 0x07) << 3) | (PNSTY & 0x07);
  return [DFx, b1, b2, b3, b4, b5, b6];
}

// Like buildDefineWindow(), but allows callers to preserve more fields when
// round-tripping a decoded window snapshot.
function buildDefineWindowExact(windowId = 0, {
  rowCount = 2,
  colCount = 32,
  rel = true,
  anchorId = 7,
  anchorV = 90,
  anchorH = 50,
  // Extra DefineWindow bits
  visible = 0,
  priority = 4,
  rowLock = 1,
  colLock = 1,
  windowStyleId = 1,
  penStyleId = 1
} = {}) {
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));
  const DFx = (C1.DF0 + wid) & 0xff;

  const PRIOR = Math.max(0, Math.min(7, Number(priority) || 0)) & 0x07;
  const C = colLock ? 1 : 0;
  const R = rowLock ? 1 : 0;
  const V = visible ? 1 : 0;
  const b1 = ((V & 1) << 5) | ((R & 1) << 4) | ((C & 1) << 3) | (PRIOR & 0x07);

  const P = rel ? 1 : 0;
  const b2 = ((P & 1) << 7) | (Math.max(0, Math.min(rel ? 99 : 74, anchorV)) & 0x7f);
  const b3 = Math.max(0, Math.min(rel ? 99 : 209, anchorH)) & 0xff;
  const ANCHOR_ID = Math.max(0, Math.min(8, Number.isFinite(Number(anchorId)) ? Math.trunc(Number(anchorId)) : 7));
  const rowsNibble = Math.max(0, Math.min(15, (rowCount | 0) - 1));
  const b4 = ((ANCHOR_ID & 0x0f) << 4) | (rowsNibble & 0x0f);
  const cols6 = Math.max(1, Math.min(63, colCount | 0));
  const b5 = cols6 & 0x3f;
  const WNSTY = Math.max(0, Math.min(7, Number(windowStyleId) || 0));
  const PNSTY = Math.max(0, Math.min(7, Number(penStyleId) || 0));
  const b6 = ((WNSTY & 0x07) << 3) | (PNSTY & 0x07);
  return [DFx, b1, b2, b3, b4, b5, b6];
}

// DefineWindow0 (DF0 0x98) + 6 bytes (see CTA-708)
function buildDefineWindow0(opts = {}) {
  return buildDefineWindow(0, opts);
}

// SetWindowAttributes (justify + defaults). 4 param bytes after 0x97.
// Justify mapping for LTR: LEFT=0, RIGHT=1, CENTER=2, FULL=3
function buildSWA({
  justify = 'left',
  // Fill/background behind glyph cells (the "window box")
  fillOpacity = 2,            // default translucent
  fillColor = 'black',
  // Optional border around the window (rare in broadcast deliverables, but supported)
  borderType = 0,
  borderColor = 'black',
  wordWrap = false,
  printDirection = 0,         // 0=LTR
  scrollDirection = 2,        // 2=top-to-bottom
  effectDirection = 0,
  displayEffect = 0,
  effectSpeed = 0
} = {}) {
  const j = String(justify || '').trim().toLowerCase();
  const JST = (j === 'center') ? 2 : (j === 'right' ? 1 : (j === 'full' ? 3 : 0));

  const FOP = _opacityTo2bit(fillOpacity, 2);
  const { r: F_R, g: F_G, b: F_B } = _parseRgb2bit(fillColor);

  const BTP = _parseEdgeType(borderType);
  const { r: B_R, g: B_G, b: B_B } = _parseRgb2bit(borderColor);

  const W = wordWrap ? 1 : 0;
  const PRD = _clampInt(printDirection, 0, 3, 0) & 0x03;
  const SCD = _clampInt(scrollDirection, 0, 3, 2) & 0x03;
  const EFD = _clampInt(effectDirection, 0, 3, 0) & 0x03;
  const DEF = _clampInt(displayEffect, 0, 3, 0) & 0x03;
  const EFT_SPD = _clampInt(effectSpeed, 0, 3, 0) & 0x03;
  const b1 = ((FOP & 3) << 6) | ((F_R & 3) << 4) | ((F_G & 3) << 2) | (F_B & 3);
  const b2 = ((BTP & 3) << 6) | ((B_R & 3) << 4) | ((B_G & 3) << 2) | (B_B & 3);
  const b3 = ((W & 1) << 7) | (((BTP >> 2) & 1) << 6) | ((PRD & 3) << 4) | ((SCD & 3) << 2) | (JST & 3);
  const b4 = ((EFT_SPD & 3) << 6) | ((EFD & 3) << 4) | ((DEF & 3) << 2);
  return [C1.SWA, b1 & 0xff, b2 & 0xff, b3 & 0xff, b4 & 0xff];
}

// SetPenLocation(row, col)(row, col)
function buildSPL(row, col) {
  const r = Math.max(0, Math.min(15, row | 0));
  const c = Math.max(0, Math.min(63, col | 0));
  // SPL column is 6-bit (0..63); top 2 bits are reserved.
  return [C1.SPL, r & 0x0f, c & 0x3f];
}


function _normalizePenLocations(penLocations, lineCount) {
  const n = Math.max(0, (lineCount | 0));
  if (!penLocations || !n) return null;

  // Array form: [{row, col}, ...] (one entry per line)
  if (Array.isArray(penLocations)) {
    const out = [];
    for (let i = 0; i < Math.min(n, penLocations.length); i++) {
      const loc = penLocations[i] || {};
      const row = _clampInt(loc.row, 0, 15, 0);
      const col = _clampInt(loc.col, 0, 63, 0);
      out.push({ row, col });
    }
    return out.length ? out : null;
  }

  // Object form: {row, col} → apply to first line, subsequent lines increment row.
  if (penLocations && typeof penLocations === 'object') {
    const baseRow = _clampInt(penLocations.row, 0, 15, 0);
    const baseCol = _clampInt(penLocations.col, 0, 63, 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ row: _clampInt(baseRow + i, 0, 15, baseRow), col: baseCol });
    }
    return out;
  }

  return null;
}

// Build a "true pop-on" preload sequence for a given window:
//   - Select window
//   - Hide + Clear
//   - (Re)define window + attrs
//   - Write text + ETX
// No DSW here: the caller decides when to display (swap).
function buildPreloadBytesForLines(
  lines,
  {
    windowId = 0,
    justify = 'left',
    colCount = 32,
    rowCount = null,
    rel = true,
    anchorId = 7,
    anchorV = 90,
    anchorH = 50,
    // Presentation styling
    windowStyle = null,    // passed to buildSWA
    pen = null,            // passed to buildSPA (base attributes)
    penColor = null,       // passed to buildSPC {foreground, background, edge}
    // Optional explicit pen locations (per line): [{row, col}, ...] OR {row, col}
    penLocations = null
  } = {}
) {
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));
  const lineList = Array.isArray(lines) ? lines : [];
  const inferredRows = Math.max(1, Math.min(15, (lineList.length || 1)));
  const rc = (rowCount != null)
    ? Math.max(1, Math.min(15, Number(rowCount) || inferredRows))
    : inferredRows;

  const bytes = [];
  bytes.push((C1.CW0 + wid) & 0xff);

  const mask = (1 << wid) & 0xff;
  bytes.push(C1.HDW, mask);
  bytes.push(C1.CLW, mask);

  bytes.push(...buildDefineWindow(wid, { rowCount: rc, colCount, rel, anchorId, anchorV, anchorH }));
  bytes.push(...buildSWA({ justify, ...(windowStyle && typeof windowStyle === 'object' ? windowStyle : {}) }));

  // Reset base pen attributes at the start of each preload so style doesn't "leak" between cues.
  // Markup-driven italics/underline is applied by encodeStyledText via SPA changes.
  const basePen = (pen && typeof pen === 'object') ? pen : {};
  const basePenAttrs = {
    penSize: basePen.penSize,
    penOffset: basePen.penOffset,
    textTag: basePen.textTag,
    fontTag: basePen.fontTag,
    edgeType: basePen.edgeType,
    edgeColor: basePen.edgeColor
  };

  const initialItalic = !!basePen.italic;
  const initialUnderline = !!basePen.underline;

  bytes.push(...buildSPA({ ...basePenAttrs, italic: initialItalic, underline: initialUnderline }));

  if (penColor) {
    // Set pen colors (foreground/background/edge). Defaults are sensible even if caller
    // only supplies one of the fields.
    bytes.push(...buildSPC(penColor));
  }

  let penState = _ensurePenState({
    italicDepth: initialItalic ? 1 : 0,
    underlineDepth: initialUnderline ? 1 : 0,
    italic: initialItalic,
    underline: initialUnderline,
    basePenAttrs
  });

  const locs = _normalizePenLocations(penLocations, lineList.length);

  const last = lineList.length - 1;
  lineList.forEach((line, i) => {
    if (locs && locs[i]) {
      bytes.push(...buildSPL(locs[i].row, locs[i].col));
    }
    const enc = encodeStyledText(line || '', penState);
    bytes.push(...enc.bytes);
    penState = enc.state;
    // When using explicit SPL per line, don't insert CR; SPL positions the pen directly.
    if (!locs && i !== last) bytes.push(C0.CR);
  });

  bytes.push(C0.ETX);
  return bytes;
}

// Build a 708 preload for a single window snapshot produced by cea708Decoder.
// This enables "style round-trip" (SWA + SPA + SPC) without forcing the UI
// text model to carry heavy inline markup.
function buildPreloadBytesForWindowSnapshot(
  windowSnapshot,
  {
    windowId = 0
  } = {}
) {
  const w = (windowSnapshot && typeof windowSnapshot === 'object') ? windowSnapshot : {};
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));

  const rc = _clampInt(w.rowCount, 1, 15, 15);
  const cc = _clampInt(w.colCount, 1, 63, 42);
  const rel = (w.relative !== false);
  const anchorId = _clampInt(w.anchorId, 0, 8, 7);
  const anchorV = _clampInt(w.anchorV, 0, rel ? 99 : 74, 90);
  const anchorH = _clampInt(w.anchorH, 0, rel ? 99 : 209, 50);

  const priority = _clampInt(w.priority, 0, 7, 4);
  const rowLock = _clampInt(w.rowLock, 0, 1, 1);
  const colLock = _clampInt(w.colLock, 0, 1, 1);
  const windowStyleId = _clampInt(w.windowStyleId, 0, 7, 1);
  const penStyleId = _clampInt(w.penStyleId, 0, 7, 1);

  const bytes = [];
  bytes.push((C1.CW0 + wid) & 0xff);
  const mask = (1 << wid) & 0xff;
  bytes.push(C1.HDW, mask);
  bytes.push(C1.CLW, mask);

  bytes.push(...buildDefineWindowExact(wid, {
    rowCount: rc,
    colCount: cc,
    rel,
    anchorId,
    anchorV,
    anchorH,
    visible: 0,
    priority,
    rowLock,
    colLock,
    windowStyleId,
    penStyleId
  }));

  const justify = String(w.justify || 'left').toLowerCase();
  const ws = (w.windowStyle && typeof w.windowStyle === 'object') ? w.windowStyle : null;
  bytes.push(...buildSWA({ justify, ...(ws || {}) }));

  const grid = Array.isArray(w.grid) ? w.grid.map(v => String(v || '')) : [];
  const gridStyles = Array.isArray(w.gridStyles) ? w.gridStyles.map(v => String(v || '')) : [];
  const gridFg = Array.isArray(w.gridFg) ? w.gridFg : null;
  const gridBg = Array.isArray(w.gridBg) ? w.gridBg : null;
  const gridEdge = Array.isArray(w.gridEdge) ? w.gridEdge : null;
  const gridEdgeType = Array.isArray(w.gridEdgeType) ? w.gridEdgeType : null;

  const DEFAULT_FG = 0x3f;
  const DEFAULT_BG = 0xc0;
  const DEFAULT_EDGE = 0x00;
  const DEFAULT_EDGE_TYPE = 0;

  const styleAt = (styleRow, idx) => {
    if (!styleRow) return 0;
    const code = styleRow.charCodeAt(idx) - 48;
    return (code >= 0 && code <= 3) ? code : 0;
  };

  const getByte = (g, r, c, fallback) => {
    if (!g || !g[r] || g[r][c] == null) return fallback;
    return (Number(g[r][c]) & 0xff) >>> 0;
  };
  const getNibble = (g, r, c, fallback) => {
    if (!g || !g[r] || g[r][c] == null) return fallback;
    return (Number(g[r][c]) & 0x0f) >>> 0;
  };

  // Pick an initial pen state from the first non-space glyph we encounter.
  let initItalic = false;
  let initUnderline = false;
  let initFg = DEFAULT_FG;
  let initBg = DEFAULT_BG;
  let initEdgeColor6 = DEFAULT_EDGE;
  let initEdgeType = (w.dominantPen && typeof w.dominantPen === 'object')
    ? _clampInt(w.dominantPen.edgeType, 0, 7, DEFAULT_EDGE_TYPE)
    : DEFAULT_EDGE_TYPE;

  outer: for (let r = 0; r < Math.min(rc, grid.length); r++) {
    const rowStr = String(grid[r] || '');
    const maxLen = Math.min(cc, rowStr.length);
    for (let c = 0; c < maxLen; c++) {
      if (rowStr[c] === ' ') continue;
      const bits = styleAt(gridStyles[r] || '', c);
      initItalic = !!(bits & 0x01);
      initUnderline = !!(bits & 0x02);
      initFg = getByte(gridFg, r, c, DEFAULT_FG);
      initBg = getByte(gridBg, r, c, DEFAULT_BG);
      initEdgeColor6 = getByte(gridEdge, r, c, DEFAULT_EDGE) & 0x3f;
      initEdgeType = getNibble(gridEdgeType, r, c, initEdgeType) & 0x07;
      break outer;
    }
  }

  const basePenAttrs = {
    // Keep defaults intentionally conservative; we only guarantee round-trip
    // for edge type/color + i/u + colors in this step.
    fontTag: 3,
    edgeType: initEdgeType,
    edgeColor: initEdgeColor6
  };

  bytes.push(...buildSPA({ ...basePenAttrs, italic: initItalic, underline: initUnderline }));
  bytes.push(...buildSPCFromBytes(initFg, initBg, initEdgeColor6));

  let curItalic = initItalic;
  let curUnderline = initUnderline;
  let curEdgeType = initEdgeType;
  let curSpaEdgeColor6 = initEdgeColor6 & 0x3f;
  let curSpcEdgeColor6 = initEdgeColor6 & 0x3f;
  let curFg = initFg & 0xff;
  let curBg = initBg & 0xff;

  for (let r = 0; r < rc && r < grid.length; r++) {
    const rowStr = String(grid[r] || '');
    const maxLen = Math.min(cc, rowStr.length);
    let last = maxLen - 1;
    while (last >= 0 && rowStr[last] === ' ') last--;
    if (last < 0) continue;

    // Use explicit pen placement for fidelity; the snapshot already encodes row offsets.
    bytes.push(...buildSPL(r, 0));

    const styleRow = gridStyles[r] || '';
    for (let c = 0; c <= last; c++) {
      const ch = (c < rowStr.length) ? rowStr[c] : ' ';
      const bits = styleAt(styleRow, c);
      const italic = !!(bits & 0x01);
      const underline = !!(bits & 0x02);
      const edgeType = (getNibble(gridEdgeType, r, c, curEdgeType) & 0x07) >>> 0;
      const fg = getByte(gridFg, r, c, curFg);
      const bg = getByte(gridBg, r, c, curBg);
      const edgeColor6 = (getByte(gridEdge, r, c, curSpcEdgeColor6) & 0x3f) >>> 0;

      if (italic !== curItalic || underline !== curUnderline || edgeType !== curEdgeType || edgeColor6 !== curSpaEdgeColor6) {
        bytes.push(...buildSPA({ ...basePenAttrs, edgeType, edgeColor: edgeColor6, italic, underline }));
        curItalic = italic;
        curUnderline = underline;
        curEdgeType = edgeType;
        curSpaEdgeColor6 = edgeColor6;
      }

      if (fg !== curFg || bg !== curBg || edgeColor6 !== curSpcEdgeColor6) {
        bytes.push(...buildSPCFromBytes(fg, bg, edgeColor6));
        curFg = fg;
        curBg = bg;
        curSpcEdgeColor6 = edgeColor6;
      }

      _push708Char(bytes, ch);
    }
  }

  bytes.push(C0.ETX);
  return bytes;
}

// Build a 708 preload using a decoded window snapshot for DEFINE_WINDOW + SWA,
// but re-render NEW text lines using the normal styled-text encoder.
//
// Use-case:
//   - Imported MCC -> user edits cue TEXT -> export MCC.
//   - We want to preserve window placement/styling, even though the snapshot text
//     no longer matches.
//
// Notes:
//   - This does NOT attempt per-character style preservation from the original
//     grid (that would require a text diff and remapping). It *does* preserve:
//       * window definition (anchor, row/col count, priority, style IDs)
//       * window attributes (SWA)
//       * a reasonable base pen + pen colors (dominantPen), unless overridden.
function buildPreloadBytesForLinesWithWindowSnapshot(
  lines,
  windowSnapshot,
  {
    windowId = 0,
    justify = null,
    windowStyle = null,
    pen = null,
    penColor = null,
    // Optional explicit pen locations (per line): [{row, col}, ...] OR {row, col}
    penLocations = null
  } = {}
) {
  const w = (windowSnapshot && typeof windowSnapshot === 'object') ? windowSnapshot : {};
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));

  const rc = _clampInt(w.rowCount, 1, 15, 15);
  const cc = _clampInt(w.colCount, 1, 63, 42);
  const rel = (w.relative !== false);
  const anchorId = _clampInt(w.anchorId, 0, 8, 7);
  const anchorV = _clampInt(w.anchorV, 0, rel ? 99 : 74, 90);
  const anchorH = _clampInt(w.anchorH, 0, rel ? 99 : 209, 50);

  const priority = _clampInt(w.priority, 0, 7, 4);
  const rowLock = _clampInt(w.rowLock, 0, 1, 1);
  const colLock = _clampInt(w.colLock, 0, 1, 1);
  const windowStyleId = _clampInt(w.windowStyleId, 0, 7, 1);
  const penStyleId = _clampInt(w.penStyleId, 0, 7, 1);

  const bytes = [];
  bytes.push((C1.CW0 + wid) & 0xff);
  const mask = (1 << wid) & 0xff;
  bytes.push(C1.HDW, mask);
  bytes.push(C1.CLW, mask);

  bytes.push(...buildDefineWindowExact(wid, {
    rowCount: rc,
    colCount: cc,
    rel,
    anchorId,
    anchorV,
    anchorH,
    visible: 0,
    priority,
    rowLock,
    colLock,
    windowStyleId,
    penStyleId
  }));

  const justifyEff = String((justify != null) ? justify : (w.justify || 'left')).toLowerCase();
  const wsSnapshot = (w.windowStyle && typeof w.windowStyle === 'object') ? w.windowStyle : null;
  const ws = (windowStyle && typeof windowStyle === 'object') ? windowStyle : wsSnapshot;
  bytes.push(...buildSWA({ justify: justifyEff, ...(ws || {}) }));

  // Base pen style and color (dominant pen from snapshot, unless overridden).
  const dom = (w.dominantPen && typeof w.dominantPen === 'object') ? w.dominantPen : null;
  const domPen = (dom && dom.pen && typeof dom.pen === 'object') ? dom.pen : null;
  const domColor = (dom && dom.penColor && typeof dom.penColor === 'object') ? dom.penColor : null;

  const basePen = (pen && typeof pen === 'object') ? pen : (domPen || {});
  const basePenAttrs = {
    penSize: basePen.penSize,
    penOffset: basePen.penOffset,
    textTag: basePen.textTag,
    fontTag: basePen.fontTag,
    edgeType: basePen.edgeType,
    edgeColor: basePen.edgeColor
  };
  const initialItalic = !!basePen.italic;
  const initialUnderline = !!basePen.underline;
  bytes.push(...buildSPA({ ...basePenAttrs, italic: initialItalic, underline: initialUnderline }));

  const pc = (penColor && typeof penColor === 'object') ? penColor : domColor;
  if (pc) bytes.push(...buildSPC(pc));

  let penState = _ensurePenState({
    italicDepth: initialItalic ? 1 : 0,
    underlineDepth: initialUnderline ? 1 : 0,
    italic: initialItalic,
    underline: initialUnderline,
    basePenAttrs
  });

  const lineList = Array.isArray(lines) ? lines : [];
  const locs = _normalizePenLocations(penLocations, lineList.length);
  const last = lineList.length - 1;
  lineList.forEach((line, i) => {
    if (locs && locs[i]) {
      bytes.push(...buildSPL(locs[i].row, locs[i].col));
    }
    const enc = encodeStyledText(line || '', penState);
    bytes.push(...enc.bytes);
    penState = enc.state;
    if (!locs && i !== last) bytes.push(C0.CR);
  });

  bytes.push(C0.ETX);
  return bytes;
}

function buildHideBytes(windowId = 0) {
  const wid = Math.max(0, Math.min(7, Number(windowId) || 0));
  const mask = (1 << wid) & 0xff;
  return [C1.HDW, mask];
}



function buildHideBytesForMask(mask = 0) {
  const m = (Number(mask) | 0) & 0xff;
  return [C1.HDW, m];
}

function buildShowHideBytesForMasks({ showMask = 0, hideMask = 0 } = {}) {
  const show = (Number(showMask) | 0) & 0xff;
  const hide = (Number(hideMask) | 0) & 0xff;
  const bytes = [];
  if (hide) bytes.push(C1.HDW, hide);
  if (show) bytes.push(C1.DSW, show);
  return bytes;
}
function buildShowHideBytes({ showWindowId = 0, hideWindowId = null } = {}) {
  const showId = Math.max(0, Math.min(7, Number(showWindowId) || 0));
  const showMask = (1 << showId) & 0xff;
  const bytes = [];
  if (hideWindowId != null) {
    const hideId = Math.max(0, Math.min(7, Number(hideWindowId) || 0));
    const hideMask = (1 << hideId) & 0xff;
    bytes.push(C1.HDW, hideMask);
  }
  bytes.push(C1.DSW, showMask);
  return bytes;
}

// ---- Service block assembly ------------------------------------------------
function buildServiceBytesForLines(lines, { justify = 'left', colCount = 32, ...rest } = {}) {
  // Back-compat: preload into window 0 then display it.
  const bytes = [];
  bytes.push(...buildPreloadBytesForLines(lines, { windowId: 0, justify, colCount, ...rest }));
  bytes.push(...buildShowHideBytes({ showWindowId: 0, hideWindowId: null }));
  return bytes;
}

function buildServiceBytesForLineRuns(lineRuns, { justify = 'left', colCount = 32, ...rest } = {}) {
  // Back-compat: preload into window 0 then display it.
  const bytes = [];
  bytes.push(...buildPreloadBytesForLineRuns(lineRuns, { windowId: 0, justify, colCount, ...rest }));
  bytes.push(...buildShowHideBytes({ showWindowId: 0, hideWindowId: null }));
  return bytes;
}

// Split service data into <=31-byte service blocks, respecting command arities.
// We only emit a small subset of 708 commands; map them to their payload sizes.
function chunkToServiceBlocks(serviceBytes, serviceNumber = 1, maxBlockDataBytes = 31) {
  const out = [];
  let i = 0;
  while (i < serviceBytes.length) {
    const start = i;
    let size = 0;
    while (i < serviceBytes.length) {
      const b = serviceBytes[i];
      // Default = 1 (G0 text or ETX/CR)
      let tokLen = 1;
      if (b >= 0x80 && b <= 0x87) tokLen = 1;         // CWx
      else if (b === 0x88 || b === 0x89 || b === 0x8a || b === 0x8c) tokLen = 2; // CLW/DSW/HDW/DLW +1
      else if (b === 0x90) tokLen = 4;                // SPA +3
      else if (b === 0x91) tokLen = 4;                // SPC +3
      else if (b === 0x92) tokLen = 3;                // SPL +2
      else if (b === 0x97) tokLen = 5;                // SWA +4
      else if (b >= 0x98 && b <= 0x9f) tokLen = 7;    // DFx +6
      // If adding this token would exceed 31, flush the block first.
      if (size + tokLen > maxBlockDataBytes) break;
      i += tokLen;
      size += tokLen;
      if (size === maxBlockDataBytes) break;
    }
    const block = serviceBytes.slice(start, start + size);
    const hdr = ((serviceNumber & 0x07) << 5) | (block.length & 0x1f);
    out.push([hdr, ...block]);
  }
  return out;
}

// Pack service blocks into DTVCC packets (seq: 0..3).
// To satisfy CDP’s 31-triplet cap, keep payload ≤ 62 bytes (31 * 2).
function packDTVCC(serviceBlocks, opts = {}) {
  const packets = [];
  let seq = (Number(opts.seqStart) || 0) & 0x03;
  let cursor = [];
  const maxPacketBytes = Math.max(2, Math.floor(Number(opts.maxPacketBytes) || 62));
  const maxPayloadBytes = maxPacketBytes - 1; // exclude the 1-byte DTVCC packet header

  const flush = () => {
    if (!cursor.length) return;

    // Interop: cc_data carries bytes in 2-byte pairs. If (1 + packet_size) is odd,
    // we would have to emit a dangling pad byte at the cc_data layer. Some decoders
    // (notably certain NLE importers) misinterpret that pad as the next packet header
    // (often 0x00 → packet_size=0) and abort.
    //
    // Make payload length ODD so total packet bytes (header + payload) is EVEN.
    if ((cursor.length % 2) === 0) {
      if ((cursor.length + 1) > maxPayloadBytes) {
        throw new Error(`packDTVCC: need 1 byte of padding but payload is already at max (${maxPayloadBytes}).`);
      }
      cursor.push(0x00); // null service block header (service=0, block_size=0)
    }

    const size = cursor.length & 0x3f;
    const header = ((seq & 0x03) << 6) | size;
    packets.push(Uint8Array.from([header, ...cursor]));
    cursor = [];
    seq = (seq + 1) & 0x03;
  };

  for (const sb of serviceBlocks) {
    if (!sb || typeof sb.length !== 'number') {
      throw new Error('packDTVCC: invalid service block (expected an array of bytes).');
    }
    if (sb.length > maxPayloadBytes) {
      throw new Error(`packDTVCC: service block length ${sb.length} exceeds max payload ${maxPayloadBytes}.`);
    }
    if ((cursor.length + sb.length) > maxPayloadBytes) flush();
    cursor.push(...sb);
  }

  flush();

  // Backwards compatible return type + expose next seq for continuous sequencing.
  packets.nextSeq = seq;
  return packets;
}

// Build cc_data triplets for 708: one triplet per two payload bytes.
//
// NOTE (interoperability):
//   In ATSC A/53 / SCTE-128 style cc_data(), DTVCC (CEA-708) uses TWO cc_type values:
//     - cc_type=3 (binary '11') for "DTVCC packet start"
//     - cc_type=2 (binary '10') for "DTVCC packet data" (continuations)
//
//   Some downstream tools (notably NLE importers) will ignore CEA-708 data unless
//   they see a packet-start triplet. If we label *everything* as cc_type=2 (data)
//   then a decoder that is waiting for a start marker will never assemble packets.
//
//   This function assumes dtvccBytes begins with a DTVCC packet header byte.
//   The first triplet is flagged as "packet start" (cc_type=3) and the remaining
//   triplets are flagged as "packet data" (cc_type=2).
function buildCcDataTriplets(dtvccBytes, { packetStart = true } = {}) {
  const data = Array.isArray(dtvccBytes)
    ? dtvccBytes.map(b => b & 0xff)
    : Array.from(dtvccBytes || [], b => b & 0xff);
  if ((data.length % 2) !== 0) {
    throw new Error('buildCcDataTriplets: dtvccBytes length must be even (pad inside packDTVCC, not at cc_data layer).');
  }
  const triplets = [];
  for (let i = 0; i < data.length; i += 2) {
    const c1 = data[i] ?? 0x00;
    const c2 = data[i + 1] ?? 0x00;
    // cc_valid=1. cc_type=3 (start) for the first pair, cc_type=2 (data) thereafter.
    // 0xFF = 1111 1111b → cc_valid=1, cc_type=3 (DTVCC packet start)
    // 0xFE = 1111 1110b → cc_valid=1, cc_type=2 (DTVCC packet data)
    const hdr = (packetStart && i === 0) ? 0xFF : 0xFE;
    triplets.push([hdr, c1 & 0xff, c2 & 0xff]);
  }
  return triplets;
}

// Build cc_data triplets for 608 (field 1 by default) from 16-bit words (hex or number).
function buildCcDataTriplets608(words = [], field = 1) {
  const hdr = (field === 2) ? 0xFD : 0xFC; // 0xFC=608 F1, 0xFD=608 F2
  const out = [];
  for (const w of words) {
    const v = typeof w === 'string' ? parseInt(w, 16) : (w | 0);
    const hi = (v >> 8) & 0xff, lo = v & 0xff;
    out.push([hdr, hi, lo]);
  }
  return out;
}

function _sanitizeIso639_2(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  return /^[a-z]{3}$/.test(raw) ? raw : 'eng';
}

// Build the 6 service_data bytes as defined by ATSC A/65 caption_service_descriptor().
// Layout:
//   language[3]
//   digital_cc(1), reserved(1),
//     if digital_cc==0: reserved5('11111'), line21_field(1)
//     else: caption_service_number(6)
//   easy_reader(1), wide_aspect_ratio(1), reserved14('1's)
function _buildCcsSvcInfoServiceData({
  language = 'eng',
  digitalCc = true,
  serviceNumber = 1,
  line21Field = 0,
  easyReader = false,
  wideAspectRatio = true
} = {}) {
  const lang = _sanitizeIso639_2(language);
  const a = lang.charCodeAt(0) & 0xff;
  const b = lang.charCodeAt(1) & 0xff;
  const c = lang.charCodeAt(2) & 0xff;

  const digital = !!digitalCc;
  const svcNum = Math.max(0, Math.min(63, Number(serviceNumber) || 0)) & 0x3f;

  let byte4 = 0x00;
  if (digital) {
    // digital_cc=1, reserved=1, caption_service_number(6)
    byte4 = 0xC0 | svcNum; // 1100_0000 | service
  } else {
    // digital_cc=0, reserved=1, reserved5='11111', line21_field(1)
    const f = (Number(line21Field) ? 1 : 0) & 0x01;
    byte4 = 0x40 | 0x3E | f; // 01_11111f
  }

  const er = easyReader ? 1 : 0;
  const war = wideAspectRatio ? 1 : 0;
  const byte5 = (er << 7) | (war << 6) | 0x3F; // __111111
  const byte6 = 0xFF; // 11111111

  return [a, b, c, byte4 & 0xff, byte5 & 0xff, byte6 & 0xff];
}

// Build a CCSVCInfo section (0x73) for CDP.
// services: [{ serviceNumber, language, digitalCc, line21Field, easyReader, wideAspectRatio }]
// Notes:
//  - svc_count is 4-bit (max 15).
//  - We emit CSN Size = 0 (6-bit caption_service_number) for the full 0..63 range.
function buildCcsSvcInfoSection({
  services = [],
  start = true,
  change = true,
  complete = true
} = {}) {
  const list = Array.isArray(services) ? services : [];
  const svcCount = Math.max(0, Math.min(15, list.length | 0));

  const hdr =
    0x80 |
    (start ? 0x40 : 0) |
    (change ? 0x20 : 0) |
    (complete ? 0x10 : 0) |
    (svcCount & 0x0F);

  const out = [0x73, hdr & 0xff];

  for (let i = 0; i < svcCount; i++) {
    const svc = list[i] || {};
    const csn = Math.max(0, Math.min(63, Number(svc.serviceNumber) || 0)) & 0x3f;

    // service_construct: reserved=1, csn_size=0, csn(6)
    out.push((0x80 | csn) & 0xff);

    const data = _buildCcsSvcInfoServiceData({
      language: svc.language,
      digitalCc: (svc.digitalCc != null) ? !!svc.digitalCc : (csn !== 0),
      serviceNumber: csn,
      line21Field: svc.line21Field,
      easyReader: !!svc.easyReader,
      wideAspectRatio: (svc.wideAspectRatio != null) ? !!svc.wideAspectRatio : true
    });

    out.push(...data);
  }

  return Uint8Array.from(out);
}

function buildCdpForDtvcc({
  dtvccBytes = [],
  cc608WordsF1 = [],
  frameRateCode = 4,
  sequenceCounter = 0,       // use as a 16-bit seq counter for both header/footer
  // Optional CDP time_code_section (0x71 + 4 bytes) as defined by SMPTE ST 334-2.
  // Layout after 0x71 is a packed SMPTE 12M label:
  //   b1: reserved2='11', tc_10hrs(2), tc_1hrs(4)
  //   b2: reserved1='1',  tc_10min(3), tc_1min(4)
  //   b3: field_flag(1),  tc_10sec(3), tc_1sec(4)
  //   b4: drop_frame(1),  zero(1),     tc_10frm(2), tc_1frm(4)
  timecode = null,
  ccsvcInfo = null,          // optional: { services:[...], start, change, complete } OR Uint8Array(section bytes)
  includeChecksum = true,
  maxTriplets = 31,
  // When true, pad CC_DATA out to maxTriplets using invalid filler triplets (0xFA 00 00).
  // Some broadcast chains expect a fixed-size cc_data channel rather than cc_count=0 on empty frames.
  padCcDataToCapacity = false
} = {}) {
  // Guardrails: CC_DATA triplet count is 5-bit (0..31). Clamp maxTriplets into that range.
  let maxTripletsClamped = Number.isFinite(Number(maxTriplets)) ? Math.trunc(Number(maxTriplets)) : 31;
  if (maxTripletsClamped < 0) maxTripletsClamped = 0;
  if (maxTripletsClamped > 31) maxTripletsClamped = 31;
  const padToCapacity = !!padCcDataToCapacity;

  // CDP start + placeholder length
  const bytes = [0x96, 0x69, 0x00];

  // CDP header
  const cdpRateRes = ((frameRateCode & 0x0f) << 4) | 0x0f; // frame rate code + reserved bits set
  bytes.push(cdpRateRes);

  // Optional SMPTE 12M timecode section (0x71 + 4 bytes). Caller provides the fully formed section.
  const hasTimecode = Array.isArray(timecode) && timecode.length === 5 && timecode[0] === 0x71;

  // Optional CCSVCInfo (0x73) section (service number/language/etc.)
  let svcSection = null;
  let svcStart = false, svcChange = false, svcComplete = false;

  if (ccsvcInfo instanceof Uint8Array) {
    // Caller-provided section bytes (must include 0x73 + header byte).
    if (ccsvcInfo.length >= 2 && ccsvcInfo[0] === 0x73) {
      svcSection = ccsvcInfo;
      const h = ccsvcInfo[1] & 0xff;
      svcStart = !!(h & 0x40);
      svcChange = !!(h & 0x20);
      svcComplete = !!(h & 0x10);
    }
  } else if (ccsvcInfo && typeof ccsvcInfo === 'object') {
    const services = Array.isArray(ccsvcInfo.services) ? ccsvcInfo.services : [];
    if (services.length) {
      const start = (ccsvcInfo.start !== false);
      const change = (ccsvcInfo.change !== false);
      const complete = (ccsvcInfo.complete !== false);
      svcSection = buildCcsSvcInfoSection({ services, start, change, complete });
      svcStart = start;
      svcChange = change;
      svcComplete = complete;
    }
  }

  const hasSvcInfo = !!(svcSection && svcSection.length);

  // CDP header flags (CTA-708 / SMPTE 334-2):
  //   bit7 timecode_present
  //   bit6 ccdata_present
  //   bit5 service_info_present
  //   bit4 service_info_start
  //   bit3 service_info_change
  //   bit2 service_info_complete
  //   bit1 caption_service_active
  //   bit0 reserved (must be 1)
  let flags = 0x01; // reserved bit0 = 1
  flags |= 0x02;    // caption_service_active = 1 (widely accepted)
  flags |= 0x40;    // ccdata_present = 1 (we always emit 0x72)
  if (hasTimecode) flags |= 0x80;

  if (hasSvcInfo) {
    flags |= 0x20;
    if (svcStart) flags |= 0x10;
    if (svcChange) flags |= 0x08;
    if (svcComplete) flags |= 0x04;
  }

  bytes.push(flags & 0xff);

  // Header sequence counter (big-endian, 2 bytes)
  bytes.push((sequenceCounter >> 8) & 0xff, sequenceCounter & 0xff);

  // Optional timecode section
  if (hasTimecode) bytes.push(...timecode);

  // ---- CC Data section ----
  // Mix in-band CEA-608 words (F1) first, then DTVCC (708) bytes; cap to 31 triplets.
  const t608 = buildCcDataTriplets608(cc608WordsF1, 1); // [ [hdr,hi,lo], ... ]
  const t708 = buildCcDataTriplets(dtvccBytes);         // [ [0xFE,b1,b2], ... ]
  const ccTriplets = [...t608, ...t708].slice(0, Math.min(maxTripletsClamped, t608.length + t708.length));

  // Optional padding: fill the remaining capacity with invalid triplets.
  // 0xFA = 11111010b → cc_valid=0, cc_type=2 (reserved bits set). This exact pattern is
  // also explicitly supported by the Telestream MCC compression schema (G..O macros).
  if (padToCapacity && maxTripletsClamped > 0) {
    while (ccTriplets.length < maxTripletsClamped) ccTriplets.push([0xFA, 0x00, 0x00]);
  }

  const ccCount = Math.min(0x1f, ccTriplets.length);

  bytes.push(0x72);                     // CC_DATA section id
  bytes.push(0xE0 | (ccCount & 0x1f));  // marker '111' + 5-bit count

  for (let i = 0; i < ccCount; i++) {
    const [b0, b1, b2] = ccTriplets[i];
    bytes.push(b0 & 0xff, b1 & 0xff, b2 & 0xff);
  }

  // Optional service info section (must appear after CC_DATA, before footer)
  if (hasSvcInfo) bytes.push(...svcSection);

  // Footer: 0x74 + footer sequence (big-endian, 2 bytes)
  bytes.push(0x74, (sequenceCounter >> 8) & 0xff, sequenceCounter & 0xff);

  // cdp_length is the number of bytes in the entire CDP from the first byte of the
  // CDP identifier (0x96) through the packet checksum (inclusive). (SMPTE ST 334-2)
  // IMPORTANT: cdp_length participates in the checksum calculation, so we must set it
  // BEFORE we compute the checksum.
  const cdpLength = (bytes.length + (includeChecksum ? 1 : 0)) & 0xff;
  bytes[2] = cdpLength;

  if (includeChecksum) {
    // Two's complement so sum from 0x96 through checksum == 0 (mod 256)
    const sum = bytes.reduce((acc, b) => (acc + (b & 0xff)) & 0xff, 0);
    const checksum = (256 - sum) & 0xff;
    bytes.push(checksum);
  }

  return Uint8Array.from(bytes);
}

module.exports = {
  encodeG0,
  buildDefineWindow0,
  buildDefineWindow,
  buildDefineWindowExact,
  buildSWA,
  buildSPL,
  buildSPA,
  buildSPC,
  buildSPCFromBytes,
  buildServiceBytesForLines,
  buildServiceBytesForLineRuns,
  buildPreloadBytesForLines,
  buildPreloadBytesForLineRuns,
  buildPreloadBytesForLinesWithWindowSnapshot,
  buildPreloadBytesForLineRunsWithWindowSnapshot,
  buildPreloadBytesForWindowSnapshot,
  buildShowHideBytes,
  buildHideBytes,
  buildHideBytesForMask,
  buildShowHideBytesForMasks,
  wrapRunsToLines,
  chunkToServiceBlocks,
  packDTVCC,
  buildCcDataTriplets,
  buildCcDataTriplets608,
  buildCdpForDtvcc
};

// Why these bit layouts and sizes? They follow the command table and field diagrams
// in CTA-708 (C1 command codes, SWA 4-byte parameter block, DFx 6-byte parameter block,
// SPL 2-byte row/col) and the service-block / packet header bit allocations.
