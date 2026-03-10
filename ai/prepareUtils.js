const { resolveFps } = require('../utils/ffmpeg');
const { addFullTimecodeMetadata } = require('./whisperFormatter');
const { normalizeTranscriptionStructure } = require('./normalizeTranscription');
const { isDropFrameRate } = require('../utils/timeUtils');

// Normalize legacy transcription array to segments with metadata

async function prepareSegments(jsonData, filePath, config) {
  const fps = await resolveFps(filePath, config);
  const dfRequested = Boolean(config.dropFrame);
  const dfCapable = isDropFrameRate(fps);
  const dropFramePreferred = dfRequested && dfCapable;

  if (dfRequested && !dfCapable) {
    // Headless/CLI guard: UI already blocks this, but scripts may pass it
    console.warn(
      `[timecode] Drop-frame requested (config.dropFrame=true) while fps=${fps} is not 29.97 or 59.94; proceeding as non-DF.`
    );
  }

  if (!jsonData.segments && Array.isArray(jsonData.transcription)) {
    normalizeTranscriptionStructure(jsonData, fps, dropFramePreferred);
  }

  // Stamp a single source of truth for timebase so writers don't guess.
  jsonData.system = {
    ...(jsonData.system || {}),
    fps,
    dropFramePreferred,
    dropFrame: dropFramePreferred
  };

  if (!Array.isArray(jsonData.segments)) return;

  if (typeof addFullTimecodeMetadata === 'function') {
    // Match the app’s selected style: one and only one representation.
    const style = (config.timecodeStyle === 'ms' || config.timecodeStyle === 'dot')
      ? config.timecodeStyle
      : 'colon';
    const pick =
      style === 'ms'
        ? { ndf: false, df: false, ms: true }
        : (dropFramePreferred
            ? { ndf: false, df: true, ms: false }
            : { ndf: true, df: false, ms: false });
    addFullTimecodeMetadata(jsonData.segments, fps, dropFramePreferred, pick);
  }
}

module.exports = {
  prepareSegments,
  normalizeTranscriptionStructure
};
