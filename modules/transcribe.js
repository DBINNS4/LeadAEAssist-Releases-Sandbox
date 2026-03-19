// Optional in certain packaging/test contexts.
try {
  require('dotenv').config();
} catch (err) {
  console.warn('[transcribe] dotenv preload skipped:', err?.message || String(err));
}

const ProgressManager = require('../utils/progressManager');
const { normalizeExportPolicy } = require('../utils/qcDeliveryPrefs');
// (rest of imports unchanged)

// Secrets must be accessed only in the main process.
// We load the OpenAI API key from the OS secure store here (never from the renderer).
let secureStore = null;
try {
  secureStore = require('./secureStore');
} catch (err) {
  secureStore = null;
  console.warn('[transcribe] secureStore unavailable:', err?.message || String(err));
}

// transcribeEngine depends on Electron/OpenAI in some builds; keep it best-effort
// so that caption export tooling (SCC/MCC) can be exercised in isolation.
let transcribeEngine = null;
try {
  transcribeEngine = require('../ai/transcribeEngine');
} catch (err) {
  transcribeEngine = null;
  console.warn('[transcribe] transcribeEngine unavailable:', err?.message || String(err));
}
const scc = require('./sccEncoder');
const { extendedGlyphMap } = require('./sccGlyphMap');
function normalizeSccChannel(value) {
  const s = String(value ?? '').trim().toUpperCase();
  const m = s.match(/^CC\s*([1-4])$/);
  const n = m ? parseInt(m[1], 10) : parseInt(s, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, n));
}
const runEngine = transcribeEngine && typeof transcribeEngine.runEngine === 'function'
  ? transcribeEngine.runEngine
  : null;
const cancelCurrentProcess = transcribeEngine && typeof transcribeEngine.cancelCurrentProcess === 'function'
  ? transcribeEngine.cancelCurrentProcess
  : null;
const fs = require('fs');
const { randomUUID } = require('crypto');
const {
  sendLogMessage,
  createJobLogger,
  createJobUserLog,
  writeJobLogToFile,
  writeJobTextToFile
} = require('./logUtils');
const { cancelIngest, createCancelToken } = require('./cancelUtils');
const { spawn } = require('child_process');
const path = require('path');

// Catch policy: operational paths must log warnings/errors; silent catches are only
// allowed for truly ignorable best-effort cleanup and must document why silence is safe.

// Best-effort renderer broadcast. Never throw.
function sendToRenderer(_sessionId, channel, payload) {
  try {
    // Require lazily so non-Electron contexts/tests don’t explode.
    const { BrowserWindow } = require('electron');
    const wins = (BrowserWindow?.getAllWindows?.() || []);
    for (const w of wins) {
      try {
        w?.webContents?.send?.(channel, payload);
      } catch (err) {
        sendLogMessage('transcribe', `⚠️ Renderer dispatch failed (${channel}): ${err?.message || String(err)}`, '', false, _sessionId || '', 'warn');
      }
    }
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ Renderer broadcast setup failed (${channel}): ${err?.message || String(err)}`, '', false, _sessionId || '', 'warn');
  }
}

const { ensureUserDataSubdir } = require('../utils/appPaths');
const platformPaths = require('../platform/paths');
// OpenAI is only needed for the streaming transcription features.
// Keep it lazy so exports/tests don't require the dependency.
let OpenAI = null;
const { ffmpegPath } = require('../utils/ffmpeg');
const {
  normalizeTranscriptionStructure,
  segmentsToCueList,
  cueListToSegments
} = require('../ai/normalizeTranscription');
const { isDropFrameRate } = require('../utils/timeUtils');
const { resolveMccDualGradeEnabled, resolveMccWant708Qc, resolveMccQcProfiles } = require("../utils/mccQcUtils");
const { ensureDocCueSchema } = require('../utils/cueSchema');
const { parseSrtFile, parseVttFile, parseSccFile, parseMccFile } = require('../ai/subtitleParsers');
const { cleanupTranscribeOutputSidecars } = require('../utils/transcribeOutputCleanup');
const {
  writeCorrectedJson,
  writeCorrectedJsonToPath,
  writeCorrectedSRT,
  writeCorrectedSRTToPath,
  writeCorrectedVTT,
  writeCorrectedVTTToPath,
  writeSccQcReport,
  writeMccQcReport,
  validateSccContentQc,
  validateMccContentQc
} = require('../ai/outputWriters');

const { shapeSegmentsForScc } = require('../ai/sccShaper');

// Transcription engine processes are single-instance (global currentProcess).
// We enforce single-job exclusivity and only send engine-level cancels for the
// active job ID.
const transcribeCancelHandles = new Map();
let activeTranscribeJobId = null;

// ------------------------------------------------------------
// SCC glyph picker support (CEA-608)
// ------------------------------------------------------------
function getSccGlyphs() {
  // Return glyphs supported by the SCC encoder's extendedGlyphMap.
  // Categorize by high-byte family for UI grouping.
  const map = extendedGlyphMap || {};
  const glyphs = Object.keys(map);

  const groups = {
    specialNorthAmerican: [],
    extendedWesternEuropean1: [],
    extendedWesternEuropean2: [],
    other: []
  };

  for (const g of glyphs) {
    const spec = map[g] || {};
    const hi = (spec.hiCh1 ?? spec.hiF1); // prefer new naming, tolerate old
    if (hi === 0x11) groups.specialNorthAmerican.push(g);
    else if (hi === 0x12) groups.extendedWesternEuropean1.push(g);
    else if (hi === 0x13) groups.extendedWesternEuropean2.push(g);
    else groups.other.push(g);
  }

  const sort = (arr) => arr.slice().sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    total: glyphs.length,
    groups: {
      specialNorthAmerican: sort(groups.specialNorthAmerican),
      extendedWesternEuropean1: sort(groups.extendedWesternEuropean1),
      extendedWesternEuropean2: sort(groups.extendedWesternEuropean2),
      other: sort(groups.other)
    }
  };
}

function runFFmpeg(args, signal = null) {
  // Sanitize args: drop libx-only or legacy flags your ffmpeg build doesn't support
  const safeArgs = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    // These options are valid for libx264/libx265/etc., but not for h264_videotoolbox/prores_ks/mpeg4
    if (flag === '-preset' || flag === '-tune' || flag === '-crf') {
      i++;
      continue;
    }
    safeArgs.push(flag);
  }
  if (process.env.DEBUG_LOGS) {
    console.log('🚀 FFmpeg args:', safeArgs.join(' '));
  }
  if (signal?.aborted) {
    const error = new Error('FFmpeg cancelled');
    error.name = 'AbortError';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, safeArgs);
    let stdout = '';
    let stderr = '';
    let aborted = false;

    const handleAbort = () => {
      if (aborted) return;
      aborted = true;
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        // Safe to continue: cancellation kill is best-effort and process may already have exited.
        sendLogMessage('transcribe', `⚠️ Failed to terminate FFmpeg process during cancel: ${err?.message || String(err)}`, '', false, '', 'warn');
      }
    };

    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true });
    }

    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (signal) {
        signal.removeEventListener('abort', handleAbort);
      }
      if (aborted) {
        const error = new Error('FFmpeg cancelled');
        error.name = 'AbortError';
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`FFmpeg exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

const registerTranscribeCancelHandle = (jobId, signal) => {
  if (!jobId) return;
  transcribeCancelHandles.set(jobId, { signal });
};

const cleanupTranscribeCancelHandle = (jobId) => {
  if (!jobId) return;
  transcribeCancelHandles.delete(jobId);
  if (activeTranscribeJobId === jobId) {
    activeTranscribeJobId = null;
  }
};

const subtitleSessions = new Map();
let lastSubtitleContext = null;

function parseJsonSubtitle(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const fps = data.system?.fps || data.metadata?.fps || lastSubtitleContext?.fps || 30;
  const dfCapable = isDropFrameRate(fps);
  const dropFrame = dfCapable && Boolean(
    data.system?.dropFrame || data.metadata?.dropFrame || lastSubtitleContext?.dropFrame
  );
  let segments = Array.isArray(data.segments) ? data.segments : [];

  if (!segments.length && Array.isArray(data.finalWords)) {
    segments = data.finalWords.map((word, idx) => ({
      id: word.id ?? idx,
      start: typeof word.start === 'number' ? word.start : (word.offset ?? 0),
      end: typeof word.end === 'number' ? word.end : (word.offsetEnd ?? word.offset ?? 0),
      text: word.text || word.word || '',
      speaker: word.speaker || null
    }));
  }

  if (!segments.length && Array.isArray(data.transcription)) {
    const clone = JSON.parse(JSON.stringify(data));
    normalizeTranscriptionStructure(clone, fps, dropFrame);
    segments = clone.segments || [];
  }

  if (!segments.length && Array.isArray(data.cues)) {
    // Phase 1: support V2 cue schema (canonical + overrides) while tolerating
    // legacy flattened cues.
    segments = data.cues.map((cue, idx) => {
      const canon = (cue && typeof cue === 'object' && cue.canonical && typeof cue.canonical === 'object')
        ? cue.canonical
        : cue;
      const overrides = (cue && typeof cue === 'object' && cue.overrides && typeof cue.overrides === 'object')
        ? cue.overrides
        : undefined;

      return {
        id: (cue && cue.id != null) ? cue.id : idx,
        start: canon?.start ?? cue?.start,
        end: canon?.end ?? cue?.end,
        text: canon?.text ?? cue?.text,
        ...(Array.isArray(canon?.runs) ? { runs: canon.runs } : (Array.isArray(cue?.runs) ? { runs: cue.runs } : {})),
        ...(Array.isArray(canon?.lines) ? { lines: canon.lines } : (Array.isArray(cue?.lines) ? { lines: cue.lines } : {})),
        speaker: canon?.speaker ?? cue?.speaker ?? null,
        sccPlacement: canon?.sccPlacement ?? cue?.sccPlacement ?? null,
        cea708Placement: canon?.cea708Placement ?? cue?.cea708Placement ?? undefined,
        ...(cue && cue.canonical ? { canonical: cue.canonical } : {}),
        ...(overrides ? { overrides } : {}),
        // Legacy compat 608 override fields (still accepted)
        compat608: cue?.compat608 || undefined,
        compat608Text: cue?.compat608Text || undefined
      };
    });
  }

  const cues = segmentsToCueList(segments, fps, dropFrame);
  const mediaPath =
    data.mediaPath ||
    data.inputPath ||
    data.sourceFile ||
    data.source ||
    lastSubtitleContext?.mediaPath ||
    null;

  const out = {
    sourcePath: filePath,
    displayName: data.displayName || path.basename(filePath),
    fps,
    dropFrame,
    startTc: data.metadata?.startTimecode || data.startTc || null,
    mediaPath,
    cues,
    originalJson: data
  };

  // Guarantee Phase-1 cue schema is present for the editor/session.
  ensureDocCueSchema(out);
  return out;
}

function storeSession(doc, sessionId) {
  const id = sessionId || randomUUID();
  const existing = subtitleSessions.get(id) || {};
  const next = { ...existing, sessionId: id };
  if (doc && typeof doc === 'object') {
    for (const [key, value] of Object.entries(doc)) {
      if (value !== undefined) {
        next[key] = value;
      }
    }
  }
  subtitleSessions.set(id, next);
  return next;
}

async function streamTranscript(filePath, engine, language, sendUpdate, apiKey) {
  try {
    if (engine === 'whisper') {
      const MAX_SIZE = 26214400;
      const stats = await fs.promises.stat(filePath);
      if (stats.size > MAX_SIZE) {
        const mb = (stats.size / 1024 / 1024).toFixed(2);
        sendUpdate(
          `❌ File too large for Whisper API: ${mb} MB (max ~25 MB per request). ` +
          'Use a local engine or split the media into smaller chunks.'
        );
        return;
      }
      if (!OpenAI) {
        try {
          OpenAI = require('openai');
        } catch (err) {
          sendLogMessage('transcribe', `⚠️ OpenAI SDK load failed: ${err?.message || String(err)}`, '', false, '', 'warn');
          throw new Error('OpenAI SDK not available (missing "openai" dependency).');
        }
      }
      let resolvedKey = typeof apiKey === 'string' ? apiKey : '';
      if (!resolvedKey) {
        try {
          resolvedKey = secureStore && typeof secureStore.getAiApiKey === 'function'
            ? await secureStore.getAiApiKey()
            : '';
        } catch (err) {
          sendLogMessage('transcribe', `⚠️ Secure-store key fetch failed: ${err?.message || String(err)}`, '', false, '', 'warn');
          resolvedKey = '';
        }
      }
      if (!resolvedKey) {
        resolvedKey = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY : '';
      }
      resolvedKey = String(resolvedKey || '').trim();
      if (!resolvedKey) {
        throw new Error('OpenAI API key not configured.');
      }

      const openai = new OpenAI({ apiKey: resolvedKey });
      const resp = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        language
      });
      if (resp.segments) {
        for (const segment of resp.segments) {
          const line = `[${segment.start.toFixed(2)} --> ${segment.end.toFixed(2)}] ${segment.text}`;
          sendUpdate(line);
        }
      }
    }
  } catch (err) {
    sendUpdate(`❌ ${err.message}`);
  }
}

