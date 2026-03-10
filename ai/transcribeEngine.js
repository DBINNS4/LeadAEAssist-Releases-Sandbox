require('dotenv').config();

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { renameReplaceSync } = require('../utils/fsSafe');
const _os = require('os');
const electron = require('electron');
const platformPaths = require('../platform/paths');
const { ensureTempSubdir } = require('../utils/appPaths');
const whisperAssetService = require('../services/whisperAssetService');

const app = electron.app || null;
const isPackaged = app?.isPackaged ?? false;
const OpenAI = require('openai');
const { convertToWav, ffmpegPath, ffprobePath } = require('../utils/ffmpeg');
const { runWhisperOnce, writeEnrichedLog, ensureUnique } = require('./whisperUtils');
const { detectAIComputeType } = require('../utils/gpuEncoder');
// Initialize export object before requiring modules that depend on this one
// to avoid circular dependency issues.
const exported = {};
module.exports = exported;

const scc = require('../modules/sccEncoder');

// Keep high-level wrappers from whisperFormatter
const {
  wrapToProfessionalFormat,
  addFullTimecodeMetadata
} = require('./whisperFormatter');
// Pull timecode math from centralized utils
const {
  parseTime: parseTimeMs,
  msToTC,
  formatTimecodes,
  formatTimecode,
  isDropFrameRate
} = require('../utils/timeUtils');

// Plain Text (.txt) export formatter is intentionally dependency-light,
// so it can be tested without Electron/FFmpeg/OpenAI.
const { generatePlainText, normalizeOffset } = require('./plainTextFormatter');

// WebVTT (.vtt) export is dependency-light and shared with output writers.
const { generateVTT: generateVTTWriter } = require('./vttWriter');

// SubRip (.srt) export is dependency-light and shared with output writers.
const { generateSRT: generateSRTWriter } = require('./srtWriter');

const { prepareSegments, normalizeTranscriptionStructure } = require('./prepareUtils');
const { prepareTranscription } = require('./prepareTranscription');
const { writeAllOutputs, validateSccContentQc, validateMccContentQc } = require('./outputWriters');

const PY_VER = '3.11';
const DEBUG_LOGS = ['1', 'true'].includes(String(process.env.DEBUG_LOGS || '').trim().toLowerCase())
  || !isPackaged;
const DEFAULT_OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) > 0
  ? Number(process.env.OPENAI_REQUEST_TIMEOUT_MS)
  : 120000;

function debugLog(event, details = {}) {
  if (!DEBUG_LOGS) return;
  console.debug(`[transcribeEngine] ${event}`, details);
}

function makeTimeoutError(message = 'API request timed out') {
  const err = new Error(message);
  err.name = 'TimeoutError';
  err.code = 'ETIMEDOUT';
  return err;
}

function isAbortError(err) {
  const name = String(err?.name || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    name === 'aborterror' ||
    code === 'abort_err' ||
    code === 'aborted' ||
    name === 'apiuserabortederror'
  );
}

function withAbortTimeout(parentSignal, timeoutMs, label = 'OpenAI request') {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    try {
      controller.abort(makeAbortError('Transcription cancelled'));
    } catch (err) {
      console.warn(`[transcribeEngine] abort propagation failed (${label}):`, err?.message || String(err));
    }
  };

  if (parentSignal?.aborted) onParentAbort();
  else if (parentSignal && typeof parentSignal.addEventListener === 'function') {
    try {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    } catch (err) {
      console.warn(`[transcribeEngine] parent abort listener bind failed (${label}):`, err?.message || String(err));
    }
  }

  const timeoutId = Number(timeoutMs) > 0
    ? setTimeout(() => {
      timedOut = true;
      console.warn(`[transcribeEngine] API timeout (${label}) after ${timeoutMs}ms.`);
      try {
        controller.abort(makeTimeoutError(`${label} timed out after ${timeoutMs}ms`));
      } catch (err) {
        console.warn(`[transcribeEngine] timeout abort failed (${label}):`, err?.message || String(err));
      }
    }, timeoutMs)
    : null;

  return {
    signal: controller.signal,
    getTimedOut: () => timedOut,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
        try {
          parentSignal.removeEventListener('abort', onParentAbort);
        } catch (err) {
          console.warn(`[transcribeEngine] parent abort listener cleanup failed (${label}):`, err?.message || String(err));
        }
      }
    }
  };
}

async function callOpenAIWithTimeout(requestFn, {
  signal = null,
  timeoutMs = DEFAULT_OPENAI_TIMEOUT_MS,
  label = 'OpenAI request'
} = {}) {
  const timeout = withAbortTimeout(signal, timeoutMs, label);
  try {
    return await requestFn(timeout.signal);
  } catch (err) {
    if (signal?.aborted) {
      console.warn(`[transcribeEngine] user cancel received during ${label}.`);
      throw makeAbortError('Transcription cancelled');
    }
    if (timeout.getTimedOut()) {
      throw makeTimeoutError(`${label} timed out after ${timeoutMs}ms`);
    }
    if (isAbortError(err)) {
      if (timeout.getTimedOut()) {
        throw makeTimeoutError(`${label} timed out after ${timeoutMs}ms`);
      }
      console.warn(`[transcribeEngine] user cancel received during ${label}.`);
      throw makeAbortError('Transcription cancelled');
    }
    console.error(`[transcribeEngine] upstream API hard error during ${label}:`, err?.message || err);
    throw err;
  } finally {
    timeout.cleanup();
  }
}

function getRuntimeRoot() {
  // In packaged apps, external resources live next to app.asar in Resources/.
  if (process && process.resourcesPath && app && app.isPackaged) {
    return process.resourcesPath;
  }
  // In dev, use project root.
  return process.cwd();
}

// Translate wrapped.segments[*].text into a target language, preserving timing and segment boundaries.
// Returns true if any text was changed, false otherwise.
async function translateWrappedSegmentsInPlace(openai, wrapped, targetLabel = 'English', options = {}) {
  const signal = options?.signal || null;
  const requestTimeoutMs = Number(options?.requestTimeoutMs) > 0
    ? Number(options.requestTimeoutMs)
    : DEFAULT_OPENAI_TIMEOUT_MS;
  if (!wrapped || !Array.isArray(wrapped.segments) || !wrapped.segments.length) return false;

  const segments = wrapped.segments;
  const originals = segments.map(s => String(s.text || ''));
  const inputs = originals.map(t => t || '');

  if (!inputs.some(t => t.trim())) {
    console.warn('[translateWrappedSegmentsInPlace] No non-empty segment text to translate.');
    return false;
  }

  // 1️⃣ Try a single JSON-array style translation
  const systemMsg =
    `You are a professional subtitle translator. ` +
    `Translate each caption into ${targetLabel}. ` +
    `Preserve meaning, punctuation, tone, and roughly the same line breaks. ` +
    `Return ONLY a JSON array of ${inputs.length} strings, where index i is the translation of input index i. ` +
    `Do not merge, split, reorder, or add items. No commentary.`;

  const userMsg = JSON.stringify(inputs);

  let outputs = null;
  let rawContent = '';

  try {
    const resp = await callOpenAIWithTimeout(
      reqSignal => openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg }
        ]
      }, { signal: reqSignal }),
      { signal, timeoutMs: requestTimeoutMs, label: 'translation-bulk' }
    );

    rawContent = resp?.choices?.[0]?.message?.content?.trim() || '';
    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      console.warn('[translateWrappedSegmentsInPlace] JSON.parse failed on bulk response:', e.message);
    }

    if (Array.isArray(parsed) && parsed.length === inputs.length) {
      outputs = parsed.map(x => (typeof x === 'string' ? x : String(x ?? '')));
    } else {
      console.warn(
        '[translateWrappedSegmentsInPlace] Parsed JSON has wrong shape; expected array length',
        inputs.length,
        'got',
        parsed && parsed.length
      );
    }
  } catch (e) {
    if (isAbortError(e) || e?.name === 'TimeoutError') throw e;
    console.warn('[translateWrappedSegmentsInPlace] Bulk translation call failed:', e.message);
  }

  // If bulk path failed or produced junk, fall back to per-line translation.
  const needFallback =
    !outputs ||
    outputs.length !== inputs.length ||
    // if nothing actually changed and target is non-English, treat as failure
    outputs.every((out, i) => out.trim() === inputs[i].trim());

  if (needFallback) {
    console.warn('[translateWrappedSegmentsInPlace] Falling back to per-line translation.');
    outputs = [];
    for (let i = 0; i < inputs.length; i++) {
      const line = inputs[i];
      if (!line.trim()) {
        outputs.push(line);
        continue;
      }
      try {
        const resp = await callOpenAIWithTimeout(
          reqSignal => openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0,
            messages: [
              {
                role: 'system',
                content:
                  `Translate the following subtitle into ${targetLabel}. ` +
                  'Return ONLY the translated text, no explanations, no quotes, no JSON.'
              },
              { role: 'user', content: line }
            ]
          }, { signal: reqSignal }),
          { signal, timeoutMs: requestTimeoutMs, label: `translation-line-${i}` }
        );
        const out = resp?.choices?.[0]?.message?.content ?? '';
        outputs.push(String(out).trim() || line);
      } catch (e) {
        if (isAbortError(e) || e?.name === 'TimeoutError') throw e;
        console.warn(`[translateWrappedSegmentsInPlace] Line ${i} translation failed:`, e.message);
        outputs.push(line);
      }
    }
  }

  if (!outputs || outputs.length !== inputs.length) {
    console.warn('[translateWrappedSegmentsInPlace] Translation fallback still invalid; keeping originals.');
    return false;
  }

  // Apply translations
  let changed = false;
  segments.forEach((seg, i) => {
    if (!seg || typeof seg !== 'object') return;
    const next = outputs[i];
    if (typeof next === 'string' && next.trim() && next.trim() !== originals[i].trim()) {
      seg.text = next;
      changed = true;
    }
  });

  if (!changed) {
    console.warn('[translateWrappedSegmentsInPlace] No segment text changed after translation; originals retained.');
  }

  return changed;
}

