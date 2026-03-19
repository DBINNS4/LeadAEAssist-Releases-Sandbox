// modules/mccDecoder.js
'use strict';

const fs = require('fs');
const path = require('path');
const { framesFromTimecodeLabel, framesToSeconds, nominalFrameBase } = require('../utils/timeUtils');
const { decodeSccText } = require('./sccDecoder');
const { decodeDtvccFramesToCues } = require('./cea708Decoder');

// NOTE: MCC can carry both 708 DTVCC + 608 compatibility bytes. We prefer 708 for text,
// but we must still recover 608 PAC placement for professional round-trip behavior.

// ---------------------------------------------------------------------------
// MacCaption (.mcc) decoder
//
// Scope:
//  - Parse MCC header metadata (fps, DF, service, language)
//  - Parse each payload line, supporting both raw hex and Telestream-style macros
//  - Extract SMPTE-291 ANC payload → CDP → CC_DATA triplets
//  - Prefer native CEA-708 (DTVCC) decode when present (service-based)
//  - Fallback to the CEA-608 compatibility bytes (cc_type 0/1) when needed by
//    converting recovered 608 words to a pseudo-SCC stream and feeding the SCC decoder.
//
// Notes:
//  - MCC timecode lines commonly use ':' even for drop-frame. We treat DF as a hint
//    from the header/opts and normalize delimiters as needed.
// ---------------------------------------------------------------------------

function _stripBom(s) {
  return String(s || '').replace(/^\uFEFF/, '');
}

function _parseBool(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

function _parseCaptionServiceValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return 1;

  // Common MCC headers use "CC1".."CC4" (608-style label) even though the field is named "Caption Service".
  let m = /^CC\s*([1-4])$/i.exec(s);
  if (m) return parseInt(m[1], 10);

  // 708 service label
  m = /^SERVICE\s*([0-9]{1,2})$/i.exec(s);
  if (m) return Math.max(1, Math.min(63, parseInt(m[1], 10) || 1));

  // Plain integer
  m = /^([0-9]{1,2})$/.exec(s);
  if (m) return Math.max(1, Math.min(63, parseInt(m[1], 10) || 1));

  // Fallback: first integer anywhere in the string
  m = /([0-9]{1,2})/.exec(s);
  if (m) return Math.max(1, Math.min(63, parseInt(m[1], 10) || 1));

  return 1;
}

function _parseTimeCodeRate(rateStr) {
  const raw = String(rateStr || '').trim();
  if (!raw) return { fps: null, dropFrameFromRate: null, nominalBase: null, isNominal: false };
  const compact = raw.replace(/\s+/g, '');
  const m = /^([0-9]+(?:\.[0-9]+)?)(DF)?$/i.exec(compact);
  if (!m) return { fps: null, dropFrameFromRate: null, nominalBase: null, isNominal: false };

  const numStr = m[1];
  const hasDf = !!m[2];
  const hasDecimal = numStr.includes('.');
  const n = parseFloat(numStr);
  if (!Number.isFinite(n) || n <= 0) return { fps: null, dropFrameFromRate: hasDf ? true : null, nominalBase: null, isNominal: false };

  const nominalBase = hasDecimal ? nominalFrameBase(n) : parseInt(numStr, 10);
  const isNominal = !hasDecimal;

  // If DF suffix is present, interpret nominal 30/60 as 29.97/59.94.
  let fps = n;
  if (hasDf) {
    if (Math.abs(fps - 30) < 0.06) fps = 29.97;
    if (Math.abs(fps - 60) < 0.12) fps = 59.94;
  }

  return { fps, dropFrameFromRate: hasDf ? true : null, nominalBase: Number.isFinite(nominalBase) ? nominalBase : null, isNominal };
}

function _parseHeader(lines) {
  // MCC files in the wild often contain a descriptive comment block (// ...)
  // and additional metadata keys, sometimes separated by blank lines.
  // Treat the header as "everything before the first timecode line".
  const meta = {};
  let dataStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i] || '').replace(/\r/g, '');
    const line = raw.trim();

    if (!line) {
      // Blank lines are allowed inside the header; keep scanning.
      dataStartIndex = i + 1;
      continue;
    }

    const firstTok = line.split(/\s+/)[0] || '';
    if (/^\d{2}:\d{2}:\d{2}[:;]\d{2}(?:\.\d+,\d+)?$/.test(firstTok)) {
      dataStartIndex = i;
      return { meta, dataStartIndex };
    }

    // Header comments/decorative lines are allowed; ignore them.
    if (/^(\/\/|#)/.test(line)) {
      dataStartIndex = i + 1;
      continue;
    }

    const m = /^([^=]+)=(.*)$/.exec(line);
    if (!m) {
      // Unknown decorative header line
      dataStartIndex = i + 1;
      continue;
    }

    const key = String(m[1] || '').trim().toLowerCase();
    const val = String(m[2] || '').trim();
    meta[key] = val;
    dataStartIndex = i + 1;
  }

  return { meta, dataStartIndex };
}


function _normalizeHeaderKey(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function _getMetaValue(meta, candidates) {
  if (!meta || typeof meta !== 'object') return null;
  const normToKey = new Map();
  for (const k of Object.keys(meta)) {
    normToKey.set(_normalizeHeaderKey(k), k);
  }
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const c of list) {
    const key = normToKey.get(_normalizeHeaderKey(c));
    if (key != null) return meta[key];
  }
  return null;
}


function _fpsFromCdpFrameRateCode(code) {
  const c = Number(code);
  // CEA-708 CDP frame rate code:
  //  1=23.976, 2=24, 3=25, 4=29.97, 5=30, 6=50, 7=59.94, 8=60
  switch (c) {
    case 1: return 23.976;
    case 2: return 24;
    case 3: return 25;
    case 4: return 29.97;
    case 5: return 30;
    case 6: return 50;
    case 7: return 59.94;
    case 8: return 60;
    default: return null;
  }
}

