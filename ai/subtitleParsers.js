// ai/subtitleParsers.js
'use strict';

const fs = require('fs');
const path = require('path');
const { isDropFrameRate } = require('../utils/timeUtils');
const { decodeSccFile } = require('../modules/sccDecoder');
const { decodeMccFile } = require('../modules/mccDecoder');
const sccEncoder = require('../modules/sccEncoder');
const { parseVTT, cuesToSegments } = require('./vttParser');
const { parseSRT } = require('./srtParser');

function parseSrtFile(filePath, ctx = {}) {
  const { fps = 30, dropFrame = false, mediaPath = null } = ctx;
  const useDf = dropFrame && isDropFrameRate(fps);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseSRT(raw);
  const cues = (parsed.cues || []).map((c, idx) => ({
    id: idx,
    start: c.start,
    end: c.end,
    text: c.text,
    // Keep a dedicated lines array for the renderer preview overlay.
    // (The editor also normalizes these later, but providing them here avoids
    // any schema/merge edge-cases.)
    lines: Array.isArray(c.textLines) ? c.textLines.slice() : String(c.text || '').split(/\n/g),
    speaker: null
  }));

  return {
    sourcePath: filePath,
    displayName: path.basename(filePath),
    fps, dropFrame: useDf,
    mediaPath,
    cues
  };
}

function parseVttFile(filePath, ctx = {}) {
  const { fps = 30, dropFrame = false, mediaPath = null } = ctx;
  const useDf = dropFrame && isDropFrameRate(fps);
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');

  // Phase 7-ish: use the shared robust WebVTT parser so we properly handle:
  // - cue IDs
  // - cue settings
  // - MM:SS.mmm timestamps (legal WebVTT)
  // - NOTE/STYLE/REGION blocks
  // - entity decoding + tag stripping (for editor-friendly text)
  const parsed = parseVTT(raw);
  const cues = cuesToSegments(parsed, {
    // Keep editor text readable: do NOT strip speaker prefixes into a separate field by default.
    // (We still strip WebVTT markup tags and decode entities.)
    extractSpeaker: false,
    // Do not inject internal {I}/{Gr} tokens into editor text unless the caller explicitly wants it.
    emit608Tokens: false,
    inferSpeakerFromTextPrefix: false,
    preserveLineBreaks: true,
    preservePlacementAsInternalTags: false
  }).map((seg, idx) => ({
    id: idx,
    start: seg.start,
    end: seg.end,
    text: seg.text,
    lines: String(seg.text || '').replace(/\r/g, '').split(/\n/g),
    speaker: seg.speaker || null
  }));

  return {
    sourcePath: filePath,
    displayName: path.basename(filePath),
    fps, dropFrame: useDf,
    mediaPath,
    cues
  };
}

function parseSccFile(filePath, opts = {}) {
  if (typeof decodeSccFile !== 'function') {
    throw new Error(
      'SCC decoder missing: decodeSccFile() is not exported from modules/sccDecoder.js'
    );
  }
  const model = opts.model || sccEncoder.SCC_MODEL;
  const modelOverflowPolicy = opts.modelOverflowPolicy || 'warn';
  return decodeSccFile(filePath, {
    shiftToZero: true,
    model,
    modelOverflowPolicy,
    ...opts
  });
}

function parseMccFile(filePath, opts = {}) {
  if (typeof decodeMccFile !== 'function') {
    throw new Error(
      'MCC decoder missing: decodeMccFile() is not exported from modules/mccDecoder.js'
    );
  }
  const model = opts.model || sccEncoder.SCC_MODEL;
  const modelOverflowPolicy = opts.modelOverflowPolicy || 'warn';
  return decodeMccFile(filePath, {
    shiftToZero: true,
    model,
    modelOverflowPolicy,
    ...opts
  });
}

module.exports = {
  parseSrtFile,
  parseVttFile,
  parseSccFile,
  parseMccFile
};