function languageCodeToLabel(code, fallback = 'English') {
  const c = String(code || '').trim().toLowerCase();
  const map = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
    zh: 'Chinese'
  };
  return map[c] || (c ? c : fallback);
}

let currentProcess = null;

function makeAbortError(message = 'Cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw makeAbortError('Transcription cancelled');
  }
}

function killProcessTree(proc, opts = {}) {
  if (!proc || typeof proc.kill !== 'function') return;
  const pid = proc.pid;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 500;

  if (process.platform === 'win32') {
    if (pid) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    }
    try { proc.kill(); } catch {}
    return;
  }

  const killGroup = !!proc.__leadaiProcessGroup && pid;
  try {
    if (killGroup) process.kill(-pid, 'SIGINT');
    else proc.kill('SIGINT');
  } catch {}

  setTimeout(() => {
    try {
      if (proc.exitCode != null) return;
      if (killGroup) process.kill(-pid, 'SIGKILL');
      else proc.kill('SIGKILL');
    } catch {}
  }, graceMs);
}

function bindAbort(signal, fn) {
  if (!signal || typeof signal.addEventListener !== 'function') return () => {};
  const handler = () => {
    try {
      fn();
    } catch (err) {
      console.warn('[transcribeEngine] abort handler failed:', err?.message || String(err));
    }
  };
  try {
    signal.addEventListener('abort', handler, { once: true });
  } catch (err) {
    console.warn('[transcribeEngine] abort listener bind failed:', err?.message || String(err));
  }
  return () => {
    try {
      signal.removeEventListener('abort', handler);
    } catch (err) {
      console.warn('[transcribeEngine] abort listener cleanup failed:', err?.message || String(err));
    }
  };
}

function withFfmpegEnv(extra = {}) {
  const env = Object.assign({}, process.env, extra);
  try {
    const appRoot = getRuntimeRoot();

    // Prefer the resolved binary directory (handles app.asar.unpacked in packaged builds).
    const ffbinDir = ffmpegPath ? path.dirname(ffmpegPath) : null;

    const candidateDirs = [
      ffbinDir,
      path.join(appRoot, 'extra', 'bin')
    ].filter(Boolean);

    const resolvedDirs = candidateDirs.filter(dir => {
      try {
        return fs.existsSync(dir);
      } catch {
        return false;
      }
    });

    const existingPath = env.PATH ? env.PATH.split(path.delimiter) : [];
    const nextPath = [...resolvedDirs, ...existingPath].filter(Boolean);
    env.PATH = nextPath.join(path.delimiter);

    // Provide explicit binary paths for downstream tools.
    if (!env.FFMPEG && ffmpegPath) env.FFMPEG = ffmpegPath;
    if (!env.FFPROBE) {
      env.FFPROBE = ffprobePath || (
        ffmpegPath
          ? path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
          : undefined
      );
    }
  } catch {}
  return env;
}

function resolveEmbeddedPython(appRoot) {
  // Packaged: prefer the app-bundled embedded Python runtime, not the venv shim.
  // This avoids dyld trying to load /Library/Frameworks/Python.framework on clean Macs.
  const candidate = path.join(
    appRoot,
    'python_embedded',
    'Python.framework',
    'Versions',
    PY_VER,
    'bin',
    `python${PY_VER}`
  );
  if (fs.existsSync(candidate)) return candidate;
  // Fallback: some layouts name it python3.11 or python3
  const alt1 = path.join(appRoot, 'python_embedded', 'Python.framework', 'Versions', PY_VER, 'bin', 'python3.11');
  if (fs.existsSync(alt1)) return alt1;
  const alt2 = path.join(appRoot, 'python_embedded', 'Python.framework', 'Versions', PY_VER, 'bin', 'python3');
  if (fs.existsSync(alt2)) return alt2;
  return null;
}

// Ensure python-based tools (whisperx/diarize) resolve the app's ffmpeg first.
function _buildPythonEnv(extra = {}) {
  const env = Object.assign({}, process.env, extra);
  try {
    const appRoot = getRuntimeRoot();

    // Ensure Python sees the app-bundled ffmpeg first.
    const isWin = process.platform === 'win32';
    const ffbinDir = ffmpegPath ? path.dirname(ffmpegPath) : path.join(appRoot, 'extra', 'ffmpeg');

    // WhisperX requires these exact env names (NOT FFMPEG / FFPROBE)
    env.FFMPEG_BINARY = ffmpegPath || path.join(ffbinDir, isWin ? 'ffmpeg.exe' : 'ffmpeg');
    env.FFPROBE_BINARY = ffprobePath || path.join(ffbinDir, isWin ? 'ffprobe.exe' : 'ffprobe');

    // If there's a venv next to the app, add it to PATH + PYTHONPATH
    const venvDir = process.env.LEADAI_VENV_DIR
      ? path.resolve(process.env.LEADAI_VENV_DIR)
      : path.join(appRoot, 'venv');
    const venvBin = isWin
      ? path.join(venvDir, 'Scripts')
      : path.join(venvDir, 'bin');
    const venvSite = path.join(venvDir, 'lib', `python${PY_VER}`, 'site-packages');

    const pathParts = [];
    if (fs.existsSync(venvBin)) pathParts.push(venvBin);
    if (fs.existsSync(ffbinDir)) pathParts.push(ffbinDir);
    if (env.PATH) pathParts.push(env.PATH);
    env.PATH = pathParts.join(path.delimiter);

    if (fs.existsSync(venvSite)) {
      env.PYTHONPATH = env.PYTHONPATH
        ? `${venvSite}${path.delimiter}${env.PYTHONPATH}`
        : venvSite;
    }

    // ✅ macOS embedded Python frequently ships without a usable CA trust store.
    // This breaks HTTPS downloads (HuggingFace / TorchHub / Torchaudio) with CERTIFICATE_VERIFY_FAILED.
    // Point Python/OpenSSL at certifi's CA bundle inside the shipped venv.
    try {
      const certFile = path.join(venvSite, 'certifi', 'cacert.pem');
      if (fs.existsSync(certFile)) {
        if (!env.SSL_CERT_FILE) env.SSL_CERT_FILE = certFile;
        if (!env.REQUESTS_CA_BUNDLE) env.REQUESTS_CA_BUNDLE = certFile;
        if (!env.CURL_CA_BUNDLE) env.CURL_CA_BUNDLE = certFile;
      }
    } catch {}

  } catch {}
  return env;
}