function _parseMccPayloadStream(payloadStr, { strict = false } = {}) {
  // Stream parser:
  //  - supports contiguous hex (no spaces)
  //  - supports Telestream single-letter macros embedded anywhere
  //  - ignores whitespace anywhere (even between nibbles)
  const raw = String(payloadStr || '');
  const bytes = [];
  const errors = [];
  const push = (...arr) => { for (const b of arr) bytes.push(b & 0xff); };
  const isWs = (c) => /\s/.test(c);
  const isHex = (c) => /^[0-9A-F]$/.test(c);

  let i = 0;
  while (i < raw.length) {
    const chRaw = raw[i];
    if (isWs(chRaw)) { i++; continue; }
    const ch = String(chRaw).toUpperCase();

    if (ch === 'T') { push(0x61, 0x01); i++; continue; }
    if (ch === 'S') { push(0x96, 0x69); i++; continue; }
    if (ch === 'P') { push(0xFB, 0x80, 0x80); i++; continue; }
    if (ch === 'Q') { push(0xFC, 0x80, 0x80); i++; continue; }
    if (ch === 'R') { push(0xFD, 0x80, 0x80); i++; continue; }
    if (ch === 'U') { push(0xE1, 0x00, 0x00, 0x00); i++; continue; }
    if (ch === 'Z') { push(0x00); i++; continue; }
    if (ch >= 'G' && ch <= 'O') {
      const n = (ch.charCodeAt(0) - 'G'.charCodeAt(0)) + 1;
      for (let k = 0; k < n; k++) push(0xFA, 0x00, 0x00);
      i++;
      continue;
    }

    if (isHex(ch)) {
      const hi = ch;
      i++;
      while (i < raw.length && isWs(raw[i])) i++;
      if (i >= raw.length) {
        errors.push({ index: i - 1, message: `Dangling hex nibble '${hi}' at end of payload.` });
        if (strict) break;
        continue;
      }
      const loRaw = raw[i];
      const lo = String(loRaw).toUpperCase();
      if (!isHex(lo)) {
        errors.push({ index: i, message: `Expected hex nibble after '${hi}', got '${loRaw}'.` });
        if (strict) break;
        continue;
      }
      bytes.push(parseInt(hi + lo, 16) & 0xff);
      i++;
      continue;
    }

    errors.push({ index: i, message: `Unknown MCC payload character '${chRaw}'.` });
    if (strict) break;
    i++;
  }

  return { bytes: Uint8Array.from(bytes), errors };
}

function _decompressMccPayload(payloadStr, opts = {}) {
  return _parseMccPayloadStream(payloadStr, opts).bytes;
}

function _findSubsequence(bytes, a, b) {
  if (!bytes || bytes.length < 2) return -1;
  for (let i = 0; i < bytes.length - 1; i++) {
    if ((bytes[i] & 0xff) === a && (bytes[i + 1] & 0xff) === b) return i;
  }
  return -1;
}

function _extractUserDataFromAnc(bytes) {
  // ANC packet in our encoder: [DID=0x61, SDID=0x01, DC, ...UDW..., checksum]
  const idx = _findSubsequence(bytes, 0x61, 0x01);
  if (idx < 0) return null;
  const dc = bytes[idx + 2];
  if (!Number.isFinite(dc)) return null;
  const start = idx + 3;
  const end = start + (dc & 0xff);
  if (end > bytes.length) return null;
  const userData = bytes.slice(start, end);
  const ancChecksum = bytes[end];
  return { did: 0x61, sdid: 0x01, dc: dc & 0xff, userData, ancChecksum };
}

