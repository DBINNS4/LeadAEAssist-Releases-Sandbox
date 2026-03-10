'use strict';

/**
 * WebVTT parser + import utilities (dependency-light).
 *
 * Phase 7-ish goals:
 * - Robust WebVTT parsing (header blocks, NOTE/STYLE/REGION, cue IDs, cue settings)
 * - Convert parsed cues into the app's internal cue/segment objects
 * - Best-effort speaker extraction from common WebVTT patterns
 * - Optional conversion of WebVTT cue text markup (<i>/<u>/<c.class>) into your internal
 *   608-style tokens ({I}/{IU}/{Gr}/{GrU}/...) so round-tripping preserves intent.
 *
 * IMPORTANT:
 * - This is not a full WebVTT spec implementation.
 * - It is tuned for post-friendly interoperability and safe ingestion.
 */

const EPS_SEC = 0.001;

function normalizeNewlines(input) {
  return String(input || '').replace(/\r\n?/g, '\n');
}

function stripBom(line) {
  if (!line) return line;
  return line.charCodeAt(0) === 0xFEFF ? line.slice(1) : line;
}

function parseTimestampToSeconds(tsRaw) {
  const ts = String(tsRaw || '').trim();
  // HH:MM:SS.mmm
  // Spec canonical is 2+ digit hours, but real-world VTTs often use "0:00:01.000".
  // Be tolerant on ingest: allow 1+ digit hours (still require dot + 3ms digits).
  let m = ts.match(/^(\d{1,}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = Number(m[3]);
    const ms = Number(m[4]);
    if (![hh, mm, ss, ms].every(Number.isFinite)) return null;
    if (mm > 59 || ss > 59 || ms > 999) return null;
    return hh * 3600 + mm * 60 + ss + (ms / 1000);
  }
  // MM:SS.mmm (allowed by spec)
  // Spec canonical is 2+ digit minutes when hours are omitted, but tolerate
  // "0:01.000" style timestamps as they appear in the wild.
  m = ts.match(/^(\d{1,}):(\d{2})\.(\d{3})$/);
  if (m) {
    const mm = Number(m[1]);
    const ss = Number(m[2]);
    const ms = Number(m[3]);
    if (![mm, ss, ms].every(Number.isFinite)) return null;
    if (ss > 59 || ms > 999) return null;
    return mm * 60 + ss + (ms / 1000);
  }
  return null;
}

function parseCueSettings(tokens) {
  const settings = {};
  const settingsRaw = [];
  const unknownSettings = [];
  const duplicates = [];

  for (const t of (Array.isArray(tokens) ? tokens : [])) {
    const tok = String(t || '').trim();
    if (!tok) continue;
    settingsRaw.push(tok);

    const idx = tok.indexOf(':');
    if (idx === -1) {
      unknownSettings.push(tok);
      continue;
    }
    const key = tok.slice(0, idx).trim();
    const value = tok.slice(idx + 1).trim();
    if (!key) {
      unknownSettings.push(tok);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(settings, key)) duplicates.push(key);
    settings[key] = value;
  }

  return { settings, settingsRaw, unknownSettings, duplicates };
}

function parseCueTimingLine(lineRaw) {
  const line = String(lineRaw || '');
  const parts = line.split('-->');
  if (parts.length < 2) return { ok: false, reason: 'Missing --> delimiter' };

  const startRaw = parts[0].trim();
  const right = parts.slice(1).join('-->').trim();

  // end timestamp is first token on right side
  const tokens = right.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, reason: 'Missing end timestamp' };

  const endRaw = tokens[0].trim();
  const settingsTokens = tokens.slice(1);

  const start = parseTimestampToSeconds(startRaw);
  const end = parseTimestampToSeconds(endRaw);

  const { settings, settingsRaw, unknownSettings, duplicates } = parseCueSettings(settingsTokens);

  return {
    ok: (start != null && end != null),
    startRaw,
    endRaw,
    start,
    end,
    settings,
    settingsRaw,
    unknownSettings,
    duplicates,
    reason: (start == null || end == null) ? 'Invalid timestamp format' : ''
  };
}