async function runTranscribe(config) {
  if (!config.jobId) {
    config.jobId = `transcribe-${Date.now()}`;
  }

  // SECURITY: Never trust renderer-supplied secrets. Ensure the API key is loaded
  // in the main process from secure storage (or environment) and then passed to
  // the transcription engine.
  try {
    const stored = secureStore && typeof secureStore.getAiApiKey === 'function'
      ? await secureStore.getAiApiKey()
      : '';
    const envKey = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY : '';
    const effective = String(stored || envKey || '').trim();

    if (effective) {
      // Overwrite any renderer-provided value.
      config.apiKey = effective;
    } else {
      delete config.apiKey;
    }
  } catch (err) {
    console.warn('[transcribe] API key override failed:', err?.message || String(err));
    delete config.apiKey;
  }

  if (!config.signal) config.signal = createCancelToken(config.jobId);
  registerTranscribeCancelHandle(config.jobId, config.signal);
  if (config.diarization) config.localSpeakerDetection = true;
  // IMPORTANT: translation.enabled means *post-process* translation of output (Translate section in UI),
  // not Whisper's built-in translate-to-English task. Keep whisperTask defaulted to transcribe unless
  // an advanced caller explicitly sets it to "translate".
  if (!config.whisperTask) config.whisperTask = 'transcribe';
  if (!config.diarization && (config.localSpeakerDetection || config.includeSpeakerNames || config.detectSpeakers)) {
    config.diarization = true;
  }
  const sanitized = JSON.parse(JSON.stringify(config));
  if (sanitized.apiKey) {
    sanitized.apiKey = sanitized.apiKey.slice(0, 4) + '...';
  }
  if (process.env.DEBUG_LOGS) {
    console.log('📝 Received transcription config:', JSON.stringify(sanitized, null, 2));
  }

  const jobLogger = createJobLogger({
    panel: 'transcribe',
    jobId: config.jobId,
    stage: 'init',
    streamToFile: true,
  });

  const userLog = createJobUserLog(jobLogger, {
    pickLevel: (text, isError) => {
      const inferredError = isError || /❌|\berror\b/i.test(text);
      const inferredWarn = !inferredError && (/⚠️|\bwarn\b/i.test(text));
      return inferredError ? 'error' : inferredWarn ? 'warn' : 'info';
    }
  });
  const logs = userLog.lines;
  const logPush = userLog.push;
  const logLine = (msg, isError = false, detail = '', fileId = '') => logPush(msg, detail, isError, fileId);

  const startTime = Date.now();

  let archivePath = null;
  let structuredPath = null;
  structuredPath = jobLogger.getStructuredLogPath?.() || structuredPath;

  let didPersistJobLogs = false;
  let reportStats = {
    requestedFiles: Array.isArray(config.files) ? config.files.length : 0,
  };
  const getSelectedOutputFormats = () => {
    const formats = (config.outputFormats && typeof config.outputFormats === 'object')
      ? config.outputFormats
      : {};
    return Object.entries(formats)
      .filter(([, enabled]) => !!enabled)
      .map(([name]) => name);
  };

  const persistJobLogs = () => {
    if (didPersistJobLogs) return;
    try {
      if (!structuredPath) {
        structuredPath = jobLogger.getStructuredLogPath?.() || null;
      }
      if (!structuredPath) {
        structuredPath = writeJobLogToFile('transcribe', config.jobId, jobLogger.getEntries());
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist transcribe JSONL log:', e?.message || e);
    }
    try {
      if (!archivePath) {
        archivePath = writeJobTextToFile(
          'transcribe',
          config.jobId,
          jobLogger.getEntries(),
          {
            structuredLogPath: structuredPath,
            inputs: {
              sourceCount: Array.isArray(config.files) ? config.files.length : 0,
              sources: Array.isArray(config.files) ? config.files.slice(0, 30) : [],
            },
            outputs: {
              primaryDestination: config.outputPath || config.outputDir || '',
            },
            settings: {
              mode: config.watchMode ? 'watch' : 'manual',
              engine: config.engine || '',
              model: config.model || '',
              outputFormats: getSelectedOutputFormats().join(', '),
              diarization: !!config.diarization,
              whisperTask: config.whisperTask || 'transcribe',
              wordTimestamps: !!config.wordTimestamps,
              localSpeakerDetection: !!config.localSpeakerDetection,
              translationEnabled: !!config.translation?.enabled,
            },
            stats: reportStats,
          }
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist transcribe TXT log:', e?.message || e);
    }
    didPersistJobLogs = true;
    try {
      jobLogger.close?.();
    } catch (err) {
      console.warn('[transcribe] job logger close failed:', err?.message || String(err));
    }
  };

  if (!runEngine) {
    const msg = '❌ Transcription engine is unavailable. Please check the installation or enable the engine to run transcribe jobs.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }

  // Guard: watch mode / presets can call into the module with an incomplete config.
  // Keep the failure mode professional (one error, not a crash).
  if (!Array.isArray(config.files)) {
    config.files = [];
  }
  config.files = config.files.map(f => String(f || '').trim()).filter(Boolean);
  if (config.files.length === 0) {
    const msg = '❌ No input files provided for transcription.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }

  if (activeTranscribeJobId && activeTranscribeJobId !== config.jobId) {
    const msg = `❌ Transcription engine is busy (active job: ${activeTranscribeJobId}).`;
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }

  activeTranscribeJobId = config.jobId;

  const progressManager = new ProgressManager(0, 250, 'files');
  progressManager.setTotalFiles(config.files.length);
  jobLogger.setStage('transcribe');

  progressManager.on('stream-progress', payload => {
    const window = require('electron').BrowserWindow.getFocusedWindow();
    if (window && !window.isDestroyed()) {
      // Legacy 'transcribe-progress' event removed
    }
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'transcribe',
        file: payload.file,
        percent: payload.overall,
        eta: payload.eta,
        completed: payload.completedFiles,
        total: payload.totalFiles,
        streamId: payload.streamId
      });
    }
  });

  progressManager.on('overall-progress', payload => {
    const window = require('electron').BrowserWindow.getFocusedWindow();
    if (window && !window.isDestroyed()) {
      // Legacy 'transcribe-progress' event removed
    }
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'transcribe',
        file: '',
        percent: payload.overall,
        eta: payload.eta,
        completed: payload.completedFiles,
        total: payload.totalFiles
      });
    }
  });

  progressManager.on('file-status', payload => {
    if (global.queue) {
      global.queue.emit('job-progress', {
        id: config.jobId,
        panel: 'transcribe',
        file: payload.file,
        status: { ...payload.statusMap },
        streamId: payload.streamId
      });
    }
  });

  // Basic validation
  const missing = [];
  const denied = [];
  const otherAccessErrors = [];

  for (const f of config.files) {
    try {
      await fs.promises.access(f, fs.constants.R_OK);
    } catch (e) {
      const code = e && e.code ? String(e.code) : '';
      if (code === 'ENOENT') {
        missing.push(f);
      } else if (code === 'EACCES' || code === 'EPERM') {
        denied.push({ file: f, code, message: e?.message || String(e) });
      } else {
        otherAccessErrors.push({ file: f, code: code || 'UNKNOWN', message: e?.message || String(e) });
      }
    }
  }

  if (missing.length || denied.length || otherAccessErrors.length) {
    const messages = [];

    for (const f of missing) {
      messages.push(`❌ File not found: ${f}`);
    }
    for (const item of denied) {
      messages.push(`❌ Permission denied (${item.code}) reading: ${item.file}${item.message ? ` — ${item.message}` : ''}`);
    }
    for (const item of otherAccessErrors) {
      messages.push(`❌ Cannot access file (${item.code}) reading: ${item.file}${item.message ? ` — ${item.message}` : ''}`);
    }

    if (denied.length) {
      messages.push('ℹ️ Tip: If this is macOS and the file is in Desktop/Documents/Downloads, grant the app access in System Settings → Privacy & Security → Files and Folders (or Full Disk Access).');
    }

    messages.forEach(msg => logLine(msg, true));
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }

  if (!Object.values(config.outputFormats || {}).some(v => v)) {
    const msg = '❌ No output format selected.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  if (!config.outputPath) {
    const msg = '❌ Output path is not a writable folder.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  let outputStat = null;
  try {
    outputStat = await fs.promises.stat(config.outputPath);
  } catch (err) {
    jobLogger.warn('Output path stat failed', {
      outputPath: config.outputPath,
      error: err?.message || String(err)
    });
    const msg = '❌ Output path is not a writable folder.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  if (!outputStat.isDirectory()) {
    const msg = '❌ Output path is not a writable folder.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  try {
    await fs.promises.access(config.outputPath, fs.constants.W_OK);
  } catch (err) {
    jobLogger.warn('Output path write access check failed', {
      outputPath: config.outputPath,
      error: err?.message || String(err)
    });
    const msg = '❌ Output path is not a writable folder.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }

  if (!config.engine) {
    const msg = '❌ No transcription engine selected.';
    logLine(msg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }

  // Normalize fps like "29.97DF" → 29.97 and set DF if present
  const co = String(config.fpsOverride ?? '').trim();
  const m1 = co ? co.toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(DF)?$/) : null;
  if (m1) {
    config.fpsOverride = parseFloat(m1[1]);
    if (m1[2]) config.dropFrame = true;
  }
  const cf = String(config.fps ?? '').trim();
  const m2 = cf ? cf.toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(DF)?$/) : null;
  if (m2) {
    config.fps = parseFloat(m2[1]);
    if (m2[2] && (config.dropFrame == null)) config.dropFrame = true;
  }
  const parsedFps = typeof config.fpsOverride === 'number'
    ? config.fpsOverride
    : parseFloat(config.fpsOverride);
  const resolvedFps = Number.isFinite(parsedFps) ? parsedFps : config.fps || 30;

  // Defer DF validation until the writer stage when the actual FPS is known.
  // Writers already enforce DF-specific constraints (e.g., SCC requires 29.97 DF).

  if (!config.logPath) {
    const supportBase2 = platformPaths.getAppDataBase();
    const appRoot2 = process.env.USER_DATA_PATH || path.join(supportBase2, 'LeadAEAssist');
    config.logPath = path.join(appRoot2, 'logs', 'transcribe');
  }
  try {
    fs.mkdirSync(config.logPath, { recursive: true });
  } catch (err) {
    const errMsg = `❌ Failed to create log directory: ${err.message}`;
    logLine(errMsg, true);
    jobLogger.setStage('error');
    structuredPath = structuredPath || jobLogger.getStructuredLogPath?.() || null;
    if (progressManager?.dispose) progressManager.dispose();
    persistJobLogs();
    cleanupTranscribeCancelHandle(config.jobId);
    return {
      success: false,
      cancelled: false,
      log: logs,
      logText: userLog.text(),
      archivePath,
      structuredLogPath: structuredPath,
      jobId: config.jobId
    };
  }
  
  const keepTempArtifacts = ['1', 'true'].includes(String(process.env.LEADAE_KEEP_TEMP || '').trim().toLowerCase());

  let successCount = 0;
  let failCount = 0;
  let cancelLogged = false;

  fileLoop: for (const [index, file] of config.files.entries()) {
    if (config.signal?.aborted) break;
    let tempInput = null;
    let inputFile = file;
    const statusMap = {
      engine: config.engine || null,
      engineDone: false
    };
    const baseName = path.basename(file, path.extname(file));
    // Update per-file subtitle context after fps/drop-frame parsing.
    lastSubtitleContext = {
      outputPath: config.outputPath,
      mediaPath: file,
      baseName,
      fps: resolvedFps,
      dropFrame: !!config.dropFrame,
      startTc: config.startTC || null
    };

    const emitStatus = () => {
      if (global.queue) {
        global.queue.emit('job-progress', {
          id: config.jobId,
          panel: 'transcribe',
          file,
          status: { ...statusMap },
          streamId: index
        });
      }
    };

    const isAbort = (err) => {
      if (config.signal?.aborted) return true;
      const name = String(err?.name || '');
      if (name === 'AbortError') return true;
      const msg = String(err?.message || '');
      return /cancelled|canceled/i.test(msg);
    };

    try {
      progressManager.startFile(index, file, 1);
      emitStatus();
      logLine(`🎬 Starting: ${file}`);

      const ext = path.extname(file).toLowerCase();
      const MAX_SIZE = 26214400;
      const isAudioCompatible = [
        '.wav', '.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.webm', '.mpga', '.mpeg'
      ].includes(ext);

      // Only do format fixes for the OpenAI Whisper API.
      if (config.engine === 'whisper') {
        try {
          const stats = await fs.promises.stat(file);
          if (isAudioCompatible) {
            if (stats.size > MAX_SIZE) {
              const mb = (stats.size / 1024 / 1024).toFixed(2);
              throw new Error(
                `❌ File too large for Whisper API: ${mb} MB (max ~25 MB per request). ` +
                `Use a local engine or split the media into smaller chunks.`
              );
            }
            logLine('✅ File extension and size are compatible with Whisper API');
            inputFile = file;
          } else {
            const jobTag = `job-${config.jobId || Date.now()}`;
            const tempDir = ensureUserDataSubdir('temp', 'transcribe', jobTag);
            const base = path.basename(file, ext);
            tempInput = path.join(tempDir, `${base}_leadai.m4a`);
            try {
              await fs.promises.unlink(tempInput);
            } catch (e) {
              if (e.code !== 'ENOENT') throw e;
            }

            logLine(`🔁 Re-encoding unsupported input ${file} → ${tempInput} for Whisper API`
            );

            try {
              if (config.signal?.aborted) {
                const cancelMsg = '🚫 Transcription cancelled by user.';
                logLine(cancelMsg);
                cancelLogged = true;
                break fileLoop;
              }
              await runFFmpeg([
                '-i', file,
                '-vn',
                '-ar', '16000',
                '-ac', '1',
                '-c:a', 'aac',
                '-b:a', '48k',
                '-movflags', '+faststart',
                tempInput
              ], config.signal);
            } catch (err) {
              if (config.signal?.aborted || err.name === 'AbortError') {
                const cancelMsg = '🚫 Transcription cancelled by user.';
                logLine(cancelMsg);
                cancelLogged = true;
                break fileLoop;
              }
              console.error(`❌ FFmpeg failed: ${err.message}`);
              if (err.stdout) console.error(`stdout: ${err.stdout}`);
              if (err.stderr) console.error(`stderr: ${err.stderr}`);
              throw err;
            }

            const outStats = await fs.promises.stat(tempInput);
            if (outStats.size > MAX_SIZE) {
              const mb = (outStats.size / 1024 / 1024).toFixed(2);
              throw new Error(
                `❌ Audio still too large for Whisper API after re-encode: ${mb} MB. ` +
                `Split into chunks or lower the bitrate further.`
              );
            }

            inputFile = tempInput;
            const mb = (outStats.size / 1024 / 1024).toFixed(2);
            logLine(`✅ Re-encoded to Whisper-compatible audio (${mb} MB)`);
          }
        } catch (err) {
          const errMsg = `❌ Whisper API input prep failed: ${err.message}`;
          logLine(errMsg, true);
          failCount++;
          emitStatus();
          continue;
        }
      }

      logLine(`⚙️ Engine: ${config.engine}`);
      const engineLogs = await runEngine(config.engine, inputFile, config);
      engineLogs.forEach(l => logLine(l));
      statusMap.engineDone = true;
      emitStatus();

      successCount++;
      progressManager.finishFile(index, statusMap);
    } catch (err) {
      if (isAbort(err)) {
        const cancelMsg = '🚫 Transcription cancelled by user.';
        logLine(cancelMsg);
        cancelLogged = true;
        try {
          progressManager.finishFile(index, statusMap);
        } catch (err) {
          jobLogger.warn('Progress manager finish failed during cancel', {
            file,
            error: err?.message || String(err)
          });
        }
        break fileLoop;
      }
      const errMsg = `❌ Error for ${file}: ${err.message}`;
      logLine(errMsg, true);
      failCount++;
      progressManager.finishFile(index, statusMap);
    } finally {
      if (config.cleanupOutputSidecars !== false) {
        try {
          cleanupTranscribeOutputSidecars({
            outputDir: config.outputPath,
            sourcePaths: [file, inputFile]
          });
        } catch (err) {
          jobLogger.warn('Transcribe sidecar cleanup failed', {
            file,
            inputFile,
            outputPath: config.outputPath,
            error: err?.message || String(err)
          });
        }
      }

      if (tempInput) {
        try {
          await fs.promises.unlink(tempInput);
        } catch (e) {
          if (e.code !== 'ENOENT') {
            console.error(`❌ Failed to cleanup temp file: ${e.message}`);
          }
        }

        // Remove the per-job temp folder (older builds left these behind as empty directories).
        if (!keepTempArtifacts) {
          try {
            const parentDir = path.dirname(tempInput);
            await fs.promises.rm(parentDir, { recursive: true, force: true });
          } catch {
            // best-effort
          }
        }
      }
    }
  }
  
  if (config.signal?.aborted && !cancelLogged) logLine('🚫 Transcription cancelled by user.');
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  logLine(`⏱️ Total time: ${totalTime}s`);
  logLine(`📄 Files processed: ${successCount + failCount} of ${config.files.length}`);
  logLine(`✅ Success: ${successCount}`);
  // Only mark failures as an error when there are actually failures.
  if (failCount === 0) {
    logLine(`✅ Failed: ${failCount}`);
  } else {
    logLine(`❌ Failed: ${failCount}`, true);
  }

  const processedFiles = successCount + failCount;
  const wasCanceled = config.signal?.aborted;
  reportStats = {
    requestedFiles: Array.isArray(config.files) ? config.files.length : 0,
    processedFiles,
    successfulFiles: successCount,
    failedFiles: failCount,
    cancelled: !!wasCanceled,
  };
  const finalStage = wasCanceled ? 'cancelled' : (failCount === 0 ? 'complete' : 'error');
  jobLogger.setStage(finalStage);
  jobLogger.info(
    wasCanceled
      ? 'Transcription cancelled'
      : (finalStage === 'complete' ? 'Transcription job completed' : 'Transcription job completed with errors')
  );

  persistJobLogs();

  if (progressManager?.dispose) progressManager.dispose();
  cleanupTranscribeCancelHandle(config.jobId);
  return {
    success: !wasCanceled && failCount === 0,
    cancelled: wasCanceled,
    log: logs,
    logText: userLog.text(),
    archivePath,
    structuredLogPath: structuredPath,
    jobId: config.jobId
  };
}

function cancelTranscribe(id) {
  const handle = transcribeCancelHandles.get(id);
  if (!handle) return;
  sendLogMessage(
    'transcribe',
    `🛑 Transcribe cancel requested for ${id}`,
    '',
    false,
    id || '',
    'warn',
    id || '',
    'cancel-request',
    { jobId: id, cancelRequested: true },
    Date.now()
  );
  if (id === activeTranscribeJobId && typeof cancelCurrentProcess === 'function') {
    cancelCurrentProcess();
  }
  cancelIngest(id);
  if (process.env.DEBUG_LOGS) {
    console.log('🛑 Transcription cancel requested');
  }
}