function _extractCcTripletsFromCdp(userDataBytes) {
  // CDP: starts with 0x96 0x69.
  const pos = _findSubsequence(userDataBytes, 0x96, 0x69);
  if (pos < 0) return { triplets: [], dtvccBytes: [], has708: false, frameRateCode: null };
  const len = userDataBytes[pos + 2];
  if (!Number.isFinite(len)) return { triplets: [], dtvccBytes: [], has708: false, frameRateCode: null };
  // SMPTE ST 334-2: cdp_length indicates the number of bytes in the *entire* CDP,
  // from the first byte of the CDP identifier (0x96) through packet_checksum inclusive.
  // Some legacy/non-compliant encoders historically wrote cdp_length excluding the first 3 bytes
  // (cdp_identifier + cdp_length field). Detect that variant heuristically.
  const declared = (len & 0xff);

  const looksLikeCdpLen = (L) => {
    if (!Number.isFinite(L) || L < 7) return false;
    const end = pos + L;
    if (end > userDataBytes.length) return false;
    // Footer id 0x74 should be located 4 bytes from the end (0x74, seqHi, seqLo, checksum)
    return (userDataBytes[end - 4] & 0xff) === 0x74;
  };

  let total = declared;
  if (!looksLikeCdpLen(total) && looksLikeCdpLen(declared + 3)) {
    total = declared + 3;
  }
  const end = Math.min(userDataBytes.length, pos + total);
  const cdp = userDataBytes.slice(pos, end);

  // CDP frame rate code is stored in the high nibble of byte 3.
  const frameRateCode = (cdp.length > 3) ? ((cdp[3] >> 4) & 0x0f) : null;

  // Find CC_DATA section (0x72).
  //
  // IMPORTANT: Do NOT use `cdp.indexOf(0x72)` blindly: 0x72 can legally appear inside the
  // DTVCC byte stream, and some NLEs/broadcast chains embed optional sections (0x71 timecode,
  // 0x73 service info) which shift offsets.
  //
  // Our encoder writes:
  //   [0] 0x96 [1] 0x69 [2] len [3] rate/res [4] flags [5] seqHi [6] seqLo
  //   [7...] optional 0x71 section (5 bytes) if flags.timecode_present
  //   then 0x72 CC_DATA
  const flags = (cdp.length > 4) ? (cdp[4] & 0xff) : 0;
  let ptr = 7;

  // Optional timecode section (0x71 + 4 bytes)
  if ((flags & 0x80) !== 0) {
    if (ptr < cdp.length && (cdp[ptr] & 0xff) === 0x71 && (ptr + 5) <= cdp.length) {
      ptr += 5;
    } else {
      // Fallback: scan forward for a plausible 0x71 section and skip it.
      for (let i = ptr; i < cdp.length - 5; i++) {
        if ((cdp[i] & 0xff) === 0x71) {
          ptr = i + 5;
          break;
        }
      }
    }
  }

  // Scan forward for CC_DATA. Validate the next byte has the 0xE0 marker (111xxxxx).
  let idx72 = -1;
  for (let i = ptr; i < cdp.length - 2; i++) {
    if ((cdp[i] & 0xff) === 0x72 && ((cdp[i + 1] & 0xe0) === 0xe0)) { idx72 = i; break; }
  }

  if (idx72 < 0 || idx72 + 2 >= cdp.length) {
    return { triplets: [], dtvccBytes: [], has708: false, frameRateCode };
  }

  const ccCountByte = cdp[idx72 + 1];
  const ccCount = (ccCountByte & 0x1f);
  const start = idx72 + 2;
  const triplets = [];
  const dtvccBytes = [];
  let has708 = false;

  for (let i = 0; i < ccCount; i++) {
    const o = start + (i * 3);
    if (o + 2 >= cdp.length) break;
    const b0 = cdp[o] & 0xff;
    const b1 = cdp[o + 1] & 0xff;
    const b2 = cdp[o + 2] & 0xff;

    const ccValid = (b0 & 0x04) !== 0;
    const ccType = (b0 & 0x03);

    if (ccValid && (ccType === 0 || ccType === 1)) {
      // 608 (field 1 / field 2) — pack bytes back into a 16-bit SCC word.
      triplets.push({ kind: '608', field: (ccType === 0 ? 1 : 2), word: ((b1 << 8) | b2) & 0xffff });
    } else if (ccValid && (ccType === 2 || ccType === 3)) {
      has708 = true;
      dtvccBytes.push(b1, b2);
    }
  }

  return { triplets, dtvccBytes, has708, frameRateCode };
}

function _parseCaptionOffsetToSeconds(value, fps) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  const sign = raw.startsWith('-') ? -1 : 1;
  const body = (raw.startsWith('-') || raw.startsWith('+')) ? raw.slice(1).trim() : raw;

  const tc = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(body);
  if (tc) {
    const hh = Number(tc[1]);
    const mm = Number(tc[2]);
    const ss = Number(tc[3]);
    const ff = Number(tc[4]);
    const nominal = nominalFrameBase(fps);
    if (![hh, mm, ss, ff, nominal].every(Number.isFinite)) {
      throw new Error(`Invalid timecodeOffset: ${raw}`);
    }
    const frames = ((hh * 3600 + mm * 60 + ss) * nominal) + ff;
    return sign * (Math.trunc(frames) / (Number(fps) || nominal));
  }

  const fm = /^(\d+(?:\.\d+)?)\s*(f|fr|frame|frames)$/i.exec(body);
  if (fm) {
    const f = Number(fm[1]);
    if (!Number.isFinite(f)) throw new Error(`Invalid timecodeOffset: ${raw}`);
    return sign * (Math.trunc(f) / (Number(fps) || 30));
  }

  const sm = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds)?$/i.exec(body);
  if (sm) {
    const sec = Number(sm[1]);
    if (!Number.isFinite(sec)) throw new Error(`Invalid timecodeOffset: ${raw}`);
    return sign * sec;
  }

  throw new Error(`Invalid timecodeOffset: ${raw}`);
}