function buildPythonEnvForWhisperX(extra = {}) {
  const env = Object.assign({}, process.env, extra);

  try {
    const appRoot = getRuntimeRoot();

    const isWin = process.platform === 'win32';
    const ffbinDir = ffmpegPath ? path.dirname(ffmpegPath) : path.join(appRoot, 'extra', 'ffmpeg');

    // 🔥 WhisperX uses THESE names (FFMPEG_BINARY / FFPROBE_BINARY) not FFMPEG / FFPROBE
    env.FFMPEG_BINARY = ffmpegPath || path.join(ffbinDir, isWin ? 'ffmpeg.exe' : 'ffmpeg');
    env.FFPROBE_BINARY = ffprobePath || path.join(ffbinDir, isWin ? 'ffprobe.exe' : 'ffprobe');

    // Prepend ffmpeg folder so plain "ffmpeg" resolves correctly
    env.PATH = [ffbinDir, env.PATH].filter(Boolean).join(path.delimiter);

    // Add virtualenv paths if present
    const venvDir = process.env.LEADAI_VENV_DIR
      ? path.resolve(process.env.LEADAI_VENV_DIR)
      : path.join(appRoot, 'venv');
    const venvBin = isWin ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
    const venvSite = path.join(venvDir, 'lib', `python${PY_VER}`, 'site-packages');

    if (fs.existsSync(venvBin)) {
      env.PATH = [venvBin, env.PATH].filter(Boolean).join(path.delimiter);
    }
    if (fs.existsSync(venvSite)) {
      env.PYTHONPATH = env.PYTHONPATH
        ? `${venvSite}${path.delimiter}${env.PYTHONPATH}`
        : venvSite;
    }

    // ✅ macOS embedded Python frequently ships without a usable CA trust store.
    // This breaks HTTPS downloads (HuggingFace / TorchHub / Torchaudio) with CERTIFICATE_VERIFY_FAILED.
    // Point Python/OpenSSL at certifi's CA bundle inside the shipped venv.
    try {
      const certFile = path.join(venvSite, 'certifi', 'cacert.pem');
      if (fs.existsSync(certFile)) {
        if (!env.SSL_CERT_FILE) env.SSL_CERT_FILE = certFile;
        if (!env.REQUESTS_CA_BUNDLE) env.REQUESTS_CA_BUNDLE = certFile;
        if (!env.CURL_CA_BUNDLE) env.CURL_CA_BUNDLE = certFile;
      }
    } catch {}


    // If we are packaged, prefer pointing PYTHONHOME at the Frameworks copy of Python (this is what
    // the afterPack rpath/relocation patch targets). Fall back to python_embedded only if needed.
    if (app && app.isPackaged && process.resourcesPath) {
      const pyHomeFramework = path.join(
        appRoot,
        '..',
        'Frameworks',
        'Python.framework',
        'Versions',
        PY_VER
      );
      if (fs.existsSync(pyHomeFramework)) {
        env.PYTHONHOME = pyHomeFramework;
      } else {
        const pyHomeEmbedded = path.join(
          appRoot,
          'python_embedded',
          'Python.framework',
          'Versions',
          PY_VER
        );
        if (fs.existsSync(pyHomeEmbedded)) {
          env.PYTHONHOME = pyHomeEmbedded;
        }
      }
    }

  } catch (e) {
    console.warn('Failed to build WhisperX env:', e);
  }

  return env;
}

function resolvePythonExecutable() {
  const isWin = process.platform === 'win32';
  const isPackaged = !!(app && app.isPackaged);
  try {
    const appRoot = getRuntimeRoot();

    // ✅ Packaged builds: prefer the shipped venv interpreter (whisperx + deps live there).
    // We only fall back to the embedded/framework python if the venv isn't present.
    if (isPackaged) {
      const venvDir = process.env.LEADAI_VENV_DIR
        ? path.resolve(process.env.LEADAI_VENV_DIR)
        : path.join(appRoot, 'venv');
      const pyDir = isWin ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');

      const candidates = isWin
        ? [path.join(pyDir, 'python.exe')]
        : [path.join(pyDir, 'python3.11'), path.join(pyDir, 'python3'), path.join(pyDir, 'python')];

      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }

      // macOS fallback: Python.framework copied into Contents/Frameworks (patched by afterPack)
      if (!isWin && process.platform === 'darwin') {
        const fwPy = path.join(
          appRoot,
          '..',
          'Frameworks',
          'Python.framework',
          'Versions',
          PY_VER,
          'bin',
          'python3.11'
        );
        if (fs.existsSync(fwPy)) return fwPy;
      }

      // Last resort: embedded python in Resources (only if you also patch it)
      const embedded = resolveEmbeddedPython(appRoot);
      if (embedded) return embedded;

      // 🚫 Packaged builds must never fall back to PATH python.
      // If we can't find a bundled runtime, fail loudly with a human-readable error.
      let logsDir = '';
      try {
        logsDir = (typeof platformPaths?.getLogsDir === 'function') ? platformPaths.getLogsDir() : '';
      } catch {}
      const logsLine = logsDir ? `\nLogs: ${logsDir}` : '';
      const err = new Error(
        `❌ Bundled Python missing. Please reinstall/repair Lead AE Assist.${logsLine}\n` +
        `This packaged build requires the bundled Python runtime (venv/Python.framework/python_embedded).`
      );
      err.code = 'BUNDLED_PYTHON_MISSING';
      throw err;
    }

    const venvDir = process.env.LEADAI_VENV_DIR
      ? path.resolve(process.env.LEADAI_VENV_DIR)
      : path.join(appRoot, 'venv');
    const pyDir = isWin ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
    const pyName = isWin ? 'python.exe' : 'python3';
    const venvPython = path.join(pyDir, pyName);
    if (fs.existsSync(venvPython)) {
      return venvPython;
    }
  } catch (e) {
    // Packaged builds: never silently fall back to PATH python.
    if (isPackaged) throw e;
  }
  // Dev/test fallback to whatever python3 is on PATH
  return isWin ? 'python' : 'python3';
}

async function runDiarization(filePath) {
  const script = path.join(getRuntimeRoot(), 'scripts', 'diarize.py');
  if (!fs.existsSync(script)) {
    throw new Error(`❌ Diarization script missing: ${script}`);
  }

  let diarizeInput = filePath;
  let tempWav = null;

  try {
    const ext = path.extname(String(filePath || '')).toLowerCase();

    // Tokenless diarizer (librosa/webrtcvad) is most reliable on WAV.
    if (ext !== '.wav') {
      const tmpDir = ensureTempSubdir('diarize');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

      tempWav = path.join(
        tmpDir,
        `diarize-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`
      );

      // Convert to mono 16k PCM WAV (Whisper-friendly)
      await convertToWav(filePath, tempWav, null, (proc) => {
        if (process.platform !== 'win32') proc.__leadaiProcessGroup = true;
        currentProcess = proc;
      });

      currentProcess = null;
      diarizeInput = tempWav;
    }

    return await new Promise((resolve, reject) => {
      const py = resolvePythonExecutable();
      const proc = spawn(
        py,
        [script, diarizeInput],
        { env: buildPythonEnvForWhisperX(), detached: process.platform !== 'win32' }
      );
      if (process.platform !== 'win32') proc.__leadaiProcessGroup = true;
      currentProcess = proc;

      let out = '';
      let err = '';

      proc.stdout.on('data', d => (out += d.toString()));
      proc.stderr.on('data', d => (err += d.toString()));

      proc.on('error', errEvt => {
        currentProcess = null;
        reject(errEvt);
      });

      proc.on('close', code => {
        currentProcess = null;

        if (code === 0) {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(new Error('❌ Diarization JSON parse failed: ' + e.message));
          }
          return;
        }

        // Keep your existing soft-fail for missing numpy
        if (err.includes("ModuleNotFoundError: No module named 'numpy'")) {
          resolve([]);
        } else {
          reject(new Error(`Diarization failed: ${err}`));
        }
      });
    });
  } finally {
    if (tempWav) {
      try { fs.rmSync(tempWav, { force: true }); } catch {}
    }
  }
}