// ------------------------------------------------------------
// Subtitle editor doc normalization (viewer + IPC compatibility)
// ------------------------------------------------------------
// The subtitle editor preview (especially the SRT/VTT "web captions" overlay)
// expects each cue to have predictable fields.
//
// Historically some parsers (or schema normalization) might only populate
// cue.canonical.{start,end,text}, while UI code reads cue.{start,end,text}.
// When that happens, the cue list can still exist but the viewer shows nothing.
//
// This helper is intentionally conservative: it only *fills missing fields*
// and never overwrites existing values.
function normalizeSubtitleDocForViewer(doc, kindHint = '') {
  if (!doc || typeof doc !== 'object') return doc;

  const kind = String(kindHint || doc.kind || doc.format || '').toLowerCase();
  if (!doc.kind && kind) doc.kind = kind;
  if (!doc.format && kind) doc.format = kind;

  if (!Array.isArray(doc.cues)) return doc;

  const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const toMs = (sec) => (typeof sec === 'number' && Number.isFinite(sec) ? Math.round(sec * 1000) : null);

  const textFromRuns = (runs) => {
    if (!Array.isArray(runs)) return '';
    return runs.map(r => {
      if (!r || typeof r !== 'object') return '';
      const t = r.text;
      return t == null ? '' : String(t);
    }).join('');
  };

  const pickText = (cue, canon) => {
    const candidates = [
      cue?.text,
      cue?.textPlain,
      textFromRuns(cue?.runs),
      canon?.text,
      canon?.textPlain,
      textFromRuns(canon?.runs),
      Array.isArray(cue?.lines) ? cue.lines.join('\n') : null,
      Array.isArray(canon?.lines) ? canon.lines.join('\n') : null
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() !== '') return c;
    }
    return '';
  };

  doc.cues = doc.cues.map((cue, idx) => {
    if (!cue || typeof cue !== 'object') return cue;

    // Ensure a stable id for UI indexing.
    if (cue.id == null) cue.id = idx;

    const canon = (cue.canonical && typeof cue.canonical === 'object') ? cue.canonical : null;

    // Normalize start/end (seconds). Prefer explicit cue fields, then canonical,
    // then ms fields if present.
    let start = toNum(cue.start);
    if (start == null) start = toNum(canon?.start);
    if (start == null && typeof cue.startMs === 'number') start = cue.startMs / 1000;
    if (start == null && typeof canon?.startMs === 'number') start = canon.startMs / 1000;

    let end = toNum(cue.end);
    if (end == null) end = toNum(canon?.end);
    if (end == null && typeof cue.endMs === 'number') end = cue.endMs / 1000;
    if (end == null && typeof canon?.endMs === 'number') end = canon.endMs / 1000;

    if (start != null && cue.start == null) cue.start = start;
    if (end != null && cue.end == null) cue.end = end;
    if (canon) {
      if (start != null && canon.start == null) canon.start = start;
      if (end != null && canon.end == null) canon.end = end;
    }

    // Mirror ms fields (some UI helpers prefer ms for display).
    if (cue.startMs == null && start != null) cue.startMs = toMs(start);
    if (cue.endMs == null && end != null) cue.endMs = toMs(end);
    if (canon) {
      if (canon.startMs == null && start != null) canon.startMs = toMs(start);
      if (canon.endMs == null && end != null) canon.endMs = toMs(end);
    }

    // Normalize text fields.
    const text = pickText(cue, canon);
    if (cue.text == null || String(cue.text).trim() === '') cue.text = text;
    if (cue.textPlain == null || String(cue.textPlain).trim() === '') cue.textPlain = text;
    if (canon) {
      if (canon.text == null || String(canon.text).trim() === '') canon.text = text;
      if (canon.textPlain == null || String(canon.textPlain).trim() === '') canon.textPlain = text;
    }

    // Provide a lines[] convenience for UI/rendering (split on real newlines).
    // Also tolerate literal "\\n" sequences (common in some JSON payloads).
    if (!Array.isArray(cue.lines) || cue.lines.length === 0) {
      cue.lines = String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\\n/g, '\n')
        .split(/\n/);
    }
    if (canon && (!Array.isArray(canon.lines) || canon.lines.length === 0)) {
      canon.lines = cue.lines.slice();
    }

    return cue;
  });

  // Some viewer helpers (and older renderer builds) expect doc.segments to exist.
  // Keep it in sync for text-based formats.
  try {
    if (!Array.isArray(doc.segments)) {
      const fps = doc.fps || lastSubtitleContext?.fps || 30;
      const dropFrame = (typeof doc.dropFrame === 'boolean')
        ? doc.dropFrame
        : !!lastSubtitleContext?.dropFrame;
      doc.segments = cueListToSegments(doc.cues, fps, dropFrame);
    }
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ Failed to populate doc.segments from cues: ${err?.message || String(err)}`, '', false, '', 'warn');
  }

  return doc;
}


function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMergePlain(base, incoming) {
  const a = isPlainObject(base) ? base : {};
  const b = isPlainObject(incoming) ? incoming : null;
  if (!b) return { ...a };

  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMergePlain(out[k], v);
    else out[k] = v;
  }
  return out;
}

function applySubtitleDocOverrides(doc, payload) {
  if (!doc || typeof doc !== 'object' || !payload || typeof payload !== 'object') return doc;

  const kind = String(doc.kind || doc.format || '').toLowerCase();

  // Broadcast captions
  if (kind === 'scc' && isPlainObject(payload.sccOptions)) {
    doc.sccOptions = deepMergePlain(doc.sccOptions || {}, payload.sccOptions);
  }
  if (kind === 'mcc' && isPlainObject(payload.mccOptions)) {
    doc.mccOptions = deepMergePlain(doc.mccOptions || {}, payload.mccOptions);
  }

  // Web captions (SRT/VTT)
  if ((kind === 'srt' || kind === 'vtt') && isPlainObject(payload.formats)) {
    doc.formats = isPlainObject(doc.formats) ? doc.formats : {};
    if (kind === 'srt' && isPlainObject(payload.formats.srt)) {
      doc.formats.srt = deepMergePlain(doc.formats.srt || {}, payload.formats.srt);
    } else if (kind === 'vtt' && isPlainObject(payload.formats.vtt)) {
      doc.formats.vtt = deepMergePlain(doc.formats.vtt || {}, payload.formats.vtt);
    }
  }
  if (kind === 'srt' && isPlainObject(payload.srtOptions)) {
    doc.srtOptions = deepMergePlain(doc.srtOptions || {}, payload.srtOptions);
  }
  if (kind === 'vtt' && isPlainObject(payload.vttOptions)) {
    doc.vttOptions = deepMergePlain(doc.vttOptions || {}, payload.vttOptions);
  }

  return doc;
}

async function openSubtitleDocument(payload = {}) {
  const { sourcePath, mediaPath, sessionId } = payload;
  let resolvedPath = sourcePath;
  if (!resolvedPath && sessionId) {
    resolvedPath = subtitleSessions.get(sessionId)?.sourcePath;
  }
  if (!resolvedPath) {
    throw new Error('No subtitle path provided');
  }

  let doc;
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext === '.srt') {
    doc = parseSrtFile(resolvedPath, {
      fps: lastSubtitleContext?.fps || 30,
      dropFrame: !!lastSubtitleContext?.dropFrame,
      mediaPath: mediaPath || lastSubtitleContext?.mediaPath || null
    });
  } else if (ext === '.vtt') {
    doc = parseVttFile(resolvedPath, {
      fps: lastSubtitleContext?.fps || 30,
      dropFrame: !!lastSubtitleContext?.dropFrame,
      mediaPath: mediaPath || lastSubtitleContext?.mediaPath || null
    });
  } else if (ext === '.scc') {
    // SCC is CEA-608 in Scenarist format.
    // IMPORTANT: don't let lastSubtitleContext (from a prior 24/25/30 fps job) poison SCC metadata.
    // SCC supports both 29.97 DF (';') and 29.97 NDF (':').
    // We lock fps to 29.97, but detect DF/NDF from the file delimiter.
    doc = parseSccFile(resolvedPath, {
      fps: 29.97,
      // auto-detect DF/NDF from SCC delimiter
      dropFrame: null,
      mediaPath: mediaPath || lastSubtitleContext?.mediaPath || null
    });
  } else if (ext === '.mcc') {
    // MCC is typically CEA-708 CDP in SMPTE-291 ANC with optional 608 compatibility bytes.
    // Milestone 4 import decodes ONLY the 608 compatibility bytes, using the existing SCC/608 decoder.
    // IMPORTANT: do not inherit fps/dropFrame from lastSubtitleContext — MCC header/timecodes define it.
    doc = parseMccFile(resolvedPath, {
      // Let the MCC header determine fps/DF; decoder also auto-detects via delimiter.
      mediaPath: mediaPath || lastSubtitleContext?.mediaPath || null
    });
  } else {
    doc = parseJsonSubtitle(resolvedPath);
  }

  if (mediaPath && !doc.mediaPath) {
    doc.mediaPath = mediaPath;
  }

  // Phase 1: ensure canonical+overrides schema exists for all cue sources.
  ensureDocCueSchema(doc);

  // Defensive: make sure web-captions (SRT/VTT) have cue.{start,end,text}
  // so the preview overlay can render.
  normalizeSubtitleDocForViewer(doc, ext.replace('.', ''));

	// IMPORTANT: When reusing a subtitle-editor sessionId, stale SCC/MCC fields can
	// bleed into SRT/VTT docs (e.g., Start TC, export options). Those fields are
	// meaningless for web-caption formats and can cause the renderer to enable
  // SRT/VTT are web-caption (text+time) formats.
  // When the editor reuses sessionId, stale SCC/MCC fields can persist via session merges.
  // Force a clean identity and clean cue text so preview can render immediately.
  if (ext === '.srt' || ext === '.vtt') {
    const kind = ext.slice(1); // 'srt' | 'vtt'

    // Force identity so the renderer routes through the web-captions UI.
    doc.kind = kind;
    doc.format = kind;

    // Force-clear timecode offset metadata.
    doc.startTc = null;
    doc.startTC = null;
    doc.startTcMs = null;
    doc.firstTimecode = null;

    // Ensure metadata exists so session merges actually overwrite stale values.
    if (!doc.metadata || typeof doc.metadata !== 'object') doc.metadata = {};
    try { delete doc.metadata.startTimecode; } catch (err) {
      // Safe to ignore: metadata key removal is cleanup-only before re-export.
      sendLogMessage('transcribe', `⚠️ Metadata cleanup skipped (startTimecode): ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
    }
    try { delete doc.metadata.startTc; } catch (err) {
      // Safe to ignore: metadata key removal is cleanup-only before re-export.
      sendLogMessage('transcribe', `⚠️ Metadata cleanup skipped (startTc): ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
    }
    try { delete doc.metadata.startTC; } catch (err) {
      // Safe to ignore: metadata key removal is cleanup-only before re-export.
      sendLogMessage('transcribe', `⚠️ Metadata cleanup skipped (startTC): ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
    }

    // Clear format-specific option blocks / derived-track state that can persist via session merges.
    doc.sccOptions = null;
    doc.mccOptions = null;
    doc.cuesByService = null;
    doc.docsByService = null;

    // Ensure cue.text exists even if schema normalization stored it only as runs.
    const _textFromRuns = (runs) => {
      if (!Array.isArray(runs)) return '';
      return runs.map(r => {
        if (!r || typeof r !== 'object') return '';
        const t = r.text;
        return t == null ? '' : String(t);
      }).join('');
    };

    const _srcLower = String(doc?.sourcePath || doc?.displayName || '').toLowerCase();
    const _kindLower = String(doc?.kind || doc?.format || '').toLowerCase();
    const _isSccLike = (_kindLower === 'scc') || (_kindLower === 'cea608') || (_kindLower === '608') || _srcLower.endsWith('.scc');
    const _isMcc = (_kindLower === 'mcc') || _srcLower.endsWith('.mcc');

    if (Array.isArray(doc.cues)) {
      for (const cue of doc.cues) {
        if (!cue || typeof cue !== 'object') continue;

        if (cue.text == null || String(cue.text).trim() === '') {
          const fromRuns = _textFromRuns(cue.runs) || _textFromRuns(cue.canonical?.runs);
          if (fromRuns && fromRuns.trim() !== '') cue.text = fromRuns;
        }

        if ((!Array.isArray(cue.lines) || cue.lines.length === 0) && typeof cue.text === 'string' && cue.text.trim() !== '') {
          cue.lines = cue.text.replace(/\r/g, '').split(/\n/g).slice(0, 4);
        }

        // Clear stale placement/snapshots only for formats where they should never exist.
        // SCC + MCC legitimately use sccPlacement (SCC canonical placement, MCC 608 overrides).
        if (!_isSccLike && !_isMcc && ('sccPlacement' in cue)) cue.sccPlacement = null;
        // The decoded 708 snapshot (cue.cea708) is meaningful only for MCC/708 round-trips.
        if (!_isMcc && ('cea708' in cue)) cue.cea708 = null;
      }
    }
  }



  // Optional: merge format/QC options provided by caller (e.g., Transcribe panel handoff)
  try { applySubtitleDocOverrides(doc, payload); } catch {}

  const session = storeSession(doc, sessionId);
  return {
    ...session,
    lastExport: session.lastExport || null
  };
}


function normalizeCorrectionExportFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'webvtt') return 'vtt';
  if (raw === 'finaljson' || raw === 'final.json') return 'json';
  return (raw === 'srt' || raw === 'vtt' || raw === 'json') ? raw : '';
}

function resolveCorrectionExportFormat(doc, requestedFormat, fallback = 'srt') {
  const explicit = normalizeCorrectionExportFormat(requestedFormat);
  if (explicit) return explicit;

  const kind = normalizeCorrectionExportFormat(doc?.kind || doc?.format);
  if (kind) return kind;

  const src = String(doc?.sourcePath || doc?.displayName || '').trim().toLowerCase();
  if (src.endsWith('.srt')) return 'srt';
  if (src.endsWith('.vtt')) return 'vtt';
  if (src.endsWith('.json')) return 'json';

  if (doc?.originalJson && typeof doc.originalJson === 'object') return 'json';

  const safeFallback = normalizeCorrectionExportFormat(fallback);
  return safeFallback || 'srt';
}