function decodeMccText(rawText, opts = {}) {
  const text = _stripBom(rawText);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const { meta, dataStartIndex } = _parseHeader(lines);

  const rateRaw = _getMetaValue(meta, ['time code rate', 'timecode rate', 'timecoderate', 'time_code_rate']);
  const dropRaw = _getMetaValue(meta, ['drop frame', 'dropframe', 'drop_frame']);
  const svcRaw  = _getMetaValue(meta, ['caption service', 'captionservice', 'caption_service', 'service', 'service number', 'captionservicenumber']);
  const langRaw = _getMetaValue(meta, ['language', 'lang', 'iso639', 'iso 639']);

  const rate = _parseTimeCodeRate(rateRaw);
  const fpsOpt = (Number.isFinite(Number(opts.fps)) && Number(opts.fps) > 0) ? Number(opts.fps) : null;
  let fps = fpsOpt != null ? fpsOpt : (rate.fps || 29.97);

  const headerDrop = _parseBool(dropRaw);
  let dropFrame = (typeof opts.dropFrame === 'boolean')
    ? opts.dropFrame
    : (headerDrop != null ? headerDrop : (rate.dropFrameFromRate != null ? rate.dropFrameFromRate : null));
  if (dropFrame === true && Number.isFinite(fps)) {
    // Some MCC headers specify nominal DF rates (30/60) while timecode math is 29.97/59.94.
    if (Math.abs(fps - 30) < 0.06) fps = 29.97;
    if (Math.abs(fps - 60) < 0.12) fps = 59.94;
  }

  const headerServiceNumber = _parseCaptionServiceValue(svcRaw);
  const explicitServiceRequest =
    Object.prototype.hasOwnProperty.call(opts, 'serviceNumber') ||
    Object.prototype.hasOwnProperty.call(opts, 'serviceNumbers') ||
    Object.prototype.hasOwnProperty.call(opts, 'allServices');
  const requestedServiceNumber = explicitServiceRequest ? opts.serviceNumber : headerServiceNumber;
  const requestedServiceSpec = (() => {
    if (!explicitServiceRequest) return null;
    if (opts.allServices === true) return 'all';
    if (Object.prototype.hasOwnProperty.call(opts, 'serviceNumber')) return opts.serviceNumber;
    if (Array.isArray(opts.serviceNumbers)) return opts.serviceNumbers.slice();
    return null;
  })();
  const language = String(langRaw || 'eng').trim().toLowerCase();
  const safeLanguage = /^[a-z]{3}$/.test(language) ? language : 'eng';

  let dfHint = (typeof dropFrame === 'boolean') ? dropFrame : null;
  const keepAbsolute = opts.keepAbsoluteTimecode === true || opts.shiftToZero === false;

  const _normalizeTcDelimiter = (tc) => {
    const m = String(tc || '').trim().match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
    if (!m) return String(tc || '').trim();
    const sep = (dfHint === true) ? ';' : ':';
    return `${m[1]}${sep}${m[2]}`;
  };

  const _forceSccDelimiterForDf = (tc) => {
    // SCC decoder infers DF from ';'. MCC usually stores ':' even for DF.
    if (dfHint !== true) return String(tc || '').trim();
    const m = String(tc || '').trim().match(/^(\d{2}:\d{2}:\d{2})[:;](\d{2})$/);
    if (!m) return String(tc || '').trim();
    return `${m[1]};${m[2]}`;
  };

  const importWarnings = [];
  const importErrors = [];

  const strictPayloadParse = opts.strictPayloadParse === true;
  let payloadParseWarned = 0;
  let payloadParseErrorCount = 0;

  // Caption slip / offset (post-production). Shifts all cues earlier/later by a fixed amount.
  // NOTE: We delay converting frame/timecode-based offsets to seconds until after fps is finalized
  // (CDP-derived fps can override the header/default).
  let timecodeOffsetPolicy = String(opts.timecodeOffsetPolicy ?? opts.offsetPolicy ?? 'clamp').trim().toLowerCase();
  if (!['clamp', 'error'].includes(timecodeOffsetPolicy)) timecodeOffsetPolicy = 'clamp';

  const slipSpec = (() => {
    if (Number.isFinite(Number(opts.timecodeOffsetFrames))) {
      return { kind: 'frames', frames: Math.trunc(Number(opts.timecodeOffsetFrames)) };
    }
    if (Number.isFinite(Number(opts.timecodeOffsetSeconds))) {
      return { kind: 'seconds', seconds: Number(opts.timecodeOffsetSeconds) };
    }
    if (typeof opts.timecodeOffset === 'string' && opts.timecodeOffset.trim()) {
      return { kind: 'raw', raw: String(opts.timecodeOffset).trim() };
    }
    return { kind: 'none' };
  })();

  let slipSec = 0;

  const _applySlipToCues = (cues) => {
    if (!slipSec) return cues;
    const shifted = (cues || []).map((c) => {
      const s = (Number(c.start) || 0) + slipSec;
      const e = (Number(c.end) || 0) + slipSec;
      return { ...c, start: s, end: e };
    });

    if (timecodeOffsetPolicy === 'error' && shifted.some(c => (Number(c.start) || 0) < 0 || (Number(c.end) || 0) < 0)) {
      throw new Error('MCC import timecodeOffset would push one or more cues before 00:00:00:00.');
    }

    for (const c of shifted) {
      if ((Number(c.start) || 0) < 0) c.start = 0;
      if ((Number(c.end) || 0) < 0) c.end = 0;
      if ((Number(c.end) || 0) < (Number(c.start) || 0)) c.end = c.start;
    }

    return shifted;
  };

  const timecodesSeen = [];
  // Collect recovered 608 SCC words as { tc, word }
  const recovered = [];
  const dtvccFramesRaw = [];
  let saw708 = false;
  let sawAnyCc = false;
  let sawV2TimecodeSuffix = false;
  let sawSemicolonTimecodeDelimiter = false;
  const v2TimecodeSuffixes = new Set();
  const v2TimecodeSuffixCounts = new Map();
  let detectedCdpFrameRateCode = null;
  let cdpFrameRateCodeConflicts = 0;

  for (let i = dataStartIndex; i < lines.length; i++) {
    const raw = String(lines[i] || '').trim();
    if (!raw) continue;
    if (/^\s*\/\//.test(raw)) continue;

    const m = /^(\d{2}:\d{2}:\d{2}[:;]\d{2})(?:\.(\d+),(\d+))?\s+(.+)$/.exec(raw);
    if (!m) continue;
    const tcBase = m[1];
    if (tcBase.includes(';')) sawSemicolonTimecodeDelimiter = true;
    const tcSuffixField = (m[2] != null) ? Math.trunc(Number(m[2])) : null;
    const tcSuffixLine = (m[3] != null) ? Math.trunc(Number(m[3])) : null;
    const payload = m[4];

    if (tcSuffixField != null || tcSuffixLine != null) {
      sawV2TimecodeSuffix = true;
      if (Number.isFinite(tcSuffixField) && Number.isFinite(tcSuffixLine)) {
        const key = `${tcSuffixField},${tcSuffixLine}`;
        v2TimecodeSuffixes.add(key);
        v2TimecodeSuffixCounts.set(key, (v2TimecodeSuffixCounts.get(key) || 0) + 1);
      } else {
        v2TimecodeSuffixes.add('invalid');
      }
    }

    timecodesSeen.push(tcBase);

    const parsed = _parseMccPayloadStream(payload, { strict: strictPayloadParse });
    const bytes = parsed.bytes || new Uint8Array();
    if (parsed.errors && parsed.errors.length) {
      payloadParseErrorCount += parsed.errors.length;
      if (strictPayloadParse) {
        importErrors.push(`MCC payload parse error at ${tcBase} (line ${i + 1}): ${parsed.errors[0].message}`);
        continue;
      }
      for (const e of parsed.errors) {
        if (payloadParseWarned >= 5) break;
        importWarnings.push(`MCC payload parse issue at ${tcBase} (line ${i + 1}): ${e.message}`);
        payloadParseWarned++;
      }
    }
    if (!bytes.length) continue;

    const anc = _extractUserDataFromAnc(bytes);
    if (!anc || !anc.userData || !anc.userData.length) continue;

    const { triplets, dtvccBytes, has708, frameRateCode } = _extractCcTripletsFromCdp(anc.userData);
    if (frameRateCode != null) {
      if (detectedCdpFrameRateCode == null) detectedCdpFrameRateCode = frameRateCode;
      else if (detectedCdpFrameRateCode !== frameRateCode) cdpFrameRateCodeConflicts += 1;
    }
    if (has708) saw708 = true;
    if (triplets.length || (dtvccBytes && dtvccBytes.length)) sawAnyCc = true;
    if (dtvccBytes && dtvccBytes.length) dtvccFramesRaw.push({ tc: tcBase, dtvccBytes });
    for (const t of triplets) {
      if (t.kind !== '608') continue;
      recovered.push({ tc: tcBase, word: t.word });
    }
  }

  if (!strictPayloadParse && payloadParseErrorCount > payloadParseWarned && payloadParseErrorCount > 0) {
    importWarnings.push(`(MCC payload parse warnings truncated; ${payloadParseErrorCount} total issues found.)`);
  }

  // MCC V2.0 timecode suffixes: ".<field>,<line>" (example: .0,9)
  // These do NOT affect timing math (we still use only the base timecode label),
  // but we retain them so an import → export round-trip can preserve the suffix.
  let detectedMccTimecodeSuffix = null;
  let detectedMccTimecodeSuffixes = null;

  if (sawV2TimecodeSuffix) {
    const valid = Array.from(v2TimecodeSuffixes).filter(k => k !== 'invalid');
    detectedMccTimecodeSuffixes = valid.length ? valid : null;

    if (valid.length) {
      // Choose the most common suffix (fallback to first-seen if counts are missing).
      let bestKey = valid[0];
      let bestCount = v2TimecodeSuffixCounts.get(bestKey) || 0;
      for (const k of valid) {
        const c = v2TimecodeSuffixCounts.get(k) || 0;
        if (c > bestCount) {
          bestKey = k;
          bestCount = c;
        }
      }

      const parts = String(bestKey).split(',');
      const f = Math.trunc(Number(parts[0]));
      const l = Math.trunc(Number(parts[1]));
      if (Number.isFinite(f) && Number.isFinite(l)) {
        detectedMccTimecodeSuffix = { field: f, line: l };
      }
    }

    const list = Array.from(v2TimecodeSuffixes).slice(0, 5).join(' | ');
    const more = v2TimecodeSuffixes.size > 5 ? ` (+${v2TimecodeSuffixes.size - 5} more)` : '';
    if (detectedMccTimecodeSuffix) {
      const chosen = `.${detectedMccTimecodeSuffix.field},${detectedMccTimecodeSuffix.line}`;
      const extra = (detectedMccTimecodeSuffixes && detectedMccTimecodeSuffixes.length > 1)
        ? ' Multiple suffix values were found; the most common value will be used on export unless overridden.'
        : '';
      importWarnings.push(`MCC timecode suffixes (".<field>,<line>") were detected (${list}${more}); retained for round-trip export (mccTimecodeSuffix=${chosen}).${extra}`);
    } else {
      importWarnings.push(`MCC timecode suffixes (".<field>,<line>") were detected (${list}${more}); none were valid, so export will omit them.`);
    }
  }

  // Decide final fps:
  //  1) explicit opts.fps
  //  2) CDP frame rate code (most reliable)
  //  3) MCC header value (may be nominal/base-only)
  const detectedFps = (detectedCdpFrameRateCode != null) ? _fpsFromCdpFrameRateCode(detectedCdpFrameRateCode) : null;
  if (cdpFrameRateCodeConflicts > 0) {
    importWarnings.push(`MCC stream contains conflicting CDP frame rate codes; imported using the first code seen (${detectedCdpFrameRateCode}).`);
  }
  if (fpsOpt == null && detectedFps) {
    if (!rate.isNominal && Number.isFinite(rate.fps) && Math.abs(rate.fps - detectedFps) > 0.01) {
      importWarnings.push(`MCC header Time Code Rate=${String(rateRaw).trim()} disagrees with CDP frame rate code; using ${detectedFps}fps from CDP.`);
    }
    fps = detectedFps;
  }
  if (fpsOpt == null && !detectedFps && rate.isNominal && Number.isFinite(rate.nominalBase) && dropFrame !== true) {
    const base = rate.nominalBase;
    let assumed = base;
    if (base === 24) assumed = 23.976;
    if (base === 30) assumed = 29.97;
    if (base === 60) assumed = 59.94;
    if (assumed !== fps) {
      fps = assumed;
      importWarnings.push(`MCC Time Code Rate=${String(rateRaw).trim()} is nominal; assumed ${assumed}fps (override with an explicit FPS if your media is true ${base}.0).`);
    }
  }
  if (dropFrame === true && Number.isFinite(fps)) {
    if (Math.abs(fps - 30) < 0.06) fps = 29.97;
    if (Math.abs(fps - 60) < 0.12) fps = 59.94;
  }

  // Infer drop-frame if the file uses ';' timecode and the header didn't explicitly say.
  // (Some sources omit "Drop Frame=True" but still use DF timecode labels.)
  if (typeof dropFrame !== 'boolean') {
    const nominal = nominalFrameBase(fps);
    const dfCapable = (nominal === 30 || nominal === 60);
    if (sawSemicolonTimecodeDelimiter && dfCapable) {
      dropFrame = true;
      dfHint = true;
      // Normalize nominal base rates to their DF timebase.
      if (Math.abs(fps - 30) < 0.06) fps = 29.97;
      if (Math.abs(fps - 60) < 0.12) fps = 59.94;
      importWarnings.push('MCC header did not specify Drop Frame, but semicolon timecode was found; assuming drop-frame.');
    }
  }

  // Resolve timecodeOffset now that fps is finalized.
  try {
    if (slipSpec.kind === 'frames') {
      slipSec = (slipSpec.frames / (Number(fps) || 30));
    } else if (slipSpec.kind === 'seconds') {
      slipSec = slipSpec.seconds;
    } else if (slipSpec.kind === 'raw') {
      slipSec = _parseCaptionOffsetToSeconds(slipSpec.raw, fps);
    } else {
      slipSec = 0;
    }
  } catch (e) {
    importWarnings.push(`MCC timecodeOffset ignored: ${e?.message || String(e)}`);
    slipSec = 0;
  }

  // Recompute the base/earliest timecode using the FINAL fps.
  // (Important when the MCC header is missing/nominal and we fall back to CDP-derived fps.)
  let timecodeBaseFrame = null;
  let timecodeBaseLabel = null;
  for (const tcSeen of timecodesSeen) {
    const fr = framesFromTimecodeLabel(tcSeen, fps, dfHint);
    if (Number.isFinite(fr) && (timecodeBaseFrame == null || fr < timecodeBaseFrame)) {
      timecodeBaseFrame = fr;
      timecodeBaseLabel = tcSeen;
    }
  }

  const baseFrame = (typeof timecodeBaseFrame === 'number' && Number.isFinite(timecodeBaseFrame))
    ? timecodeBaseFrame
    : 0;
  const baseSec = framesToSeconds(baseFrame, fps);
  const baseLabelRaw = (typeof timecodeBaseLabel === 'string' && timecodeBaseLabel.trim())
    ? timecodeBaseLabel.trim()
    : '00:00:00:00';
  const baseLabel = _normalizeTcDelimiter(baseLabelRaw);

  const dtvccFrames = dtvccFramesRaw
    .filter(f => f && f.dtvccBytes && f.dtvccBytes.length)
    .map(f => {
      const fr = framesFromTimecodeLabel(f.tc, fps, dfHint);
      if (!Number.isFinite(fr)) return null;
      return {
        tc: f.tc,
        sec: framesToSeconds(fr, fps),
        dtvccBytes: f.dtvccBytes
      };
    })
    .filter(Boolean);

  // --- Prefer native 708 decode when present
  const force608 = opts.force608Compatibility === true || opts.prefer608Compatibility === true;
  if (!force608 && dtvccFrames.length) {
    let svcUsed = headerServiceNumber;
    let decoded708 = decodeDtvccFramesToCues(dtvccFrames, {
      fps,
      serviceNumber: requestedServiceNumber,
      serviceNumbers: Array.isArray(opts.serviceNumbers) ? opts.serviceNumbers : undefined,
      allServices: opts.allServices === true,
      primaryServiceNumber: headerServiceNumber
    });

    // If the caller explicitly requested a service (or all services), do not auto-fallback.
    // (This mirrors how pro tools behave: if you pick a service, you get that service.)
    svcUsed = (decoded708 && Number.isFinite(Number(decoded708.primaryServiceNumber)))
      ? Number(decoded708.primaryServiceNumber)
      : headerServiceNumber;

    if (!explicitServiceRequest) {
      if ((!decoded708.cues || !decoded708.cues.length) && Array.isArray(decoded708.seenServices) && decoded708.seenServices.length) {
        const fallbackSvc = decoded708.seenServices[0];
        if (fallbackSvc && fallbackSvc !== svcUsed) {
          const decoded2 = decodeDtvccFramesToCues(dtvccFrames, { fps, serviceNumber: fallbackSvc });
          if (decoded2.cues && decoded2.cues.length) {
            decoded708 = decoded2;
            svcUsed = fallbackSvc;
            importWarnings.push(`MCC header Caption Service=${headerServiceNumber} not present in stream; imported service ${fallbackSvc} instead.`);
          }
        }
      }
    }

    const _normalizeCues = (inCues) => {
      const arr = Array.isArray(inCues) ? inCues : [];
      let out = arr.map((c, idx) => ({
        ...c,
        id: c.id ?? idx,
        start: keepAbsolute ? (Number(c.start) || 0) : Math.max(0, (Number(c.start) || 0) - baseSec),
        end: keepAbsolute ? (Number(c.end) || 0) : Math.max(0, (Number(c.end) || 0) - baseSec)
      }));
      out = _applySlipToCues(out);
      // Ensure deterministic IDs (after slip/shift).
      out = out.map((c, idx) => ({ ...c, id: idx }));
      return out;
    };

    const transformedCues = _normalizeCues(decoded708?.cues);

    // ------------------------------------------------------------
    // NEW: If MCC carries 608 compatibility bytes, decode them and
    // attach per-cue PAC placements onto the 708 cues so export can
    // preserve original legacy placement (no defaults).
    // ------------------------------------------------------------
    const _hasPlacementArray = (arr) => (
      Array.isArray(arr) &&
      arr.some(p => p && Number.isFinite(Number(p.row)) && Number.isFinite(Number(p.col)))
    );

    const _clonePlacementArray = (arr) => (
      Array.isArray(arr)
        ? arr.map(p => (p && typeof p === 'object')
            ? { row: Number.isFinite(Number(p.row)) ? Math.trunc(Number(p.row)) : null,
                col: Number.isFinite(Number(p.col)) ? Math.trunc(Number(p.col)) : null }
            : null
          )
        : null
    );

    const _decodeCompat608Cues = () => {
      if (!recovered || !recovered.length) return null;
      // Build pseudo-SCC with one word per MCC timecode line (matches existing fallback path)
      const pseudoLines = ['Scenarist_SCC V1.0'];
      for (const r of recovered) {
        const w = (r.word & 0xffff).toString(16).toUpperCase().padStart(4, '0');
        const tcScc = _forceSccDelimiterForDf(r.tc);
        pseudoLines.push(`${tcScc}\t${w}`);
      }
      const pseudoScc = pseudoLines.join('\n') + '\n';
      const decoded = decodeSccText(pseudoScc, {
        fps,
        dropFrame: dropFrame === true,
        keepAbsoluteTimecode: true,
        shiftToZero: false,
        model: opts.model,
        modelOverflowPolicy: opts.modelOverflowPolicy,
        mediaPath: opts.mediaPath || null,
        sourcePath: opts.sourcePath || null,
        displayName: opts.displayName || (opts.sourcePath ? path.basename(opts.sourcePath) : 'MCC'),
        sccOptions: opts.sccOptions || {}
      });
      return _normalizeCues(decoded?.cues || []);
    };

    const _bestOverlapCue = (cues, start, end) => {
      if (!Array.isArray(cues) || !cues.length) return null;
      const s0 = Number(start) || 0;
      const e0 = Number(end) || 0;
      let best = null;
      let bestOv = 0;
      for (const c of cues) {
        if (!c) continue;
        const s = Number(c.start) || 0;
        const e = Number(c.end) || 0;
        if (e <= s0) continue;
        if (s >= e0) continue;
        const ov = Math.max(0, Math.min(e, e0) - Math.max(s, s0));
        if (ov > bestOv) { bestOv = ov; best = c; }
      }
      return best;
    };

    try {
      const compat608Cues = _decodeCompat608Cues();
      if (compat608Cues && compat608Cues.length && transformedCues && transformedCues.length) {
        let mapped = 0;
        for (const c708 of transformedCues) {
          if (!c708) continue;
          // Don’t clobber user edits (or any already-present placement)
          const existing = c708?.overrides?.['608']?.placement;
          if (_hasPlacementArray(existing) || _hasPlacementArray(c708.sccPlacement)) continue;

          const match = _bestOverlapCue(compat608Cues, c708.start, c708.end);
          const pl = match?.sccPlacement;
          if (!_hasPlacementArray(pl)) continue;

          const cloned = _clonePlacementArray(pl);
          if (!cloned) continue;

          c708.overrides = (c708.overrides && typeof c708.overrides === 'object') ? c708.overrides : {};
          c708.overrides['608'] = (c708.overrides['608'] && typeof c708.overrides['608'] === 'object') ? c708.overrides['608'] : {};
          c708.overrides['608'].placement = cloned;
          // mirror legacy slot (safe; SCC unaffected)
          c708.sccPlacement = cloned;
          mapped += 1;
        }
        if (mapped === 0 && recovered.length) {
          importWarnings.push('MCC contains 608 compatibility bytes, but placements could not be mapped onto 708 cues. Export may fall back to derived 608 placement.');
        }
      }
    } catch (e) {
      importWarnings.push(`608 compatibility placement mapping failed: ${e?.message || String(e)}`);
    }

    const transformedCuesByService = (() => {
      const raw = decoded708 && decoded708.cuesByService;
      if (!raw || typeof raw !== 'object') return null;
      const out = {};
      for (const k of Object.keys(raw)) {
        const svc = Number(k);
        if (!Number.isFinite(svc)) continue;
        out[svc] = _normalizeCues(raw[k]);
      }
      return out;
    })();

    // Important: ensure the editor view (doc.cues) and multi-service store
    // (doc.cuesByService) share the *same array instance* for the active service.
    // Otherwise, edits made to doc.cues would be lost when switching services.
    if (transformedCuesByService && Array.isArray(transformedCues) && Number.isFinite(Number(svcUsed))) {
      const activeSvc = Number(svcUsed);
      transformedCuesByService[activeSvc] = transformedCues;
    }

    if (transformedCues && transformedCues.length) {
      if (decoded708.warnings && decoded708.warnings.length) {
        importWarnings.push(...decoded708.warnings.slice(0, 5));
        if (decoded708.warnings.length > 5) {
          importWarnings.push(`(CEA-708 decoder warnings truncated; ${decoded708.warnings.length} total)`);
        }
      }

      const docsByService = (() => {
        if (!transformedCuesByService) return null;
        const out = {};
        for (const k of Object.keys(transformedCuesByService)) {
          const svc = Number(k);
          if (!Number.isFinite(svc)) continue;
          out[svc] = {
            kind: 'cea708',
            format: 'mcc',
            sourcePath: opts.sourcePath || null,
            displayName: opts.displayName || ((opts.sourcePath ? path.basename(opts.sourcePath) : 'MCC')),
            fps,
            dropFrame: (typeof dropFrame === 'boolean') ? dropFrame : false,
            startTc: keepAbsolute ? null : baseLabel,
            startTC: keepAbsolute ? null : baseLabel,
            timecodeBaseSec: baseSec,
            timecodeBaseLabel: baseLabel,
            keepAbsoluteTimecode: keepAbsolute,
            mediaPath: opts.mediaPath || null,
            cues: transformedCuesByService[svc] || [],
            cuesByService: transformedCuesByService,
            sccOptions: opts.sccOptions || {},
            mccOptions: {
              serviceNumber: svc,
              requestedServiceNumber: requestedServiceSpec,
              language: safeLanguage,
              include608Compatibility: recovered.length > 0,
              availableServices: decoded708?.seenServices || [],
              decodedServices: decoded708?.seenServices || [],
              mccTimecodeSuffix: detectedMccTimecodeSuffix,
              mccTimecodeSuffixes: detectedMccTimecodeSuffixes
            },
            modelIssues: [],
            importWarnings: importWarnings.slice(),
            importErrors: importErrors.slice()
          };
        }
        return out;
      })();

      const cues = transformedCues;

      const sourcePath = opts.sourcePath || null;
      const displayName = opts.displayName || (sourcePath ? path.basename(sourcePath) : 'MCC');
      return {
        kind: 'cea708',
        format: 'mcc',
        sourcePath,
        displayName,
        fps,
        dropFrame: (typeof dropFrame === 'boolean') ? dropFrame : false,
        startTc: keepAbsolute ? null : baseLabel,
        startTC: keepAbsolute ? null : baseLabel,
        timecodeBaseSec: baseSec,
        timecodeBaseLabel: baseLabel,
        keepAbsoluteTimecode: keepAbsolute,
        mediaPath: opts.mediaPath || null,
        cues,
        cuesByService: transformedCuesByService,
        docsByService,
        sccOptions: opts.sccOptions || {},
        mccOptions: {
          serviceNumber: svcUsed,
          requestedServiceNumber: requestedServiceSpec,
          language: safeLanguage,
          include608Compatibility: recovered.length > 0,
          availableServices: decoded708.seenServices || [],
          decodedServices: decoded708.seenServices || [],
          mccTimecodeSuffix: detectedMccTimecodeSuffix,
          mccTimecodeSuffixes: detectedMccTimecodeSuffixes
        },
        modelIssues: [],
        importWarnings,
        importErrors
      };
    }
  }

  // --- Fallback: 608 compatibility track
  if (!recovered.length) {
    if (saw708 || sawAnyCc) {
      importWarnings.push('MCC contains CEA-708 (DTVCC) data, but no decodable 708 cues were produced. (Possibly unsupported command set.)');
    } else {
      importErrors.push('No caption data found in MCC file.');
    }

    const sourcePath = opts.sourcePath || null;
    const displayName = opts.displayName || (sourcePath ? path.basename(sourcePath) : 'MCC');
    return {
      kind: saw708 ? 'cea708' : 'mcc',
      format: 'mcc',
      sourcePath,
      displayName,
      fps,
      dropFrame: (typeof dropFrame === 'boolean') ? dropFrame : false,
      startTc: null,
      timecodeBaseSec: baseSec,
      timecodeBaseLabel: baseLabel,
      keepAbsoluteTimecode: true,
      mediaPath: opts.mediaPath || null,
      cues: [],
      sccOptions: { channel: 1 },
      mccOptions: {
        serviceNumber: headerServiceNumber,
        requestedServiceNumber: requestedServiceSpec,
        language: safeLanguage,
        include608Compatibility: false,
        mccTimecodeSuffix: detectedMccTimecodeSuffix,
        mccTimecodeSuffixes: detectedMccTimecodeSuffixes
      },
      modelIssues: [],
      importWarnings,
      importErrors
    };
  }

  // Build a pseudo-SCC stream with one word per timecode line to avoid injecting
  // SCC’s intra-line 1-frame spacing into MCC frame payloads.
  const pseudoLines = ['Scenarist_SCC V1.0'];
  for (const r of recovered) {
    const w = (r.word & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    const tcScc = _forceSccDelimiterForDf(r.tc);
    pseudoLines.push(`${tcScc}\t${w}`);
  }
  const pseudoScc = pseudoLines.join('\n') + '\n';

  // Decode via existing SCC decoder, but keep absolute timecode for now.
  const decoded = decodeSccText(pseudoScc, {
    fps,
    dropFrame: dropFrame === true,
    keepAbsoluteTimecode: true,
    shiftToZero: false,
    model: opts.model,
    modelOverflowPolicy: opts.modelOverflowPolicy,
    mediaPath: opts.mediaPath || null,
    sourcePath: opts.sourcePath || null,
    displayName: opts.displayName || (opts.sourcePath ? path.basename(opts.sourcePath) : 'MCC'),
    // Preserve caller options if they passed them
    sccOptions: opts.sccOptions || {}
  });

  let cues = (decoded.cues || []).map((c, idx) => ({
    ...c,
    id: c.id ?? idx,
    start: keepAbsolute ? (Number(c.start) || 0) : Math.max(0, (Number(c.start) || 0) - baseSec),
    end: keepAbsolute ? (Number(c.end) || 0) : Math.max(0, (Number(c.end) || 0) - baseSec)
  }));

  cues = _applySlipToCues(cues);

  const mergedWarnings = Array.isArray(decoded.importWarnings) ? decoded.importWarnings.slice() : [];
  // MCC-specific warning: we only import the 608 compatibility track.
  if (saw708) {
    mergedWarnings.push('Imported MCC using only the 608 compatibility track (CEA-708 data present but not decoded).');
  } else {
    mergedWarnings.push('Imported MCC using the 608 compatibility track.');
  }

  return {
    ...decoded,
    kind: 'cea608',
    format: 'mcc',
    fps: decoded.fps || fps,
    dropFrame: (typeof decoded.dropFrame === 'boolean') ? decoded.dropFrame : (typeof dropFrame === 'boolean' ? dropFrame : false),
    keepAbsoluteTimecode: keepAbsolute,
    startTc: keepAbsolute ? null : baseLabel,
    startTC: keepAbsolute ? null : baseLabel,
    timecodeBaseSec: baseSec,
    timecodeBaseLabel: baseLabel,
    cues,
    importWarnings: mergedWarnings,
    importErrors: Array.isArray(decoded.importErrors) ? decoded.importErrors : [],
    mccOptions: {
      serviceNumber: headerServiceNumber,
      requestedServiceNumber: requestedServiceSpec,
      language: safeLanguage,
      include608Compatibility: true,
      mccTimecodeSuffix: detectedMccTimecodeSuffix,
      mccTimecodeSuffixes: detectedMccTimecodeSuffixes
    }
  };
}

function decodeMccFile(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return decodeMccText(raw, {
    ...opts,
    sourcePath: filePath,
    displayName: path.basename(filePath)
  });
}

module.exports = {
  decodeMccText,
  decodeMccFile
};