function injectSpeakersIntoSegments(segments, diarized) {
  if (!Array.isArray(segments) || !Array.isArray(diarized) || diarized.length === 0) return;

  for (const seg of segments) {
    if (!seg || typeof seg.start !== 'number') continue;

    const existing = (typeof seg.speaker === 'string') ? seg.speaker.trim() : '';
    if (existing) continue;

    const segStart = Number(seg.start);
    const segEndRaw = (typeof seg.end === 'number') ? Number(seg.end) : segStart;
    if (!Number.isFinite(segStart) || !Number.isFinite(segEndRaw)) continue;

    // Treat point-segments as a tiny window so overlap math still works.
    let segEnd = segEndRaw;
    if (segEnd <= segStart) segEnd = segStart + 0.001;

    let bestSpeaker = '';
    let bestOverlap = 0;

    for (const d of diarized) {
      if (!d || typeof d.start !== 'number' || typeof d.end !== 'number') continue;
      const sp = (typeof d.speaker === 'string') ? d.speaker.trim() : '';
      if (!sp) continue;

      const overlap = Math.min(segEnd, d.end) - Math.max(segStart, d.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = sp;
      }
    }

    if (bestSpeaker && bestOverlap > 0) {
      seg.speaker = bestSpeaker;
    }
  }
}

// ----------------------------------------
// 🔊 Whisper (OpenAI) API
// ----------------------------------------
async function transcribeWithWhisperAPI(filePath, config) {
  const { language, apiKey } = config;
  const signal = config?.signal || null;
  const requestTimeoutMs = Number(config?.requestTimeoutMs) > 0
    ? Number(config.requestTimeoutMs)
    : DEFAULT_OPENAI_TIMEOUT_MS;
  const effectiveKey = (apiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!effectiveKey) {
    // Fail loudly with a human-readable reason instead of a cryptic 401
    throw new Error(
      'OpenAI Whisper API key is missing. ' +
      'Set an API key in Preferences (or OPENAI_API_KEY in your environment) to run translate jobs.'
    );
  }

  const openai = new OpenAI({ apiKey: effectiveKey });
  const keySource = apiKey ? 'config' : 'env';
  debugLog('whisper-api-key-source', { keySource });

  const results = [];
  const wantsTranslate = !!config.translation?.enabled;
  const targetLabel = languageCodeToLabel(config.translation?.target);

  let resp;
  try {
    // IMPORTANT: transcription only – no `task` here
    const req = {
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'verbose_json'
    };

    // Engine Language dropdown → input language hint.
    // If unset, Whisper will auto-detect.
    if (language && String(language).toLowerCase() !== 'auto') {
      req.language = language;
    }

    resp = await callOpenAIWithTimeout(
      reqSignal => openai.audio.transcriptions.create(req, { signal: reqSignal }),
      { signal, timeoutMs: requestTimeoutMs, label: 'whisper-transcription' }
    );
  } catch (err) {
    if (isAbortError(err)) throw makeAbortError('Transcription cancelled');
    if (err?.name === 'TimeoutError') {
      throw new Error(`OpenAI Whisper API timeout: ${err.message || String(err)}`);
    }
    // Surface a clean error to your job queue / UI
    throw new Error(`OpenAI Whisper API error: ${err.message || String(err)}`);
  }

  let jsonData;
  try {
    jsonData = typeof resp === 'object' ? resp : JSON.parse(resp);
  } catch {
    const snippet = String(resp).slice(0, 120).replace(/\n/g, ' ');
    throw new Error(`❌ Expected JSON but got invalid response.\n${snippet}`);
  }

  await prepareSegments(jsonData, filePath, config);
  const diarized = (config.diarization || config.localSpeakerDetection || config.detectSpeakers || config.includeSpeakerNames)
    ? (await runDiarization(filePath).catch(() => []))
    : [];
  const wrapped = await prepareTranscription(jsonData, filePath, config, { engine: 'whisper', diarized });

  // 🔁 If Translate dropdown is ON, convert segment text into the target language
  if (wantsTranslate) {
    try {
      const changed = await translateWrappedSegmentsInPlace(openai, wrapped, targetLabel, {
        signal,
        requestTimeoutMs
      });
      if (changed) {
        results.push(`🌍 Translation applied → ${targetLabel}`);
      } else {
        results.push(
          `⚠️ Translation requested but produced no changes; leaving original language (${jsonData.language || language || 'unknown'}).`
        );
      }
    } catch (e) {
      if (isAbortError(e)) throw makeAbortError('Transcription cancelled');
      if (e?.name === 'TimeoutError') throw e;
      results.push(`⚠️ Translation failed: ${e?.message || e}`);
    }
  }

  const outputLogs = await writeAllOutputs(wrapped, filePath, config);
  results.push(...outputLogs);

  return results;
}

// ----------------------------------------
// 🖥️ Local Whisper Binary
// ----------------------------------------