function parseVTT(vttText) {
  const text = normalizeNewlines(vttText);
  const lines = text.split('\n');

  if (lines.length) lines[0] = stripBom(lines[0]);

  let i = 0;
  while (i < lines.length && !String(lines[i]).trim()) i++;

  const headerLineNo = i + 1;
  const header = (i < lines.length) ? String(lines[i] || '') : '';
  const headerValid = header.startsWith('WEBVTT');
  i++;

  const headerBlocks = [];
  const cues = [];

  const parseBlockUntilBlank = (type, startIdx) => {
    const startLineNo = startIdx + 1;
    const blockLines = [];
    let j = startIdx;
    for (; j < lines.length; j++) {
      const l = String(lines[j] ?? '');
      if (!l.trim() && blockLines.length) break;
      if (!l.trim() && !blockLines.length) break;
      blockLines.push(l);
    }
    return { type, startLineNo, endLineNo: j + 1, lines: blockLines, nextIdx: j };
  };

  // Header blocks must appear before cues.
  while (i < lines.length) {
    while (i < lines.length && !String(lines[i]).trim()) i++;
    if (i >= lines.length) break;

    const t = String(lines[i] || '').trim();
    if (t.startsWith('NOTE')) {
      const b = parseBlockUntilBlank('NOTE', i);
      headerBlocks.push({ ...b, inHeader: true });
      i = b.nextIdx;
      continue;
    }
    if (t === 'STYLE' || t.startsWith('STYLE ')) {
      const b = parseBlockUntilBlank('STYLE', i);
      headerBlocks.push({ ...b, inHeader: true });
      i = b.nextIdx;
      continue;
    }
    if (t === 'REGION' || t.startsWith('REGION ')) {
      const b = parseBlockUntilBlank('REGION', i);
      headerBlocks.push({ ...b, inHeader: true });
      i = b.nextIdx;
      continue;
    }
    break; // first cue
  }

  // Cues (and NOTE blocks that may appear later)
  while (i < lines.length) {
    while (i < lines.length && !String(lines[i]).trim()) i++;
    if (i >= lines.length) break;

    const t = String(lines[i] || '').trim();
    if (t.startsWith('NOTE')) {
      const b = parseBlockUntilBlank('NOTE', i);
      headerBlocks.push({ ...b, inHeader: false });
      i = b.nextIdx;
      continue;
    }
    if (t === 'STYLE' || t.startsWith('STYLE ') || t === 'REGION' || t.startsWith('REGION ')) {
      const kind = t.startsWith('REGION') ? 'REGION' : 'STYLE';
      const b = parseBlockUntilBlank(kind, i);
      headerBlocks.push({ ...b, inHeader: false });
      i = b.nextIdx;
      continue;
    }

    // Cue identifier is optional.
    let id = null;
    let timingLine = String(lines[i] || '');
    let timingLineNo = i + 1;

    if (!timingLine.includes('-->')) {
      id = timingLine;
      i++;
      if (i >= lines.length) break;
      timingLine = String(lines[i] || '');
      timingLineNo = i + 1;
    }

    const timingParsed = parseCueTimingLine(timingLine);
    i++;

    const textLines = [];
    const textStartLineNo = i + 1;
    while (i < lines.length && String(lines[i] ?? '').trim() !== '') {
      textLines.push(String(lines[i] ?? ''));
      i++;
    }

    cues.push({
      id,
      timingLine,
      timingLineNo,
      ...timingParsed,
      textLines,
      textStartLineNo
    });
  }

  return {
    header,
    headerValid,
    headerLineNo,
    headerBlocks,
    cues
  };
}

function decodeEntities(s) {
  let out = String(s || '');
  out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

  // Numeric decimal: &#123;
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return '';
    try { return String.fromCodePoint(code); } catch { return ''; }
  });

  // Numeric hex: &#x1F600;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16);
    if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return '';
    try { return String.fromCodePoint(code); } catch { return ''; }
  });

  return out;
}

function stripVttTags(s) {
  // Broad removal of cue-text tags.
  return String(s || '').replace(/<[^>]*>/g, '');
}