async function exportCorrectedSubtitles(payload = {}) {
  const { doc, sessionId } = payload;
  if (!doc || !Array.isArray(doc.cues)) {
    throw new Error('No subtitle cues provided');
  }

  // Phase 1: be tolerant of docs sent from renderer/IPC that might not yet
  // contain normalized canonical+overrides shapes.
  try {
    ensureDocCueSchema(doc);
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ Cue schema normalization failed before corrected export: ${err?.message || String(err)}`, '', false, sessionId || doc?.sessionId || '', 'warn');
  }

  const fps = doc.fps || lastSubtitleContext?.fps || 30;
  const dropFrame = (typeof doc.dropFrame === 'boolean') ? doc.dropFrame : !!lastSubtitleContext?.dropFrame;
  const kind = String(doc.kind || doc.format || '').toLowerCase();
  const src = String(doc.sourcePath || doc.displayName || '').toLowerCase();
  const isMcc = (kind === 'mcc') || src.endsWith('.mcc');
  const isSccLike = (kind === 'scc') || (kind === 'cea608') || (kind === '608') || src.endsWith('.scc');
  const is708Like = (kind === 'cea708') || (kind === '708') || (kind === 'dtvcc') || (
    isMcc && doc.cues.some(c => c && c.cea708 && Array.isArray(c.cea708.windows) && c.cea708.windows.length)
  );
  // 608-style docs (SCC / 608-only MCC) get placement tags + 2-line clamping.
  const is608Like = isSccLike || (isMcc && !is708Like);
  const segments = cueListToSegments(doc.cues, fps, dropFrame).map((seg, idx) => {
    const cue = doc.cues?.[idx];
    if (!cue) return seg;

    if (is608Like) {
      // Prefer the parsed/editor `lines` so placement and wrapping match 608 reality.
      const lines = (Array.isArray(cue.lines) && cue.lines.length)
        ? cue.lines.slice(0, 2)
        : String(seg.text || '')
          .replace(/\\n/g, '\n')
          .split(/\r?\n|\s*\|\s*/g)
          .slice(0, 2);

      const pairs = lines
        .map((ln, i) => ({ ln, pl: cue.sccPlacement?.[i] || null }))
        .filter(p => String(p.ln || '').trim());

      const withTags = pairs.map(({ ln, pl }) => (
        pl && Number.isFinite(pl.row) && Number.isFinite(pl.col)
          ? `{row:${pl.row}}{col:${pl.col}}${ln}`
          : ln
      )).join('\n');

      return { ...seg, text: withTags };
    }

    // For SRT/VTT/708/other docs, keep the full cue text and let writers do shaping.
    const baseText = (typeof cue.text === 'string') ? cue.text : seg.text;
    return { ...seg, text: String(baseText || '').replace(/\\n/g, '\n') };
  });
  const cues = segmentsToCueList(segments, fps, dropFrame);

  const exportFormat = resolveCorrectionExportFormat(doc, payload?.exportFormat, 'srt');

  // Optional explicit output paths (Save As… driven by the renderer).
  // If provided, we write to the exact path for the selected export format.
  const outReq = (payload && typeof payload.outputPaths === 'object') ? payload.outputPaths : null;
  const reqSrt = normalizeOutputPath(outReq?.srt);
  const reqVtt = normalizeOutputPath(outReq?.vtt);
  const reqJson = normalizeOutputPath(outReq?.json);
  const explicitPaths = { srt: reqSrt, vtt: reqVtt, json: reqJson };
  const explicitAnchor = reqSrt || reqVtt || reqJson || null;
  const explicitPath = explicitPaths[exportFormat] || null;
  const hasExplicit = !!explicitPath;

  let targetDir = doc.outputDir;
  if (explicitAnchor) {
    try {
      targetDir = path.dirname(explicitAnchor);
    } catch (err) {
      sendLogMessage('transcribe', `⚠️ Failed to derive output directory from explicit subtitle path: ${err?.message || String(err)}`, '', false, sessionId || doc?.sessionId || '', 'warn');
    }
  }
  if (!targetDir && doc.sourcePath) targetDir = path.dirname(doc.sourcePath);
  if (!targetDir && lastSubtitleContext?.outputPath) targetDir = lastSubtitleContext.outputPath;
  if (!targetDir) targetDir = ensureUserDataSubdir('temp', 'subtitles');

  const baseName = doc.baseName
    || (doc.sourcePath ? path.basename(doc.sourcePath, path.extname(doc.sourcePath))
    : (doc.mediaPath ? path.basename(doc.mediaPath, path.extname(doc.mediaPath)) : 'subtitle'));

  const meta = {
    sourcePath: doc.sourcePath,
    mediaPath: doc.mediaPath,
    fps,
    dropFrame,
    startTimecode: doc.startTc || doc.startTC || null
  };

  const outputs = { directory: targetDir };
  let savedPath = null;

  if (exportFormat === 'vtt') {
    savedPath = hasExplicit
      ? await writeCorrectedVTTToPath(segments, explicitPath, { includeSpeakerNames: true })
      : await writeCorrectedVTT(segments, targetDir, baseName, { includeSpeakerNames: true });
    outputs.vtt = savedPath;
  } else if (exportFormat === 'json') {
    savedPath = hasExplicit
      ? await writeCorrectedJsonToPath(cues, explicitPath, meta)
      : await writeCorrectedJson(cues, targetDir, baseName, meta);
    outputs.json = savedPath;
  } else {
    savedPath = hasExplicit
      ? await writeCorrectedSRTToPath(segments, explicitPath, { includeSpeakerNames: true })
      : await writeCorrectedSRT(segments, targetDir, baseName, { includeSpeakerNames: true });
    outputs.srt = savedPath;
  }

  const session = storeSession({
    ...doc,
    sourcePath: doc.sourcePath || (subtitleSessions.get(sessionId || doc.sessionId)?.sourcePath),
    mediaPath: doc.mediaPath || subtitleSessions.get(sessionId || doc.sessionId)?.mediaPath || null,
    outputDir: targetDir,
    lastExport: outputs
  }, sessionId || doc.sessionId);

  return {
    success: true,
    exportFormat,
    message: `Saved corrections to ${savedPath}`,
    outputs: session.lastExport
  };
}

async function burnInCorrectedSubtitles(payload = {}) {
  const { doc, sessionId, lastExport } = payload;
  const session = subtitleSessions.get(sessionId || doc?.sessionId) || {};
  const combined = { ...session, ...(doc || {}) };
  const mediaPath = combined.mediaPath || lastSubtitleContext?.mediaPath;
  if (!mediaPath) {
    throw new Error('No media path available for burn-in');
  }

  const exportInfo = lastExport || session.lastExport;
  if (!exportInfo?.srt) {
    throw new Error('Export corrections before burn-in');
  }

  const outputDir = combined.outputDir || exportInfo?.directory || path.dirname(mediaPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = path.basename(mediaPath, path.extname(mediaPath));
  const outputMov = path.join(outputDir, `${baseName}.burnin.mov`);

  const srtPath = exportInfo.srt;
  const escapeFfmpegFilterArg = (value) => (
    value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/,/g, '\\,')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
  );
  const escapedSrt = escapeFfmpegFilterArg(srtPath);
  // Keep subtitle-editor burn-in styling aligned with the Transcribe panel
  // so both workflows generate visually consistent review files.
  const vf = `subtitles='filename=${escapedSrt}:force_style=FontName=Arial,FontSize=22,Outline=2,Shadow=1'`;

  await runFFmpeg([
    '-y',
    '-i', mediaPath,
    '-vf', vf,
    '-c:v', 'prores_ks',
    '-profile:v', '3',
    '-c:a', 'copy',
    outputMov
  ]);

  session.outputDir = outputDir;
  session.lastExport = { ...exportInfo, directory: outputDir, burnIn: outputMov };
  subtitleSessions.set(session.sessionId || sessionId || doc?.sessionId || randomUUID(), session);

  return {
    success: true,
    message: `Burn-in complete → ${outputMov}`,
    output: outputMov
  };
}

async function findLatestSubtitleSource(payload = {}) {
  const searchDir = payload.outputPath || lastSubtitleContext?.outputPath;
  if (!searchDir) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(searchDir);
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ Failed reading subtitle source directory: ${err?.message || String(err)}`, '', false, payload?.jobId || '', 'warn');
    return null;
  }

  const subtitleEntries = entries.filter(name => /\.(json|srt|vtt|scc|mcc)$/i.test(name));
  if (!subtitleEntries.length) return null;

  const prefix = payload.baseName || lastSubtitleContext?.baseName;
  const byPrefix = subtitleEntries.filter(name => !prefix || name.startsWith(prefix));
  // If a naming template changed the basename, don't fail closed.
  // Fall back to the full directory and let mtime + preferred extension pick the freshest export.
  const candidateNames = byPrefix.length ? byPrefix : subtitleEntries;

  const decorated = candidateNames
    .map(name => {
      const full = path.join(searchDir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch (err) {
        sendLogMessage('transcribe', `⚠️ Failed to stat subtitle candidate "${full}": ${err?.message || String(err)}`, '', false, payload?.jobId || '', 'warn');
      }
      return { name, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const preferredExts = Array.isArray(payload.preferredExts)
    ? payload.preferredExts
        .map(ext => String(ext || '').trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (preferredExts.length) {
    for (const ext of preferredExts) {
      const match = decorated.find(entry => entry.name.toLowerCase().endsWith(ext));
      if (match) return match.full;
    }
  }

  const priorities = [
    '.corrected.scc',
    '.scc',
    '.corrected.mcc',
    '.mcc',
    '.corrected.final.json',
    '.final.json',
    '.corrected.srt',
    '.srt',
    '.corrected.vtt',
    '.vtt',
    '.json'
  ];

  for (const ext of priorities) {
    const match = decorated.find(entry => entry.name.toLowerCase().endsWith(ext));
    if (match) return match.full;
  }

  return decorated[0]?.full || null;
}

function normalizeMusicGlyphLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return line;
  const up = raw.toUpperCase();
  if (up === '[MUSIC]' || up === '[MUSIC ONLY]' || up === '[MUSIC INTRO]' || up === '[MUSIC OUT]') {
    return '♪';
  }
  return line;
}

function normalizeOutputPath(input) {
  // Accept either:
  //  - string "/path/to/file.scc"
  //  - { filePath: "/path/to/file.scc" } (dialog-return style)
  //  - { path: "/path/to/file.scc" } (defensive)
  if (!input) return null;
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    const p = input.filePath || input.path || input.outPath || null;
    return (typeof p === 'string' && p.trim()) ? p : null;
  }
  return null;
}

async function exportSccFromEditor(payload = {}) {
  const { doc, sessionId, outputPath } = payload;
  if (!doc || !Array.isArray(doc.cues)) {
    throw new Error('No subtitle cues provided');
  }

  // Phase 1: normalize cue schema for export paths.
  try {
    ensureDocCueSchema(doc);
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ Cue schema normalization failed before SCC export: ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
  }

  let outPath = null;
  const normalized = normalizeOutputPath(outputPath);
  if (normalized) {
    outPath = normalized;
  } else {
    let targetDir = doc.outputDir;
    if (!targetDir) {
      throw new Error('No export destination selected.');
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const baseName = doc.baseName
      || (doc.sourcePath ? path.basename(doc.sourcePath, path.extname(doc.sourcePath))
      : (doc.mediaPath ? path.basename(doc.mediaPath, path.extname(doc.mediaPath)) : 'subtitle'));
    outPath = path.join(targetDir, `${baseName}.corrected.scc`);
  }

  // SCC export is always 29.97-timebase, but SCC itself supports both:
  //  - DF labels (;) — default
  //  - NDF labels (:) — only when explicitly enabled
  // We intentionally DO NOT fall back to lastSubtitleContext here because that can come from
  // unrelated jobs (e.g. 24/25/30) and would make SCC export inconsistent.
  const fps = 29.97;
  const wantsNdf = doc?.dropFrame === false;
  const allowNdf = !!doc?.sccOptions?.allowNdf;
  const dropFrame = wantsNdf ? false : true;
  if (wantsNdf && !allowNdf) {
    throw new Error('NDF SCC export is disabled. Enable sccOptions.allowNdf (advanced) to export ":" timecodes.');
  }

  const alignment = (() => {
    const raw = doc?.sccOptions?.alignment || doc?.alignment || 'center';
    const norm = String(raw || '').trim().toLowerCase();
    return norm === 'centre' ? 'center' : norm || 'center';
  })();

  // SCC speaker labels are a QC risk for some broadcast deliverables.
  // Keep OFF by default; allow opt-in via doc.sccOptions.includeSpeakerNames.
  const includeSpeakerNamesScc = !!doc?.sccOptions?.includeSpeakerNames;

  const injectSpeakerPrefixAfterPlacementTags = (text, speakerPrefix) => {
    const t = String(text || '');
    const pfx = String(speakerPrefix || '');
    if (!pfx) return t;
    const lines = t.split('\n');
    const first = lines[0] || '';
    const m = first.match(/^((?:\{(?:row|col|pac):[^}]+\})+)(.*)$/);
    if (m) {
      const tags = m[1] || '';
      const body = m[2] || '';
      lines[0] = body.startsWith(pfx) ? `${tags}${body}` : `${tags}${pfx}${body}`;
    } else {
      lines[0] = first.startsWith(pfx) ? first : `${pfx}${first}`;
    }
    return lines.join('\n');
  };

  const segments = cueListToSegments(doc.cues, fps, dropFrame).map((seg, idx) => {
    const cue = doc.cues?.[idx];
    if (!cue) return seg;
    // Prefer the parsed/editor `lines` so placement and wrapping match 608 reality.
    const lines = (Array.isArray(cue.lines) && cue.lines.length)
      ? cue.lines.slice(0, 2)
      : String(seg.text || '')
        .replace(/\\n/g, '\n')
        .split(/\r?\n|\s*\|\s*/g)
        .slice(0, 2);
    const pairs = lines
      .map((ln, i) => ({ ln: normalizeMusicGlyphLine(ln), pl: cue.sccPlacement?.[i] || null }))
      .filter(p => String(p.ln || '').trim());
    const withTags = pairs.map(({ ln, pl }) => (
      pl && Number.isFinite(pl.row) && Number.isFinite(pl.col)
        ? `{row:${pl.row}}{col:${pl.col}}${ln}`
        : ln
    )).join('\n');
    return { ...seg, text: withTags };
  });

  // If speaker labels are enabled, bake them into the first line *after* any
  // placement tags so we don't break {row}/{col}.
  // Then disable encoder auto-prefixing to avoid double insertion.
  let segmentsForScc = includeSpeakerNamesScc
    ? segments.map(seg => {
        if (!seg || !seg.speaker) return seg;
        const sp = String(seg.speaker || '').trim();
        if (!sp) return seg;
        const prefix = `${sp}: `;
        return { ...seg, text: injectSpeakerPrefixAfterPlacementTags(seg.text, prefix) };
      })
    : segments;

  // Editor SCC shaping: clamp to 608-safe ranges
  const rawMaxChars = Number(doc.maxCharsPerLine);
  const maxCharsPerLine = Math.max(20, Math.min(32, Number.isFinite(rawMaxChars) ? rawMaxChars : 28));
  const rawMaxLines = Number(doc.maxLinesPerBlock || 2);
  const maxLinesPerBlock = Math.max(1, Math.min(2, Number.isFinite(rawMaxLines) ? rawMaxLines : 2));

  const startTc = doc?.startTc || doc?.startTC || doc?.sccOptions?.startTc || doc?.sccOptions?.startTC || null;
  // SCC export policy (single source of truth where available)
  // Values: 'warn' | 'gate_write' | 'gate_block'
  const exportPolicy = normalizeExportPolicy(doc?.sccOptions?.exportPolicy, '');

  // Generate SCC (strict first; optional draft fallback on overflow/encoding).
  // In Strict Deliverable (gate_block), draft salvage is forcibly OFF.
  const allowDraft = (exportPolicy === 'gate_block')
    ? false
    : (doc?.sccOptions?.draft !== false); // default ON

  const qcCfg = (doc && doc.sccOptions && doc.sccOptions.qc) ? doc.sccOptions.qc : {};
  const qcGateFromPolicy = (exportPolicy === 'gate_write' || exportPolicy === 'gate_block');
  const qcGate = qcGateFromPolicy
    ? true
    : (qcCfg?.gate === true || qcCfg?.failJob === true || doc?.sccOptions?.qcGate === true);
  const blockWriteOnQcFail = (exportPolicy === 'gate_block');

  const overflowRequested = (() => {
    const raw = (doc?.sccOptions?.overflowPolicy);
    const fallbackDefault = qcGate ? 'error' : 'truncate';
    const v = (raw == null) ? fallbackDefault : String(raw || '');
    const norm = String(v || '').trim().toLowerCase();
    return norm || fallbackDefault;
  })();
  const overflowFallback = (() => {
    const raw = (doc?.sccOptions?.fallbackOverflowPolicy) ?? 'truncate';
    const norm = String(raw || '').trim().toLowerCase();
    return (norm && norm !== 'error') ? norm : 'truncate';
  })();
  const strictEncodingRequested = doc?.sccOptions?.strictCharacterEncoding === true;

  // UI/JSON may carry prefix words as a string (e.g. "9420 94AE") or an array.
  // The encoder expects an array of 4-hex SCC words.
  const normalizePrefixWords = (value) => {
    if (Array.isArray(value)) {
      const out = value.map(v => String(v || '').trim()).filter(Boolean);
      return out.length ? out : null;
    }
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const toks = raw
      .split(/[\s,]+/g)
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => t.replace(/^0x/i, ''))
      .filter(t => /^[0-9A-Fa-f]{4}$/.test(t))
      .map(t => t.toUpperCase());
    return toks.length ? toks : null;
  };
  const prefixWords = normalizePrefixWords(doc?.sccOptions?.prefixWords);

  const encoderAttempts = [];
  let usedEncoder = { pass: 'primary', overflowPolicy: overflowRequested, strictCharacterEncoding: strictEncodingRequested };
  let sccRes = null;

  const genAttempts = [
    { pass: 'primary', overflowPolicy: overflowRequested, strictCharacterEncoding: strictEncodingRequested }
  ];
  if (allowDraft && (overflowFallback !== overflowRequested || strictEncodingRequested)) {
    genAttempts.push({ pass: 'draft', overflowPolicy: overflowFallback, strictCharacterEncoding: false });
  }

  const makeGenOpts = (attempt) => ({
    fps,
    dropFrame,
    startTc,
    maxCharsPerLine,
    maxLinesPerBlock,
    // Speaker labels (if enabled) were baked into seg text above.
    includeSpeakerNames: false,
    sccOptions: {
      // Defaults aim for broadcaster/QC compatibility.
      alignment,
      // NDF SCC export is opt-in and must be explicitly enabled.
      allowNdf,
      strictCharacterEncoding: attempt.strictCharacterEncoding,
      overflowPolicy: attempt.overflowPolicy,
      preStartTransmitSec: (() => {
        const v = Number(doc?.sccOptions?.preStartTransmitSec);
        return Number.isFinite(v) && v > 0 ? v : 0;
      })(),
      // Caption service (CC1–CC4)
      channel: normalizeSccChannel(doc?.sccOptions?.channel),
      rowPolicy: (doc?.sccOptions?.rowPolicy) || 'bottom2',
      // Default safeMargins to full 32-col width (col 0 start).
      // Title-safe width is handled by maxCharsPerLine (defaults to 28 unless overridden by the doc).
      safeMargins: (doc?.sccOptions?.safeMargins) || { left: 0, right: 0 },
      padEven: !!(doc?.sccOptions?.padEven),
      extendedGlyphMap,
      prefixWords,
      repeatControlCodes: (doc?.sccOptions?.repeatControlCodes) !== false,
      repeatPreambleCodes: (doc?.sccOptions?.repeatPreambleCodes) !== false,
      timeSource: (doc?.sccOptions?.timeSource) || 'auto',
      // Optional post-production slip/offset applied to all cue times
      timecodeOffset: doc?.sccOptions?.timecodeOffset ?? doc?.sccOptions?.captionOffset ?? doc?.sccOptions?.offset,
      appendEOFAt: (doc?.sccOptions?.appendEOFAt) || 'afterLast',
      eofOp: (doc?.sccOptions?.eofOp) || 'edm',
      stripLeadingDashes: !!(doc?.sccOptions?.stripLeadingDashes),
      // F) Optional program-start reset support (passed through if present)
      startResetAt: doc?.sccOptions?.startResetAt,
      startResetOp: doc?.sccOptions?.startResetOp
    },
    returnStats: true
  });

  for (const attempt of genAttempts) {
    try {
      sccRes = scc.generateSCC(segmentsForScc, makeGenOpts(attempt));
      usedEncoder = attempt;
      break;
    } catch (e) {
      encoderAttempts.push({
        pass: attempt.pass,
        overflowPolicy: attempt.overflowPolicy,
        strictCharacterEncoding: attempt.strictCharacterEncoding,
        message: e?.message || String(e)
      });
    }
  }

  if (!sccRes) {
    const last = encoderAttempts[encoderAttempts.length - 1];
    throw new Error(last?.message || 'SCC generation failed');
  }

  let outputText = typeof sccRes === 'string' ? sccRes : sccRes?.scc || '';
  let encoderStats = (sccRes && typeof sccRes === 'object' && sccRes.stats) ? sccRes.stats : null;

  // Optional: Start TC clamp fix (first cue)
  // If Start TC is set and preStartTransmitSec=0, SCC transmit is clamped to Start TC.
  // The encoder may warn that the first caption transmit would have needed to start earlier;
  // delaying the first cue resolves it cleanly and removes late‑EOC warnings.
  let firstCueDelaySec = 0;
  try {
    const shapingCfg = doc?.sccOptions?.shaping;
    const startTcStr = startTc ? String(startTc).trim() : '';
    const preStartTransmitSec = (() => {
      const v = Number(doc?.sccOptions?.preStartTransmitSec);
      return Number.isFinite(v) && v > 0 ? v : 0;
    })();

    if (shapingCfg && shapingCfg.enabled !== false && shapingCfg.fixStartTcClamp !== false && startTcStr && preStartTransmitSec === 0) {
      const warningsArr = Array.isArray(encoderStats?.warnings) ? encoderStats.warnings : [];
      const w = warningsArr.find(x => /Start TC clamp: first caption transmit delayed by/i.test(String(x)));
      if (w) {
        const m = String(w).match(/delayed by\s+([0-9.]+)s/i);
        const delta = m ? Number(m[1]) : 0;
        if (Number.isFinite(delta) && delta > 0) {
          const gap = Number.isFinite(Number(qcCfg?.minGapSec)) ? Number(qcCfg.minGapSec) : 0.1;
          firstCueDelaySec = delta;

          // Delay first cue + ripple forward to preserve ordering.
          const frameSec = (Number(fps) > 0) ? (1 / Number(fps)) : (1 / 29.97);

          if (segmentsForScc.length) {
            segmentsForScc = segmentsForScc.map((seg, idx) => {
              if (!seg) return seg;
              if (idx === 0) return { ...seg, start: seg.start + delta, end: seg.end + delta };
              return seg;
            });

            for (let i = 1; i < segmentsForScc.length; i++) {
              const prev = segmentsForScc[i - 1];
              const cur = segmentsForScc[i];
              const minStart = (prev.end + gap);
              if (cur.start < minStart) {
                const need = minStart - cur.start;
                segmentsForScc[i] = { ...cur, start: cur.start + need, end: cur.end + need };
              }
              const cur2 = segmentsForScc[i];
              if (cur2.end <= cur2.start + frameSec) {
                segmentsForScc[i] = { ...cur2, end: cur2.start + Math.max(frameSec, 0.5) };
              }
            }

            // Re-generate SCC with the same attempt settings that succeeded (strict or draft).
            try {
              const rerun = scc.generateSCC(segmentsForScc, makeGenOpts(usedEncoder));
              if (rerun) {
                sccRes = rerun;
                outputText = typeof sccRes === 'string' ? sccRes : sccRes?.scc || '';
                encoderStats = (sccRes && typeof sccRes === 'object' && sccRes.stats) ? sccRes.stats : encoderStats;
              }
            } catch (err) {
              sendLogMessage('transcribe', `⚠️ SCC rerun with selected encoder profile failed: ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
            }
          }
        }
      }
    }
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ SCC header normalization fallback encountered an error: ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
  }
  // Safety: guarantee header is first, move any pre-header comments beneath it
  outputText = outputText.replace(/^\uFEFF/, '');
  {
    const L = outputText.replace(/\r/g,'').split('\n');
    const i = L.findIndex(l => /^Scenarist_SCC\b/i.test(l.trim()));
    if (i > 0) {
      const pre = L.slice(0, i).filter(l => l.trim().startsWith('//'));
      outputText = [L[i], ...pre, ...L.slice(i + 1)].join('\n').replace(/\n+$/, '') + '\n';
    }
  }
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });

  // D) Content-level QC (Rev/MaxCaption-grade): enforce readability + timing
  // thresholds, not just SCC structural validity.
  const contentQc = (typeof validateSccContentQc === 'function')
    ? validateSccContentQc(segmentsForScc, {
        fps,
        dropFrame,
        startTc,
        // QC should evaluate the FINAL SCC output so line breaks/lengths match
        // what downstream QC/NLE ingest will see.
        sccText: outputText,
        maxCharsPerLine,
        maxLinesPerBlock,
        safeMargins: (doc?.sccOptions?.safeMargins) || null,
        maxCps: qcCfg.maxCps,
        maxWpm: qcCfg.maxWpm,
        minDurationSec: qcCfg.minDurationSec,
        maxDurationSec: Number(doc?.maxDurationSeconds ?? 6.0),
        minGapSec: qcCfg.minGapSec,
        maxLateEocSec: qcCfg.maxLateEocSec,
        maxLateEocCount: qcCfg.maxLateEocCount,
        // Encoder-derived late-EOC stats when available
        lateEocCount: Number(encoderStats?.lateEocCount ?? 0),
        maxLateEocSecObserved: Number(encoderStats?.maxLateEocSec ?? 0)
      })
    : null;

  // QC: verify parity/tokens so we fail fast instead of handing Premiere junk
  let verify = null;
  let verifyErr = null;
  try {
    if (typeof scc.verifySCC === 'function') {
      verify = scc.verifySCC(outputText);
      if (!verify.ok || verify.invalidTokens > 0) {
        verifyErr = new Error(`SCC verify failed — ${verify.summary}`);
      }
    }
  } catch (e) {
    // Surface verifier problems as an actionable error
    verifyErr = e;
  }

  // G) QC report sidecar (same pattern as transcription SCC writer)
  const reportOut = writeSccQcReport({
    sccText: outputText,
    verify,
    metrics: {
      encoderStats,
      contentQc,
      firstCueDelaySec,
      encoderPolicy: usedEncoder,
      encoderAttemptFailures: encoderAttempts
    },
    srcLabel: 'subtitle-editor',
    outPath
  });
  // QC results can be used three ways (exportPolicy):
  //   warn       → always write, surface warnings
  //   gate_write → write + return failure (so the UI can’t miss QC)
  //   gate_block → block writing when QC fails
  const warnings = [];

  if (usedEncoder?.pass === 'draft') {
    warnings.push(`encoder fallback used (overflowPolicy=${usedEncoder.overflowPolicy}, strictEncoding=OFF)`);
  }

  if (contentQc && !contentQc.ok) {
    const head = contentQc.failures?.[0];
    const sample = head
      ? `${head.message}${head.startTc ? ` @ ${head.startTc}` : ''}`
      : 'One or more content QC failures.';
    warnings.push(`content QC failed — ${contentQc.failures.length} issue(s). ${sample}`);
  }

  if (verifyErr) {
    warnings.push(`verification error: ${verifyErr.message}`);
  }

  const reportPath = reportOut?.reportPath || `${outPath}.report.txt`;
  const hasWarnings = Array.isArray(warnings) && warnings.length > 0;

  const shouldBlockWrite = !!(hasWarnings && qcGate && blockWriteOnQcFail);
  const wroteFile = !shouldBlockWrite;

  const writtenFiles = wroteFile ? [outPath] : [];
  const structuralErrorCount = 0;
  const qcFailCount = Array.isArray(contentQc?.failures) ? contentQc.failures.length : 0;
  const qcWarningCount = Array.isArray(contentQc?.warnings) ? contentQc.warnings.length : 0;

  if (wroteFile) {
    const writeText = outputText.replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(outPath, writeText, 'utf8');
  }

  const existing = subtitleSessions.get(sessionId || doc.sessionId) || {};
  const mergedLastExport = {
    ...(existing.lastExport || {}),
    ...(doc.lastExport || {}),
    directory: outDir,
    ...(wroteFile ? { scc: outPath } : {})
  };

  storeSession({ ...doc, outputDir: outDir, lastExport: mergedLastExport }, sessionId || doc.sessionId);

  if (shouldBlockWrite) {
    const encoderFallbackUsed = usedEncoder?.pass === 'draft';
    return {
      status: 'fail_qc',
      success: false,
      error: `SCC QC gate failed — SCC was NOT written. Report: ${reportPath}`,
      warning: true,
      qcGateFailed: true,
      qcGateBlocked: true,
      message: `⛔ SCC NOT saved — QC failed (see report)`,
      output: null,
      intendedOutput: outPath,
      writtenFiles: [],
      reportPath,
      structuralErrorCount,
      qcFailCount,
      qcWarningCount,
      encoderFallbackUsed,
      warnings
    };
  }

  if (hasWarnings && qcGate) {
    const encoderFallbackUsed = usedEncoder?.pass === 'draft';
    const qcFailed = !!(contentQc && !contentQc.ok);
    const status = qcFailed ? 'partial_written' : (encoderFallbackUsed ? 'fail_fallback' : 'partial_written');
    return {
      status,
      success: false,
      error: `SCC QC gate failed — output was written for editing. SCC: ${outPath} • Report: ${reportPath}`,
      warning: true,
      qcGateFailed: true,
      qcGateBlocked: false,
      message: `⚠️ SCC saved with QC warnings → ${outPath} (see report)`,
      output: outPath,
      writtenFiles,
      reportPath,
      structuralErrorCount,
      qcFailCount,
      qcWarningCount,
      encoderFallbackUsed,
      warnings
    };
  }

  return {
    status: 'success',
    success: true,
    warning: hasWarnings,
    qcGateFailed: false,
    qcGateBlocked: false,
    message: hasWarnings
      ? `⚠️ SCC saved with QC warnings → ${outPath} (see report)`
      : `SCC saved → ${outPath}`,
    output: wroteFile ? outPath : null,
    writtenFiles,
    reportPath,
    structuralErrorCount,
    qcFailCount,
    qcWarningCount,
    encoderFallbackUsed: usedEncoder?.pass === 'draft',
    warnings
  };
}

async function exportMccFromEditor(payload = {}) {
  const { doc, sessionId, outputPath } = payload;
  if (!doc || !Array.isArray(doc.cues)) {
    throw new Error('No subtitle cues provided');
  }

  // Phase 1: normalize cue schema for export paths.
  try {
    ensureDocCueSchema(doc);
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ Cue schema normalization failed before MCC export: ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
  }

  let outPath = null;
  const normalized = normalizeOutputPath(outputPath);
  if (normalized) {
    outPath = normalized;
  } else {
    let targetDir = doc.outputDir;
    if (!targetDir) {
      throw new Error('No export destination selected.');
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const baseName = doc.baseName
      || (doc.sourcePath ? path.basename(doc.sourcePath, path.extname(doc.sourcePath))
      : (doc.mediaPath ? path.basename(doc.mediaPath, path.extname(doc.mediaPath)) : 'subtitle'));
    outPath = path.join(targetDir, `${baseName}.corrected.mcc`);
  }

  // Ensure destination exists early so we can always write a report on hard failures.
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = `${outPath}.report.txt`;

  // MCC supports multiple timebases. Prefer doc timebase; only enable DF where it makes sense.
  const fpsRaw = Number(doc?.fps ?? lastSubtitleContext?.fps ?? 29.97);
  const fps = (Number.isFinite(fpsRaw) && fpsRaw > 0) ? fpsRaw : 29.97;
  const dfCapable = isDropFrameRate(fps);
  // Default to DF at DF-capable rates unless the doc explicitly disables it.
  const dropFrame = dfCapable ? (doc?.dropFrame !== false) : false;

  const mccOptions = (doc && doc.mccOptions && typeof doc.mccOptions === 'object') ? doc.mccOptions : {};
  // MCC authoring model: fixed to True 708 (708 is canonical; 608 is derived separately when enabled).
  const authoringModel = 'true708';

  // Default ON: include 608 compatibility (common broadcast expectation)
  const include608Compatibility = (mccOptions.include608Compatibility ?? mccOptions.include608 ?? mccOptions.mccInclude608) !== false;
  const requireCompat608Placement =
    include608Compatibility &&
    (String(doc?.sourcePath || '').toLowerCase().endsWith('.mcc') || String(doc?.format || '').toLowerCase() === 'mcc');

  const maxCharsPerLineRaw = Number(mccOptions.maxCharsPerLine ?? doc.maxCharsPerLine);
  let maxCharsPerLine = Number.isFinite(maxCharsPerLineRaw)
    ? maxCharsPerLineRaw
    : 42;
  maxCharsPerLine = Math.max(1, Math.min(63, Math.trunc(maxCharsPerLine)));

  const maxLinesRaw = Number(mccOptions.maxLinesPerBlock ?? doc.maxLinesPerBlock);
  let maxLinesPerBlock = Number.isFinite(maxLinesRaw) ? maxLinesRaw : 2;
  // Lead AE policy: never allow more than 3 lines per subtitle block.
  maxLinesPerBlock = Math.max(1, Math.min(3, Math.trunc(maxLinesPerBlock)));

  const maxDurationRaw = Number(mccOptions.maxDurationSeconds ?? mccOptions.maxDuration ?? doc.maxDurationSeconds);
  const maxDurationSeconds = Number.isFinite(maxDurationRaw) ? Math.max(0.1, maxDurationRaw) : 6.0;

  const telestreamCompression = (mccOptions.telestreamCompression ?? mccOptions.compress ?? mccOptions.mccCompress) === true;

  const compatibilityMode = (mccOptions.compatibilityMode ?? mccOptions.compatMode ?? null);
  const compatModeNorm = String(compatibilityMode || '').trim().toLowerCase();
  const includeCcsSvcInfo = (mccOptions.includeCcsSvcInfo ?? mccOptions.includeServiceInfo ?? null);

  // Default OFF for NLE compatibility (see sccEncoder.generateMCC).
  let includeCdpTimecode = (mccOptions.includeCdpTimecode ?? mccOptions.embedCdpTimecode ?? mccOptions.cdpTimecode) === true;

  // Guard: CDP timecode (0x71) uses SMPTE-12M BCD frame digits which only support <=30fps.
  // If we allowed this at >30fps we'd generate garbled frame numbers (e.g. frames 40-59).
  if (includeCdpTimecode && Number(fps) > 30.0001 && compatModeNorm !== 'nle') {
    throw new Error(
      `Embed CDP timecode is only supported at <=30fps in the current MCC encoder (resolved fps=${Number(fps).toFixed(3)}). ` +
      `Disable "Embed CDP timecode" or set the MCC fps override to <=30.`
    );
  }

  // MCC V2.0 optional timecode suffix: ".<field>,<line>" (example: .0,9)
  // Retained on import (doc.mccOptions.mccTimecodeSuffix) for round-trip workflows.
  const mccTimecodeSuffix = (mccOptions.mccTimecodeSuffix ?? mccOptions.mccV2TimecodeSuffix ?? mccOptions.timecodeSuffix ?? null);

  const serviceRaw = Number(mccOptions.serviceNumber);
  let serviceNumber = Number.isFinite(serviceRaw) ? serviceRaw : 1;
  serviceNumber = Math.max(1, Math.min(63, Math.trunc(serviceNumber)));

  let language = String(mccOptions.language || 'eng').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(language)) language = 'eng';

  const alignment = (() => {
    const raw = mccOptions.alignment || doc?.alignment || doc?.sccOptions?.alignment || 'left';
    const norm = String(raw || '').trim().toLowerCase();
    return norm === 'centre' ? 'center' : (norm || 'left');
  })();
  // Caption slip / offset (post-production). Can be negative.
  const timecodeOffset = (typeof mccOptions.timecodeOffset === 'string')
    ? mccOptions.timecodeOffset
    : (mccOptions.captionOffset ?? mccOptions.offset ?? null);
  const timecodeOffsetFrames = Number.isFinite(Number(mccOptions.timecodeOffsetFrames)) ? Number(mccOptions.timecodeOffsetFrames) : undefined;
  const timecodeOffsetSeconds = Number.isFinite(Number(mccOptions.timecodeOffsetSeconds)) ? Number(mccOptions.timecodeOffsetSeconds) : undefined;
  let timecodeOffsetPolicy = String(mccOptions.timecodeOffsetPolicy ?? mccOptions.offsetPolicy ?? 'clamp').trim().toLowerCase();
  if (!['clamp', 'error'].includes(timecodeOffsetPolicy)) timecodeOffsetPolicy = 'clamp';

  // 708 window placement (DefineWindow); stored on doc.mccOptions.
  const mcc708Window = (mccOptions.mcc708Window && typeof mccOptions.mcc708Window === 'object')
    ? mccOptions.mcc708Window
    : (mccOptions.windowPlacement || mccOptions.window || null);

  // Deliverable policy (mirrors SCC): warn | gate_write | gate_block
  const exportPolicy = normalizeExportPolicy(mccOptions.exportPolicy, '');

  const qcCfg = (mccOptions && mccOptions.qc) ? mccOptions.qc : {};

  // Phase 2.1: resolve per-track QC profiles (708 vs 608) from config.
  // These are optional; when absent, both tracks inherit the legacy single-profile settings.
  const { qcProfile708, qcProfile608 } = resolveMccQcProfiles(qcCfg);


  // Option C — Dual grading (best UX)
  // Default behavior:
  //   • Broadcast/strict profiles → ON (unless explicitly disabled)
  //   • NLE/other profiles → OFF (unless explicitly enabled)
  const dualGrade = resolveMccDualGradeEnabled(qcCfg, compatibilityMode);
  const want708Qc = resolveMccWant708Qc(qcCfg, dualGrade);

  // Milestone 4: explicit 608 compatibility generation rules (used when authoringModel='true708').
  // Defaults to QC thresholds so the derived 608 track stays readable.
  const compatGenerationRules = (() => {
    const userRules = (mccOptions && typeof mccOptions === 'object') ? (mccOptions.compatGenerationRules || null) : null;
    const userQc = (userRules && typeof userRules === 'object') ? (userRules.qc || null) : null;

    const qc = {
      ...(userQc && typeof userQc === 'object' ? userQc : {}),
      maxCps: (userQc && userQc.maxCps != null) ? userQc.maxCps : ((qcProfile608 && qcProfile608.maxCps != null) ? qcProfile608.maxCps : qcCfg.maxCps),
      maxWpm: (userQc && userQc.maxWpm != null) ? userQc.maxWpm : ((qcProfile608 && qcProfile608.maxWpm != null) ? qcProfile608.maxWpm : qcCfg.maxWpm),
      minDurationSec: (userQc && userQc.minDurationSec != null) ? userQc.minDurationSec : ((qcProfile608 && qcProfile608.minDurationSec != null) ? qcProfile608.minDurationSec : qcCfg.minDurationSec),
      minGapSec: (userQc && userQc.minGapSec != null) ? userQc.minGapSec : ((qcProfile608 && qcProfile608.minGapSec != null) ? qcProfile608.minGapSec : qcCfg.minGapSec),
    };

    return {
      ...(userRules && typeof userRules === 'object' ? userRules : {}),
      qc,
    };
  })();
  const qcGateFromPolicy = (exportPolicy === 'gate_write' || exportPolicy === 'gate_block');
  const qcGate = qcGateFromPolicy
    ? true
    : (qcCfg?.gate === true || qcCfg?.failJob === true || doc?.mccOptions?.qcGate === true);
  const blockWriteOnQcFail = (exportPolicy === 'gate_block');

  const warnings = [];

  // MCC "shaping" (608-style) — best-effort retiming/merging to meet QC thresholds.
  // Enabled by default when 608 compatibility is ON; disable via mccOptions.shaping.enabled=false.
  let shaping = null;

  const stripPlacementTags = (text) => String(text || '').replace(/(?:\{(?:row|col|pac):[^}]+\})+/g, '');

  // Build segments from cues; strip SCC-only placement tags (MCC doesn't understand them).
  const segments = cueListToSegments(doc.cues, fps, dropFrame).map((seg, idx) => {
    const cue = doc.cues?.[idx];
    if (!cue) return seg;

    const lines = (Array.isArray(cue.lines) && cue.lines.length)
      ? cue.lines.slice()
      : String(seg.text || '')
        .replace(/\\n/g, '\n')
        .split(/\r?\n|\s*\|\s*/g);

    const cleanedLines = lines
      .map(ln => normalizeMusicGlyphLine(stripPlacementTags(ln)))
      .filter(ln => String(ln || '').trim());

    const out = { ...seg, text: cleanedLines.join('\n') };

    // Phase A: carry CEA-708 style runs[] through MCC export.
    // If runs are present, they become the canonical 708 payload; `text` remains
    // as a plain fallback for legacy paths and for 608 derivation.
    if (Array.isArray(cue.runs) && cue.runs.length) {
      const cleanedRuns = cue.runs
        .map((r) => {
          const text = normalizeMusicGlyphLine(stripPlacementTags((r && typeof r === 'object') ? (r.text ?? '') : ''));
          const style = (r && typeof r === 'object' && r.style && typeof r.style === 'object') ? { ...r.style } : undefined;
          return { text: String(text || ''), ...(style ? { style } : {}) };
        })
        .filter((r) => String(r.text || '').length > 0);

      if (cleanedRuns.length) {
        out.runs = cleanedRuns;
        out.text = cleanedRuns.map(r => String(r.text || '')).join('');
      }
    }

    // If this cue originated from an MCC/708 import, preserve its decoded
    // window snapshot so timing-only edits can round-trip 708 styling and
    // placement back to MCC. If the user edits the cue text, the MCC encoder
    // will detect the mismatch and fall back to re-encoding from text.
    if (cue && typeof cue === 'object' && cue.cea708 && typeof cue.cea708 === 'object') {
      out.cea708 = cue.cea708;
      if (typeof cue.textPlain === 'string') out.cea708SourceTextPlain = cue.textPlain;
    }
    return out;
  });

  const includeSpeakerNamesMcc = mccOptions.includeSpeakerNames === true;

  // 608 wrap shaping preferences (speaker labels, punctuation, hyphenation, explicit line breaks).
  // Optional. Sources:
  //   - mccOptions.wrap608 / mccOptions.cea608Wrap
  //   - mccOptions.shaping.wrap608 (or .textWrap/.wrap)
  const wrap608Options = (() => {
    const direct = (mccOptions && typeof mccOptions === 'object')
      ? (mccOptions.wrap608 || mccOptions.cea608Wrap || mccOptions.textWrap608 || null)
      : null;
    if (direct && typeof direct === 'object') return direct;

    const sh = (mccOptions && mccOptions.shaping && typeof mccOptions.shaping === 'object') ? mccOptions.shaping : null;
    if (!sh) return null;

    const candidate = (sh.wrap608 && typeof sh.wrap608 === 'object') ? sh.wrap608
      : ((sh.textWrap && typeof sh.textWrap === 'object') ? sh.textWrap
        : ((sh.wrap && typeof sh.wrap === 'object') ? sh.wrap : sh));

    return (candidate && typeof candidate === 'object') ? candidate : null;
  })();
  let segmentsForMcc = includeSpeakerNamesMcc
    ? segments.map(seg => {
        if (!seg) return seg;
        const sp = String(seg.speaker || '').trim();
        if (!sp) return seg;
        const prefix = `${sp}: `;
        const t = String(seg.text || '');
        if (!t) return { ...seg, text: prefix.trim() };
        if (t.startsWith(prefix)) return seg;

        // If rich runs exist, prefix them too (inherit the first run's style so
        // the label matches cue-level styling by default).
        if (Array.isArray(seg.runs) && seg.runs.length) {
          const firstStyle = (seg.runs[0] && typeof seg.runs[0] === 'object' && seg.runs[0].style && typeof seg.runs[0].style === 'object')
            ? { ...seg.runs[0].style }
            : undefined;
          const prefRun = { text: prefix, ...(firstStyle ? { style: firstStyle } : {}) };
          return { ...seg, text: `${prefix}${t}`, runs: [prefRun, ...seg.runs] };
        }

        return { ...seg, text: `${prefix}${t}` };
      })
    : segments;

  // ---- Optional shaping (recommended for broadcast / NLE reliability) ----
  try {
    const shapeCfg = (mccOptions && mccOptions.shaping && typeof mccOptions.shaping === 'object') ? mccOptions.shaping : null;

    // P0-3: Broadcast/strict deliverables should shape by default when 608 compat is ON.
    // - If shaping is explicitly enabled, honor it.
    // - Else if compatibilityMode is broadcast/strict, enable conservative shaping.
    // - Else (nle/unknown), stay relaxed unless explicitly enabled.
    const explicitEnableShaping = (() => {
      if (!shapeCfg || typeof shapeCfg !== 'object') return false;
      const v = (shapeCfg.enabled ?? shapeCfg.enable ?? shapeCfg.on);
      return (v === true || v === 'true');
    })();

    const autoEnableByProfile = (compatModeNorm === 'broadcast' || compatModeNorm === 'strict');
    const enableShaping = !!include608Compatibility && (explicitEnableShaping || autoEnableByProfile);

    const hasRichRuns = Array.isArray(segmentsForMcc) && segmentsForMcc.some(s => Array.isArray(s?.runs) && s.runs.length);
    const enableShapingFinal = enableShaping && !hasRichRuns;
    if (enableShaping && hasRichRuns) {
      warnings.push('MCC shaping skipped: rich 708 style runs[] are present (shaping would discard styling).');
    }
    if (enableShapingFinal && typeof shapeSegmentsForScc === 'function') {
      // Auto-shape(608) must enforce 608-safe constraints even if authoringModel is true708.
      // Respect any tighter authoring settings, but never exceed 608's 32x2 envelope.
      const shapeMaxCharsPerLine = Math.min(32, maxCharsPerLine);
      const shapeMaxLinesPerBlock = Math.min(2, maxLinesPerBlock);

      const res = shapeSegmentsForScc(segmentsForMcc, {
        fps,
        dropFrame,
        startTc: mccOptions.startTC ?? mccOptions.startTc ?? doc?.startTC ?? doc?.startTc ?? null,
        preStartTransmitSec: 0,
        fixStartTcClamp: false,
        maxCharsPerLine: shapeMaxCharsPerLine,
        maxLinesPerBlock: shapeMaxLinesPerBlock,
        maxDurationSec: maxDurationSeconds,
        preserveSpeakerBoundaries: true,
        clampToMaxEnd: true,
        qc: {
          maxCps: qcCfg.maxCps,
          maxWpm: qcCfg.maxWpm,
          minDurationSec: qcCfg.minDurationSec,
          minGapSec: qcCfg.minGapSec
        },
        // If auto-enabled by profile, force conservative defaults.
        // If explicitly enabled, honor user-tuned knobs.
        mode: explicitEnableShaping && shapeCfg && shapeCfg.mode ? shapeCfg.mode : 'conservative',
        microCueSec: explicitEnableShaping && shapeCfg ? shapeCfg.microCueSec : undefined,
        microGapSec: explicitEnableShaping && shapeCfg ? shapeCfg.microGapSec : undefined,
        maxShiftSec: explicitEnableShaping && shapeCfg ? shapeCfg.maxShiftSec : undefined
      });

      if (res && Array.isArray(res.segments) && res.segments.length) {
        segmentsForMcc = res.segments;
        shaping = res.report || null;
        const sum = shaping && shaping.summary ? shaping.summary : null;
        if (sum && (sum.mergedCues || sum.splitCues || sum.retimedCues || sum.firstCueDelayedSec)) {
          warnings.push(
            `MCC shaping applied: merged=${sum.mergedCues}, split=${sum.splitCues}, retimed=${sum.retimedCues}${sum.firstCueDelayedSec ? `, firstDelay=${sum.firstCueDelayedSec.toFixed(3)}s` : ''}`
          );
        }
      }
    }
  } catch (e) {
    shaping = { ok: false, error: e?.message || String(e) };
    warnings.push(`MCC shaping failed (export continues unshaped): ${shaping.error}`);
  }

  const _normOverflow = (v) => {
    const s = String(v || '').trim().toLowerCase();
    return (s === 'truncate' || s === 'error') ? s : '';
  };

  const allowDraft = exportPolicy !== 'gate_block';

  const overflowRequested = (() => {
    const v = _normOverflow(mccOptions.overflowPolicy ?? doc?.sccOptions?.overflowPolicy);
    if (v) return v;
    return (exportPolicy === 'gate_block') ? 'error' : 'truncate';
  })();

  const strictEncodingRequested =
    (mccOptions.strictCharacterEncoding ?? doc?.sccOptions?.strictCharacterEncoding) === true;

  const mccEncoderPlan = [
    { pass: 'primary', overflowPolicy: overflowRequested, strictCharacterEncoding: strictEncodingRequested }
  ];

  // Draft fallback: make *something* so the user can edit it. In deliverable mode (gate_write),
  // falling back to draft is treated as a gate failure (written for editing, but job fails).
  if (allowDraft && (overflowRequested === 'error' || strictEncodingRequested)) {
    mccEncoderPlan.push({ pass: 'draft', overflowPolicy: 'truncate', strictCharacterEncoding: false });
  }

  let mccText = '';
  const mccEncoderAttempts = [];
  let mccEncoderPass = mccEncoderPlan[0].pass;

  for (const a of mccEncoderPlan) {
    try {
      mccText = scc.generateMCC(segmentsForMcc, {
        fps,
        dropFrame,
        startTc: mccOptions.startTC ?? mccOptions.startTc ?? doc?.startTC ?? doc?.startTc ?? null,
        timecodeOffset,
        timecodeOffsetFrames,
        timecodeOffsetSeconds,
        timecodeOffsetPolicy,
        compatibilityMode,
        includeCcsSvcInfo,
        includeCdpTimecode,
        mccTimecodeSuffix,
        authoringModel,
        include608Compatibility: include608Compatibility,
        compatGenerationRules,
        telestreamCompression: telestreamCompression,
        pingPongWindows: (mccOptions.pingPongWindows ?? mccOptions.popOnPingPongWindows ?? true) !== false,
        creationProgram: mccOptions.creationProgram ?? 'Lead AE Assist',
        maxCharsPerLine,
        maxLinesPerBlock,
        maxDurationSeconds,
        includeSpeakerNames: false,
        serviceNumber,
        language,
        sccOptions: {
          alignment,
          channel: Number.isFinite(Number(mccOptions.channel)) ? normalizeSccChannel(mccOptions.channel) : 1,
          rowPolicy: mccOptions.rowPolicy || doc?.sccOptions?.rowPolicy || 'bottom2',
          safeMargins: (mccOptions.safeMargins ?? doc?.sccOptions?.safeMargins),
          strictCharacterEncoding: a.strictCharacterEncoding,
          overflowPolicy: a.overflowPolicy,
          padEven: !!(mccOptions.padEven ?? doc?.sccOptions?.padEven),
          repeatControlCodes: (compatModeNorm === 'nle')
            ? false
            : ((mccOptions.repeatControlCodes ?? doc?.sccOptions?.repeatControlCodes) === true),
          repeatPreambleCodes: (mccOptions.repeatPreambleCodes ?? doc?.sccOptions?.repeatPreambleCodes) !== false,
          mcc708Window,
          preserveImported708Layout: (mccOptions.preserveImported708Layout !== false),
          requireCompat608Placement,
          wrap608: wrap608Options || null,
          extendedGlyphMap
        }
      });
      mccEncoderPass = a.pass;
      break;
    } catch (e) {
      mccEncoderAttempts.push({
        pass: a.pass,
        overflowPolicy: a.overflowPolicy,
        strictEncoding: a.strictCharacterEncoding,
        message: e?.message || String(e)
      });
    }
  }

  if (!mccText) {
    const last = mccEncoderAttempts[mccEncoderAttempts.length - 1];
    throw new Error(last?.message || 'MCC generation failed');
  }

  const mccEncoderFallbackUsed = (mccEncoderPass !== mccEncoderPlan[0].pass);
  if (mccEncoderFallbackUsed) {
    warnings.push('MCC encoder fell back to draft settings (truncate/non-strict). Output may be truncated; see report.');
  }

  // Structural QC: refuse to export a syntactically invalid MCC (broadcast sanity).
  // IMPORTANT: do NOT override MCC header timebase with caller-provided fps/df.
  let structural = scc.verifyMCC(mccText, {
    strictPayloadParse: (compatibilityMode === 'strict') || includeCdpTimecode === true || includeCcsSvcInfo === true,
    checkHeader: true,
    requireHeader: true,
    checkTimecode: true,
    checkMonotonic: true,
    checkAncChecksum: true,
    checkCdpChecksum: true,
    checkCdpLength: true,
    checkCcCount: true,
    checkSequence: true,
    checkSmpte12M: true
  });

  // Explicit header ↔ expected mismatch check (prevents caller-provided fps from hiding bad headers).
  const mismatchErrors = [];
  const approxEq = (a, b, eps = 0.12) => {
    const A = Number(a);
    const B = Number(b);
    if (!Number.isFinite(A) || !Number.isFinite(B)) return false;
    return Math.abs(A - B) <= eps;
  };

  const hdr = (structural && structural.header && typeof structural.header === 'object') ? structural.header : {};

  if (structural && Number.isFinite(Number(structural.fps)) && Number.isFinite(Number(fps)) && !approxEq(structural.fps, fps, 0.12)) {
    mismatchErrors.push({
      line: 1,
      timecode: '',
      type: 'header',
      code: 'E_MCC_HEADER_MISMATCH',
      message:
        `Header timecode rate implies ~${Number(structural.fps).toFixed(3)}fps${structural.dropFrame ? ' (DF)' : ' (NDF)'}, ` +
        `but export expected ~${Number(fps).toFixed(3)}fps${dropFrame ? ' (DF)' : ' (NDF)'}. ` +
        `Time Code Rate=${hdr['time code rate'] ?? 'n/a'}; Drop Frame=${hdr['drop frame'] ?? 'n/a'}.`
    });
  }

  if (structural && typeof structural.dropFrame === 'boolean' && typeof dropFrame === 'boolean' && !!structural.dropFrame !== !!dropFrame) {
    mismatchErrors.push({
      line: 1,
      timecode: '',
      type: 'header',
      code: 'E_MCC_HEADER_MISMATCH',
      message: `Header Drop Frame=${structural.dropFrame ? 'True' : 'False'} does not match expected ${dropFrame ? 'True' : 'False'}.`
    });
  }

  if (mismatchErrors.length) {
    structural = {
      ...structural,
      ok: false,
      headerErrors: Number(structural?.headerErrors || 0) + mismatchErrors.length,
      errors: [...mismatchErrors, ...(Array.isArray(structural?.errors) ? structural.errors : [])]
    };
  }

  if (structural && structural.ok === false) {
    const total = Array.isArray(structural.errors) ? structural.errors.length : 0;
    const head = (typeof scc.formatVerifyErrors === 'function')
      ? scc.formatVerifyErrors(structural.errors, 8)
      : (Array.isArray(structural.errors) ? structural.errors.slice(0, 8).map(e => String(e && e.message ? e.message : e)) : []);
    const shown = head.length;

    const msg = `MCC export blocked: file would not pass structural validation (${total} error(s); first ${shown} shown).\n${head.join('\n')}`;

    if (reportPath) {
      try {
        writeMccQcReport({
          reportPath,
          outPath,
          fps,
          dropFrame,
          compatibilityMode,
          includeCcsSvcInfo,
          authoringModel,
          maxCharsPerLine,
          maxLinesPerBlock,
          maxDurationSeconds,
          include608Compatibility,
          includeCdpTimecode,
          telestreamCompression,
          serviceNumber,
          language,
          encoderPlan: mccEncoderPlan,
          encoderPass: mccEncoderPass,
          encoderAttempts: mccEncoderAttempts,
          shaping,
          contentQc: null,
          structuralQc: structural
        });
      } catch (err) {
        sendLogMessage('transcribe', `⚠️ Failed to write MCC structural QC report: ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
      }
    }

    const msgWithReport = reportPath ? `${msg}\nReport: ${reportPath}` : msg;
    if (sessionId) {
      try {
        sendToRenderer(sessionId, 'transcribe:log', { level: 'error', message: msgWithReport });
      } catch (err) {
        sendLogMessage('transcribe', `⚠️ Failed to dispatch MCC structural failure to renderer: ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
      }
    }
    const structuralErrorCount = Array.isArray(structural?.errors) ? structural.errors.length : 0;

    return {
      status: 'fail_structural',
      success: false,
      error: msgWithReport,
      message: msgWithReport,
      warning: true,
      qcGateFailed: true,
      qcGateBlocked: true,
      output: null,
      intendedOutput: outPath,
      writtenFiles: [],
      reportPath,
      structuralErrorCount,
      qcFailCount: 0,
      qcWarningCount: 0,
      encoderFallbackUsed: !!mccEncoderFallbackUsed,
      warnings
    };
  }

    // Round-trip QC (encode → decode → compare).
    // This is a self-consistency check to catch regressions where we write MCC that
    // our own decoder can't re-import cleanly.
    //
    // We validate BOTH decode views:
    //  - default decode (prefers native 708 service when present)
    //  - forced 608 compatibility decode (what many NLEs display when 708 isn't used)
    //
    // Note: We compare against the *expected transforms* (wrapping/shaping), not the raw
    // editor text, to avoid false positives (e.g., hyphenation of a 40-char word).
    if (structural && Array.isArray(segmentsForMcc) && segmentsForMcc.length > 0) {
      const pushWarn = (code, message, timecode = '') => {
        if (!Array.isArray(structural.warnings)) structural.warnings = [];
        structural.warnings.push({ line: 0, type: 'round_trip', code, message, ...(timecode ? { timecode } : {}) });
      };
  
      try {
        const { roundTripCompareMccText } = require('./mccRoundTrip');
  
        // Try to reflect the *actual* encoder pass that produced this payload.
        const plan = Array.isArray(mccEncoderPlan) ? mccEncoderPlan : [];
        const usedPass = (mccEncoderPass != null) ? String(mccEncoderPass).trim() : '';
        const used = (usedPass && plan.length)
          ? (plan.find(p => String(p?.pass || p?.name || '').trim() === usedPass) || plan[0] || {})
          : (plan[0] || {});
        const effectiveOverflowPolicy = String(used?.overflowPolicy || overflowRequested || 'truncate').trim() || 'truncate';
  
        const safeMargins = (mccOptions && typeof mccOptions === 'object')
          ? (mccOptions.safeMargins ?? doc?.sccOptions?.safeMargins)
          : (doc?.sccOptions?.safeMargins);
  
        const rt = roundTripCompareMccText(mccText, segmentsForMcc, {
          fps,
          dropFrame,
          include608Compatibility,
          compare708: true,
          compare608: true,
          safeMargins,
          overflowPolicy: effectiveOverflowPolicy,
          wrap608Options
        });
  
        if (rt && rt.compare708 && rt.compare708.ok === false) {
          const firstTc = (rt.compare708.mismatches && rt.compare708.mismatches[0] && rt.compare708.mismatches[0].expected && rt.compare708.mismatches[0].expected.startTc) || '';
          const sample = rt.compare708.sample ? ` Sample: ${rt.compare708.sample}` : '';
          pushWarn(
            'W_MCC_ROUNDTRIP_708_MISMATCH',
            `Round-trip mismatch (708 decode view): ${rt.compare708.mismatchCount ?? 'n/a'} cue(s) differ after decode.${sample}`,
            firstTc
          );
        }
  
        if (rt && rt.compare608 && rt.compare608.ok === false) {
          const firstTc = (rt.compare608.mismatches && rt.compare608.mismatches[0] && rt.compare608.mismatches[0].expected && rt.compare608.mismatches[0].expected.startTc) || '';
          const sample = rt.compare608.sample ? ` Sample: ${rt.compare608.sample}` : '';
          pushWarn(
            'W_MCC_ROUNDTRIP_608_MISMATCH',
            `Round-trip mismatch (forced 608 decode view): ${rt.compare608.mismatchCount ?? 'n/a'} cue(s) differ after decode.${sample}`,
            firstTc
          );
        }
  
        if (rt && rt.compare708 && rt.compare708.error) {
          pushWarn('W_MCC_ROUNDTRIP_ERROR', `Round-trip QC (708 decode) failed: ${rt.compare708.error}`);
        }
        if (rt && rt.compare608 && rt.compare608.error) {
          pushWarn('W_MCC_ROUNDTRIP_ERROR', `Round-trip QC (608 decode) failed: ${rt.compare608.error}`);
        }
      } catch (e) {
        pushWarn(
          'W_MCC_ROUNDTRIP_ERROR',
          `Round-trip QC failed to run: ${e?.message || String(e)}`
        );
      }
    }

  const safeMargins = (mccOptions && typeof mccOptions === "object")
    ? (mccOptions.safeMargins ?? doc?.sccOptions?.safeMargins)
    : (doc?.sccOptions?.safeMargins);

  const contentQc = (typeof validateMccContentQc === 'function')
    ? validateMccContentQc(segmentsForMcc, {
        fps,
        dropFrame,
        maxCharsPerLine,
        maxLinesPerBlock,
        maxDurationSec: maxDurationSeconds,
        maxCps: qcCfg.maxCps,
        maxWpm: qcCfg.maxWpm,
        minDurationSec: qcCfg.minDurationSec,
        minGapSec: qcCfg.minGapSec,
        qcProfile708,
        qcProfile608,
        // New: decode-from-output QC so maxCols/maxLines reflect the actual MCC payload.
        mccText,
        decode708: want708Qc,
        require708: qcCfg.require708 === true || qcCfg.gateOnMissing708 === true,
        serviceNumber,
        // Dual grading extras (keep in sync with ai/outputWriters.writeMCC)
        dualGrade,
        compatibilityMode,
        compatGenerationRules,
        safeMargins
      })
    : null;

  try {
    if (typeof writeMccQcReport === 'function') {
      writeMccQcReport({
        reportPath,
        outPath,
        fps,
        dropFrame,
        compatibilityMode,
        includeCcsSvcInfo,
        authoringModel,
        maxCharsPerLine,
        maxLinesPerBlock,
        maxDurationSeconds,
        include608Compatibility,
        includeCdpTimecode,
        telestreamCompression,
        serviceNumber,
        language,
        encoderPlan: mccEncoderPlan,
        encoderPass: mccEncoderPass,
        encoderAttempts: mccEncoderAttempts,
        shaping,
        contentQc,
        structuralQc: structural
      });
    }
  } catch (err) {
    sendLogMessage('transcribe', `⚠️ Failed to write MCC QC report: ${err?.message || String(err)}`, '', false, sessionId || '', 'warn');
  }

  if (contentQc && !contentQc.ok) {
    const head = contentQc.failures?.[0];
    const sample = head
      ? `${head.message}${head.startTc ? ` @ ${head.startTc}` : ''}`
      : 'One or more content QC failures.';
    warnings.push(`content QC failed — ${contentQc.failures.length} issue(s). ${sample}`);
  }

  const qcFailed = !!(contentQc && contentQc.ok === false);

  // Encoder fallback (primary → draft) is a deliverable failure in gate_write mode.
  // In warn mode, it is reported but does not fail unless explicitly gated via qcCfg.
  const gateOnDraftFallback =
    (exportPolicy === 'gate_write')
      ? true
      : (qcCfg?.gateOnDraftFallback === true || qcCfg?.failOnDraftFallback === true || qcCfg?.gateOnFallback === true);

  const gateFailDueToFallback = !!(mccEncoderFallbackUsed && gateOnDraftFallback);
  const gateFailed = qcFailed || gateFailDueToFallback;

  const hasWarnings = Array.isArray(warnings) && warnings.length > 0;

  const shouldBlockWrite = !!(qcFailed && qcGate && blockWriteOnQcFail);
  const wroteFile = !shouldBlockWrite;

  const writtenFiles = wroteFile ? [outPath] : [];
  const structuralErrorCount = Array.isArray(structural?.errors) ? structural.errors.length : 0;
  const qcFailCount = Array.isArray(contentQc?.failures) ? contentQc.failures.length : 0;
  const qcWarningCount = Array.isArray(contentQc?.warnings) ? contentQc.warnings.length : 0;

  if (wroteFile) {
    const writeText = String(mccText || '').replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(outPath, writeText, 'utf8');
  }

  const existing = subtitleSessions.get(sessionId || doc.sessionId) || {};
  const mergedLastExport = {
    ...(existing.lastExport || {}),
    ...(doc.lastExport || {}),
    directory: outDir,
    ...(wroteFile ? { mcc: outPath } : {})
  };

  storeSession({ ...doc, outputDir: outDir, lastExport: mergedLastExport }, sessionId || doc.sessionId);

  if (shouldBlockWrite) {
    const error = `MCC QC gate failed — MCC was NOT written. Report: ${reportPath}`;
    return {
      status: 'fail_qc',
      success: false,
      error,
      message: `⛔ MCC NOT saved — QC failed (see report)`,
      warning: true,
      qcGateFailed: true,
      qcGateBlocked: true,
      output: null,
      intendedOutput: outPath,
      writtenFiles: [],
      reportPath,
      structuralErrorCount,
      qcFailCount,
      qcWarningCount,
      encoderFallbackUsed: !!mccEncoderFallbackUsed,
      warnings
    };
  }
  if (gateFailed && qcGate) {
    const reasons = [];
    if (qcFailed) reasons.push('content QC failed');
    if (gateFailDueToFallback) reasons.push('encoder fell back to draft pass');
    const reasonText = reasons.length ? ` (${reasons.join(' + ')})` : '';

    const status = qcFailed ? 'partial_written' : 'fail_fallback';
    const error = `MCC gate failed${reasonText} — output was written for editing. MCC: ${outPath} • Report: ${reportPath}`;
    return {
      status,
      success: false,
      error,
      warning: true,
      qcGateFailed: true,
      qcGateBlocked: false,
      encoderFallbackUsed: !!mccEncoderFallbackUsed,
      message: `⚠️ MCC saved but gate failed → ${outPath} (see report)`,
      output: outPath,
      writtenFiles,
      reportPath,
      structuralErrorCount,
      qcFailCount,
      qcWarningCount,
      warnings
    };
  }

  return {
    status: 'success',
    success: true,
    warning: hasWarnings,
    qcGateFailed: false,
    qcGateBlocked: false,
    message: hasWarnings
      ? `⚠️ MCC saved with QC warnings → ${outPath} (see report)`
      : `MCC saved → ${outPath}`,
    output: wroteFile ? outPath : null,
    writtenFiles,
    reportPath,
    structuralErrorCount,
    qcFailCount,
    qcWarningCount,
    encoderFallbackUsed: !!mccEncoderFallbackUsed,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Milestone 5: Dual preview panes (708 authoring vs derived 608)
//
// Generate the same MCC payload we'd export, but keep it in-memory and
// round-trip it through the MCC decoder twice:
//  - default decode (prefer native 708 service) → preview708
//  - force 608 compatibility decode → preview608
//
// NOTE: This is intentionally export-faithful (uses the same generateMCC path),
// so the editor previews match the real deliverable.
// ---------------------------------------------------------------------------
async function previewMccFromEditor(payload = {}) {
  const { doc } = payload;
  if (!doc || !Array.isArray(doc.cues)) {
    throw new Error('No subtitle cues provided');
  }

  // Keep preview timebase aligned with export.
  const fpsRaw = Number(doc?.fps ?? lastSubtitleContext?.fps ?? 29.97);
  const fps = (Number.isFinite(fpsRaw) && fpsRaw > 0) ? fpsRaw : 29.97;
  const dfCapable = isDropFrameRate(fps);
  const dropFrame = dfCapable ? (doc?.dropFrame !== false) : false;

  const mccOptions = (doc && doc.mccOptions && typeof doc.mccOptions === 'object') ? doc.mccOptions : {};
  // MCC authoring model: fixed to True 708 (708 is canonical; 608 is derived separately when enabled).
  const authoringModel = 'true708';

  const include608Compatibility = (mccOptions.include608Compatibility ?? mccOptions.include608 ?? mccOptions.mccInclude608) !== false;
  const requireCompat608Placement =
    include608Compatibility &&
    (String(doc?.sourcePath || '').toLowerCase().endsWith('.mcc') || String(doc?.format || '').toLowerCase() === 'mcc');

  const maxCharsPerLineRaw = Number(mccOptions.maxCharsPerLine ?? doc.maxCharsPerLine);
  let maxCharsPerLine = Number.isFinite(maxCharsPerLineRaw) ? maxCharsPerLineRaw : 42;
  maxCharsPerLine = Math.max(1, Math.min(63, Math.trunc(maxCharsPerLine)));

  const maxLinesRaw = Number(mccOptions.maxLinesPerBlock ?? doc.maxLinesPerBlock);
  let maxLinesPerBlock = Number.isFinite(maxLinesRaw) ? maxLinesRaw : 2;
  // Lead AE policy: never allow more than 3 lines per subtitle block.
  maxLinesPerBlock = Math.max(1, Math.min(3, Math.trunc(maxLinesPerBlock)));

  const maxDurationRaw = Number(mccOptions.maxDurationSeconds ?? mccOptions.maxDuration ?? doc.maxDurationSeconds);
  const maxDurationSeconds = Number.isFinite(maxDurationRaw) ? Math.max(0.1, maxDurationRaw) : 6.0;

  const telestreamCompression = (mccOptions.telestreamCompression ?? mccOptions.compress ?? mccOptions.mccCompress) === true;
  const compatibilityMode = (mccOptions.compatibilityMode ?? mccOptions.compatMode ?? null);
  const compatModeNorm = String(compatibilityMode || '').trim().toLowerCase();
  const includeCcsSvcInfo = (mccOptions.includeCcsSvcInfo ?? mccOptions.includeServiceInfo ?? null);
  let includeCdpTimecode = (mccOptions.includeCdpTimecode ?? mccOptions.embedCdpTimecode ?? mccOptions.cdpTimecode) === true;

  // Guard: CDP timecode (0x71) uses SMPTE-12M BCD frame digits which only support <=30fps.
  // If we allowed this at >30fps we'd generate garbled frame numbers (e.g. frames 40-59).
  if (includeCdpTimecode && Number(fps) > 30.0001 && compatModeNorm !== 'nle') {
    throw new Error(
      `Embed CDP timecode is only supported at <=30fps in the current MCC encoder (resolved fps=${Number(fps).toFixed(3)}). ` +
      `Disable "Embed CDP timecode" or set the MCC fps override to <=30.`
    );
  }

  // Retained on import (doc.mccOptions.mccTimecodeSuffix) for round-trip workflows.
  const mccTimecodeSuffix = (mccOptions.mccTimecodeSuffix ?? mccOptions.mccV2TimecodeSuffix ?? mccOptions.timecodeSuffix ?? null);

  const serviceRaw = Number(mccOptions.serviceNumber);
  let serviceNumber = Number.isFinite(serviceRaw) ? serviceRaw : 1;
  serviceNumber = Math.max(1, Math.min(63, Math.trunc(serviceNumber)));

  let language = String(mccOptions.language || 'eng').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(language)) language = 'eng';

  const alignment = (() => {
    const raw = mccOptions.alignment || doc?.alignment || doc?.sccOptions?.alignment || 'left';
    const norm = String(raw || '').trim().toLowerCase();
    return norm === 'centre' ? 'center' : (norm || 'left');
  })();

  // Caption slip / offset (post-production). Can be negative.
  const timecodeOffset = (typeof mccOptions.timecodeOffset === 'string')
    ? mccOptions.timecodeOffset
    : (mccOptions.captionOffset ?? mccOptions.offset ?? null);
  const timecodeOffsetFrames = Number.isFinite(Number(mccOptions.timecodeOffsetFrames)) ? Number(mccOptions.timecodeOffsetFrames) : undefined;
  const timecodeOffsetSeconds = Number.isFinite(Number(mccOptions.timecodeOffsetSeconds)) ? Number(mccOptions.timecodeOffsetSeconds) : undefined;
  let timecodeOffsetPolicy = String(mccOptions.timecodeOffsetPolicy ?? mccOptions.offsetPolicy ?? 'clamp').trim().toLowerCase();
  if (!['clamp', 'error'].includes(timecodeOffsetPolicy)) timecodeOffsetPolicy = 'clamp';

  // 708 window placement (DefineWindow)
  const mcc708Window = (mccOptions.mcc708Window && typeof mccOptions.mcc708Window === 'object')
    ? mccOptions.mcc708Window
    : (mccOptions.windowPlacement || mccOptions.window || null);

  const qcCfg = (mccOptions && mccOptions.qc) ? mccOptions.qc : {};

  // Phase 2.1: resolve per-track QC profiles (708 vs 608) from config.
  // These are optional; when absent, both tracks inherit the legacy single-profile settings.
  const { qcProfile708: _qcProfile708, qcProfile608 } = resolveMccQcProfiles(qcCfg);


  // Milestone 4: explicit 608 compatibility generation rules (used when authoringModel='true708').
  const compatGenerationRules = (() => {
    const userRules = (mccOptions && typeof mccOptions === 'object') ? (mccOptions.compatGenerationRules || null) : null;
    const userQc = (userRules && typeof userRules === 'object') ? (userRules.qc || null) : null;

    const qc = {
      ...(userQc && typeof userQc === 'object' ? userQc : {}),
      maxCps: (userQc && userQc.maxCps != null) ? userQc.maxCps : ((qcProfile608 && qcProfile608.maxCps != null) ? qcProfile608.maxCps : qcCfg.maxCps),
      maxWpm: (userQc && userQc.maxWpm != null) ? userQc.maxWpm : ((qcProfile608 && qcProfile608.maxWpm != null) ? qcProfile608.maxWpm : qcCfg.maxWpm),
      minDurationSec: (userQc && userQc.minDurationSec != null) ? userQc.minDurationSec : ((qcProfile608 && qcProfile608.minDurationSec != null) ? qcProfile608.minDurationSec : qcCfg.minDurationSec),
      minGapSec: (userQc && userQc.minGapSec != null) ? userQc.minGapSec : ((qcProfile608 && qcProfile608.minGapSec != null) ? qcProfile608.minGapSec : qcCfg.minGapSec),
    };

    return {
      ...(userRules && typeof userRules === 'object' ? userRules : {}),
      qc,
    };
  })();

  const stripPlacementTags = (text) => String(text || '').replace(/(?:\{(?:row|col|pac):[^}]+\})+/g, '');

  // Build segments from cues; strip SCC-only placement tags (MCC doesn't understand them).
  const segments = cueListToSegments(doc.cues, fps, dropFrame).map((seg, idx) => {
    const cue = doc.cues?.[idx];
    if (!cue) return seg;

    const lines = (Array.isArray(cue.lines) && cue.lines.length)
      ? cue.lines.slice()
      : String(seg.text || '')
        .replace(/\\n/g, '\n')
        .split(/\r?\n|\s*\|\s*/g);

    const cleanedLines = lines
      .map(ln => normalizeMusicGlyphLine(stripPlacementTags(ln)))
      .filter(ln => String(ln || '').trim());

    const out = { ...seg, text: cleanedLines.join('\n') };

    // Phase A: carry cue-level runs[] through MCC preview (mirrors exportMccFromEditor()).
    if (cue && typeof cue === 'object' && Array.isArray(cue.runs) && cue.runs.length) {
      const cleanedRuns = cue.runs
        .map((r) => {
          const rr = (r && typeof r === 'object') ? r : null;
          const rawText = rr ? (rr.text ?? '') : '';
          const txt = normalizeMusicGlyphLine(stripPlacementTags(rawText));
          const style = rr && rr.style && typeof rr.style === 'object' ? rr.style : null;
          const t = String(txt || '');
          if (!t) return null;
          return style ? { text: t, style } : { text: t };
        })
        .filter(Boolean);

      if (cleanedRuns.length) {
        out.runs = cleanedRuns;
        const joined = cleanedRuns.map(r => String(r.text || '')).join('');
        if (joined.trim()) out.text = joined;
      }
    }

    if (cue && typeof cue === 'object' && cue.cea708 && typeof cue.cea708 === 'object') {
      out.cea708 = cue.cea708;
      if (typeof cue.textPlain === 'string') out.cea708SourceTextPlain = cue.textPlain;
    }
    return out;
  });

  const includeSpeakerNamesMcc = mccOptions.includeSpeakerNames === true;

  // 608 wrap shaping preferences (speaker labels, punctuation, hyphenation, explicit line breaks).
  // Optional. Sources:
  //   - mccOptions.wrap608 / mccOptions.cea608Wrap
  //   - mccOptions.shaping.wrap608 (or .textWrap/.wrap)
  const wrap608Options = (() => {
    const direct = (mccOptions && typeof mccOptions === 'object')
      ? (mccOptions.wrap608 || mccOptions.cea608Wrap || mccOptions.textWrap608 || null)
      : null;
    if (direct && typeof direct === 'object') return direct;

    const sh = (mccOptions && mccOptions.shaping && typeof mccOptions.shaping === 'object') ? mccOptions.shaping : null;
    if (!sh) return null;

    const candidate = (sh.wrap608 && typeof sh.wrap608 === 'object') ? sh.wrap608
      : ((sh.textWrap && typeof sh.textWrap === 'object') ? sh.textWrap
        : ((sh.wrap && typeof sh.wrap === 'object') ? sh.wrap : sh));

    return (candidate && typeof candidate === 'object') ? candidate : null;
  })();
  let segmentsForMcc = includeSpeakerNamesMcc
    ? segments.map(seg => {
        if (!seg) return seg;
        const sp = String(seg.speaker || '').trim();
        if (!sp) return seg;
        const prefix = `${sp}: `;
        const t = String(seg.text || '');
        if (!t) return { ...seg, text: prefix.trim() };
        if (t.startsWith(prefix)) return seg;

        if (Array.isArray(seg.runs) && seg.runs.length) {
          const first = seg.runs[0] && typeof seg.runs[0] === 'object' ? seg.runs[0] : null;
          const inheritStyle = (first && first.style && typeof first.style === 'object') ? { ...first.style } : null;
          const prefixRun = inheritStyle ? { text: prefix, style: inheritStyle } : { text: prefix };
          return { ...seg, text: `${prefix}${t}`, runs: [prefixRun, ...seg.runs] };
        }

        return { ...seg, text: `${prefix}${t}` };
      })
    : segments;

  // ---- Optional shaping (preview must mirror export) ----
  const previewWarnings = [];
  try {
    const shapeCfg = (mccOptions && mccOptions.shaping && typeof mccOptions.shaping === 'object') ? mccOptions.shaping : null;

    // P0-3: Broadcast/strict deliverables should shape by default when 608 compat is ON.
    // - If shaping is explicitly enabled, honor it.
    // - Else if compatibilityMode is broadcast/strict, enable conservative shaping.
    // - Else (nle/unknown), stay relaxed unless explicitly enabled.
    const explicitEnableShaping = (() => {
      if (!shapeCfg || typeof shapeCfg !== 'object') return false;
      const v = (shapeCfg.enabled ?? shapeCfg.enable ?? shapeCfg.on);
      return (v === true || v === 'true');
    })();

    const autoEnableByProfile = (compatModeNorm === 'broadcast' || compatModeNorm === 'strict');
    const enableShaping = !!include608Compatibility && (explicitEnableShaping || autoEnableByProfile);

    const hasRichRuns = Array.isArray(segmentsForMcc) && segmentsForMcc.some(s => Array.isArray(s?.runs) && s.runs.length);
    const enableShapingFinal = enableShaping && !hasRichRuns;
    if (enableShaping && hasRichRuns) {
      previewWarnings.push({
        line: 0,
        timecode: '',
        type: 'shaping',
        code: 'W_MCC_SHAPING_SKIPPED',
        message: 'MCC shaping skipped: rich 708 style runs[] are present (shaping would discard styling).'
      });
    }

    if (enableShapingFinal && typeof shapeSegmentsForScc === 'function') {
      const shapeMaxCharsPerLine = Math.min(32, maxCharsPerLine);
      const shapeMaxLinesPerBlock = Math.min(2, maxLinesPerBlock);

      const res = shapeSegmentsForScc(segmentsForMcc, {
        fps,
        dropFrame,
        startTc: mccOptions.startTC ?? mccOptions.startTc ?? doc?.startTC ?? doc?.startTc ?? null,
        preStartTransmitSec: 0,
        fixStartTcClamp: false,
        maxCharsPerLine: shapeMaxCharsPerLine,
        maxLinesPerBlock: shapeMaxLinesPerBlock,
        maxDurationSec: maxDurationSeconds,
        preserveSpeakerBoundaries: true,
        clampToMaxEnd: true,
        qc: {
          maxCps: qcCfg.maxCps,
          maxWpm: qcCfg.maxWpm,
          minDurationSec: qcCfg.minDurationSec,
          minGapSec: qcCfg.minGapSec
        },
        // If auto-enabled by profile, force conservative defaults.
        // If explicitly enabled, honor user-tuned knobs.
        mode: explicitEnableShaping && shapeCfg && shapeCfg.mode ? shapeCfg.mode : 'conservative',
        microCueSec: explicitEnableShaping && shapeCfg ? shapeCfg.microCueSec : undefined,
        microGapSec: explicitEnableShaping && shapeCfg ? shapeCfg.microGapSec : undefined,
        maxShiftSec: explicitEnableShaping && shapeCfg ? shapeCfg.maxShiftSec : undefined
      });

      if (res && Array.isArray(res.segments) && res.segments.length) {
        segmentsForMcc = res.segments;
        const shaping = res.report || null;
        const sum = shaping && shaping.summary ? shaping.summary : null;
        if (sum && (sum.mergedCues || sum.splitCues || sum.retimedCues || sum.firstCueDelayedSec)) {
          previewWarnings.push({
            line: 0,
            timecode: '',
            type: 'shaping',
            code: 'I_MCC_SHAPING_APPLIED',
            message:
              `MCC shaping applied: merged=${sum.mergedCues}, split=${sum.splitCues}, retimed=${sum.retimedCues}` +
              (sum.firstCueDelayedSec ? `, firstDelay=${sum.firstCueDelayedSec.toFixed(3)}s` : '')
          });
        }
      }
    }
  } catch (e) {
    previewWarnings.push({
      line: 0,
      timecode: '',
      type: 'shaping',
      code: 'W_MCC_SHAPING_FAILED',
      message: `MCC shaping failed (preview continues unshaped): ${e?.message || String(e)}`
    });
  }

  const mccText = scc.generateMCC(segmentsForMcc, {
    fps,
    dropFrame,
    startTc: mccOptions.startTC ?? mccOptions.startTc ?? doc?.startTC ?? doc?.startTc ?? null,
    timecodeOffset,
    timecodeOffsetFrames,
    timecodeOffsetSeconds,
    timecodeOffsetPolicy,
    compatibilityMode,
    includeCcsSvcInfo,
    includeCdpTimecode,
    mccTimecodeSuffix,
    authoringModel,
    include608Compatibility,
    compatGenerationRules,
    telestreamCompression,
    pingPongWindows: (mccOptions.pingPongWindows ?? mccOptions.popOnPingPongWindows ?? true) !== false,
    creationProgram: mccOptions.creationProgram ?? 'Lead AE Assist',
    maxCharsPerLine,
    maxLinesPerBlock,
    maxDurationSeconds,
    includeSpeakerNames: false,
    serviceNumber,
    language,
    sccOptions: {
      alignment,
      channel: Number.isFinite(Number(mccOptions.channel)) ? normalizeSccChannel(mccOptions.channel) : 1,
      rowPolicy: mccOptions.rowPolicy || doc?.sccOptions?.rowPolicy || 'bottom2',
      safeMargins: (mccOptions.safeMargins ?? doc?.sccOptions?.safeMargins),
      strictCharacterEncoding: (mccOptions.strictCharacterEncoding ?? doc?.sccOptions?.strictCharacterEncoding) === true,
      overflowPolicy: (mccOptions.overflowPolicy ?? doc?.sccOptions?.overflowPolicy),
      padEven: !!(mccOptions.padEven ?? doc?.sccOptions?.padEven),
      repeatControlCodes: (compatModeNorm === 'nle')
        ? false
        : ((mccOptions.repeatControlCodes ?? doc?.sccOptions?.repeatControlCodes) === true),
      repeatPreambleCodes: (mccOptions.repeatPreambleCodes ?? doc?.sccOptions?.repeatPreambleCodes) !== false,
      mcc708Window,
      preserveImported708Layout: (mccOptions.preserveImported708Layout !== false),
      requireCompat608Placement,
      wrap608: wrap608Options || null,
      extendedGlyphMap
    }
  });

  // Structural sanity: preview should not crash on corrupt writes.
  // IMPORTANT: do NOT override MCC header timebase with caller-provided fps/df.
  let structural = scc.verifyMCC(mccText, {
    strictPayloadParse: (compatibilityMode === 'strict') || includeCdpTimecode === true || includeCcsSvcInfo === true,
    checkHeader: true,
    requireHeader: true,
    checkTimecode: true,
    checkMonotonic: true,
    checkAncChecksum: true,
    checkCdpChecksum: true,
    checkCdpLength: true,
    checkCcCount: true,
    checkSequence: true,
    checkSmpte12M: true
  });

  // Explicit header ↔ expected mismatch check (prevents caller-provided fps from hiding bad headers).
  const mismatchErrors = [];
  const approxEq = (a, b, eps = 0.12) => {
    const A = Number(a);
    const B = Number(b);
    if (!Number.isFinite(A) || !Number.isFinite(B)) return false;
    return Math.abs(A - B) <= eps;
  };

  const hdr = (structural && structural.header && typeof structural.header === 'object') ? structural.header : {};

  if (structural && Number.isFinite(Number(structural.fps)) && Number.isFinite(Number(fps)) && !approxEq(structural.fps, fps, 0.12)) {
    mismatchErrors.push({
      line: 1,
      timecode: '',
      type: 'header',
      code: 'E_MCC_HEADER_MISMATCH',
      message:
        `Header timecode rate implies ~${Number(structural.fps).toFixed(3)}fps${structural.dropFrame ? ' (DF)' : ' (NDF)'}, ` +
        `but export expected ~${Number(fps).toFixed(3)}fps${dropFrame ? ' (DF)' : ' (NDF)'}. ` +
        `Time Code Rate=${hdr['time code rate'] ?? 'n/a'}; Drop Frame=${hdr['drop frame'] ?? 'n/a'}.`
    });
  }

  if (structural && typeof structural.dropFrame === 'boolean' && typeof dropFrame === 'boolean' && !!structural.dropFrame !== !!dropFrame) {
    mismatchErrors.push({
      line: 1,
      timecode: '',
      type: 'header',
      code: 'E_MCC_HEADER_MISMATCH',
      message: `Header Drop Frame=${structural.dropFrame ? 'True' : 'False'} does not match expected ${dropFrame ? 'True' : 'False'}.`
    });
  }

  if (mismatchErrors.length) {
    structural = {
      ...structural,
      ok: false,
      headerErrors: Number(structural?.headerErrors || 0) + mismatchErrors.length,
      errors: [...mismatchErrors, ...(Array.isArray(structural?.errors) ? structural.errors : [])]
    };
  }

  if (structural && structural.ok === false) {
    const total = Array.isArray(structural.errors) ? structural.errors.length : 0;
    const head = (typeof scc.formatVerifyErrors === 'function')
      ? scc.formatVerifyErrors(structural.errors, 8)
      : (Array.isArray(structural.errors) ? structural.errors.slice(0, 8).map(e => String(e && e.message ? e.message : e)) : []);
    const shown = head.length;
    throw new Error(`MCC preview blocked: structural validation failed (${total} error(s); first ${shown} shown).\n${head.join('\n')}`);
  }

  const { decodeMccText } = require('./mccDecoder');

  const preview708 = decodeMccText(mccText, {
    fps,
    dropFrame,
    keepAbsoluteTimecode: false
  });

  const preview608 = decodeMccText(mccText, {
    fps,
    dropFrame,
    keepAbsoluteTimecode: false,
    force608Compatibility: true
  });

  return {
    ok: true,
    fps,
    dropFrame,
    authoringModel,
    include608Compatibility,
    preview708,
    preview608,
    warnings: (() => {
      const out = [];
      if (Array.isArray(previewWarnings) && previewWarnings.length) out.push(...previewWarnings);
      if (Array.isArray(structural?.warnings) && structural.warnings.length) out.push(...structural.warnings);
      return out.slice(0, 50);
    })()
  };
}

module.exports = {
  runTranscribe,
  cancelTranscribe,
  streamTranscript,
  openSubtitleDocument,
  exportCorrectedSubtitles,
  burnInCorrectedSubtitles,
  findLatestSubtitleSource,
  exportSccFromEditor,
  exportMccFromEditor,
  previewMccFromEditor,
  // SCC glyph picker
  getSccGlyphs
};