async function transcribeWithLocalWhisper(filePath, config) {
  const signal = config?.signal || null;
  const unbindAbort = bindAbort(signal, () => { if (currentProcess) killProcessTree(currentProcess); });
  const requestTimeoutMs = Number(config?.requestTimeoutMs) > 0
    ? Number(config.requestTimeoutMs)
    : DEFAULT_OPENAI_TIMEOUT_MS;

  let tempDir = null;
  const keepTempArtifacts = ['1', 'true'].includes(String(process.env.LEADAE_KEEP_TEMP || '').trim().toLowerCase());

  try {
  // --- Language → model selection ---
  // whisper.cpp requires the multilingual model (e.g. ggml-base.bin) for non-English languages.
  const lang = String(config?.language || 'en').trim().toLowerCase() || 'en';
  const wantsMultilingual = lang !== 'en';

  // Phase 2: In packaged builds, models live under userData/assets and are installed on-demand.
  // During migration (until Phase 4 removes bundled models), we seed userData/assets from the
  // currently-bundled copies under process.resourcesPath/whisper.cpp/models.
  const devDir = path.join(process.cwd(), 'whisper.cpp');
  const appDir = path.join(getRuntimeRoot(), 'whisper.cpp');

  const candidateDirs = [
    process.env.WHISPER_CPP_DIR,
    devDir,
    appDir
  ].filter(Boolean);

  // Choose whisper.cpp root for binaries/toolchain (models are handled separately below).
  let whisperDir = candidateDirs.find(d => {
    try { return fs.existsSync(d); } catch { return false; }
  }) || appDir;

  // Dev default: models in repo/app whisper.cpp/models
  const englishModelPath = path.join(whisperDir, 'models', 'ggml-base.en.bin');
  const multilingualModelPath = path.join(whisperDir, 'models', 'ggml-base.bin');
  let modelPath = wantsMultilingual ? multilingualModelPath : englishModelPath;

  // Packaged default: install into userData/assets via runtime asset service.
  // Offline mode is read from canonical preferences unless the caller explicitly overrides it.
  if (isPackaged) {
    const ensuredModel = await whisperAssetService.ensureWhisperModelPath({
      language: lang,
      isPackaged: true,
      offline: (typeof config?.offline === 'boolean') ? config.offline : undefined
    });
    modelPath = ensuredModel.modelPath;
  }


  // --- Toolchain preference ---
  // Prefer Metal toolchain on Apple Silicon macOS unless explicitly disabled.
  // env override:
  //   LEADAI_WHISPER_TOOLCHAIN=metal|cpu  (optional)
  const toolchainOverride = String(process.env.LEADAI_WHISPER_TOOLCHAIN || '').trim().toLowerCase();
  const canPreferMetal = (process.platform === 'darwin' && process.arch === 'arm64');
  const preferMetal =
    toolchainOverride === 'metal'
      ? true
      : toolchainOverride === 'cpu'
        ? false
        : (config?.preferMetalWhisper !== false && canPreferMetal);

  // --- Binary selection (handle multiple layouts) ---
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

  const baseDir = path.dirname(whisperDir);
  const cpuCandidates = [
    // Prefer the stable shipped toolchain first
    path.join(baseDir, 'whisper-static', 'bin', exe),
    path.join(process.cwd(), 'whisper-static', 'bin', exe),

    // Dev fallbacks
    path.join(whisperDir, 'build', 'bin', exe),
    path.join(whisperDir, 'bin', exe)
  ];
  const metalCandidates = [
    // Common repo layout: <repo>/whisper-static-metal
    path.join(baseDir, 'whisper-static-metal', 'bin', exe),
    path.join(process.cwd(), 'whisper-static-metal', 'bin', exe)
  ];
  const binaryCandidates = preferMetal
    ? [...metalCandidates, ...cpuCandidates]
    : [...cpuCandidates];
  const binaryPath = binaryCandidates.find(p => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) || binaryCandidates[0];

  // --- Preflight ---
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `❌ whisper-cli not found. Looked in:\n` +
      binaryCandidates.map(p => `  - ${p}`).join('\n') +
      `\n\nSet WHISPER_CPP_DIR to the directory containing models/ and build/bin/ (or bin/).`
    );
  }
  const chosenIsMetal = binaryPath.includes('whisper-static-metal');
  const cpuFallbackPath = cpuCandidates.find(p => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) || null;
  if (!fs.existsSync(modelPath)) {
    if (isPackaged) {
      throw whisperAssetService.createWhisperDependencyError(
        Object.assign(new Error(`Whisper model file is missing at ${modelPath}`), {
          code: 'ASSET_MISSING'
        }),
        {
          language: lang,
          installPath: modelPath
        }
      );
    }
    if (wantsMultilingual) {
      throw new Error(
        `❌ Multilingual Whisper model missing for language "${lang}".\n` +
        `Expected: ${modelPath}\n\n` +
        `Install it via whisper.cpp:\n` +
        `  cd whisper.cpp && ./models/download-ggml-model.sh base\n\n` +
        `Or place ggml-base.bin into: ${path.join(whisperDir, 'models')}`
      );
    }
    throw new Error(
      `❌ English Whisper model missing. Expected: ${modelPath}\n` +
      `Place ggml-base.en.bin into: ${path.join(whisperDir, 'models')}`
    );
  }
  const outputDir = config.outputPath;
  const filename = path.basename(filePath, path.extname(filePath));
  const results = [];
  const logDir = config.logPath || outputDir;

  const isWav = path.extname(filePath).toLowerCase() === '.wav';
  const jobTag = `job-${config.jobId || Date.now()}`;
  tempDir = ensureTempSubdir('transcribe', jobTag);

  throwIfAborted(signal);

  const inputPath = isWav ? filePath : path.join(tempDir, `${filename}-${Date.now()}.wav`);
  if (!isWav && !fs.existsSync(inputPath)) {
    debugLog('convert-to-wav', { inputPath });
    await convertToWav(filePath, inputPath, config.useAltTracks ? 1 : null, p => (currentProcess = p));
  }
  const extraArgs = [];
  if (config.whisperTask === 'translate') {
    extraArgs.push('--translate');
  }

  throwIfAborted(signal);
  let jsonData;
  try {
    jsonData = await runWhisperOnce({
      filePath,
      inputPath,
      outputDir,
      binaryPath,
      modelPath,
      config,
      extraArgs,
      setProcess: p => (currentProcess = p),
      signal
    });
  } catch (e) {
    // If the user cancelled, DO NOT trigger Metal→CPU fallback. Bail immediately.
    if (signal?.aborted) {
      try {
        cleanupRawJSONs(filePath, outputDir);
      } catch (err) {
        // Safe to continue: best-effort temp artifact cleanup on cancellation.
        console.warn('[transcribeEngine] cleanupRawJSONs failed after cancel:', err?.message || String(err));
      }
      throw makeAbortError('Transcription cancelled');
    }
    const canFallback = chosenIsMetal && cpuFallbackPath && cpuFallbackPath !== binaryPath;
    if (!canFallback) throw e;
    console.warn('⚠️ Whisper Metal toolchain failed; falling back to CPU toolchain:', e?.message || e);
    jsonData = await runWhisperOnce({
      filePath,
      inputPath,
      outputDir,
      binaryPath: cpuFallbackPath,
      modelPath,
      config,
      extraArgs,
      setProcess: p => (currentProcess = p),
      signal
    });
  }
  throwIfAborted(signal);
  // Remove raw Whisper JSON now so our writer can claim the canonical name.
  cleanupRawJSONs(filePath, outputDir);

  await prepareSegments(jsonData, filePath, config);
  const enrichedPath = writeEnrichedLog(jsonData, filePath, config, logDir);
  results.push(`📁 Enriched JSON Log saved → ${enrichedPath}`);

  const diarized = (config.diarization || config.localSpeakerDetection || config.detectSpeakers || config.includeSpeakerNames)
    ? (await runDiarization(inputPath).catch(() => []))
    : [];
  const wrapped = await prepareTranscription(jsonData, filePath, config, { engine: 'lead', diarized });

  // Optional: Translate final output into the UI-selected target language.
  // NOTE: This is post-processing translation (Translate section in UI), not Whisper's built-in
  // translate-to-English task. (That is controlled by config.whisperTask === 'translate'.)
  if (config.translation?.enabled) {
    const targetLabel = languageCodeToLabel(config.translation?.target);
    const effectiveKey = (config.apiKey || process.env.OPENAI_API_KEY || '').trim();
    if (!effectiveKey) {
      results.push('⚠️ Translation enabled but no OpenAI API key is configured. Skipping translation.');
    } else {
      try {
        const openai = new OpenAI({ apiKey: effectiveKey });
        const changed = await translateWrappedSegmentsInPlace(openai, wrapped, targetLabel, {
          signal,
          requestTimeoutMs
        });
        if (changed) results.push(`🌍 Translation applied → ${targetLabel}`);
        else results.push(`⚠️ Translation requested but produced no changes (target=${targetLabel}).`);
      } catch (e) {
        if (isAbortError(e)) throw makeAbortError('Transcription cancelled');
        if (e?.name === 'TimeoutError') throw e;
        results.push(`⚠️ Translation failed: ${e?.message || e}`);
      }
    }
  }

  // NEW: add indent/row audit into .final.json when enabled
  if (config.verboseQcLogs) {
    try {
      const useSccConstraints = config?.outputFormats?.scc === true;
      const audit = scc.computeCea608PlacementAudit(wrapped.segments, {
        // When SCC is selected, prefer SCC-scoped constraints so the audit reflects
        // what the SCC writer will actually do.
        maxCharsPerLine:
          (useSccConstraints ? config?.sccOptions?.maxCharsPerLine : config?.maxCharsPerLine) ?? 32,
        maxLinesPerBlock:
          (useSccConstraints ? config?.sccOptions?.maxLinesPerBlock : config?.maxLinesPerBlock) ?? 2,
        includeSpeakerNames: config.includeSpeakerNames ?? false,
        sccOptions: {
          alignment: 'left',
          rowPolicy: 'bottom2'
        }
      });
      // Attach compact audit per segment
      wrapped.segments?.forEach((seg, i) => {
        if (!seg || !audit?.[i]) return;
        seg.indentAudit = audit[i].lines; // [{index,row,indentNibble,columnStart,text}]
      });
      // Optionally record the policy used at the top level
      wrapped.qc = Object.assign({}, wrapped.qc, {
        cea608: {
          alignment: 'left',
          rowPolicy: 'bottom2',
          channel: 1,
          fields: ['index', 'row', 'indentNibble', 'columnStart', 'text']
        }
      });
    } catch (e) {
      console.warn('QC indent audit failed:', e);
    }
  }

  // If cancelled mid-pipeline, do not write any outputs.
  throwIfAborted(signal);

  // Single source of truth: final JSON will be written by outputWriters.writeFinalJSON (if selected).
  const outputLogs = await writeAllOutputs(wrapped, filePath, config);
  results.push(...outputLogs);

  if (!isWav && fs.existsSync(inputPath)) {
    fs.unlinkSync(inputPath);
  }

    // Burn-in is handled by outputWriters.writeAllOutputs()

    return results;
  } finally {
    if (tempDir && !keepTempArtifacts) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }

    try {
      unbindAbort();
    } catch (err) {
      console.warn('[transcribeEngine] abort unbind failed:', err?.message || String(err));
    }
  }
} // ✅ this closing brace is critical to end transcribeWithLocalWhisper

