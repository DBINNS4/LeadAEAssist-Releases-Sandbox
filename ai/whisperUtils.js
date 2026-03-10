// Utility functions for invoking Whisper CLI and handling output
const fs = require('fs');
const path = require('path');
const { renameReplaceSync } = require('../utils/fsSafe');
const { spawn } = require('child_process');
const { detectAIComputeType } = require('../utils/gpuEncoder');

function makeAbortError(message = 'Cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function killProcessTree(proc, opts = {}) {
  if (!proc || typeof proc.kill !== 'function') return;
  const pid = proc.pid;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 500;

  // Windows: best-effort kill process tree.
  if (process.platform === 'win32') {
    if (pid) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    }
    try { proc.kill(); } catch {}
    return;
  }

  // POSIX: if we spawned detached, we can safely kill the whole process group.
  const killGroup = !!proc.__leadaiProcessGroup && pid;
  try {
    if (killGroup) process.kill(-pid, 'SIGINT');
    else proc.kill('SIGINT');
  } catch {}

  // Escalate if still alive after a short grace.
  setTimeout(() => {
    try {
      if (proc.exitCode != null) return;
      if (killGroup) process.kill(-pid, 'SIGKILL');
      else proc.kill('SIGKILL');
    } catch {}
  }, graceMs);
}

function ensureUnique(p) {
  if (!fs.existsSync(p)) return p;
  const parsed = path.parse(p);
  let count = 1;
  let candidate;
  do {
    candidate = path.join(parsed.dir, `${parsed.name}(${count})${parsed.ext}`);
    count++;
  } while (fs.existsSync(candidate));
  return candidate;
}

async function binarySupportsArg(binaryPath, arg) {
  if (!binarySupportsArg._cache) binarySupportsArg._cache = new Map();
  const key = `${binaryPath}::${arg}`;
  if (binarySupportsArg._cache.has(key)) return binarySupportsArg._cache.get(key);
  const val = await new Promise(resolve => {
    const p = spawn(binaryPath, ['-h']);
    let out = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (out += d.toString()));
    p.on('close', () => resolve(out.includes(arg)));
    p.on('error', () => resolve(false));
  });
  binarySupportsArg._cache.set(key, val);
  return val;
}

async function runWhisperOnce({ filePath, inputPath, outputDir, binaryPath, modelPath, config, setProcess, extraArgs = [], signal = null }) {
  const filename = path.basename(filePath, path.extname(filePath));
  const jsonOut = path.join(outputDir, `${filename}.json`);
  const lang = String(config?.language || 'en').trim().toLowerCase() || 'en';
  const whisperArgs = [
    '-m', modelPath,
    '-f', inputPath,
    '-of', path.join(outputDir, filename),
    '-oj',
    '-l', lang,
    '--output-json-full',
    ...extraArgs
  ];

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Whisper CLI not found at ${binaryPath}. ` +
        'Set WHISPER_CPP_DIR or install the local whisper.cpp binary.'
    );
  }

  const device = detectAIComputeType();
  if (device !== 'cpu' && (await binarySupportsArg(binaryPath, '-ngl'))) {
    whisperArgs.push('-ngl', '999');
  }

  console.log(`🔊 Running Whisper JSON: ${binaryPath} ${whisperArgs.join(' ')}`);

  await new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (typeof setProcess === 'function') setProcess(null);
      if (err) reject(err);
      else resolve();
    };

    // Capture output so we can surface the real failure (SIGKILL, codesign, missing libs, etc.)
    // Spawn detached on POSIX so we can kill the whole process group safely on cancel.
    const proc = spawn(binaryPath, whisperArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    if (process.platform !== 'win32') proc.__leadaiProcessGroup = true;
    if (typeof setProcess === 'function') setProcess(proc);

    let out = '';
    let err = '';
    const CAP = 20000;
    const cap = (s) => (s.length > CAP ? s.slice(s.length - CAP) : s);

    proc.stdout.on('data', (d) => (out = cap(out + d.toString())));
    proc.stderr.on('data', (d) => (err = cap(err + d.toString())));

    const onAbort = () => {
      aborted = true;
      try { killProcessTree(proc); } catch {}
      // Best-effort cleanup of raw whisper output.
      try { if (fs.existsSync(jsonOut)) fs.unlinkSync(jsonOut); } catch {}
      finish(makeAbortError('Whisper cancelled'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      try { signal.addEventListener('abort', onAbort, { once: true }); } catch {}
    }

    proc.on('close', (code, signal) => {
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
      if (aborted) return finish(makeAbortError('Whisper cancelled'));
      if (code === 0) return finish();

      const tail = (err || out || '').trim();
      const sig = signal ? ` (signal ${signal})` : '';
      const extra = tail ? `\n\n${tail}` : '';
      return finish(new Error(`Whisper exited with code ${code}${sig}${extra}`));
    });

    proc.on('error', (err) => {
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
      if (aborted) return finish(makeAbortError('Whisper cancelled'));
      finish(err);
    });
  });

  if (!fs.existsSync(jsonOut)) {
    throw new Error(`❌ Expected output file missing: ${jsonOut}`);
  }
  return JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
}

function writeEnrichedLog(jsonData, filePath, config, logDir) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const baseName = path.basename(filePath, path.extname(filePath));
  const enrichedPath = path.join(logDir, `${baseName}.final-${timestamp}.json`);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.warn(`⚠️  Failed to create log directory ${logDir}:`, err);
  }
  fs.writeFileSync(enrichedPath, JSON.stringify(jsonData, null, 2));
  return enrichedPath;
}

function safeWriteFinalJSON(wrapped, filePath, outputDir) {
  const finalOut = path.join(
    outputDir,
    `${path.basename(filePath, path.extname(filePath))}.final.json`
  );
  const tempPath = `${finalOut}.__temp__`;

  try {
    const dir = path.dirname(finalOut);
    fs.mkdirSync(dir, { recursive: true });
  } catch {}

  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } catch {}

  fs.writeFileSync(tempPath, JSON.stringify(wrapped, null, 2));
  renameReplaceSync(tempPath, finalOut);
  return finalOut;
}

module.exports = {
  runWhisperOnce,
  writeEnrichedLog,
  safeWriteFinalJSON,
  ensureUnique
};