function inferSpeakerFromLine(lineRaw, { inferSpeakerFromTextPrefix = false } = {}) {
  const line = String(lineRaw || '');

  // 1) Voice tag: <v Name> ... </v>
  // Accept optional dot-classes on v tag, e.g. <v.class Name>
  const vOpen = line.match(/^\s*<v(?:\.[A-Za-z0-9_-]+)*\s+([^>]+)>\s*/i);
  if (vOpen) {
    const speaker = decodeEntities(String(vOpen[1] || '')).trim();
    const rest = line.slice(vOpen[0].length);
    return { speaker: speaker || null, restLine: rest };
  }

  // 2) Our writer's speaker markup: <c.speaker>NAME:</c> text
  const cSpeaker = line.match(/^\s*<c\.speaker>\s*([^<]*)\s*<\/c>\s*/i);
  if (cSpeaker) {
    const label = decodeEntities(String(cSpeaker[1] || '')).trim();
    const speaker = label.replace(/:\s*$/, '').trim();
    const rest = line.slice(cSpeaker[0].length);
    return { speaker: speaker || null, restLine: rest };
  }

  // 3) Optional heuristic: "NAME: text" (disabled by default)
  if (inferSpeakerFromTextPrefix) {
    // Conservative: allow letters/numbers/spaces/'- up to 32 chars, must be followed by a space.
    const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9 ' -]{0,31}):\s+(.*)$/);
    if (m) {
      const candidate = String(m[1] || '').trim();
      // Avoid obvious timestamp-like prefixes.
      if (!/^\d{1,2}:\d{2}/.test(candidate)) {
        return { speaker: candidate || null, restLine: String(m[2] || '') };
      }
    }
  }

  return { speaker: null, restLine: line };
}

function inferStyleFromLine(lineRaw) {
  const line = String(lineRaw || '');
  const italic = /<\/?i\b[^>]*>/i.test(line);
  const underline = /<\/?u\b[^>]*>/i.test(line);

  // Color classes our writer emits: c-wh, c-gr, c-bl, c-cy, c-r, c-y, c-ma
  const known = new Set(['c-wh', 'c-gr', 'c-bl', 'c-cy', 'c-r', 'c-y', 'c-ma']);
  let colorClass = null;

  // Find all <c...> open tags and scan their dot-classes.
  const cTags = line.match(/<c(?:\.[A-Za-z0-9_-]+)+>/gi) || [];
  for (const tag of cTags) {
    const inner = tag.slice(1, -1).trim();
    // inner like "c.c-gr.c-wh"
    const head = inner.split(/\s+/)[0] || '';
    const parts = head.split('.').filter(Boolean);
    // parts[0] is 'c'
    for (const cls of parts.slice(1)) {
      if (known.has(cls)) {
        colorClass = cls;
        break;
      }
    }
    if (colorClass) break;
  }

  return { italic, underline, colorClass };
}

function tokensForStyle({ italic, underline, colorClass }) {
  const out = [];
  const colorMap = {
    'c-wh': 'Wh',
    'c-gr': 'Gr',
    'c-bl': 'Bl',
    'c-cy': 'Cy',
    'c-r': 'R',
    'c-y': 'Y',
    'c-ma': 'Ma'
  };

  const colorTokenBase = colorClass ? (colorMap[colorClass] || null) : null;

  // If we have a color token, encode underline via the "U" suffix on the color token.
  if (colorTokenBase) {
    if (italic) out.push('{I}');
    out.push(`{${colorTokenBase}${underline ? 'U' : ''}}`);
    return out;
  }

  // No color token: use IU for italic+underline, I for italic.
  if (italic && underline) {
    out.push('{IU}');
    return out;
  }

  if (italic) out.push('{I}');
  if (underline) {
    // Best-effort: underline-only is represented as white underline in 608 mid-row attributes.
    out.push('{WhU}');
  }

  return out;
}