// ----------------------------------------
// 🐍 WhisperX (Python)
// ----------------------------------------
async function transcribeWithWhisperX(filePath, config) {
  const signal = config?.signal || null;
  const unbindAbort = bindAbort(signal, () => { if (currentProcess) killProcessTree(currentProcess); });
  const requestTimeoutMs = Number(config?.requestTimeoutMs) > 0
    ? Number(config.requestTimeoutMs)
    : DEFAULT_OPENAI_TIMEOUT_MS;

  const finalOutputDir = config.outputPath;
  const filename = path.basename(filePath, path.extname(filePath));
  const outFile = path.join(finalOutputDir, `${filename}.x.json`);

  const jobTag = `job-${config.jobId || Date.now()}`;
  const tempBase = ensureTempSubdir('whisperx', jobTag);
  const tempOutputDir = path.join(tempBase, filename);

  try {
    fs.mkdirSync(tempOutputDir, { recursive: true });
  } catch {
    // best-effort
  }

  const baseArgs = [
    '-m', 'whisperx',
    filePath,
    '--output_dir', tempOutputDir,
    '--output_format', 'json'
  ];

  if (config.language && config.language !== 'auto') baseArgs.push('--language', config.language);
  // 🔇 DO NOT let WhisperX attempt diarization; we use our own engine instead.
  // if (config.diarization || config.localSpeakerDetection) baseArgs.push('--diarize');
  if (config.whisperTask === 'translate') {
    baseArgs.push('--task', 'translate');
  }

  // --- DEVICE LOGIC ---
  const isMac = process.platform === 'darwin';
  let device = 'cpu';

  if (!isMac) {
    // PC (Windows/Linux)
    // detectAIComputeType() returns "cuda" when available
    device = detectAIComputeType() || 'cpu';
  }

  // CTranslate2 naming consistency
  const deviceFlag = device === 'metal' ? 'mps' : device;

  // --- COMPUTE TYPE ---
  let computeType = 'float32'; // safest
  const accuracy = config.accuracyMode || 'auto';
  if (accuracy === 'accurate') computeType = 'float32';
  else if (accuracy === 'fast') computeType = 'int8';

  const runWhisperXOnce = () => {
    const args = baseArgs.concat(['--device', deviceFlag, '--compute_type', computeType]);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(makeAbortError('Transcription cancelled'));
      const py = resolvePythonExecutable();
      const env = buildPythonEnvForWhisperX();

      // 🔎 Debug — keep runtime diagnostics minimal and non-sensitive.
      debugLog('whisperx-env', {
        ffmpegBinaryResolved: Boolean(env.FFMPEG_BINARY),
        ffprobeBinaryResolved: Boolean(env.FFPROBE_BINARY),
        ffmpegBinaryBasename: env.FFMPEG_BINARY ? path.basename(env.FFMPEG_BINARY) : null,
        ffprobeBinaryBasename: env.FFPROBE_BINARY ? path.basename(env.FFPROBE_BINARY) : null,
        pathEntryCount: typeof env.PATH === 'string' ? env.PATH.split(path.delimiter).filter(Boolean).length : 0
      });

      const proc = spawn(py, args, { env, detached: process.platform !== 'win32' });
      if (process.platform !== 'win32') proc.__leadaiProcessGroup = true;
      currentProcess = proc;

      let err = '';

      proc.stderr.on('data', d => err += d.toString());
      proc.stdout.on('data', () => {}); // Silence noise

      proc.on('error', e => {
        currentProcess = null;
        reject(e);
      });

      proc.on('close', async code => {
        currentProcess = null;

        if (signal?.aborted) {
          return reject(makeAbortError('Transcription cancelled'));
        }
        if (code !== 0) {
          try {
            fs.rmSync(tempBase, { recursive: true, force: true });
          } catch {}
          return reject(new Error(err || `WhisperX exited with code ${code}`));
        }

        // WhisperX always writes <filename>.json, move to .x.json
        const defaultOut = path.join(tempOutputDir, `${filename}.json`);
        try {
          if (signal?.aborted) throw makeAbortError('Transcription cancelled');

          if (!fs.existsSync(defaultOut)) {
            throw new Error('WhisperX JSON not found');
          }

          const tempFinal = `${outFile}.__temp__`;

          try {
            const dir = path.dirname(outFile);
            fs.mkdirSync(dir, { recursive: true });
          } catch {}

          if (signal?.aborted) throw makeAbortError('Transcription cancelled');

          fs.copyFileSync(defaultOut, tempFinal);
          renameReplaceSync(tempFinal, outFile);

          const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
          await prepareSegments(raw, filePath, config);

          // ✅ Use the same tokenless diarizer we wired for other engines
          const wantsDiar = (
            config.diarization ||
            config.localSpeakerDetection ||
            config.detectSpeakers ||
            config.includeSpeakerNames
          );

          let diarized = [];
          if (wantsDiar) {
            try {
              // WhisperX runs directly on the original media path
              diarized = await runDiarization(filePath);
            } catch (e) {
              console.warn('WhisperX diarization fallback (tokenless) failed:', e.message || e);
              diarized = [];
            }
          }

          const wrapped = await prepareTranscription(raw, filePath, config, {
            engine: 'whisperx',
            diarized
          });

          const statusLogs = [`📝 WhisperX JSON → ${outFile}`];

          // If cancelled mid-pipeline, do not write any additional outputs.
          throwIfAborted(signal);

          // Optional: Translate final output into the UI-selected target language.
          if (config.translation?.enabled) {
            const targetLabel = languageCodeToLabel(config.translation?.target);
            const effectiveKey = (config.apiKey || process.env.OPENAI_API_KEY || '').trim();
            if (!effectiveKey) {
              statusLogs.push('⚠️ Translation enabled but no OpenAI API key is configured. Skipping translation.');
            } else {
              try {
                const openai = new OpenAI({ apiKey: effectiveKey });
                const changed = await translateWrappedSegmentsInPlace(openai, wrapped, targetLabel, {
                  signal,
                  requestTimeoutMs
                });
                if (changed) statusLogs.push(`🌍 Translation applied → ${targetLabel}`);
                else statusLogs.push(`⚠️ Translation requested but produced no changes (target=${targetLabel}).`);
              } catch (e) {
                if (isAbortError(e)) throw makeAbortError('Transcription cancelled');
                if (e?.name === 'TimeoutError') throw e;
                statusLogs.push(`⚠️ Translation failed: ${e?.message || e}`);
              }
            }
          }

          const logs = await writeAllOutputs(wrapped, filePath, config);
          resolve([...statusLogs, ...logs]);
        } catch (e) {
          reject(new Error(`WhisperX post-processing failed: ${e.message}`));
        } finally {
          try {
            fs.rmSync(tempBase, { recursive: true, force: true });
          } catch {}
          try { unbindAbort(); } catch {}
        }
      });
    });
  };

  // Run exactly once; no fallback because device is guaranteed valid
  return await runWhisperXOnce();
}

// ----------------------------------------
// 🔁 Dispatch Logic
// ----------------------------------------
async function runEngine(engine, filePath, config) {
  switch (engine) {
    case 'whisper':
      return await transcribeWithWhisperAPI(filePath, config);
    case 'lead':
      return await transcribeWithLocalWhisper(filePath, config);
    case 'whisperx':
      return await transcribeWithWhisperX(filePath, config);
    default:
      throw new Error(`❌ Unsupported transcription engine: ${engine}`);
  }
}

function cancelCurrentProcess() {
  if (currentProcess && typeof currentProcess.kill === 'function') {
    killProcessTree(currentProcess);
  }
  currentProcess = null;
}

