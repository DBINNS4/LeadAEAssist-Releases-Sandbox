const { resolveFps } = require('../utils/ffmpeg');
const { toFrame, toFrameEnd, toMs } = require('../utils/timeUtils');
const { normalizeTranscriptionStructure } = require('./normalizeTranscription');
// 🚚 All timecode math now comes from utils/timeUtils
const {
  parseTime,
  msToTC,
  formatTimecodes,
  formatTimecode,
  isDropFrameRate
} = require('../utils/timeUtils');

// (no change) everything else below still uses {parseTime, formatTimecode, ...}
// injected above from utils/timeUtils

function addFullTimecodeMetadata(
  segments,
  fps = 29.97,
  _ignoredDropFrameFlag = false,
  pick /* {ndf?:bool, df?:bool, ms?:bool} */
) {
  if (!Array.isArray(segments)) return;

  const dfCapable = isDropFrameRate(fps) === true;
  const modes = (pick && typeof pick === 'object')
    ? { ndf: !!pick.ndf, df: !!pick.df && dfCapable, ms: !!pick.ms }
    : { ndf: true, df: dfCapable, ms: true }; // backward-compatible default

  for (const seg of segments) {
    const rawStart = Number(seg.start);
    const rawEnd = Number(seg.end);
    const startSec = Number.isFinite(rawStart) ? rawStart : 0;
    const endSec = Number.isFinite(rawEnd) ? rawEnd : startSec;

    const msStart = toMs(startSec);
    const msEnd = toMs(endSec);

    seg.msStart = msStart;
    seg.msEnd = msEnd;
    // frameStart/frameEnd are "real" frame counters at `fps` (no DF label math).
    // They’re for math/comparison, not for direct ;FF indices.
    seg.frameStart = toFrame(startSec, fps);
    seg.frameEnd = toFrameEnd(endSec, fps);

    const ndfStart = formatTimecode(startSec, false, fps, 'colon');
    const ndfEnd = formatTimecode(endSec, false, fps, 'colon');
    const dfStart = formatTimecode(startSec, true, fps, 'colon');
    const dfEnd = formatTimecode(endSec, true, fps, 'colon');

    const tc = {};
    if (modes.ndf) tc.ndf = { start: ndfStart, end: ndfEnd };
    if (modes.df)  tc.df  = { start: dfStart, end: dfEnd, dfCapable };
    if (modes.ms)  tc.ms  = { start: msStart, end: msEnd };
    seg.timecodes = tc;

    if (Array.isArray(seg.tokens)) {
      // Normalize tokens — keep only objects (drop numeric ids) to prevent primitive writes
      seg.tokens = seg.tokens.filter(t => t && typeof t === 'object');
      for (const tok of seg.tokens) {
        // Skip numeric token IDs (OpenAI Whisper API often returns ints here)
        if (!tok || typeof tok !== 'object') continue;

        // Prefer numeric if already present; otherwise derive from existing (legacy) fields
        const from = tok.timestamps?.from;
        const to = tok.timestamps?.to;
        const rawTokStart = Number.isFinite(tok.msStart) ? tok.msStart : parseTime(from, fps, /* auto-detect */ null);
        const rawTokEnd = Number.isFinite(tok.msEnd) ? tok.msEnd : parseTime(to, fps, /* auto-detect */ null);
        const safeTokStart = Number.isFinite(rawTokStart) ? rawTokStart : msStart;
        const safeTokEnd = Number.isFinite(rawTokEnd) ? rawTokEnd : msEnd;
        const floatStart = safeTokStart / 1000;
        const floatEnd = safeTokEnd / 1000;

        const tokMsStart = Math.floor(safeTokStart);
        const tokMsEnd = Math.floor(safeTokEnd);

        tok.msStart = tokMsStart;
        tok.msEnd = tokMsEnd;
        // Token frame counters follow the same "real frames" convention.
        tok.frameStart = toFrame(floatStart, fps);
        tok.frameEnd = toFrameEnd(floatEnd, fps);

        const tokNdfStart = formatTimecode(floatStart, false, fps, 'colon');
        const tokNdfEnd = formatTimecode(floatEnd, false, fps, 'colon');
        const tokDfStart = formatTimecode(floatStart, true, fps, 'colon');
        const tokDfEnd = formatTimecode(floatEnd, true, fps, 'colon');

        const ttc = {};
        if (modes.ndf) ttc.ndf = { start: tokNdfStart, end: tokNdfEnd };
        if (modes.df)  ttc.df  = { start: tokDfStart, end: tokDfEnd, dfCapable };
        if (modes.ms)  ttc.ms  = { start: tokMsStart, end: tokMsEnd };
        tok.timecodes = ttc;
        // No flat mirrors; no token.timestamps rewrite.
      }

      const validTokens = seg.tokens.filter(
        t => t && typeof t === 'object' && t.text && !(t.text.startsWith('[') && t.text.endsWith(']'))
      );
      if (!seg.text && validTokens.length) {
        seg.text = validTokens.map(t => t.text).join('').replace(/\s+/g, ' ').trim();
      }
    }
  }
}

async function wrapToProfessionalFormat(jsonData, config, filePath) {
  const fps = await resolveFps(filePath, config);
  const dfCapable = isDropFrameRate(fps);
  const dropFramePreferred = Boolean(config.dropFrame) && dfCapable;

  if (!jsonData.segments && Array.isArray(jsonData.transcription)) {
    normalizeTranscriptionStructure(jsonData, fps, dropFramePreferred);
  }
  if (Array.isArray(jsonData.segments)) {
    // Emit only what the user selected
    const style = (config.timecodeStyle === 'ms' || config.timecodeStyle === 'dot') ? config.timecodeStyle : 'colon';
    const pick =
      style === 'ms'
        ? { ndf: false, df: false, ms: true }
        : (dropFramePreferred ? { ndf: false, df: true, ms: false }
                              : { ndf: true, df: false, ms: false });
    addFullTimecodeMetadata(jsonData.segments, fps, dropFramePreferred, pick);
  }

  return {
    system: {
      engine: config.engine,
      model: config.params?.model || '',
      language: config.language || 'en',
      fps,
      dropFramePreferred,
      dropFrame: dropFramePreferred,
      timecodeRepresentations: {
        ndf: !!(config.timecodeStyle !== 'ms' && !dropFramePreferred),
        df: !!(config.timecodeStyle !== 'ms' && dropFramePreferred),
        ms: config.timecodeStyle === 'ms'
      },
      created: new Date().toISOString(),
      timecodeStyle: (config.timecodeStyle === 'ms') ? 'ms' : (dropFramePreferred ? 'df' : 'ndf')
    },
    metadata: {
      durationSeconds: jsonData.duration || (jsonData.segments?.at(-1)?.end ?? 0),
      numSegments: jsonData.segments?.length || 0,
      timecodeStyle: (config.timecodeStyle === 'ms') ? 'ms' : (dropFramePreferred ? 'df' : 'ndf'),
      // Do not force true; respect config
      autoSpeakerLabels: Boolean(config.localSpeakerDetection),
      // optional: carry UI-provided source TC origin (doesn't alter segment timing)
      tcStart: config.startTC || null
    },
    segments: jsonData.segments
  };
}

module.exports = {
  parseTime,
  msToTC,
  formatTimecodes,
  formatTimecode,
  addFullTimecodeMetadata,
  wrapToProfessionalFormat,
  // expose so all modules share one DF-capability definition
  isDropFrameRate
};