function cueSettingsToPlacementTags(settings = {}) {
  // Best-effort reverse mapping of our own export settings.
  // We DO NOT apply this by default (it would leak internal tags into editors).
  const lineRaw = settings?.line != null ? String(settings.line) : '';
  const posRaw = settings?.position != null ? String(settings.position) : '';
  const alignRaw = settings?.align != null ? String(settings.align) : '';

  const pctOf = (raw) => {
    const core = String(raw || '').split(',')[0].trim();
    const m = core.match(/^(-?\d+(?:\.\d+)?)%$/);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };

  const linePct = pctOf(lineRaw);
  const posPct = pctOf(posRaw);
  const align = String(alignRaw || '').trim().toLowerCase();

  let row = null;
  let col = null;

  // Invert our mapping: pct = ((row-1)/14) * 90
  if (linePct != null) {
    const clamped = Math.max(0, Math.min(90, linePct));
    const r = Math.round((clamped / 90) * 14 + 1);
    row = Math.max(1, Math.min(15, r));
  }

  // Invert our mapping heuristics.
  if (posPct != null || align) {
    if (align === 'start' || (posPct != null && posPct <= 20)) col = 0;
    else if (align === 'end' || (posPct != null && posPct >= 80)) col = 31;
    else col = 16;
  }

  const tags = [];
  if (row != null) tags.push(`{row:${row}}`);
  if (col != null) tags.push(`{col:${col}}`);
  return tags.join('');
}

function cueToInternalTextLines(cue, options = {}) {
  const {
    extractSpeaker = true,
    inferSpeakerFromTextPrefix = false,
    emit608Tokens = false,
    preserveLineBreaks = true,
    preservePlacementAsInternalTags = false
  } = options;

  const outLines = [];
  let speaker = null;

  const rawLines = Array.isArray(cue?.textLines) ? cue.textLines : [];
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine0 = String(rawLines[i] ?? '');
    if (!rawLine0.trim()) continue;

    // Speaker extraction only from the FIRST non-empty line.
    let rawLine = rawLine0;
    if (extractSpeaker && speaker == null) {
      const s = inferSpeakerFromLine(rawLine, { inferSpeakerFromTextPrefix });
      speaker = s.speaker;
      rawLine = s.restLine;
    }

    const style = inferStyleFromLine(rawLine);
    const plain = decodeEntities(stripVttTags(rawLine)).replace(/[\t ]+/g, ' ').trim();
    if (!plain) continue;

    let lineOut = plain;
    if (emit608Tokens) {
      const toks = tokensForStyle(style);
      if (toks.length) lineOut = toks.join('') + lineOut;
    }

    outLines.push(lineOut);
  }

  // Optional best-effort placement preservation: convert cue settings → internal {row}{col} tags.
  // Disabled by default to avoid leaking internal tags into UI/editor text.
  if (preservePlacementAsInternalTags && outLines.length) {
    const tags = cueSettingsToPlacementTags(cue?.settings || {});
    if (tags) outLines[0] = tags + outLines[0];
  }

  const text = preserveLineBreaks ? outLines.join('\n') : outLines.join(' ');
  return { speaker, text };
}

function cuesToSegments(parsedOrCues, options = {}) {
  const cues = Array.isArray(parsedOrCues)
    ? parsedOrCues
    : (parsedOrCues && Array.isArray(parsedOrCues.cues) ? parsedOrCues.cues : []);

  const segments = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!cue || !cue.ok) continue;
    if (typeof cue.start !== 'number' || typeof cue.end !== 'number') continue;
    if (!(cue.start + EPS_SEC < cue.end)) continue;

    const { speaker, text } = cueToInternalTextLines(cue, options);
    if (!String(text || '').trim()) continue;

    segments.push({
      id: cue.id != null ? cue.id : i,
      start: cue.start,
      end: cue.end,
      text,
      speaker: speaker || null,
      vtt: {
        settings: cue.settings || {},
        settingsRaw: cue.settingsRaw || []
      }
    });
  }
  return segments;
}

module.exports = {
  parseVTT,
  decodeEntities,
  cuesToSegments,
  cueToInternalTextLines,
  inferSpeakerFromLine,
  inferStyleFromLine,
  tokensForStyle,
  cueSettingsToPlacementTags
};