function generateSyncableScriptCSV(jsonResults, arg) {
  const opts = (typeof arg === 'number') ? { fps: arg } : (arg || {});
  const segments = Array.isArray(jsonResults.segments) ? jsonResults.segments : [];
  const fpsCandidates = [
    Number(opts.fps),
    Number(jsonResults.system?.fps)
  ];
  const fps = fpsCandidates.find(v => Number.isFinite(v) && v > 0) || 30;
  const includeSpeakers = opts.includeSpeakers ?? true;
  const includeTimecodes = opts.includeTimecodes ?? true;
  let timestampStyle = String(opts.timestampStyle || 'start-end').replace(/_/g, '-');
  if (!includeTimecodes) timestampStyle = 'none';
  const allowGrouping = Boolean(opts.groupBySpeaker) && timestampStyle !== 'every-line';
  const speakerStyle = opts.speakerStyle || 'title';
  const timecodeFormat = String(opts.timecodeFormat || 'ndf').toLowerCase();
  let dropPref;
  if (typeof opts.dropFrame === 'boolean') dropPref = opts.dropFrame;
  else if (timecodeFormat === 'df') dropPref = true;
  else if (timecodeFormat === 'ndf' || timecodeFormat === 'ms') dropPref = false;
  else dropPref = jsonResults.system?.dropFramePreferred ?? jsonResults.system?.dropFrame;
  const dropFrame = Boolean(dropPref && isDropFrameRate(fps));
  const tcStyle = timecodeFormat === 'ms' ? 'ms' : 'colon';
  const startOffset = normalizeOffset(opts.startTimecodeOffset, fps, dropFrame);
  const defaultTc = tcStyle === 'ms'
    ? '00:00:00,000'
    : dropFrame
      ? '00:00:00;00'
      : '00:00:00:00';
  const lines = ['Timecode,Speaker,Text'];

  const escapeCsv = value => String(value ?? '').replace(/"/g, '""');
  const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const resolveTime = (seg, field) => {
    const numeric = Number(seg?.[field]);
    if (Number.isFinite(numeric)) return numeric;
    const ms = seg?.timecodes?.ms?.[field];
    if (typeof ms === 'number') return ms / 1000;
    const tcLabel = seg?.timecodes?.df?.[field] || seg?.timecodes?.ndf?.[field];
    if (tcLabel) {
      const parsed = parseTimeMs(tcLabel, fps, dropFrame);
      if (Number.isFinite(parsed)) return parsed / 1000;
    }
    return null;
  };
  const formatTimeValue = (start, end) => {
    if (timestampStyle === 'none') return '';
    const withOffset = value => {
      if (!Number.isFinite(value)) return null;
      return Math.max(0, value + startOffset);
    };
    const startSec = withOffset(start);
    const endSec = withOffset(end);
    const startLabel = startSec != null
      ? formatTimecode(startSec, dropFrame, fps, tcStyle)
      : defaultTc;
    const endLabel = endSec != null
      ? formatTimecode(endSec, dropFrame, fps, tcStyle)
      : defaultTc;
    if (timestampStyle === 'start-end') return `${startLabel} - ${endLabel}`;
    return startLabel;
  };
  const formatSpeaker = name => {
    if (!name) return '';
    if (speakerStyle === 'caps') return String(name).toUpperCase();
    if (speakerStyle === 'title') {
      return String(name).replace(/\b\w/g, c => c.toUpperCase());
    }
    return String(name).trim();
  };

  let currentGroup = null;
  const flushGroup = () => {
    if (!currentGroup) return;
    const timeValue = formatTimeValue(currentGroup.start, currentGroup.end);
    const speakerValue = includeSpeakers ? currentGroup.displaySpeaker : '';
    const textValue = cleanText(currentGroup.text);
    lines.push(`"${escapeCsv(timeValue)}","${escapeCsv(speakerValue)}","${escapeCsv(textValue)}"`);
    currentGroup = null;
  };

  for (const segment of segments) {
    const text = cleanText(segment.text);
    const start = resolveTime(segment, 'start');
    const endRaw = resolveTime(segment, 'end');
    let speakerRaw = typeof segment.speaker === 'string' ? segment.speaker : '';
    speakerRaw = String(speakerRaw || '').trim();
    if (!speakerRaw && jsonResults.metadata?.autoSpeakerLabels && (includeSpeakers || allowGrouping)) {
      // Minimal fallback: don't invent alternation; keep a single "Speaker 1" label.
      speakerRaw = 'SPEAKER 1';
    }
    const speakerKey = speakerRaw || (includeSpeakers ? 'SPEAKER' : '');
    let displaySpeaker = includeSpeakers ? (speakerRaw || 'SPEAKER') : '';
    displaySpeaker = formatSpeaker(displaySpeaker);
    const entry = {
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(endRaw) ? endRaw : (Number.isFinite(start) ? start : null),
      speakerKey,
      displaySpeaker,
      text
    };

    if (allowGrouping && currentGroup && entry.speakerKey === currentGroup.speakerKey) {
      currentGroup.text = `${currentGroup.text} ${text}`.trim();
      if (Number.isFinite(entry.end)) currentGroup.end = entry.end;
    } else {
      flushGroup();
      currentGroup = entry;
    }
  }
  flushGroup();
  return lines.join('\n');
}

function _wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + word).length > maxChars) {
      lines.push(current.trim());
      current = '';
    }
    current += word + ' ';
  }
  if (current) lines.push(current.trim());
  return lines;
}

function _toSrtTimestamp(seconds) {
  const whole = Math.floor(seconds);
  let ms = Math.round((seconds - whole) * 1000);
  let sec = whole;
  if (ms === 1000) { sec += 1; ms = 0; }
  const pad2 = v => String(v).padStart(2, '0');
  const pad3 = v => String(v).padStart(3, '0');
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(ms)}`;
}

function _toVttTimestamp(seconds) {
  const whole = Math.floor(seconds);
  let ms = Math.round((seconds - whole) * 1000);
  let sec = whole;
  if (ms === 1000) { sec += 1; ms = 0; }
  const pad2 = v => String(v).padStart(2, '0');
  const pad3 = v => String(v).padStart(3, '0');
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
}

function generateSRT(segments, config = {}) {
  return generateSRTWriter(segments, config);
}

function generateVTT(segments, config = {}) {
  return generateVTTWriter(segments, config);
}


function generateFrameTimecodeTXT(segments, fps = 29.97, style = 'colon', dropFrame = false) {
  return segments
    .map(seg => {
      const startMs =
        Number.isFinite(Number(seg.start)) ? Number(seg.start) * 1000 :
        (typeof seg?.timecodes?.ms?.start === 'number' ? seg.timecodes.ms.start :
         parseTimeMs(seg?.timecodes?.df?.start || seg?.timecodes?.ndf?.start || '0', fps, null));
      const endMs =
        Number.isFinite(Number(seg.end)) ? Number(seg.end) * 1000 :
        (typeof seg?.timecodes?.ms?.end === 'number' ? seg.timecodes.ms.end :
         parseTimeMs(seg?.timecodes?.df?.end || seg?.timecodes?.ndf?.end || '0', fps, null));
      const tcStart = msToTC(startMs, fps, style, dropFrame);
      const tcEnd = msToTC(endMs, fps, style, dropFrame);
      const speaker = seg.speaker || 'SPEAKER';
      const txt = (seg.text || '').trim();
      return `[${tcStart} - ${tcEnd}] ${speaker}: ${txt}`;
    })
    .join('\n');
}

function generateSegmentTextWithTokenTiming(segments, format = 'FF') {
  const lines = [];

  const getTC = (tok, fmt) => {
    if (!tok?.timecodes) return (fmt === 'ms' ? '00:00:00,000' : (fmt === 'ff' ? '00:00:00;00' : '00:00:00:00'));
    if (fmt === 'ms') {
      const ms = tok.timecodes.ms?.start;
      return Number.isFinite(ms) ? msToTC(ms, 29.97, 'ms', false) : '00:00:00,000';
    }
    if (fmt === 'ff') return tok.timecodes.df?.start || '00:00:00;00';
    return tok.timecodes.ndf?.start || '00:00:00:00';
  };

  for (const seg of segments) {
    const tokens = (seg.tokens || []).filter(
      t => t?.text && !(t.text.startsWith('[') && t.text.endsWith(']'))
    );
    if (!tokens.length) continue;

    const start = getTC(tokens[0], format);
    const end = getTC(tokens[tokens.length - 1], format);
    const speaker = seg.speaker || 'SPEAKER';

    // Preserve original spacing as emitted by Whisper
    const text = tokens.map(t => t.text).join('').trim();

    lines.push(`[${start} - ${end}] ${speaker}: ${text}`);
  }

  return lines.join('\n');
}


function generateMarkersTXT(segments, fps = 29.97, style = 'colon', dropFrame = false) {
  return segments.map(seg => {
    const start = typeof seg.start === 'number'
      ? formatTimecode(seg.start, dropFrame, fps, style)
      : style === 'ms' ? '00:00:00,000' : '00:00:00:00';
    const label = (seg.text || '').replace(/\n/g, ' ').trim().slice(0, 60);
    return `${start}\t${label}`;
  }).join('\n');
}

function generateXML(segments, style = 'colon', fps = 29.97, dropFrame = false) {
  const xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>');
  xml.push('<transcription>');

  segments.forEach((seg, i) => {
    const start = formatTimecode(seg.start || 0, dropFrame, fps, style);
    const end = formatTimecode(seg.end || 0, dropFrame, fps, style);
    const speaker = seg.speaker || 'SPEAKER';
    const text = (seg.text || '').replace(/[<>&]/g, c => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;'
    }[c]) || c);
    xml.push(`  <event id="${i + 1}" start="${start}" end="${end}" speaker="${speaker}">${text}</event>`);
  });

  xml.push('</transcription>');
  return xml.join('\n');
}

async function burnInSubtitles(inputVideoPath, srtPath, outputDir) {
  const outName = `${path.basename(inputVideoPath, path.extname(inputVideoPath))}_burnin.mp4`;
  const outputFile = ensureUnique(path.join(outputDir, outName));

  return new Promise((resolve, reject) => {
    const esc = (p) => String(p)
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");
    const filter = `subtitles=${esc(srtPath)}:force_style='FontName=Arial,FontSize=22'`;
    const args = [
      '-y', '-i', inputVideoPath,
      '-vf', filter,
      '-c:v', detectBestEncoderSync(), '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '192k',
      outputFile
    ];

    debugLog('burn-in-command', { ffmpegPath, args });
    // Ensure burn-in uses the app-bundled ffmpeg/ffprobe (extra/bin or extra/ffmpeg)
    const proc = spawn(ffmpegPath, args, { env: withFfmpegEnv() });
    currentProcess = proc;
    let err = '';
    proc.stderr.on('data', d => (err += d.toString()));
    proc.on('error', errEvt => {
      currentProcess = null;
      reject(errEvt);
    });
    proc.on('close', code => {
      currentProcess = null;
      if (code === 0) {
        resolve(`🎬 Burn-in created → ${outputFile}`);
      } else {
        reject(new Error(`❌ Burn-in failed: ${err}`));
      }
    });
  });
}

function detectBestEncoderSync() {
  try {
    // Probe encoders with the same env used elsewhere for consistency
    const out = spawnSync(ffmpegPath, ['-encoders'], { encoding: 'utf8', env: withFfmpegEnv() }).stdout || '';
    if (/\bh264_videotoolbox\b/.test(out)) return 'h264_videotoolbox';
    if (/\bmpeg4\b/.test(out)) return 'mpeg4';
  } catch {}
  return 'mpeg4';
}

function parseTimecode(tc, fps = 30, dropFrameHint = null) {
  if (!tc) return 0;
  // Reuse the DF-aware parser from the formatter (returns ms)
  return parseTimeMs(tc, fps, dropFrameHint) / 1000;
}

function cleanupRawJSONs(filePath, outputDir) {
  const base = path.basename(filePath, path.extname(filePath));
  const rawPath = path.join(outputDir, `${base}.json`);
  const patchedPath = path.join(outputDir, `${base}.patched.json`);
  [rawPath, patchedPath].forEach(p => {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}

Object.assign(exported, {
  runEngine,
  cancelCurrentProcess,
  prepareTranscription,
  generateSyncableScriptCSV,
  generatePlainText,
  generateFrameTimecodeTXT,
  generateSegmentTextWithTokenTiming,
  generateMarkersTXT,
  runDiarization,
  injectSpeakersIntoSegments,
  addFullTimecodeMetadata,
  transcribeWithWhisperX,
  wrapToProfessionalFormat,
  parseTimecode,
  parseTime: parseTimeMs,
  msToTC,
  formatTimecodes,
  generateSRT,
  generateVTT,
  generateXML,
  generateSCC: scc.generateSCC,
  // 608 wrapping for UI previews and downstream helpers.
  // IMPORTANT: prefer the SAME 608 wrapper the MCC/SCC encoders use so preview == output.
  // Signature preserved for back-compat with older renderer call sites.
  wrap608: (text, maxChars = 32, maxLines = 2, wrapOpts = null) => {
    const cols = Math.max(1, Math.min(32, Math.trunc(Number(maxChars) || 32)));
    const lines = Math.max(1, Math.min(2, Math.trunc(Number(maxLines) || 2)));
    const wrap608 = (wrapOpts && typeof wrapOpts === 'object') ? { ...wrapOpts } : null;

    // For derived 608 from 708 text, explicit line breaks should be treated as SOFT by default.
    // Callers can override by passing { allowExplicitLineBreaks: true } in wrapOpts.
    const allowExplicitLineBreaks = (wrap608 && wrap608.allowExplicitLineBreaks != null)
      ? (wrap608.allowExplicitLineBreaks !== false)
      : false;

    try {
      // Prefer the rich 608 wrapper (smart two-line break selection + truncation metadata).
      if (typeof scc.wrapTextAndClamp608 === 'function') {
        return scc.wrapTextAndClamp608(String(text || ''), {
          maxCols: cols,
          maxLines: lines,
          allowExplicitLineBreaks,
          ...(wrap608 ? { wrap608 } : {})
        });
      }
    } catch {}

    // Last-resort fallback (legacy API)
    return scc.wrapTextAndClamp(String(text || ''), cols, lines);
  },
  // 608 wrapping with metadata (overflow/truncation) so the subtitle editor can warn without guessing.
  // Returns: { lines: string[], overflowed: boolean, truncated: boolean, usedExplicitBreaks?: boolean }
  wrap608WithMeta: (text, maxChars = 32, maxLines = 2, wrapOpts = null) => {
    const cols = Math.max(1, Math.min(32, Math.trunc(Number(maxChars) || 32)));
    const lines = Math.max(1, Math.min(2, Math.trunc(Number(maxLines) || 2)));
    const wrap608 = (wrapOpts && typeof wrapOpts === 'object') ? { ...wrapOpts } : null;

    // For derived 608 from 708 text, explicit line breaks should be treated as SOFT by default.
    // Callers can override by passing { allowExplicitLineBreaks: true } in wrapOpts.
    const allowExplicitLineBreaks = (wrap608 && wrap608.allowExplicitLineBreaks != null)
      ? (wrap608.allowExplicitLineBreaks !== false)
      : false;

    try {
      if (typeof scc.wrapTextAndClamp608WithMeta === 'function') {
        return scc.wrapTextAndClamp608WithMeta(String(text || ''), {
          maxCols: cols,
          maxLines: lines,
          allowExplicitLineBreaks,
          ...(wrap608 ? { wrap608 } : {})
        });
      }
    } catch {}

    // Fallback: return a meta-shaped object even if the rich wrapper isn't available.
    let outLines = [];
    try {
      if (typeof scc.wrapTextAndClamp608 === 'function') {
        const wrapped = scc.wrapTextAndClamp608(String(text || ''), {
          maxCols: cols,
          maxLines: lines,
          allowExplicitLineBreaks,
          ...(wrap608 ? { wrap608 } : {})
        });
        outLines = Array.isArray(wrapped) ? wrapped : [];
      } else {
        const legacy = scc.wrapTextAndClamp(String(text || ''), cols, lines);
        outLines = Array.isArray(legacy) ? legacy : [];
      }
    } catch {
      outLines = [];
    }

    return { lines: outLines, overflowed: false, truncated: false, usedExplicitBreaks: false };
  },
  // Phase 2: derived 608 compatibility track generation (with 608-only overrides).
  // Exposed for renderer previews so on-air 608 projection matches export/QC behavior.
  derive608TrackFromCanonical: scc.derive608TrackFromCanonical,
  computeCea608PlacementAudit: scc.computeCea608PlacementAudit,
  verifySCC: scc.verifySCC,
  pacForRow: scc.pacForRow,
  ctrl: scc.ctrl,
  build608WordsForPopOn: scc.build608WordsForPopOn,
  burnInSubtitles,
  formatTimecode,
  validateSccContentQc,
  validateMccContentQc,
  normalizeTranscriptionStructure
});
