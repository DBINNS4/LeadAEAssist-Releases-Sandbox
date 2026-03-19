const {
  sendLogMessage,
  writeLogToFile,
  createJobLogger,
  createJobUserLog,
  writeJobLogToFile,
  writeJobTextToFile
} = require('./logUtils');
const { copyFileWithProgress } = require('./fileUtils');
const { compareFilesByteByByte } = require('../utils/compare');
const { StageProgressManager } = require('../progressBridge');
const ProgressManager = require('../utils/progressManager');
const {
  getBlake3Hash,
  getSha256Hash,
  getMd5Hash,
  getXxHashHash
} = require('./hashUtils');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { moveReplace } = require('../utils/fsSafe');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { ffmpegPath, ffprobePath } = require('../utils/ffmpeg');
const net = require('net');
let electronApp = null;
try {
  electronApp = require('electron').app || null;
} catch {
  electronApp = null;
}

const localeMessagesCache = new Map();

function loadLocaleMessages(localeCode) {
  const normalized = String(localeCode || 'en').toLowerCase();
  if (localeMessagesCache.has(normalized)) return localeMessagesCache.get(normalized);
  const localePath = path.join(__dirname, '..', 'locales', `${normalized}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    localeMessagesCache.set(normalized, parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    localeMessagesCache.set(normalized, {});
  }
  return localeMessagesCache.get(normalized);
}

function resolveAdobeUtilitiesLocale(config = {}) {
  const raw = String(config.locale || process.env.LA_LOCALE || electronApp?.getLocale?.() || 'en').toLowerCase();
  return raw.split('-')[0] || 'en';
}

function formatAdobeUtilitiesMessage(key, params = {}, options = {}) {
  const locale = resolveAdobeUtilitiesLocale(options.config || options);
  const preferred = loadLocaleMessages(locale);
  const english = loadLocaleMessages('en');
  const template = preferred[key] || english[key] || key;
  return String(template).replace(/{{\s*([^{}\s]+)\s*}}/g, (_m, token) => (
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : ''
  ));
}

const fetchWithTimeout = async (url, options = {}, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetch = (...args) =>
      import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error(`Timeout after ${timeoutMs}ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

// Bind CEP forwarders for a given jobId and return a cleanup fn
function bindCepForwardersForJob(jobId, _config) {
  if (!global.cepBridge) return () => {};
  // OLD behavior: forward progress only; completion is emitted by finalizer

  const forward = msg => {
    try {
      const data = typeof msg === 'string' ? JSON.parse(msg) : msg;
      // Mirror progress to the queue so Electron UI stays in sync
      if (data?.type === 'queue-job-progress' && data.panel === 'adobe-utilities') {
        global.queue?.emit('job-progress', {
          id: jobId,
          panel: 'adobe-utilities',
          stage: data.stage,
          status: data.status,
          // Canonical fields (preferred)
          overall: data.overall,
          filePercent: data.filePercent,
          eta: data.eta,
          file: data.file,
          completed: data.completed,
          total: data.total,
          // Back-compat
          percent: data.percent,
          origin: data.origin,
          jobId: data.jobId
        });
        return;
      }
      // Do not emit job-complete here (OLD behavior defers to finalizer).
    } catch {
      /* ignore parse errors */
    }
  };

  const onComplete = data => forward(data);
  const onProgress = data => forward(data);

  global.cepBridge.on('queue-job-complete', onComplete);
  global.cepBridge.on('queue-job-progress', onProgress);
  global.cepBridge.on('message', forward); // fallback for legacy packets

  return () => {
    try { global.cepBridge?.off?.('queue-job-complete', onComplete); } catch {}
    try { global.cepBridge?.off?.('queue-job-progress', onProgress); } catch {}
    try { global.cepBridge?.off?.('message', forward); } catch {}
  };
}
// ───────────────────────────────────────────────────────────────
// Match‑Source support
// ───────────────────────────────────────────────────────────────
const MATCH_SOURCE_SENTINEL = 'match-source-ffmpeg';

function normalizeProxyPresetValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'match-source') {
    return MATCH_SOURCE_SENTINEL;
  }
  return trimmed;
}

function normalizeAdobeConfig(config = {}) {
  if (!config || typeof config !== 'object') return {};
  if (typeof config.proxyPreset === 'string' || typeof config.proxyPreset === 'number') {
    config.proxyPreset = normalizeProxyPresetValue(config.proxyPreset);
  }
  return config;
}

const LEGACY_MATCH_SOURCE_SENTINEL = 'match-source';
const isMatchSourcePreset = value =>
  value === MATCH_SOURCE_SENTINEL || value === LEGACY_MATCH_SOURCE_SENTINEL;

function fileExists(p) {
  try {
    return !!(p && fs.existsSync(p));
  } catch {
    return false;
  }
}

function isPrivateHostname(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host) return true;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
  if (host.endsWith('.local')) return true;

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (ipVersion === 6) {
    const normalized = host.split('%')[0];
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80')) return true;
  }

  return false;
}

function collectBasenameCollisions(pathMap) {
  const basenameMap = new Map();
  for (const [src, dest] of pathMap.entries()) {
    const base = path.basename(dest || src || '');
    if (!base) continue;
    if (!basenameMap.has(base)) basenameMap.set(base, new Set());
    basenameMap.get(base).add(src);
  }
  return Array.from(basenameMap.entries())
    .filter(([, sources]) => sources.size > 1)
    .map(([basename, sources]) => ({
      basename,
      sources: Array.from(sources)
    }));
}

function formatBasenameCollisionErrors(label, targetPath, collisions, config = {}) {
  if (!collisions.length) return [];
  const details = collisions
    .map(({ basename, sources }) => `• ${basename}\n  ${sources.join('\n  ')}`)
    .join('\n');
  const key = targetPath
    ? 'adobeUtilities.validation.basenameCollisionWithTarget'
    : 'adobeUtilities.validation.basenameCollision';
  const message = formatAdobeUtilitiesMessage(
    key,
    { label, targetPath, details },
    { config }
  );
  return [
    message
  ];
}

function validateN8nUrl(n8nUrl, opts = {}) {
  const allowPrivate = !!opts?.allowPrivate;
  const allowlist = opts?.allowlist;
  const trimmed = (n8nUrl || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      message: formatAdobeUtilitiesMessage('adobeUtilities.n8nValidationMissingUrl')
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      message: formatAdobeUtilitiesMessage('adobeUtilities.n8nValidationInvalidUrl')
    };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      valid: false,
      message: formatAdobeUtilitiesMessage('adobeUtilities.n8nValidationInvalidProtocol')
    };
  }

  if (!allowPrivate && isPrivateHostname(parsed.hostname)) {
    return {
      valid: false,
      message: formatAdobeUtilitiesMessage('adobeUtilities.n8nValidationPrivateDisallowed')
    };
  }

  const normalizedAllowlist = Array.isArray(allowlist)
    ? allowlist.map(entry => String(entry || '').trim()).filter(Boolean)
    : [];

  if (normalizedAllowlist.length) {
    const match = normalizedAllowlist.some(allowed =>
      parsed.hostname.toLowerCase() === allowed.toLowerCase()
    );
    if (!match) {
      return {
        valid: false,
        message: formatAdobeUtilitiesMessage('adobeUtilities.n8nValidationHostNotAllowed', {
          hosts: normalizedAllowlist.join(', ')
        })
      };
    }
  }

  return { valid: true, url: parsed.toString() };
}

const filterSupportCache = new Map();
let filterSupportProbePromise = null;

const execFileAsync = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function primeFilterSupportCache() {
  if (filterSupportProbePromise) return filterSupportProbePromise;
  filterSupportProbePromise = execFileAsync(
    ffmpegPath,
    ['-hide_banner', '-filters'],
    { encoding: 'utf8' }
  )
    .then(({ stdout }) => String(stdout || ''))
    .catch(() => '');
  return filterSupportProbePromise;
}

async function ffmpegSupportsFilter(name) {
  if (filterSupportCache.has(name)) {
    return filterSupportCache.get(name);
  }

  const output = await primeFilterSupportCache();
  const supported = output.indexOf(` ${name} `) !== -1;
  filterSupportCache.set(name, supported);
  return supported;
}

primeFilterSupportCache();

const createConcurrencyLimiter = maxConcurrency => {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= maxConcurrency) return;
    const item = queue.shift();
    if (!item) return;
    active += 1;
    item()
      .catch(() => {})
      .finally(() => {
        active -= 1;
        next();
      });
  };

  return fn =>
    new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject));
      next();
    });
};

async function probeProxyInputMeta(src) {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', src];
  const res = await execFileAsync(ffprobePath, args, { encoding: 'utf8' });
  const probe = JSON.parse(res.stdout || '{}');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const audioStreams = streams
    .filter(s => s.codec_type === 'audio')
    .map((s, i) => ({
      inIdx: i,
      ch: Number(s.channels) || 1,
      layout: typeof s.channel_layout === 'string' ? s.channel_layout : ''
    }));

  // Prefer container duration, then fallback to first video stream duration.
  let durationMs = 0;
  const durFormat = parseFloat(probe?.format?.duration);
  if (Number.isFinite(durFormat) && durFormat > 0) {
    durationMs = Math.round(durFormat * 1000);
  } else {
    const v = streams.find(s => s.codec_type === 'video');
    const durV = parseFloat(v?.duration);
    if (Number.isFinite(durV) && durV > 0) {
      durationMs = Math.round(durV * 1000);
    }
  }

  return { audioStreams, durationMs };
}

// 🔹 Active job tracking
const activeAdobeJobs = new Map();

function isAMEAvailable(pushLog) {
  try {
    if (process.platform === 'darwin') {
      const apps = fs.readdirSync('/Applications');
      const matches = apps.filter(a => String(a).toLowerCase().includes('adobe media encoder'));
      pushLog?.(`🔍 /Applications AME matches: ${JSON.stringify(matches)}`);
      return matches.length > 0;
    }
    if (process.platform === 'win32') {
      const base = 'C:/Program Files/Adobe';
      const dirs = fs.existsSync(base) ? fs.readdirSync(base) : [];
      const matches = dirs.filter(d => String(d).toLowerCase().includes('adobe media encoder'));
      pushLog?.(`🔍 C:/Program Files/Adobe AME matches: ${JSON.stringify(matches)}`);
      return matches.length > 0;
    }
    return false;
  } catch (err) {
    pushLog?.(`⚠️ isAMEAvailable error: ${err.message || err}`);
    return false;
  }
}

async function pathExists(p) {
  if (!p) return false;
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function validateAdobeConfig(config = {}) {
  config = normalizeAdobeConfig(config);
  const errors = [];

  const sources = Array.isArray(config.sources) ? config.sources : [];
  if (sources.length > 0) {
    const checks = await Promise.all(sources.map(pathExists));
    const missing = sources.filter((_, index) => !checks[index]);
    if (missing.length > 0) {
      const isMountedPath = p =>
        p?.startsWith?.('/Volumes/') || p?.startsWith?.('/media/') || p?.startsWith?.('/mnt/');
      const mountedMissing = missing.filter(isMountedPath);
      const localMissing = missing.filter(p => !isMountedPath(p));
      if (localMissing.length > 0) {
        errors.push(formatAdobeUtilitiesMessage(
          'adobeUtilities.validation.missingLocalFiles',
          { paths: localMissing.join('\n') },
          { config }
        ));
      }
      if (mountedMissing.length > 0) {
        errors.push(formatAdobeUtilitiesMessage(
          'adobeUtilities.validation.missingMountedFiles',
          { paths: mountedMissing.join('\n') },
          { config }
        ));
      }
    }

  } else {
    errors.push(formatAdobeUtilitiesMessage('adobeUtilities.validation.noSourcesSelected', {}, { config }));
  }

  const backupEnabled = !!(config.backup || config.dualCopy);
  const backupPath = typeof config.backupPath === 'string' ? config.backupPath.trim() : '';

  if (backupEnabled) {
    if (!backupPath) {
      errors.push(formatAdobeUtilitiesMessage('adobeUtilities.validation.noBackupDestinationSelected', {}, { config }));
    } else if (!(await pathExists(backupPath))) {
      errors.push(formatAdobeUtilitiesMessage(
        'adobeUtilities.validation.backupFolderMissing',
        { path: backupPath },
        { config }
      ));
    }
  }

  const destination = typeof config.destination === 'string' ? config.destination.trim() : '';
  const needsDestination = !config.importPremiere && !backupEnabled;
  const destinationExists = destination ? await pathExists(destination) : false;

  if (!destination) {
    if (needsDestination) {
      errors.push(formatAdobeUtilitiesMessage('adobeUtilities.validation.noDestinationSelected', {}, { config }));
    }
  } else if (!destinationExists) {
    errors.push(formatAdobeUtilitiesMessage(
      'adobeUtilities.validation.destinationFolderMissing',
      { path: destination },
      { config }
    ));
  }

  if (config.generateProxies) {
    const proxyDest = typeof config.proxyDest === 'string' ? config.proxyDest.trim() : '';
    const proxyDestExists = proxyDest ? await pathExists(proxyDest) : false;
    const hasValidProxyBase = proxyDestExists || destinationExists;

    if (!hasValidProxyBase) {
      errors.push(formatAdobeUtilitiesMessage('adobeUtilities.validation.proxyDestinationOrDestinationRequired', {}, { config }));
    }
  }

  // 🔁 New behavior:
  // • Proxy preset is OPTIONAL (we synthesize/patch per group).
  // • Proxy destination is auto-chosen/created later if missing.
  // Allow virtual preset "match-source-ffmpeg" without requiring a file on disk.
  if (config.generateProxies && config.proxyPreset && !isMatchSourcePreset(config.proxyPreset)) {
    if (!(await pathExists(config.proxyPreset))) {
      errors.push(formatAdobeUtilitiesMessage(
        'adobeUtilities.validation.proxyPresetMissing',
        { path: config.proxyPreset },
        { config }
      ));
    }
    const proxyWarnings = await validateProxyConfig(config);
    if (proxyWarnings.length) {
      errors.push(...proxyWarnings);
    }
  }

  if (sources.length) {
    if (destination) {
      const destPathMap = new Map();
      sources.forEach(src => {
        destPathMap.set(src, path.join(destination, path.basename(src)));
      });
      const destCollisions = collectBasenameCollisions(destPathMap);
      errors.push(
        ...formatBasenameCollisionErrors(
          formatAdobeUtilitiesMessage('adobeUtilities.destinationCollisionTitle', {}, { config }),
          destination,
          destCollisions,
          config
        )
      );
    }

    if (backupEnabled && backupPath) {
      const backupPathMap = new Map();
      sources.forEach(src => {
        backupPathMap.set(src, path.join(backupPath, path.basename(src)));
      });
      const backupCollisions = collectBasenameCollisions(backupPathMap);
      errors.push(
        ...formatBasenameCollisionErrors(
          formatAdobeUtilitiesMessage('adobeUtilities.backupCollisionTitle', {}, { config }),
          backupPath,
          backupCollisions,
          config
        )
      );
    }

    if (config.generateProxies) {
      const proxyBase = typeof config.proxyDest === 'string' && config.proxyDest.trim()
        ? config.proxyDest.trim()
        : destination;
      if (proxyBase) {
        let proxyExt = 'mov';
        if (config.proxyPreset && !isMatchSourcePreset(config.proxyPreset)) {
          const presetPath = String(config.proxyPreset || '').trim();
          if (presetPath && fileExists(presetPath)) {
            proxyExt = parseProxyPreset(presetPath)?.fileExt || proxyExt;
          }
        }
        const proxyPathMap = new Map();
        sources.forEach(src => {
          const base = path.basename(src, path.extname(src));
          const outName = `${base}_Proxy.${proxyExt}`;
          proxyPathMap.set(src, path.join(proxyBase, outName));
        });
        const proxyCollisions = collectBasenameCollisions(proxyPathMap);
        errors.push(
          ...formatBasenameCollisionErrors(
            formatAdobeUtilitiesMessage('adobeUtilities.proxyCollisionTitle', {}, { config }),
            proxyBase,
            proxyCollisions,
            config
          )
        );
      }
    }
  }

  return errors;
}

async function validateProxyConfig(config) {
  config = normalizeAdobeConfig(config);
  const errors = [];
  if (!config.generateProxies || !config.proxyPreset) return errors;

  let presetXml;
  try {
    presetXml = fs.readFileSync(config.proxyPreset, 'utf8');
  } catch {
    errors.push(formatAdobeUtilitiesMessage('adobeUtilities.validation.proxyPresetLoadFailed', {}, { config }));
    return errors;
  }

  const width = parseInt(
    /<VideoFrameWidth>(\d+)<\/VideoFrameWidth>/.exec(presetXml)?.[1] || 0,
    10
  );
  const height = parseInt(
    /<VideoFrameHeight>(\d+)<\/VideoFrameHeight>/.exec(presetXml)?.[1] || 0,
    10
  );
  const fps = /<FrameRate>([\d.]+)<\/FrameRate>/.exec(presetXml)?.[1];
  const channels = parseInt(
    /<AudioChannels>(\d+)<\/AudioChannels>/.exec(presetXml)?.[1] || 0,
    10
  );
  const fileExt =
    /<FileExt>([^<]+)<\/FileExt>/.exec(presetXml)?.[1] ||
    /<FileExtension>([^<]+)<\/FileExtension>/.exec(presetXml)?.[1];

  if (fileExt && !['mov', 'mp4'].includes(fileExt.toLowerCase())) {
    errors.push(formatAdobeUtilitiesMessage(
      'adobeUtilities.validation.proxyInvalidOutputFormat',
      { fileExt },
      { config }
    ));
  }

  const execFileAsync = (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout, stderr) => {
        if (error) {
          const err = new Error(stderr || error.message);
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  const runWithConcurrency = async (items, limit, worker) => {
    const queue = items.slice();
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) break;
        await worker(next);
      }
    });
    await Promise.all(runners);
  };

  const sources = Array.isArray(config.sources) ? config.sources : [];
  const MAX_SOURCES_TO_PROBE = 100;
  const PROBE_CONCURRENCY = 3;
  const MAX_CRITICAL_ERRORS = 5;
  const sampledSources =
    sources.length > MAX_SOURCES_TO_PROBE
      ? sources.slice(0, MAX_SOURCES_TO_PROBE)
      : sources;
  let criticalErrors = 0;

  await runWithConcurrency(sampledSources, PROBE_CONCURRENCY, async src => {
    if (criticalErrors >= MAX_CRITICAL_ERRORS) return;

    let probe;
    try {
      const args = [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_streams',
        src
      ];
      const res = await execFileAsync(ffprobePath, args, { encoding: 'utf8' });
      probe = JSON.parse(res.stdout);
    } catch {
      errors.push(formatAdobeUtilitiesMessage(
        'adobeUtilities.validation.sourceMediaReadFailed',
        { path: src },
        { config }
      ));
      criticalErrors += 1;
      return;
    }

    const videoStream = probe.streams?.find(s => s.codec_type === 'video');
    const audioStream = probe.streams?.find(s => s.codec_type === 'audio');
    if (videoStream && width && height) {
      const sourceRatio = videoStream.width / videoStream.height;
      const presetRatio = width / height;
      if (Math.abs(sourceRatio - presetRatio) > 0.01) {
        errors.push(
          formatAdobeUtilitiesMessage(
            'adobeUtilities.validation.aspectRatioMismatch',
            {
              basename: path.basename(src),
              sourceWidth: videoStream.width,
              sourceHeight: videoStream.height,
              proxyWidth: width,
              proxyHeight: height
            },
            { config }
          )
        );
      }
    }

    if (videoStream && fps) {
      const [num, den] = (videoStream.avg_frame_rate || '0/1').split('/');
      const sourceFps =
        den && den !== '0'
          ? parseFloat(num) / parseFloat(den)
          : parseFloat(num);
      if (Math.abs(parseFloat(fps) - sourceFps) > 0.01) {
        errors.push(
          formatAdobeUtilitiesMessage(
            'adobeUtilities.validation.frameRateMismatch',
            {
              basename: path.basename(src),
              sourceFps,
              proxyFps: fps
            },
            { config }
          )
        );
      }
    }

    if (channels && audioStream && channels !== audioStream.channels) {
      errors.push(
        formatAdobeUtilitiesMessage(
          'adobeUtilities.validation.audioChannelMismatch',
          {
            basename: path.basename(src),
            sourceChannels: audioStream.channels,
            proxyChannels: channels
          },
          { config }
        )
      );
    }
  });

  if (sources.length > sampledSources.length) {
    errors.push(formatAdobeUtilitiesMessage(
      'adobeUtilities.validation.proxyValidationSampledSources',
      { count: sampledSources.length, total: sources.length },
      { config }
    ));
  }

  if (criticalErrors >= MAX_CRITICAL_ERRORS) {
    errors.push(formatAdobeUtilitiesMessage('adobeUtilities.validation.proxyValidationStoppedEarly', {}, { config }));
  }

  return errors;
}

function _getActiveStages(cfg) {
  const stages = [];

  if (cfg.destination) {
    stages.push({ key: 'copy', weight: 0.4, label: formatAdobeUtilitiesMessage('adobeUtilities.stage.copyingFiles', {}, { config: cfg }) });
  }

  if (cfg.importPremiere) {
    stages.push({ key: 'import', weight: 0.05, label: formatAdobeUtilitiesMessage('adobeUtilities.stage.importingMedia', {}, { config: cfg }) });
  }

  if (cfg.createBins) {
    stages.push({ key: 'bins', weight: 0.05, label: formatAdobeUtilitiesMessage('adobeUtilities.stage.creatingBins', {}, { config: cfg }) });
  }

  if (cfg.generateProxies) {
    stages.push({ key: 'proxies', weight: 0.5, label: formatAdobeUtilitiesMessage('adobeUtilities.stage.generatingProxies', {}, { config: cfg }) });
  }

  const total = stages.reduce((s, st) => s + st.weight, 0) || 1;
  stages.forEach(st => (st.weight = st.weight / total));

  return stages;
}

// ✅ Finder-style proxy collector with source name matching (bounded scan)
async function collectProxyFiles(proxyDest, sourceList = [], options = {}) {
  if (!proxyDest || typeof proxyDest !== 'string') return { found: [], mapped: [] };

  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, options.maxDepth) : 2;
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(0, options.maxFiles) : 2000;
  const log = typeof options.log === 'function' ? options.log : null;

  let limitLogged = false;
  const items = await scanProxyDest(proxyDest, maxDepth, {
    maxFiles,
    onLimit: info => {
      if (limitLogged) return;
      limitLogged = true;
      log?.(`⚠️ Proxy scan capped at ${info.maxFiles} files in ${proxyDest}.`);
    }
  });

  const found = items.map(item => item.path);

  const mapped = [];
  const sources = sourceList.map(source => {
    const base = path.basename(source, path.extname(source));
    return {
      base,
      key: base.toLowerCase()
    };
  });
  const proxies = found.map(proxy => {
    const base = path.basename(proxy, path.extname(proxy));
    return {
      base,
      key: base.toLowerCase(),
      proxy
    };
  });
  const proxyByBase = new Map();
  const proxyByStripped = new Map();
  for (const proxy of proxies) {
    const list = proxyByBase.get(proxy.key) || [];
    list.push(proxy);
    proxyByBase.set(proxy.key, list);

    if (proxy.base.toLowerCase().endsWith('_proxy')) {
      const stripped = proxy.base.slice(0, -6);
      const strippedKey = stripped.toLowerCase();
      const strippedList = proxyByStripped.get(strippedKey) || [];
      strippedList.push(proxy);
      proxyByStripped.set(strippedKey, strippedList);
    }
  }

  for (const source of sources) {
    let matchList = proxyByBase.get(source.key);
    if (matchList?.length) {
      const match = matchList.shift();
      mapped.push({ original: source.base, proxy: match.proxy });
      continue;
    }

    matchList = proxyByStripped.get(source.key);
    if (matchList?.length) {
      const match = matchList.shift();
      mapped.push({ original: source.base, proxy: match.proxy });
    }
  }

  return { found, mapped };
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg fallback utilities
// ─────────────────────────────────────────────────────────────────────────────

const PROXY_FILE_EXT_RE = /\.(mov|mp4|mxf)$/i;
const PROXY_NAME_RE = /^(.*)_Proxy\.(mov|mp4|mxf)$/i;

function jitterMs(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(a, Number(max) || a);
  return Math.floor(a + Math.random() * (b - a + 1));
}

async function scanProxyDest(proxyDest, maxDepth = 1, options = {}) {
  const out = [];
  if (!proxyDest || typeof proxyDest !== 'string') return out;

  const root = proxyDest;
  const seen = new Set();
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(0, options.maxFiles) : 2000;
  const maxDepthGuard = Number.isFinite(maxDepth) ? Math.max(0, maxDepth) : 1;
  const maxConcurrency = Number.isFinite(options.maxConcurrency)
    ? Math.max(1, options.maxConcurrency)
    : 8;
  const onLimit = typeof options.onLimit === 'function' ? options.onLimit : null;
  let limitHit = false;

  const queue = [{ dir: root, depth: 0 }];

  const worker = async () => {
    while (queue.length && !limitHit) {
      const next = queue.shift();
      if (!next) break;
      const { dir, depth } = next;

      if (!dir || depth > maxDepthGuard) continue;

      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const ent of entries) {
        if (limitHit) break;

        const full = path.join(dir, ent.name);
        if (seen.has(full)) continue;
        seen.add(full);

        if (ent.isDirectory()) {
          if (depth < maxDepthGuard) {
            queue.push({ dir: full, depth: depth + 1 });
          }
          continue;
        }

        if (!ent.isFile()) continue;
        if (!PROXY_FILE_EXT_RE.test(ent.name)) continue;

        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }

        const m = ent.name.match(PROXY_NAME_RE);
        const base = m?.[1] || null;

        out.push({
          path: full,
          name: ent.name,
          base,
          size: st?.size || 0,
          mtimeMs: st?.mtimeMs || 0,
        });

        if (!limitHit && out.length >= maxFiles) {
          limitHit = true;
          onLimit?.({ type: 'fileCap', maxFiles, dir, maxDepth: maxDepthGuard });
          break;
        }
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrency, Math.max(1, queue.length)) },
    () => worker()
  );

  await Promise.all(workers);
  return out;
}

async function buildProxyIndex(proxyDest) {
  const items = await scanProxyDest(proxyDest, 1, { maxFiles: 2000 });
  const byBase = new Map();
  let totalBytes = 0;
  let newestMtime = 0;

  for (const it of items) {
    totalBytes += it.size || 0;
    newestMtime = Math.max(newestMtime, it.mtimeMs || 0);
    if (!it.base) continue;

    const prev = byBase.get(it.base);
    if (
      !prev ||
      (it.size || 0) > (prev.size || 0) ||
      ((it.size || 0) === (prev.size || 0) && (it.mtimeMs || 0) > (prev.mtimeMs || 0))
    ) {
      byBase.set(it.base, it);
    }
  }

  return {
    byBase,
    snapshot: {
      fileCount: items.length,
      totalBytes,
      newestMtime,
    },
    items,
  };
}

async function resolveExistingProxyPairsForSources(sources, proxyDest, preferredExt = null) {
  const srcs = Array.isArray(sources) ? sources : [];
  const idx = await buildProxyIndex(proxyDest);
  const pairs = [];
  const missingSources = [];

  const ext = typeof preferredExt === 'string' ? preferredExt.replace(/^\./, '') : '';

  for (const src of srcs) {
    const base = path.basename(String(src || '')).replace(/\.[^/.]+$/, '');
    let proxyPath = null;

    // If we know the preset’s output extension, try that exact path first
    if (ext) {
      const candidate = path.join(proxyDest, `${base}_Proxy.${ext}`);
      try {
        await fsp.access(candidate, fs.constants.F_OK);
        proxyPath = candidate;
      } catch {
        // ignore
      }
    }

    // Otherwise fall back to whatever we can find in the folder scan
    if (!proxyPath) {
      const best = idx.byBase.get(base);
      if (best?.path) proxyPath = best.path;
    }

    if (proxyPath) {
      pairs.push({ original: src, proxy: proxyPath });
    } else {
      missingSources.push(src);
    }
  }

  return {
    pairs,
    missingSources,
    snapshot: idx.snapshot,
  };
}

async function isAdobeMediaEncoderRunning(timeoutMs = 4000) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      const out = String(stdout || '');
      return /"Adobe Media Encoder/i.test(out) || /Adobe Media Encoder\.exe/i.test(out);
    }

    // macOS + Linux: best-effort process list
    const cmd = process.platform === 'darwin' ? 'ps' : 'ps';
    const args = process.platform === 'darwin' ? ['-ax', '-o', 'comm='] : ['-A', '-o', 'comm='];
    const { stdout } = await execFileAsync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
    const out = String(stdout || '');
    return /Adobe Media Encoder/i.test(out);
  } catch {
    return null;
  }
}

function formatVerificationLabel(method = 'none') {
  switch ((method || '').toLowerCase()) {
    case 'bytecompare':
      return 'Byte Compare';
    case 'blake3':
      return 'BLAKE3';
    case 'sha256':
      return 'SHA-256';
    case 'md5':
      return 'MD5';
    case 'xxhash64':
      return 'xxHash64';
    default:
      return 'None';
  }
}

async function computeHashForMethod(filePath, method) {
  const normalized = (method || '').toLowerCase();
  switch (normalized) {
    case 'blake3':
      return getBlake3Hash(filePath);
    case 'sha256':
      return getSha256Hash(filePath);
    case 'md5':
      return getMd5Hash(filePath);
    case 'xxhash64':
      return getXxHashHash(filePath);
    default:
      return null;
  }
}

function parseProxyPreset(presetPath) {
  const meta = { fileExt: 'mov' };
  if (!presetPath) return meta;

  try {
    const presetXml = fs.readFileSync(presetPath, 'utf8');
    const widthMatch =
      /<VideoFrameWidth>(\d+)<\/VideoFrameWidth>/i.exec(presetXml) ||
      /<FrameWidth>(\d+)<\/FrameWidth>/i.exec(presetXml);
    const heightMatch =
      /<VideoFrameHeight>(\d+)<\/VideoFrameHeight>/i.exec(presetXml) ||
      /<FrameHeight>(\d+)<\/FrameHeight>/i.exec(presetXml);
    const fpsMatch =
      /<FrameRate>([\d.]+)<\/FrameRate>/i.exec(presetXml) ||
      /<FramesPerSecond>([\d.]+)<\/FramesPerSecond>/i.exec(presetXml);
    const channelMatch = /<AudioChannels>(\d+)<\/AudioChannels>/i.exec(presetXml);
    const extMatch =
      /<FileExt>([^<]+)<\/FileExt>/i.exec(presetXml) ||
      /<FileExtension>([^<]+)<\/FileExtension>/i.exec(presetXml);

    if (widthMatch) meta.width = parseInt(widthMatch[1], 10) || undefined;
    if (heightMatch) meta.height = parseInt(heightMatch[1], 10) || undefined;
    if (fpsMatch) meta.fps = parseFloat(fpsMatch[1]);
    if (channelMatch) meta.channels = parseInt(channelMatch[1], 10) || undefined;
    if (extMatch && extMatch[1]) {
      meta.fileExt = extMatch[1].replace(/^\./, '') || meta.fileExt;
    }
  } catch {
    // ignore parse errors and fall back to defaults
  }

  return meta;
}

function spawnFFmpegWithSignal(args, outputPath, signal, opts = {}) {
  const onProgressLine = typeof opts.onProgressLine === 'function' ? opts.onProgressLine : null;

  return new Promise((resolve, reject) => {
    let lastLine = '';
    const lines = [];
    let stdoutBuf = '';
    const finalArgs = [...args, outputPath];
    const proc = spawn(ffmpegPath, finalArgs);

    const cleanup = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      }
    };

    const onAbort = () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      cleanup();
      reject(new Error('Proxy generation cancelled'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        signal.addEventListener('abort', onAbort, { once: true });
      } catch {}
    }

    // FFmpeg "-progress pipe:1" emits key=value lines on stdout.
    if (onProgressLine && proc.stdout) {
      proc.stdout.on('data', data => {
        try {
          stdoutBuf += data.toString();
          const parts = stdoutBuf.split(/\r?\n/);
          stdoutBuf = parts.pop() || '';
          for (const line of parts) {
            const trimmed = String(line || '').trim();
            if (!trimmed) continue;
            try { onProgressLine(trimmed); } catch {}
          }
        } catch {}
      });
    }

    proc.stderr.on('data', data => {
      const s = data.toString();
      lastLine = s.trim() || lastLine;
      lines.push(s.trim());
    });

    proc.on('error', err => {
      cleanup();
      reject(err);
    });

    proc.on('close', code => {
      cleanup();
      if (code !== 0) {
        const tail = lines.slice(-25).join('\n');
        reject(new Error(`FFmpeg exited with code ${code}.\n${tail || lastLine || 'Unknown error'}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

async function generateProxiesWithFFmpeg(groupCfg, pushLog, generatedProxies = []) {
  const sources = Array.isArray(groupCfg.sources) ? groupCfg.sources : [];
  if (!sources.length) return [];

  // Skip XML preset parsing in Match-Source (FFMPEG) mode
  let meta = {};
  if (groupCfg.proxyPreset && groupCfg.proxyPreset !== MATCH_SOURCE_SENTINEL) {
    meta = parseProxyPreset(groupCfg.proxyPreset);
  } else {
    meta = {}; // dynamic path: probe each file directly
  }
  const ext = 'mov';
  const isMov = ext === 'mov';
  const total = sources.length;
  const pairs = [];

  const ffmpegLogLevel = (() => {
    const explicit = process.env.LEADAE_FFMPEG_LOGLEVEL || process.env.FFMPEG_LOGLEVEL;
    const debug = String(process.env.DEBUG_FFMPEG || '').toLowerCase();
    if (debug === '1' || debug === 'true' || debug === 'yes') return 'verbose';
    if (explicit) return String(explicit);
    return 'error';
  })();

  const padSupported = await ffmpegSupportsFilter('pad');
  if (meta.width && meta.height && !padSupported) {
    pushLog?.('⚠️ FFmpeg pad filter is unavailable; proxies will be scaled without padding.');
  }

  const emitProgress = (data = {}) => {
    const overall = (typeof data.overall === 'number') ? data.overall : data.percent;
    const payload = {
      id: groupCfg.jobId,
      jobId: groupCfg.jobId, // helps ID matching
      panel: 'adobe-utilities',
      stage: 'proxies',
      status: data.status || 'active',
      origin: data.origin || 'ffmpeg',
      engine: data.engine || 'ffmpeg',
      overall,
      filePercent: data.filePercent,
      eta: data.eta,
      file: data.file,
      completed: data.completed,
      total: data.total,
      percent: overall
    };
    // Electron UI
    global.queue?.emit('job-progress', payload);
    // CEP panel (so the checklist updates in FFmpeg mode too)
    try {
      global.cepBridge?.broadcast({ type: 'queue-job-progress', ...payload });
    } catch {}
  };

  emitProgress({ overall: 0, filePercent: 0, status: 'start' });
  const probeFailures = [];
  const probeResults = new Map();
  const probeLimit = createConcurrencyLimiter(3);

  await Promise.all(
    sources.map(src =>
      probeLimit(async () => {
        try {
          const { audioStreams, durationMs } = await probeProxyInputMeta(src);
          probeResults.set(src, { audioStreams, durationMs, probeFailed: false });
        } catch (err) {
          probeFailures.push({ src, err });
          probeResults.set(src, { audioStreams: [], durationMs: 0, probeFailed: true });
        }
      })
    )
  );

  if (probeFailures.length) {
    pushLog?.(
      `⚠️ FFprobe failed for ${probeFailures.length} file(s); using safe fallback audio mapping where needed.`
    );
  }

  const allDurations = sources
    .map(src => probeResults.get(src)?.durationMs || 0)
    .filter(d => d > 0)
    .sort((a, b) => a - b);
  const medianDurationMs = (() => {
    if (!allDurations.length) return 0;
    const mid = Math.floor(allDurations.length / 2);
    return allDurations.length % 2 === 0
      ? Math.round((allDurations[mid - 1] + allDurations[mid]) / 2)
      : allDurations[mid];
  })();
  const fallbackDurationMs = medianDurationMs || 1000;
  const durationsBySource = new Map(
    sources.map(src => {
      const dur = probeResults.get(src)?.durationMs || 0;
      return [src, dur > 0 ? dur : fallbackDurationMs];
    })
  );
  const totalDurationMs = sources.reduce((sum, src) => sum + (durationsBySource.get(src) || 0), 0);

  const progressManager = new ProgressManager(totalDurationMs, 250, 'time');
  progressManager.setTotalFiles(total);

  const onStreamProgress = e => {
    emitProgress({
      overall: e.overall,
      filePercent: e.percent,
      eta: e.eta,
      file: e.file,
      completed: e.completedFiles,
      total: e.totalFiles,
      status: 'active'
    });
  };
  const onOverallProgress = e => {
    emitProgress({
      overall: e.overall,
      eta: e.eta,
      completed: e.completedFiles,
      total: e.totalFiles,
      status: 'active'
    });
  };
  const onFileComplete = e => {
    emitProgress({
      file: e.file,
      filePercent: 100,
      completed: e.completedFiles,
      total: e.totalFiles,
      status: 'active'
    });
  };

  progressManager.on('stream-progress', onStreamProgress);
  progressManager.on('overall-progress', onOverallProgress);
  progressManager.on('file-complete', onFileComplete);

  try {
    for (let i = 0; i < total; i++) {
      if (groupCfg.signal?.aborted) throw new Error('Proxy generation cancelled');

      const src = sources[i];
      const base = path.basename(src).replace(/\.[^/.]+$/, '');
      const outName = `${base}_Proxy.${ext}`;
      const outputPath = path.join(groupCfg.proxyDest, outName);

      pushLog?.(`🎞 Generating proxy via FFmpeg: ${path.basename(src)} → ${outName}`);

      const durationMs = durationsBySource.get(src) || fallbackDurationMs;
      const streamId = `${i}`;
      let lastOutTimeMs = 0;
      progressManager.startFile(streamId, src, durationMs);

      // Probe per-source audio layout (preserve DISCRETE track parity)
      const probeEntry = probeResults.get(src);
      const audioStreams = Array.isArray(probeEntry?.audioStreams)
        ? probeEntry.audioStreams
        : [];
      const probeFailed = !!probeEntry?.probeFailed;
      const audioChannels = probeFailed
        ? 2
        : audioStreams.reduce((sum, s) => sum + Math.max(1, s.ch), 0);

      const filters = [];
      if (meta.width && meta.height) {
        filters.push(
          `scale=${meta.width}:${meta.height}:force_original_aspect_ratio=decrease`
        );
        if (padSupported) {
          filters.push(`pad=${meta.width}:${meta.height}:(ow-iw)/2:(oh-ih)/2`);
        }
      } else if (meta.width) {
        filters.push(`scale=${meta.width}:-2`);
      }

      const filterStr = filters.join(',');
      const args = ['-nostats', '-loglevel', ffmpegLogLevel, '-progress', 'pipe:1', '-y', '-i', src];
      if (filterStr) {
        args.push('-vf', filterStr);
      }
      if (meta.fps) {
        args.push('-r', String(meta.fps));
      }

      // Ensure deterministic stream selection and audio characteristics
      args.push('-map', '0:v:0');
      if (probeFailed) {
        args.push('-map', '0:a?');
      } else if (!audioStreams.length) {
        args.push('-an');
      } else {
        // Map every source audio stream 1:1 to the proxy and keep per-stream channel counts.
        // Preserves discrete layouts: mono↔mono, stereo↔stereo, dual‑mono↔dual‑mono, 8×mono↔8×mono.
        audioStreams.forEach((_s, j) => {
          args.push('-map', `0:a:${j}`);
          args.push(`-c:a:${j}`, 'pcm_s16le');
          args.push(`-ar:a:${j}`, '48000');
          args.push(`-ac:a:${j}`, String(Math.max(1, _s.ch)));
        });
      }

      if (isMov) {
        // ProRes Proxy w/ 10-bit 422 in MOV
        args.push('-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le');
        if (probeFailed) {
          args.push('-c:a', 'pcm_s16le', '-ar', '48000');
        }
        // Per‑stream audio options already added above (or -an if none)
        args.push('-f', 'mov'); // explicit container
      } else {
        // Use macOS hardware encoder present in FFmpeg build
        args.push('-c:v', 'h264_videotoolbox');
        if (meta.width && meta.height) {
          const mp = (meta.width * meta.height) / 1e6;
          const targetMbps = Math.max(2, Math.min(10, mp * 4));
          args.push('-b:v', `${Math.round(targetMbps)}M`);
        } else {
          args.push('-q:v', '50');
        }
        args.push('-pix_fmt', 'yuv420p');
        if (audioChannels > 0) {
          args.push(
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-ar',
            '48000',
            '-ac',
            String(Math.min(2, audioChannels))
          );
        } else {
          args.push('-an');
        }
      }

      // Log the full command for troubleshooting
      try {
        const printable = [ffmpegPath, ...args, outputPath]
          .map(s => (/\s/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : s))
          .join(' ');
        pushLog?.(`🧪 FFmpeg command:\n${printable}`);
      } catch {}

      const updateProgressFromOutTimeMs = outTimeMs => {
        if (!Number.isFinite(outTimeMs)) return;
        const clamped = Math.min(durationMs, Math.max(0, outTimeMs));
        const delta = Math.max(0, clamped - lastOutTimeMs);
        if (delta > 0) {
          progressManager.updateStream(streamId, delta);
          lastOutTimeMs = clamped;
        }
      };

      const parseTimeToMs = raw => {
        if (!raw) return 0;
        const parts = String(raw).trim().split(':');
        if (parts.length !== 3) return 0;
        const [h, m, s] = parts;
        const sec = parseFloat(String(s).replace(',', '.'));
        if (!Number.isFinite(sec)) return 0;
        const hours = parseInt(h, 10) || 0;
        const mins = parseInt(m, 10) || 0;
        return Math.round(((hours * 3600) + (mins * 60) + sec) * 1000);
      };

      const onProgressLine = line => {
        if (!line || typeof line !== 'string') return;
        const [key, rawValue = ''] = line.split('=');
        const value = rawValue.trim();
        if (key === 'out_time_ms') {
          const parsed = parseInt(value, 10);
          if (Number.isFinite(parsed)) {
            updateProgressFromOutTimeMs(Math.round(parsed / 1000));
          }
        } else if (key === 'out_time') {
          const parsed = parseTimeToMs(value);
          if (parsed > 0) {
            updateProgressFromOutTimeMs(parsed);
          }
        } else if (key === 'progress' && value === 'end') {
          updateProgressFromOutTimeMs(durationMs);
        }
      };

      try {
        // Log discovered audio layout for transparency
        if (probeFailed) {
          pushLog?.('⚠️ Audio probe failed; using fallback audio mapping.');
        } else if (audioStreams.length) {
          const sig = `[${audioStreams.map(s => s.ch).join(',')}] (${audioStreams.length} stream${audioStreams.length>1?'s':''})`;
          pushLog?.(`🔎 Audio layout (preserved): ${sig}`);
        } else {
          pushLog?.('🔎 Audio layout: none (video‑only proxy).');
        }
        await spawnFFmpegWithSignal(args, outputPath, groupCfg.signal, { onProgressLine });
      } catch (err) {
        // Last-resort fallback to prevent hard failure if some rare muxer quirk appears.
        const msg = String(err?.message || err);
        if (isMov && /Invalid argument|codec not currently supported/i.test(msg)) {
          pushLog?.('↩️ Retrying FFmpeg with conservative stereo PCM fallback (1 stream)…');
          const retry = ['-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0',
            '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le',
            '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 'mov'
          ];
          await spawnFFmpegWithSignal(retry, outputPath, groupCfg.signal, { onProgressLine });
        } else {
          throw err;
        }
      }

      updateProgressFromOutTimeMs(durationMs);
      progressManager.finishFile(streamId);

      generatedProxies.push(outputPath);
      pairs.push({ original: src, proxy: outputPath });
      pushLog?.(`✅ Proxy created: ${outName}`);
    }
  } finally {
    progressManager.off('stream-progress', onStreamProgress);
    progressManager.off('overall-progress', onOverallProgress);
    progressManager.off('file-complete', onFileComplete);
    progressManager.complete(groupCfg.jobId);
  }

  emitProgress({ overall: 100, filePercent: 100, eta: '0s', status: 'complete' });
  return pairs;
}

function broadcastProxyAttach(pairs = []) {
  if (!pairs.length) return;
  try {
    global.cepBridge?.broadcast({
      type: 'premiere-attach-proxy',
      pairs,
      data: JSON.stringify(pairs)
    });
  } catch {}
}

// ───────────────────────────────────────────────────────────────
// 🧠 Grouping Helpers: container / WxH / FPS bucket / channels
// ───────────────────────────────────────────────────────────────
function _extLower(p) {
  try { return (path.extname(p) || '').toLowerCase().replace(/^\./, ''); } catch { return ''; }
}
function _normalizeContainerFromSource(p) {
  // For now we normalize to mov|mp4 (others later).
  return _extLower(p) === 'mp4' ? 'mp4' : 'mov';
}
function _parseFps(avgOrRational) {
  if (!avgOrRational || avgOrRational === '0/0') return 0;
  if (typeof avgOrRational === 'number') return avgOrRational;
  if (String(avgOrRational).includes('/')) {
    const [n, d] = String(avgOrRational).split('/').map(Number);
    if (d && isFinite(d) && d !== 0) return n / d;
    return n || 0;
  }
  const v = parseFloat(avgOrRational);
  return isFinite(v) ? v : 0;
}
function _bucketFrameRate(fps) {
  // Coarse buckets with small tolerance for 24000/1001 etc.
  const buckets = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  if (!fps || !isFinite(fps)) return 30;
  let best = buckets[0], mind = Math.abs(fps - buckets[0]);
  for (const b of buckets) {
    const d = Math.abs(fps - b);
    if (d < mind) { mind = d; best = b; }
  }
  // generous tolerance; anything near lands in its closest bucket
  return best;
}

  /**
   * Probe verified sources and group them by container/WxH/FPS-bucket/channels/layout signature.
   * Returns an array of { attrs, sources } where attrs = { container, width, height, fpsBucket, channels, layoutSig }.
   */
async function _analyzeSourcesForProxyGroups(config, pushLog) {
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const groups = new Map();
  const limitProbe = createConcurrencyLimiter(3);

  await Promise.all(
    sources.map(src =>
      limitProbe(async () => {
    let probe;
    try {
      const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', src];
      const res = await execFileAsync(ffprobePath, args, { encoding: 'utf8' });
      probe = JSON.parse(res.stdout || '{}');
    } catch {
      // Best-effort defaults for unprobeable files
      pushLog?.(`⚠️ Probe failed for "${path.basename(src)}" — using defaults for grouping.`);
      const attrs = { container: _normalizeContainerFromSource(src), width: 1920, height: 1080, fpsBucket: 29.97, channels: 2 };
      const key = `${attrs.container}|${attrs.width}x${attrs.height}|${attrs.fpsBucket}|${attrs.channels}`;
      if (!groups.has(key)) groups.set(key, { attrs, sources: [] });
      groups.get(key).sources.push(src);
      return;
    }

    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const v = streams.find(s => s.codec_type === 'video');

    if (!v) {
      // Import/bins still run; proxies only for video sources
      pushLog?.(`ℹ️ Skipping non‑video source for proxies: ${path.basename(src)}`);
      return;
    }

    const width = parseInt(v.width || 0, 10) || 1920;
    const height = parseInt(v.height || 0, 10) || 1080;
    const fpsRaw = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
    const fpsBucket = _bucketFrameRate(_parseFps(fpsRaw));
    const videoCodec = String(v.codec_name || '').toLowerCase();
    // Sum channels across all audio streams (dual‑mono, multitrack, etc.)
    const aStreams = streams.filter(s => s.codec_type === 'audio');
    const channels = aStreams.reduce((sum, s) => sum + (Number(s.channels) || 0), 0) || 2;
    const layoutSig = aStreams.map(s => Number(s.channels) || 1).join('+') || '0';
    const container = _normalizeContainerFromSource(src);
    const key = `${container}|${width}x${height}|${fpsBucket}|${channels}|${layoutSig}`;
    if (!groups.has(key))
      groups.set(key, { attrs: { container, width, height, fpsBucket, channels, layoutSig, videoCodec }, sources: [] });
    groups.get(key).sources.push(src);
      })
    )
  );

  return Array.from(groups.values());
}
/**
 * Dispatch ingest workflow jobs to the Adobe CEP panel.
 *
 * @param {object} config - Job configuration sent to Premiere
 * @returns {Promise<object>} result with log entries
 */
async function runAdobeUtilities(config = {}) {
  config = normalizeAdobeConfig(config);
  const t = (key, params = {}) => formatAdobeUtilitiesMessage(key, params, { config });
  const yesNo = value => t(value ? 'adobeUtilities.common.yes' : 'adobeUtilities.common.no');
  
  if (!config.jobId) {
    config.jobId = `adobe-${Date.now()}`;
  }

  const jobLogger = createJobLogger({
    panel: 'adobe-utilities',
    jobId: config.jobId,
    stage: 'init',
    streamToFile: true,
  });

  const userLog = createJobUserLog(jobLogger, {
    normalize: (msg) => (typeof msg === 'string' ? msg : String(msg ?? '')),
    pickLevel: (normalized, isError) => {
      const text = String(normalized || '').trim();

      // Summary lines like "Errors: 0" / "Warnings: 0" should not be treated as issues
      // unless the count is non-zero.
      const countLineMatch = text.match(/^(?:(?:✅|❌|⚠️)\s*)?(Errors|Warnings|Failed)\s*:\s*(\d+)\b/i);
      if (countLineMatch) {
        const label = String(countLineMatch[1] || '').toLowerCase();
        const count = parseInt(countLineMatch[2], 10);
        if (Number.isFinite(count) && count > 0) {
          return label.startsWith('warn') ? 'warn' : 'error';
        }
        return 'info';
      }

      // Command previews can legitimately contain "-loglevel error" without being failures.
      if (/^🧪\s*FFmpeg command:/i.test(text)) {
        return 'info';
      }

      const inferredError = isError || /❌|\berror\b/i.test(text);
      const inferredWarn = !inferredError && (/⚠️|\bwarn(?:ing)?\b/i.test(text));
      return inferredError ? 'error' : inferredWarn ? 'warn' : 'info';
    }
  });
  const log = userLog.lines;
  const logPush = userLog.push;

  const pushLog = (msg, opts = {}) => {
    if (opts && typeof opts === 'object' && (opts.detail || opts.isError || opts.fileId)) {
      const { detail = '', isError = false, fileId = '' } = opts;
      logPush(msg, detail, isError, fileId);
    } else {
      logPush(msg);
    }
  };
  const pushLogI18n = (key, params = {}, opts = {}) => pushLog(t(key, params), opts);

  let structuredLogPath = null;
  let archivePath = null;
  structuredLogPath = jobLogger.getStructuredLogPath?.() || structuredLogPath;

  let didPersistJobLogs = false;
  let reportStats = {};
  const savedJobReportCopies = new Set();
  const refreshSavedJobReportCopies = () => {
    if (!archivePath || savedJobReportCopies.size === 0) return;
    if (!fs.existsSync(archivePath)) return;
    for (const targetPath of savedJobReportCopies) {
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(archivePath, targetPath);
      } catch (err) {
        console.warn('⚠️ Failed to refresh saved adobe-utilities TXT log copy:', err?.message || err);
      }
    }
  };
  const persistJobLogs = ({ rewriteText = false, closeLogger = true } = {}) => {
    if (didPersistJobLogs && !rewriteText) {
      if (closeLogger) {
        try { jobLogger.close?.(); } catch {}
      }
      return;
    }
    try {
      if (!structuredLogPath) {
        structuredLogPath = jobLogger.getStructuredLogPath?.() || null;
      }
      if (!structuredLogPath) {
        structuredLogPath = writeJobLogToFile(
          'adobe-utilities',
          config.jobId,
          jobLogger.getEntries()
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist adobe-utilities JSONL log:', e?.message || e);
    }
    try {
      if (!archivePath || rewriteText) {
        archivePath = writeJobTextToFile(
          'adobe-utilities',
          config.jobId,
          jobLogger.getEntries(),
          {
            structuredLogPath: structuredLogPath,
            inputs: {
              sourceCount: Array.isArray(config.sources) ? config.sources.length : 0,
              sources: Array.isArray(config.sources) ? config.sources.slice(0, 50) : [],
            },
            outputs: {
              primaryDestination: config.destination || '',
              secondaryDestination: config.backupPath || '',
              proxyDestination: config.proxyDest || '',
            },
            settings: {
              mode: 'manual',
              importPremiere: !!config.importPremiere,
              createBins: !!config.createBins,
              generateProxies: !!config.generateProxies,
              saveLog: !!config.saveLog,
              backupEnabled: !!(config.backup || config.dualCopy),
              proxyPreset: config.proxyPreset ? String(config.proxyPreset) : '',
              verificationMethod: config.verification?.method || 'none',
            },
            stats: reportStats,
          }
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist adobe-utilities TXT log:', e?.message || e);
    }
    didPersistJobLogs = true;
    if (closeLogger) {
      try { jobLogger.close?.(); } catch {}
    }
  };

  const validationErrors = await validateAdobeConfig(config);
  if (validationErrors.length) {
    validationErrors.forEach(msg => logPush(msg, '', true));
    jobLogger.setStage('error');
    structuredLogPath = structuredLogPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs();
    return {
      success: false,
      cancelled: false,
      log,
      logText: log.join('\n'),
      archivePath,
      structuredLogPath,
      jobId: config.jobId
    };
  }

  if (isMatchSourcePreset(config.proxyPreset)) {
    pushLogI18n('adobeUtilities.log.matchSourceMode');
    config.proxyPreset = MATCH_SOURCE_SENTINEL;
  } else if (config.proxyPreset) {
    pushLogI18n('adobeUtilities.log.amePresetDirect', { preset: path.basename(config.proxyPreset) });
  }

  const enableN8N = !!config.enableN8N;
  const n8nUrl = typeof config.n8nUrl === 'string' ? config.n8nUrl.trim() : '';
  const n8nAllowlistRaw = config.n8nAllowlist || config.n8nAllowedHosts;
  const n8nAllowlist = Array.isArray(n8nAllowlistRaw)
    ? n8nAllowlistRaw
    : typeof n8nAllowlistRaw === 'string'
      ? n8nAllowlistRaw
          .split(',')
          .map(entry => entry.trim())
          .filter(Boolean)
      : [];
  const n8nLog = !!config.n8nLog;
  const n8nAllowPrivate = !!config.n8nAllowPrivate;

  if (enableN8N) {
    pushLogI18n('adobeUtilities.log.webhookEnabled', { suffix: n8nUrl ? ` → ${n8nUrl}` : '' });
  }

  const generatedProxies = [];
  // Track any proxies created so we can update UI even if AME doesn't attach
  const seenProxyPaths = new Set();
  let totalCreated = 0;
  const trackNewProxies = (paths = []) => {
    let added = 0;
    const list = Array.isArray(paths) ? paths : [paths];
    for (const p of list) {
      if (!p) continue;
      const key = path.normalize(String(p));
      if (seenProxyPaths.has(key)) continue;
      seenProxyPaths.add(key);
      added++;
      try {
        config?.emit?.('proxy-created', { path: key, totalCreated: totalCreated + added });
      } catch {}
    }
    if (added > 0) totalCreated += added;
    return added;
  };
  const jobStart = new Date();

  const jobMeta = { cancelled: false, config };
  if (config.jobId) {
    activeAdobeJobs.set(config.jobId, jobMeta);
  }

  let removeForward = bindCepForwardersForJob(config.jobId, config);

  const verificationMethod = (config.verification?.method || 'none').toLowerCase();
  const verifyEnabled = verificationMethod !== 'none';
  const verificationLabel = formatVerificationLabel(verificationMethod);
  const verificationResults = new Map();
  const verifiedForPremiere = new Set();
  const srcHashMap = new Map();
  const copyFailures = new Set();
  // Track real copy/import outcomes for honest summaries
  let copyOkCount = 0;
  let copyOkBytes = 0;
  let ingestDispatched = false;
  let ingestEligibleCount = 0;

  const logJobCompletion = async () => {
    const end = new Date();
    const durationSec = ((end - jobStart) / 1000).toFixed(1);
    const durationMin = (durationSec / 60).toFixed(1);

    updateReportStats({
      durationSeconds: durationSec,
      durationMinutes: durationMin,
    });

    pushLogI18n('adobeUtilities.log.summaryHeader');
    pushLogI18n('adobeUtilities.log.summaryDivider');

    // Source / destination summary
    pushLogI18n('adobeUtilities.log.sourcesProcessed', { count: sourceList.length });
    if (config.destination) pushLogI18n('adobeUtilities.log.destination', { destination: config.destination });
    if (backupEnabled) pushLogI18n('adobeUtilities.log.backupPath', { backupPath });
    if (config.importPremiere) {
      if (ingestDispatched && ingestEligibleCount > 0) {
        pushLogI18n('adobeUtilities.log.importedToPremiereSent', { count: ingestEligibleCount });
      } else {
        pushLogI18n('adobeUtilities.log.importedToPremiereNone');
      }
    }
    if (config.createBins) pushLogI18n('adobeUtilities.log.binsCreated', { value: yesNo(true) });
    if (config.generateProxies) {
      pushLogI18n('adobeUtilities.log.proxyGeneration', { value: t('adobeUtilities.common.enabled') });
      pushLogI18n('adobeUtilities.log.proxyPreset', { preset: path.basename(config.proxyPreset || t('adobeUtilities.common.noneValue')) });
      pushLogI18n('adobeUtilities.log.proxyDestination', { destination: config.proxyDest || t('adobeUtilities.common.defaultValue') });
    }

    // File verification stats
    const totalCount = sourceList.length;
    const verifiedCount = verifiedForPremiere.size;
    const failedCount = totalCount - verifiedCount;
    if (verifyEnabled) {
      pushLogI18n('adobeUtilities.log.verificationMethod', { method: verificationLabel });
      pushLogI18n('adobeUtilities.log.verifiedFiles', { verifiedCount, totalCount });
      if (failedCount > 0)
        pushLogI18n('adobeUtilities.log.verificationFailedCount', { count: failedCount });
    } else {
      pushLogI18n('adobeUtilities.log.verificationDisabled');
    }

    // Backup stats (kept separate from Premiere import gating)
    if (backupEnabled) {
      const totalBackupCount = sourceList.length;
      const okBackupCount = Array.from(backupResults.values()).filter(Boolean).length;
      const failedBackupCount = totalBackupCount - okBackupCount;
      pushLogI18n('adobeUtilities.log.backupResults', { okBackupCount, totalBackupCount });
      if (failedBackupCount > 0) pushLogI18n('adobeUtilities.log.backupFailedCount', { count: failedBackupCount });
    }

    // Transfer metrics
    if (config.destination) {
      const mb = (copyOkBytes / (1024 * 1024)).toFixed(1);
      const mbpm = ((copyOkBytes / (1024 * 1024)) / (durationSec / 60)).toFixed(1);
      pushLogI18n('adobeUtilities.log.totalCopied', { mb });
      pushLogI18n('adobeUtilities.log.averageThroughput', { mbpm });
      if (copyOkCount === 0) pushLogI18n('adobeUtilities.log.copyStageZeroFiles');
    }

    // Proxy summary — handle both FFmpeg + AME paths
    let proxies = [...generatedProxies];
    if (config.generateProxies && proxies.length === 0) {
      const tryDirs = [];
      if (config.proxyDest) tryDirs.push(config.proxyDest);
      if (config.destination) tryDirs.push(path.join(config.destination, 'Proxies'));

      for (const dir of tryDirs) {
        try {
          const { mapped } = await collectProxyFiles(dir, sourceList, {
            maxDepth: 2,
            maxFiles: 2000,
            log: msg => pushLog(msg),
          });
          if (mapped.length) {
            proxies = mapped.map(entry => entry.proxy);
            pushLogI18n('adobeUtilities.log.proxyFilesDetectedIn', { count: mapped.length, dir });
            mapped.forEach(p => pushLogI18n('adobeUtilities.log.bulletFile', { name: path.basename(p.proxy) }));
            break;
          }
        } catch {}
      }
    }

    if (generatedProxies.length) {
      pushLogI18n('adobeUtilities.log.proxyFilesCreatedList', { count: generatedProxies.length });
      for (const p of generatedProxies) {
        pushLogI18n('adobeUtilities.log.bulletFile', { name: path.basename(p) });
      }
    }

    if (config.generateProxies && proxies.length === 0) {
      pushLogI18n('adobeUtilities.log.noProxiesFoundOrGenerated');
    } else if (config.generateProxies && proxies.length) {
      pushLogI18n('adobeUtilities.log.proxyFilesDetectedVerifyAttachment', { count: proxies.length });
    }

    // Webhook / automation
    if (config.enableN8N) {
      pushLogI18n('adobeUtilities.log.webhookUrl', { url: config.n8nUrl || t('adobeUtilities.common.noUrl') });
      pushLogI18n('adobeUtilities.log.webhookAllowPrivate', { value: yesNo(config.n8nAllowPrivate) });
      if (config.n8nLog) pushLogI18n('adobeUtilities.log.webhookSentLogPayload');
    }

    // Threading / retries
    if (config.enableThreads) {
      pushLogI18n('adobeUtilities.log.threading', { value: config.autoThreads ? t('adobeUtilities.common.auto') : (config.maxThreads || 1) });
    }
    if (config.retryFailures) {
      pushLogI18n('adobeUtilities.log.retryOnFailure', { value: t('adobeUtilities.common.enabled') });
    }

    // End markers
    pushLogI18n('adobeUtilities.log.summaryDivider');
    pushLogI18n('adobeUtilities.log.finishedAt', { value: end.toLocaleString() });
    pushLogI18n('adobeUtilities.log.duration', { durationSec, durationMin });
    pushLogI18n('adobeUtilities.log.summaryDivider');
  };

  // 🔹 COPY STAGE ONLY
  // 🩹 Skip filterOutDestination for Adobe Automate — files, not folders
  const sourceList = Array.isArray(config.sources) ? config.sources.slice() : [];
  const destPathMap = new Map();
  const fileSizeMap = new Map();
  const totalSourceBytes = sourceList.reduce((sum, src) => {
    try {
      const size = fs.statSync(src).size;
      fileSizeMap.set(src, size);
      return sum + size;
    } catch {
      fileSizeMap.set(src, 0);
      return sum;
    }
  }, 0);
  if (config.destination) {
    sourceList.forEach(src => {
      destPathMap.set(src, path.join(config.destination, path.basename(src)));
    });
  } else {
    sourceList.forEach(src => destPathMap.set(src, src));
  }

  const backupRequested = !!(config.backup || config.dualCopy);
  const backupPath = typeof config.backupPath === 'string' ? config.backupPath.trim() : '';
  const backupEnabled = backupRequested && !!backupPath;
  const backupDestMap = new Map();
  const backupResults = new Map();
  const updateReportStats = (extra = {}) => {
    const totalSources = Array.isArray(sourceList) ? sourceList.length : 0;
    const backupOkCount = backupEnabled
      ? Array.from(backupResults.values()).filter(Boolean).length
      : 0;
    reportStats = {
      sourceFiles: totalSources,
      copiedFiles: copyOkCount,
      copyFailedFiles: copyFailures.size,
      verificationPassedFiles: verifiedForPremiere.size,
      verificationFailedFiles: Math.max(0, totalSources - verifiedForPremiere.size),
      backupCopiedFiles: backupOkCount,
      backupFailedFiles: backupEnabled ? Math.max(0, totalSources - backupOkCount) : 0,
      premiereEligibleFiles: ingestEligibleCount,
      generatedProxyFiles: totalCreated || seenProxyPaths.size || generatedProxies.length,
      ...extra,
    };
  };
  if (backupEnabled) {
    for (const src of sourceList) {
      backupDestMap.set(src, path.join(backupPath, path.basename(src)));
    }
  }

  const cpuCount = Math.max(1, os.cpus().length);
  let copyConcurrency = 1;
  if (config.enableThreads) {
    let maxThreads = Number(config.maxThreads);
    if (!Number.isFinite(maxThreads) || maxThreads <= 0) {
      maxThreads = config.autoThreads ? cpuCount : 1;
    }
    copyConcurrency = Math.max(1, Math.min(cpuCount, maxThreads));
  }

  const collisionErrors = [
    ...formatBasenameCollisionErrors(
      formatAdobeUtilitiesMessage('adobeUtilities.destinationCollisionTitle', {}, { config }),
      config.destination,
      config.destination ? collectBasenameCollisions(destPathMap) : [],
      config
    ),
    ...formatBasenameCollisionErrors(
      formatAdobeUtilitiesMessage('adobeUtilities.backupCollisionTitle', {}, { config }),
      backupPath,
      backupEnabled ? collectBasenameCollisions(backupDestMap) : [],
      config
    )
  ];

  if (collisionErrors.length) {
    collisionErrors.forEach(msg => logPush(msg, '', true));
    try { removeForward?.(); } catch {}
    if (config.jobId) activeAdobeJobs.delete(config.jobId);
    jobLogger.setStage('error');
    structuredLogPath = structuredLogPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs();
    return {
      success: false,
      cancelled: false,
      log,
      logText: log.join('\n'),
      archivePath,
      structuredLogPath,
      jobId: config.jobId,
      validationErrors: collisionErrors
    };
  }

  // Shared hash cache for verification (used by copy + backup stages)
  // (declared above)

  const originalBinMap = config.fileToBinMap ? { ...config.fileToBinMap } : {};

  const createStageByteProgressBridge = (stage, totalBytes, totalFiles) => {
    const manager = new ProgressManager(Math.max(1, Number(totalBytes) || 0), 250, 'bytes');
    manager.setTotalFiles(totalFiles);

    const emit = (payload = {}) => {
      const overall = typeof payload.overall === 'number'
        ? payload.overall
        : (typeof payload.percent === 'number' ? payload.percent : 0);
      global.queue?.emit('job-progress', {
        id: config.jobId,
        panel: 'adobe-utilities',
        stage,
        status: 'active',
        overall,
        filePercent: payload.percent,
        eta: payload.eta,
        file: payload.file,
        completed: payload.completedFiles,
        total: payload.totalFiles,
        percent: overall
      });
    };

    const onStreamProgress = payload => emit(payload);
    const onOverallProgress = payload => emit(payload);

    manager.on('stream-progress', onStreamProgress);
    manager.on('overall-progress', onOverallProgress);

    return {
      manager,
      cleanup() {
        try { manager.off('stream-progress', onStreamProgress); } catch {}
        try { manager.off('overall-progress', onOverallProgress); } catch {}
        try { manager.dispose(); } catch {}
      }
    };
  };

  const finalizeCancellation = (message, extra = {}) => {
    jobLogger.setStage('cancelled');
    pushLog(message);
    jobMeta.cancelled = true;
    try { removeForward?.(); } catch {}
    if (config.jobId) activeAdobeJobs.delete(config.jobId);
    structuredLogPath = structuredLogPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs();
    return {
      success: false,
      cancelled: true,
      log,
      logText: log.join('\n'),
      archivePath,
      structuredLogPath,
      jobId: config.jobId,
      ...extra
    };
  };

  async function verifyFile(src, destPath) {
    if (!verifyEnabled) return true;
    const displayPath = destPath && destPath !== src ? destPath : src;
    const displayName = path.basename(displayPath);
    try {
      if (verificationMethod === 'bytecompare') {
        const hasCopyTarget = destPath && destPath !== src && fs.existsSync(destPath);
        if (!hasCopyTarget) {
          pushLogI18n('adobeUtilities.log.verificationSkippedNoDestination', { verificationLabel, displayName });
          return true;
        }
        const identical = await compareFilesByteByByte(src, destPath);
        if (identical) {
          pushLogI18n('adobeUtilities.log.verificationMatch', { verificationLabel, displayName });
          return true;
        }
        pushLogI18n('adobeUtilities.log.verificationMismatch', { verificationLabel, displayName });
        return false;
      }

      let sourceHash = srcHashMap.get(src);
      if (!sourceHash) {
        const res = await computeHashForMethod(src, verificationMethod);
        sourceHash = res?.hash;
        if (sourceHash) srcHashMap.set(src, sourceHash);
      }
      if (!sourceHash) {
        throw new Error('Failed to compute source hash');
      }

      const hasCopyTarget = destPath && destPath !== src && fs.existsSync(destPath);
      if (!hasCopyTarget) {
        pushLogI18n('adobeUtilities.log.verificationHashGeneratedSourceOnly', { verificationLabel, displayName });
        return true;
      }

      const destHash = await computeHashForMethod(destPath, verificationMethod);
      if (!destHash?.hash) {
        throw new Error('Failed to compute destination hash');
      }

      if (destHash.hash === sourceHash) {
        pushLogI18n('adobeUtilities.log.verificationMatch', { verificationLabel, displayName });
        return true;
      }

      pushLogI18n('adobeUtilities.log.verificationMismatch', { verificationLabel, displayName });
      return false;
    } catch (err) {
      pushLogI18n('adobeUtilities.log.verificationFailedForFile', { displayName, error: err.message || err });
      return false;
    }
  }

  async function verifyAndStore(src) {
    if (copyFailures.has(src)) {
      verificationResults.set(src, false);
      config.fileFlags = config.fileFlags || {};
      config.fileFlags[src] = {
        ...(config.fileFlags[src] || {}),
        notImportable: true,
        import: false,
        encode: false
      };
      const destPath = destPathMap.get(src) || src;
      const displayPath = destPath && destPath !== src ? destPath : src;
      pushLogI18n('adobeUtilities.log.skippingVerificationImportDueToCopyFailure', { name: path.basename(displayPath) });
      return false;
    }
    const destPath = destPathMap.get(src) || src;
    const verified = await verifyFile(src, destPath);
    verificationResults.set(src, verified);
    if (verified) {
      verifiedForPremiere.add(src);
    } else if (verifyEnabled && config.importPremiere) {
      const displayPath = destPath && destPath !== src ? destPath : src;
      pushLogI18n('adobeUtilities.log.skippingPremiereImportDueToVerificationFailure', { name: path.basename(displayPath) });
    }
    return verified;
  }

  if (!sourceList.length) {
    pushLogI18n('adobeUtilities.log.noSourcesProvided');
    try { removeForward?.(); } catch {}
    if (config.jobId) activeAdobeJobs.delete(config.jobId);
    jobLogger.setStage('error');
    structuredLogPath = structuredLogPath || jobLogger.getStructuredLogPath?.() || null;
    persistJobLogs();
    return {
      success: false,
      cancelled: false,
      log,
      logText: log.join('\n'),
      archivePath,
      structuredLogPath,
      jobId: config.jobId
    };
  }

  if (config.destination) {
    const totalBytes = totalSourceBytes;

    // Optional precompute of source hashes to avoid rehashing large files
    if (verifyEnabled && verificationMethod !== 'none' && verificationMethod !== 'bytecompare') {
      pushLogI18n('adobeUtilities.log.precomputeSourceHashesForVerification', { verificationMethod });
      for (const s of sourceList) {
        try {
          const stats = await fs.promises.stat(s);
          if (stats.size > 10 * 1024) {
            const res = await computeHashForMethod(s, verificationMethod);
            if (res?.hash) srcHashMap.set(s, res.hash);
          }
        } catch (err) {
          pushLogI18n('adobeUtilities.log.failedPrecomputeHashForSource', { name: path.basename(s), error: err.message });
        }
      }
    }

    const {
      manager: copyProgressManager,
      cleanup: cleanupCopyProgressBridge
    } = createStageByteProgressBridge('copy', totalBytes, sourceList.length);

    const copyLimiter = createConcurrencyLimiter(copyConcurrency);
    let copyCancelled = false;
    const copyOne = async src => {
      if (config.signal?.aborted) {
        copyCancelled = true;
        throw new Error('cancelled');
      }
      const destPath = destPathMap.get(src) || path.join(config.destination, path.basename(src));
      const tempDestPath = `${destPath}.partial`;
      const streamId = `copy:${src}`;
      let started = false;

      try {
        copyProgressManager.startFile(streamId, src, fileSizeMap.get(src) || 0);
        started = true;

        // Copy to temp file first
        await copyFileWithProgress(
          src,
          tempDestPath,
          (_percent, chunkSize) => {
            if (config.signal?.aborted) throw new Error('cancelled');
            copyProgressManager.updateStream(streamId, chunkSize);
          },
          config.signal
        );

        // Ensure data hits disk before rename (best effort)
        try {
          const fd = await fs.promises.open(tempDestPath, 'r');
          await fd.sync();
          await fd.close();
        } catch {}

        // Atomic rename promotion (with cross-volume fallback)
        try {
          await fs.promises.rename(tempDestPath, destPath);
        } catch (renameErr) {
          if (renameErr.code === 'EXDEV') {
            await fs.promises.copyFile(tempDestPath, destPath);
            await fs.promises.unlink(tempDestPath).catch(() => {});
          } else {
            await fs.promises.unlink(tempDestPath).catch(() => {});
            throw renameErr;
          }
        }

        // Checksum or byte compare verification (src ↔ dest)
        if (verifyEnabled && verificationMethod !== 'none') {
          if (verificationMethod === 'bytecompare') {
            const identical = await compareFilesByteByByte(src, destPath);
            if (!identical) {
              await fs.promises.unlink(destPath).catch(() => {});
              throw new Error('Byte-level mismatch');
            }
          } else {
            let srcHash = srcHashMap.get(src);
            if (!srcHash) {
              const srcRes = await computeHashForMethod(src, verificationMethod);
              srcHash = srcRes?.hash;
              if (srcHash) srcHashMap.set(src, srcHash);
            }

            const destRes = await computeHashForMethod(destPath, verificationMethod);
            const destHash = destRes?.hash;

            if (!srcHash || !destHash || srcHash !== destHash) {
              await fs.promises.unlink(destPath).catch(() => {});
              throw new Error('Checksum mismatch (src vs dest)');
            }
            pushLogI18n('adobeUtilities.log.checksumVerifiedForFile', { verificationMethod, name: path.basename(src) });
          }
        }

        pushLogI18n('adobeUtilities.log.copiedFile', { name: path.basename(src) });
        copyOkCount += 1;
        try {
          const st = await fs.promises.stat(destPath);
          copyOkBytes += (st?.size || 0);
        } catch {}
        verificationResults.set(src, true);
        verifiedForPremiere.add(src);
      } catch (err) {
        if (err?.message === 'cancelled' || err?.name === 'AbortError') {
          copyCancelled = true;
          throw err;
        }
        await fs.promises.unlink(tempDestPath).catch(() => {});
        copyFailures.add(src);
        verificationResults.set(src, false);
        config.fileFlags = config.fileFlags || {};
        config.fileFlags[src] = {
          ...(config.fileFlags[src] || {}),
          notImportable: true,
          import: false,
          encode: false
        };
        pushLogI18n('adobeUtilities.log.copyVerifyFailedForFile', { name: path.basename(src), error: err.message || err });
      } finally {
        if (started) {
          copyProgressManager.finishFile(streamId);
        }
      }
    };
    let copyResults;
    try {
      copyResults = await Promise.allSettled(
        sourceList.map(src => copyLimiter(() => copyOne(src)))
      );
    } finally {
      cleanupCopyProgressBridge();
    }
    const copyCancelledResult = copyCancelled || config.signal?.aborted || copyResults.some(
      result =>
        result.status === 'rejected' &&
        (result.reason?.message === 'cancelled' || result.reason?.name === 'AbortError')
    );
    if (copyCancelledResult) {
      return finalizeCancellation('🛑 Copy cancelled');
    }
    global.queue?.emit('job-progress', {
      id: config.jobId,
      panel: 'adobe-utilities',
      stage: 'copy',
      status: 'complete',
      overall: 100,
      filePercent: 100,
      percent: 100
    });

  }

  // 💾 BACKUP STAGE — copy/verify to a secondary destination (does NOT gate Premiere import)
  if (backupEnabled) {
    jobLogger.setStage('backup');
    pushLogI18n('adobeUtilities.log.startingBackup', { backupPath });

    global.queue?.emit('job-progress', {
      id: config.jobId,
      panel: 'adobe-utilities',
      stage: 'backup',
      percent: 0
    });

    const backupTotalBytes = totalSourceBytes;

    // Precompute hashes only if we haven't already and verification requires it
    if (verifyEnabled && verificationMethod !== 'bytecompare' && srcHashMap.size === 0) {
      pushLogI18n('adobeUtilities.log.precomputeSourceHashesBackup');
      for (const src of sourceList) {
        try {
          const stat = await fsp.stat(src);
          if (stat.size > 10_000) {
            const hash = await computeHashForMethod(src, verificationMethod);
            srcHashMap.set(src, hash?.hash || hash);
          }
        } catch (err) {
          pushLogI18n('adobeUtilities.log.couldNotHashSourceForBackup', { name: path.basename(src), error: err.message });
        }
      }
    }

    const {
      manager: backupProgressManager,
      cleanup: cleanupBackupProgressBridge
    } = createStageByteProgressBridge('backup', backupTotalBytes, sourceList.length);

    const backupLimiter = createConcurrencyLimiter(copyConcurrency);
    let backupCancelled = false;
    let backupCancelMessage = '⛔ Backup cancelled.';
    const backupOne = async src => {
      if (config.signal?.aborted) {
        backupCancelled = true;
        throw new Error('cancelled');
      }

      const dest = backupDestMap.get(src);
      if (!dest) return;

      // Avoid self-copy footguns (source already in backup destination)
      if (path.resolve(src) === path.resolve(dest)) {
        pushLogI18n('adobeUtilities.log.backupSkipAlreadyInDestination', { name: path.basename(src) });
        backupResults.set(src, true);
        return;
      }

      const streamId = `backup:${src}`;
      let started = false;

      try {
        const tempDestPath = dest + '.partial';
        backupProgressManager.startFile(streamId, src, fileSizeMap.get(src) || 0);
        started = true;

        await copyFileWithProgress(src, tempDestPath, (_percent, chunkSize) => {
          if (config.signal?.aborted) throw new Error('cancelled');
          backupProgressManager.updateStream(streamId, chunkSize);
        }, config.signal);

        // Atomic-ish finalize (Windows-safe + cross-device safe)
        await moveReplace(tempDestPath, dest);

        // Verification (separate from Premiere gating)
        let verified = true;
        if (verifyEnabled) {
          if (verificationMethod === 'bytecompare') {
            verified = await compareFilesByteByByte(src, dest);
          } else {
            let srcHash = srcHashMap.get(src);
            if (!srcHash) {
              const srcHashRes = await computeHashForMethod(src, verificationMethod);
              srcHash = srcHashRes?.hash || srcHashRes;
              srcHashMap.set(src, srcHash);
            }
            const destHashRes = await computeHashForMethod(dest, verificationMethod);
            const destHash = destHashRes?.hash || destHashRes;
            verified = srcHash && destHash && srcHash === destHash;
          }

          if (!verified) {
            pushLogI18n('adobeUtilities.log.backupVerificationFailed', { name: path.basename(src) });
            try { await fsp.unlink(dest); } catch {}
          } else {
            pushLogI18n('adobeUtilities.log.backupVerified', { name: path.basename(src) });
          }
        } else {
          pushLogI18n('adobeUtilities.log.backedUpFile', { name: path.basename(src) });
        }

        backupResults.set(src, verified);
      } catch (err) {
        if (err?.message === 'cancelled' || err?.name === 'AbortError') {
          backupCancelled = true;
          backupCancelMessage = '⛔ Backup cancelled during copy.';
          throw err;
        }
        pushLogI18n('adobeUtilities.log.backupFailedForFile', { name: path.basename(src), error: err.message });
        backupResults.set(src, false);
      } finally {
        if (started) {
          backupProgressManager.finishFile(streamId);
        }
      }
    };
    let backupResultsSettled;
    try {
      backupResultsSettled = await Promise.allSettled(
        sourceList.map(src => backupLimiter(() => backupOne(src)))
      );
    } finally {
      cleanupBackupProgressBridge();
    }
    const backupCancelledResult = backupCancelled || config.signal?.aborted || backupResultsSettled.some(
      result =>
        result.status === 'rejected' &&
        (result.reason?.message === 'cancelled' || result.reason?.name === 'AbortError')
    );
    if (backupCancelledResult) {
      return finalizeCancellation(backupCancelMessage, { stage: 'backup' });
    }

    global.queue?.emit('job-progress', {
      id: config.jobId,
      panel: 'adobe-utilities',
      stage: 'backup',
      status: 'complete',
      overall: 100,
      filePercent: 100,
      percent: 100
    });

    const ok = Array.from(backupResults.values()).filter(Boolean).length;
    pushLogI18n('adobeUtilities.log.backupSummary', { okCount: ok, totalCount: sourceList.length });
  }

  for (const src of sourceList) {
    if (!verificationResults.has(src)) {
      await verifyAndStore(src);
    }
  }

  const availableSources = sourceList.filter(src => !copyFailures.has(src));

  if (verifyEnabled) {
    const totalCount = sourceList.length;
    const verifiedCount = verifiedForPremiere.size;
    pushLogI18n('adobeUtilities.log.verificationSummary', { verificationLabel, verifiedCount, totalCount });
    const verifiedSources = Array.from(verifiedForPremiere);

    // Apply per-file Import/Proxy flags (renderer supplies config.fileFlags)
    const perFile = (config && typeof config.fileFlags === 'object' && config.fileFlags) ? config.fileFlags : {};
    const wantsImport = (src) => {
      const f = perFile[src];
      if (!f) return true;
      if (f.notImportable) return false;
      return f.import !== false;
    };
    const wantsProxy = (src) => {
      if (!config.generateProxies) return false;
      const f = perFile[src];
      if (!f) return true; // default: proxy everything when enabled (older presets)
      if (f.notImportable) return false;
      return !!f.encode;
    };

    const proxySet = new Set(verifiedSources.filter(wantsProxy));
    const importSources = verifiedSources.filter(src => wantsImport(src) || proxySet.has(src));
    const proxySources = verifiedSources.filter(src => proxySet.has(src));

    const mappedImportSources = importSources.map(src => destPathMap.get(src) || src);
    const mappedProxySources = proxySources.map(src => destPathMap.get(src) || src);

    if (config.importPremiere) {
      const skippedByVerify = totalCount - verifiedSources.length;
      if (skippedByVerify > 0) {
        pushLogI18n('adobeUtilities.log.omitFromPremiereImportDueToVerification', { count: skippedByVerify });
      }
      const skippedByFlags = verifiedSources.length - importSources.length;
      if (skippedByFlags > 0) {
        pushLogI18n('adobeUtilities.log.omitFromPremiereImportDueToImportToggles', { count: skippedByFlags });
      }
      if (!mappedImportSources.length) {
        pushLogI18n('adobeUtilities.log.noFilesEnabledForPremiereImportAfterFilters');
      }
    }

    config.sources = mappedImportSources;
    config.proxySources = mappedProxySources;

    if (config.fileToBinMap) {
      const newMap = {};
      for (const src of importSources) {
        const dest = destPathMap.get(src) || src;
        const bin = originalBinMap[src] || originalBinMap[dest];
        if (bin) newMap[dest] = bin;
      }
      config.fileToBinMap = newMap;
    }

    if (config.generateProxies && !config.proxySources.length) {
      pushLogI18n('adobeUtilities.log.disablingProxyGenerationNoProxyEnabledFiles');
      config.generateProxies = false;
    }
  } else if (config.importPremiere) {
    // No checksum verification. Still apply per-file Import/Proxy flags.
    const perFile = (config && typeof config.fileFlags === 'object' && config.fileFlags) ? config.fileFlags : {};
    const wantsImport = (src) => {
      const f = perFile[src];
      if (!f) return true;
      if (f.notImportable) return false;
      return f.import !== false;
    };
    const wantsProxy = (src) => {
      if (!config.generateProxies) return false;
      const f = perFile[src];
      if (!f) return true;
      if (f.notImportable) return false;
      return !!f.encode;
    };

    const proxySet = new Set(availableSources.filter(wantsProxy));
    const importSources = availableSources.filter(src => wantsImport(src) || proxySet.has(src));
    const proxySources = availableSources.filter(src => proxySet.has(src));

    const mappedImportSources = importSources.map(src => destPathMap.get(src) || src);
    const mappedProxySources = proxySources.map(src => destPathMap.get(src) || src);

    config.sources = mappedImportSources;
    config.proxySources = mappedProxySources;

    if (config.fileToBinMap) {
      const newMap = {};
      for (const src of importSources) {
        const dest = destPathMap.get(src) || src;
        const bin = originalBinMap[src] || originalBinMap[dest];
        if (bin) newMap[dest] = bin;
      }
      config.fileToBinMap = newMap;
    }

    if (config.generateProxies && !config.proxySources.length) {
      pushLogI18n('adobeUtilities.log.disablingProxyGenerationNoProxyEnabledFiles');
      config.generateProxies = false;
    }
  }

  // Ensure per-file proxy list is respected even when we're NOT importing to Premiere.
  // (If Premiere import is enabled, config.proxySources is already computed above.)
  if (config.generateProxies && (!Array.isArray(config.proxySources) || !config.proxySources.length)) {
    const perFile = (config && typeof config.fileFlags === 'object' && config.fileFlags) ? config.fileFlags : {};
    const wantsProxy = (src) => {
      const f = perFile[src];
      if (!f) return true;
      if (f.notImportable) return false;
      return !!f.encode;
    };
    const proxySources = availableSources.filter(wantsProxy);
    config.proxySources = proxySources.map(src => destPathMap.get(src) || src);

    if (!config.proxySources.length) {
      pushLogI18n('adobeUtilities.log.disablingProxyGenerationNoProxyEnabledFiles');
      config.generateProxies = false;
    }
  }

  // 🔹 Ensure valid proxy destination if proxies are enabled
  if (config.generateProxies) {
    let baseProxy = null;

    if (config.proxyDest && config.proxyDest.trim() !== '') {
      baseProxy = config.proxyDest;
    } else if (config.destination && config.destination.trim() !== '') {
      baseProxy = config.destination;
    }

    if (baseProxy) {
      config.proxyDest = baseProxy.endsWith('Proxies')
        ? baseProxy
        : path.join(baseProxy, 'Proxies');
      try {
        fs.mkdirSync(config.proxyDest, { recursive: true });
        pushLogI18n('adobeUtilities.log.proxyFolderReady', { proxyDest: config.proxyDest });
      } catch (err) {
        pushLogI18n('adobeUtilities.log.couldNotCreateProxyDirectory', { error: err.message });
      }
    } else {
      pushLogI18n('adobeUtilities.log.proxyGenerationDisabledNoValidDestination');
      config.generateProxies = false;
    }
  }

  const ameAvailable = isAMEAvailable(pushLog);
  const ffmpegFallbackEnabled = config.ffmpegFallback !== false;

  // Track whether we actually dispatched an AME proxy job to CEP.
  // This is important for the watchdog / fallback logic (prevents "waiting forever"
  // when AME never launches or the preset is missing at runtime).
  let ameProxyDispatched = false;
  let ameProxyPresetExt = null;

  const forceFfmpegForMatchSource = config.proxyPreset === MATCH_SOURCE_SENTINEL;
  if (forceFfmpegForMatchSource) {
    pushLogI18n('adobeUtilities.log.matchSourceForcingFfmpegOnly');
  }

  if (config.generateProxies) {
    // Simplified: do NOT split into multiple groups. Treat all sources as one AME job.
    // This avoids duplicate imports / duplicate proxy generation when only one AME job is desired.
    pushLogI18n('adobeUtilities.log.singleGroupMode');
    // Use the proxy-enabled source list when available; otherwise fall back to imported sources.
    const baseSources = Array.isArray(config.proxySources) && config.proxySources.length
      ? config.proxySources.slice()
      : (Array.isArray(config.sources) ? config.sources.slice() : sourceList.slice());
    const groups = [{ attrs: {}, sources: baseSources }];

    if (isMatchSourcePreset(config.proxyPreset)) {
      pushLogI18n('adobeUtilities.log.dynamicMatchSourceNoPresetRequired');
    }
    // Hint JSX to reset sticky proxy state before queueing AME
    config.resetBeforeProxies = true;
    // No user prompt for mixed sources — user requested single AME job behavior.
    // (If you later need protective cancellation, add it explicitly.)

    if (!groups.length) {
      pushLogI18n('adobeUtilities.log.noProxyEligibleVideoSources');
      const cepNoProxy = { ...config, generateProxies: false };
      if (global.cepBridge) {
        global.cepBridge.broadcast({ type: 'runIngestWorkflow', config: cepNoProxy });
        pushLogI18n('adobeUtilities.log.sentIngestNoProxiesToCep');
      }
    }

    // 🧩 Simplified flow — always import first, then generate proxies (no duplicates)

    // If the operator explicitly disabled FFmpeg fallback, an unavailable AME should abort the job
    // instead of hanging forever in the "waiting for proxies" stage.
    if (!forceFfmpegForMatchSource && !ameAvailable && !ffmpegFallbackEnabled) {
      const msg = formatAdobeUtilitiesMessage(
        'adobeUtilities.log.ameUnavailableFfmpegFallbackDisabledAbortProxyJob',
        {},
        { config }
      );
      pushLogI18n('adobeUtilities.log.errorWithMessage', { message: msg });
      removeForward?.();
      if (config.jobId) activeAdobeJobs.delete(config.jobId);
      jobLogger.setStage('error');
      structuredLogPath = writeJobLogToFile(
        'adobe-utilities',
        config.jobId,
        jobLogger.getEntries()
      );
      persistJobLogs();
      return {
        success: false,
        cancelled: false,
        error: msg,
        log,
        logText: log.join('\n'),
        structuredLogPath,
        archivePath,
        config,
      };
    }

    // ✅ Import sources into Premiere only once before proxy generation
    // Prevents double-import and duplicate proxy creation during AME runs.
    if (groups.length && config.importPremiere && !config._importedAlready) {
      pushLogI18n('adobeUtilities.log.importingSourcesBeforeProxyGeneration');
      const importCfg = {
        ...config,
        generateProxies: false,
        premiereImportOnly: false,
        _importedAlready: true
      };
      if (global.cepBridge) {
        global.cepBridge.broadcast({ type: 'runIngestWorkflow', config: importCfg });
        ingestEligibleCount = Array.isArray(importCfg.sources) ? importCfg.sources.length : 0;
        ingestDispatched = ingestEligibleCount > 0;
        pushLogI18n('adobeUtilities.log.sentImportToCep');
      }
    }

    if (config.generateProxies && forceFfmpegForMatchSource) {
      pushLogI18n('adobeUtilities.log.runningFfmpegOnlyProxyGeneration');
      for (const g of groups) {
        if (config.signal?.aborted) break;
        const groupCfg = { ...config, sources: g.sources, importPremiere: false };
        try {
          const pairs = await generateProxiesWithFFmpeg(groupCfg, pushLog, generatedProxies);
          if (pairs?.length) {
            // ✅ The "original" for proxy attachment must be the destination copy, not the source.
            const attachPairs = pairs.map(p => ({
              original: destPathMap?.get?.(p.original) || p.original,
              proxy: p.proxy
            }));
            trackNewProxies(pairs.map(p => p.proxy));
            broadcastProxyAttach(attachPairs);
            pushLogI18n('adobeUtilities.log.attachedProxyFilesGeneratedByFfmpeg', { count: pairs.length });
          } else {
            pushLogI18n('adobeUtilities.log.ffmpegProducedNoProxiesForGroup');
          }
        } catch (err) {
          pushLogI18n('adobeUtilities.log.ffmpegGroupGenerationFailed', { error: err.message || err });
        }
      }
    } else if (config.generateProxies && ameAvailable) {
      const trimmedPreset = typeof config.proxyPreset === 'string' ? config.proxyPreset.trim() : config.proxyPreset;
      if (!trimmedPreset) {
        const msg = formatAdobeUtilitiesMessage(
          'adobeUtilities.log.proxyPresetMissingOrEmptyCannotQueueAmeProxyJob',
          {},
          { config }
        );
        if (ffmpegFallbackEnabled) {
          pushLogI18n('adobeUtilities.log.fallingBackToFfmpegMatchSource', { message: msg });
          for (const g of groups) {
            const groupCfg = {
              ...config,
              sources: g.sources,
              importPremiere: false,
              proxyPreset: MATCH_SOURCE_SENTINEL
            };
            try {
              const pairs = await generateProxiesWithFFmpeg(groupCfg, pushLog, generatedProxies);
              if (pairs?.length) {
                const attachPairs = pairs.map(p => ({
                  original: destPathMap?.get?.(p.original) || p.original,
                  proxy: p.proxy
                }));
                trackNewProxies(pairs.map(p => p.proxy));
                broadcastProxyAttach(attachPairs);
                pushLogI18n('adobeUtilities.log.attachedProxyFilesGeneratedByFfmpegFallback', { count: pairs.length });
              } else {
                pushLogI18n('adobeUtilities.log.ffmpegFallbackProducedNoProxiesForGroup');
              }
            } catch (err) {
              pushLogI18n('adobeUtilities.log.ffmpegFallbackGenerationFailed', { error: err.message || err });
            }
          }
        } else {
          pushLogI18n('adobeUtilities.log.errorMessageFfmpegFallbackDisabled', { message: msg });
          removeForward?.();
          if (config.jobId) activeAdobeJobs.delete(config.jobId);
          jobLogger.setStage('error');
          structuredLogPath = writeJobLogToFile(
            'adobe-utilities',
            config.jobId,
            jobLogger.getEntries()
          );
          persistJobLogs();
          return {
            success: false,
            cancelled: false,
            error: msg,
            log,
            logText: log.join('\n'),
            structuredLogPath,
            archivePath,
            config,
          };
        }
      } else {
        pushLogI18n('adobeUtilities.log.startingAmeProxyGeneration');

        // Cache the expected output extension (useful for watchdog heuristics).
        if (!ameProxyPresetExt && typeof config.proxyPreset === 'string' && fileExists(config.proxyPreset)) {
          try {
            ameProxyPresetExt = parseProxyPreset(config.proxyPreset)?.fileExt || null;
          } catch {
            ameProxyPresetExt = null;
          }
        }

        for (const g of groups) {
          const proxyPresetPath = config.proxyPreset;
          if (!fileExists(proxyPresetPath)) {
            pushLogI18n('adobeUtilities.log.skippingAmePresetNotFound', { presetPath: proxyPresetPath });
            continue;
          }

          const groupCfg = {
            ...config,
            sources: g.sources.slice(),
            proxyPreset: proxyPresetPath,
            generateProxies: true,
            importPremiere: false, // ✅ import already done
            premiereImportOnly: false
          };

          // Mark that import has already occurred for this job
          groupCfg._importedAlready = true;

          pushLogI18n('adobeUtilities.log.dispatchingAmeProxyJob', { count: g.sources.length, preset: path.basename(proxyPresetPath) });

          if (global.cepBridge) {
            global.cepBridge.broadcast({ type: 'runIngestWorkflow', config: groupCfg });
            pushLogI18n('adobeUtilities.log.sentAmeProxyJobToCep');
            ameProxyDispatched = true;
          }
          // ⛳ No safety/timeout attach here — AME onProxyComplete in JSX does the real attach immediately.
        }
      }
    } else if (config.generateProxies && ffmpegFallbackEnabled) {
      // AME isn't available (or couldn't be found). Use FFmpeg Match Source fallback immediately.
      pushLogI18n('adobeUtilities.log.ameNotDetectedUsingFfmpegFallback');
      for (const g of groups) {
        const groupCfg = {
          ...config,
          sources: g.sources,
          importPremiere: false,
          proxyPreset: MATCH_SOURCE_SENTINEL
        };
        try {
          const pairs = await generateProxiesWithFFmpeg(groupCfg, pushLog, generatedProxies);
          if (pairs?.length) {
            const attachPairs = pairs.map(p => ({
              original: destPathMap?.get?.(p.original) || p.original,
              proxy: p.proxy
            }));
            trackNewProxies(pairs.map(p => p.proxy));
            broadcastProxyAttach(attachPairs);
            pushLogI18n('adobeUtilities.log.attachedProxyFilesGeneratedByFfmpegFallback', { count: pairs.length });
          } else {
            pushLogI18n('adobeUtilities.log.ffmpegFallbackProducedNoProxiesForGroup');
          }
        } catch (err) {
          pushLogI18n('adobeUtilities.log.ffmpegFallbackGenerationFailed', { error: err.message || err });
        }
      }
    } else if (config.generateProxies) {
      pushLogI18n('adobeUtilities.log.ameNotDetectedSkippingForcedQueue');
    }

    // (Second temp‑EPR pass removed — attachments handled per‑group above.)

    if (totalCreated > 0) {
      pushLogI18n('adobeUtilities.log.proxyFilesCreatedCount', { count: totalCreated });
    }
  } else {
    // No proxies: fire-and-forget CEP run (import/bins). JSX will emit completion.
    ingestEligibleCount = Array.isArray(config.sources) ? config.sources.length : 0;
    if (global.cepBridge && ingestEligibleCount > 0) {
      global.cepBridge.broadcast({ type: 'runIngestWorkflow', config });
      ingestDispatched = true;
      pushLogI18n('adobeUtilities.log.sentIngestNoProxiesToCep');
    } else if (config.importPremiere) {
      pushLogI18n('adobeUtilities.log.skippingCepIngestNoEligibleFiles');
    }
  }

  // ⛔ Do NOT print the final summary here for proxy runs.
  // The proxies path completes asynchronously in JSX; printing now creates
  // a misleading "No proxies found..." line and confuses the panels.
  if (!config.generateProxies) {
    jobLogger.setStage('complete');
    await logJobCompletion();
  }

  if (enableN8N) {
    if (n8nUrl) {
      const n8nValidation = validateN8nUrl(n8nUrl, {
        allowPrivate: n8nAllowPrivate,
        allowlist: n8nAllowlist
      });
      if (!n8nValidation.valid) {
        pushLog(n8nValidation.message || t('adobeUtilities.log.n8nUrlBlockedByValidation'), {
          isError: true
        });
        pushLogI18n('adobeUtilities.log.skippingWebhookDueToInvalidUrl');
      }

      const payload = n8nLog
        ? { log }
        : {
            status: 'complete',
            panel: 'adobe-utilities',
            success: true,
            sources: Array.isArray(config.sources) ? config.sources.length : 0,
            destination: config.destination || '',
            importedIntoPremiere: !!config.importPremiere,
            generatedProxies: !!config.generateProxies
          };

      if (n8nValidation.valid) {
        pushLogI18n('adobeUtilities.log.preparingWebhookSend', { url: n8nValidation.url });
        pushLogI18n('adobeUtilities.log.payloadPreview', { payload: JSON.stringify(payload, null, 2) });

        try {
          const response = await fetchWithTimeout(n8nValidation.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            let snippet = '';
            try {
              const bodyText = await response.text();
              if (bodyText) {
                snippet = bodyText.trim().slice(0, 200);
              }
            } catch {}
            const snippetSuffix = snippet ? ` — ${snippet}` : '';
            pushLogI18n('adobeUtilities.log.webhookResponseNotOk', {
              status: response.status,
              statusText: response.statusText,
              snippetSuffix
            });
          } else {
            pushLogI18n('adobeUtilities.log.webhookTriggered');
          }
        } catch (err) {
          if (err?.name === 'TimeoutError') {
            pushLogI18n('adobeUtilities.log.webhookTimedOut', { error: err?.message || err });
          } else {
            pushLogI18n('adobeUtilities.log.failedToTriggerWebhook', { error: err?.message || err });
          }
        }
      }
    } else {
      pushLogI18n('adobeUtilities.log.webhookEnabledNoUrlProvided');
    }
  }

  // Only write the log immediately for jobs that truly end here (no proxies).
  if (!config.generateProxies && config.saveLog && (config.destination || backupEnabled)) {
    persistJobLogs({ closeLogger: false });
    const baseDir = config.destination || backupPath;
    const targetLabel = config.destination ? 'destination' : 'backup';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `AdobeAutomateLog_${timestamp}.txt`;
    const logPath = path.join(baseDir, filename);

    try {
      let wrote = false;
      if (archivePath && fs.existsSync(archivePath)) {
        fs.copyFileSync(archivePath, logPath);
        savedJobReportCopies.add(logPath);
        wrote = true;
      } else {
        wrote = !!writeLogToFile(log, logPath);
        savedJobReportCopies.add(logPath);
      }
      if (wrote) {
        pushLogI18n('adobeUtilities.log.logSaved', { targetLabel, logPath });
      } else {
        pushLogI18n('adobeUtilities.log.failedToWriteLogAtPath', { targetLabel, logPath });
      }
    } catch (err) {
      pushLogI18n('adobeUtilities.log.failedToWriteLogWithError', { targetLabel, error: err?.message || err });
    }
  }

  const finalPayload = {
    id: config.jobId,
    panel: 'adobe-utilities',
    status: 'completed',
    source: 'backend',
    config
  };

  try {
    // Only self-finalize when proxies are NOT enabled.
    if (!finalPayload.config?.generateProxies) {
      const shouldEmitCompletion = finalPayload.config?.emitCompletion === true;
      jobLogger.setStage('complete');
      updateReportStats({ cancelled: false });
      structuredLogPath = structuredLogPath || jobLogger.getStructuredLogPath?.() || writeJobLogToFile(
        'adobe-utilities',
        config.jobId,
        jobLogger.getEntries()
      );
      persistJobLogs({ rewriteText: true });
      refreshSavedJobReportCopies();
      const result = {
        success: true,
        cancelled: false,
        log,
        logText: log.join('\n'),
        archivePath,
        structuredLogPath,
        jobId: config.jobId,
        config
      };
      finalPayload.result = result;

      if (shouldEmitCompletion) {
        global.queue?.emit('job-progress', {
          id: config.jobId,
          panel: 'adobe-utilities',
          stage: 'complete',
          status: 'complete',
          percent: 100
        });
        global.queue?.emit('job-complete', finalPayload);
        if (global.cepBridge) {
          global.cepBridge.broadcast({
            type: 'queue-job-complete',
            panel: 'adobe-utilities',
            job: finalPayload
          });
        }
      }
    }
  } catch (err) {
    console.error('⚠️ Final completion emit failed:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // PROXY PATH (MIRROR OLD): finish on either
  //  • JSX 'queue-job-complete'  (origin:'jsx'), OR
  //  • 'queue-job-progress' with stage:'proxies', status:'complete', percent:100.
  // Also be tolerant to missing jobId on these packets (OLD was).
  // Clean up and write the final summary/log at the moment of true finish.
  // ─────────────────────────────────────────────────────────────
  if (finalPayload.config?.generateProxies && global.cepBridge) {
    return await new Promise(resolve => {
      let settled = false;
      let doneTimer = null;
      let watchdogTimer = null;
      let watchdogInFlight = false;
      let ffmpegFallbackUsed = false;

      const proxyDest = String(config.proxyDest || '');
      const plannedProxySources = Array.isArray(config.proxySources) && config.proxySources.length
        ? config.proxySources.slice()
        : Array.isArray(config.sources) && config.sources.length
          ? config.sources.slice()
          : Array.isArray(sourceList)
            ? sourceList.slice()
            : [];

      let lastSnapshot = { fileCount: 0, totalBytes: 0, newestMtime: 0 };
      let lastActivityAt = Date.now();
      let watchdogStartedAt = Date.now();
      let allProxiesStableSince = null;

      const requestPremiereProxyReset = () => {
        try {
          global.cepBridge?.broadcast?.({
            type: 'premiere-reset-proxy-state',
            opts: { clearAll: true }
          });
        } catch {
          // best-effort
        }
      };

      const safeAttachPairs = (pairs, tag = 'attach') => {
        if (!pairs || !Array.isArray(pairs) || pairs.length === 0) return;
        const attachPairs = pairs.map(p => ({
          original: destPathMap?.get?.(p.original) || p.original,
          proxy: p.proxy
        }));
        try {
          broadcastProxyAttach(attachPairs);
          pushLogI18n('adobeUtilities.log.sentProxyLinksToPremiere', { tag, count: attachPairs.length });
        } catch {
          // best-effort
        }
      };

      const finalize = async (originHint = 'jsx', opts = {}) => {
        if (settled) return;
        settled = true;
        try { clearTimeout(doneTimer); } catch {}
        try { clearTimeout(watchdogTimer); } catch {}
        try { global.cepBridge?.off?.('queue-job-complete', onMessage); } catch {}
        try { global.cepBridge?.off?.('queue-job-progress', onMessage); } catch {}
        try { global.cepBridge?.off?.('message', onMessage); } catch {}
        try { removeForward?.(); } catch {}
        if (config.jobId) activeAdobeJobs.delete(config.jobId);

        const success = opts.success !== false;
        const cancelled = !!opts.cancelled;
        const error = opts.error ? String(opts.error) : null;
        const usedFfmpegFallback = !!opts.usedFfmpegFallback;

        jobLogger.setStage(cancelled ? 'cancelled' : success ? 'complete' : 'error');

        try {
          await logJobCompletion();
        } catch {
          // keep finalization moving even if summary logging hiccups
        }
        if (config.saveLog && config.destination) {
          persistJobLogs({ closeLogger: false });
          try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `AdobeAutomateLog_${timestamp}.txt`;
            const baseDir = config.destination;
            const logPath = require('path').join(baseDir, filename);
            if (archivePath && fs.existsSync(archivePath)) {
              fs.copyFileSync(archivePath, logPath);
              savedJobReportCopies.add(logPath);
            } else {
              writeLogToFile?.(log, logPath);
              savedJobReportCopies.add(logPath);
            }
            pushLogI18n('adobeUtilities.log.logSaved', { targetLabel: 'destination', logPath });
          } catch {}
        }

        updateReportStats({
          cancelled,
          usedFfmpegFallback,
        });

        structuredLogPath = structuredLogPath || jobLogger.getStructuredLogPath?.() || writeJobLogToFile(
          'adobe-utilities',
          config.jobId,
          jobLogger.getEntries()
        );

        persistJobLogs({ rewriteText: true });
        refreshSavedJobReportCopies();

        const result = {
          success,
          cancelled,
          log,
          logText: log.join('\n'),
          archivePath,
          structuredLogPath,
          jobId: config.jobId,
          config,
          ...(usedFfmpegFallback ? { usedFfmpegFallback: true } : {}),
          ...(error ? { error } : {})
        };

        // One authoritative completion with final log (renderer expects this)
        // IMPORTANT: never send AbortSignals / cancel tokens / controller objects over IPC.
        // Electron must structured-clone payloads; these objects are not serializable.
        const configForIPC = (() => {
          if (!config || typeof config !== 'object') return config;
          const c = { ...config };
          // common non-serializable fields we may have attached in QueueManager/processJob
          if ('signal' in c) c.signal = undefined;
          if ('abortSignal' in c) c.abortSignal = undefined;
          if ('controller' in c) c.controller = undefined;
          if ('abortController' in c) c.abortController = undefined;
          return c;
        })();

        const resultPayload = {
          id: config.jobId,
          panel: 'adobe-utilities',
          status: cancelled ? 'cancelled' : success ? 'completed' : 'failed',
          source: 'backend',
          origin: originHint,
          config: configForIPC,
          result
        };
        try {
          if (cancelled) {
            global.cepBridge?.broadcast({
              type: 'queue-job-cancelled',
              panel: 'adobe-utilities',
              id: config.jobId
            });
          } else {
            global.cepBridge?.broadcast({
              type: 'queue-job-complete',
              panel: 'adobe-utilities',
              job: resultPayload
            });
          }
        } catch {}
        if (success) {
          try {
            global.queue?.emit('job-progress', {
              id: config.jobId,
              panel: 'adobe-utilities',
              stage: 'complete',
              status: 'complete',
              percent: 100
            });
            global.queue?.emit('job-complete', resultPayload);
          } catch {}
        }
        resolve(result);
      };

      const armFallback = () => {
        try { clearTimeout(doneTimer); } catch {}
        // short grace in case the explicit complete lands right after proxies:complete
        doneTimer = setTimeout(() => finalize('progress'), 1200);
      };

      const finalizeCancelled = () => finalize('cancelled', { success: false, cancelled: true });
      const finalizeError = (message, origin = 'error') =>
        finalize(origin, { success: false, error: message });

      const performFfmpegFallback = async reason => {
        if (ffmpegFallbackUsed || settled) return;
        ffmpegFallbackUsed = true;

        pushLogI18n('adobeUtilities.log.ffmpegFallbackEngaged', { reason });

        // Stop any potentially-stuck JSX proxy poller/job bookkeeping so it doesn't run forever.
        requestPremiereProxyReset();

        const scan = await resolveExistingProxyPairsForSources(
          plannedProxySources,
          proxyDest,
          ameProxyPresetExt
        );

        const existingPairs = scan.pairs || [];
        const missingSources = scan.missingSources || [];

        if (existingPairs.length) {
          pushLogI18n('adobeUtilities.log.foundExistingProxyFilesAttemptAttach', { count: existingPairs.length });
          safeAttachPairs(existingPairs, 'existing');
        }

        if (missingSources.length) {
          pushLogI18n('adobeUtilities.log.generatingMissingProxyFilesViaFfmpeg', { count: missingSources.length });
          try {
            const groupCfg = {
              ...config,
              sources: missingSources,
              importPremiere: false,
              proxyPreset: MATCH_SOURCE_SENTINEL
            };

            const createdPairs = await generateProxiesWithFFmpeg(groupCfg, pushLog, generatedProxies);
            trackNewProxies(createdPairs.map(p => p.proxy));

            const allPairs = [...existingPairs, ...createdPairs];
            safeAttachPairs(allPairs, 'fallback');
          } catch (err) {
            const msg = `FFmpeg fallback failed: ${String(err?.message || err)}`;
            pushLogI18n('adobeUtilities.log.errorWithMessage', { message: msg });
            return finalizeError(msg, 'ffmpeg-fallback');
          }
        } else {
          pushLogI18n('adobeUtilities.log.noMissingProxiesProceedFinalize');
        }

        finalize('ffmpeg-fallback', { usedFfmpegFallback: true });
      };

      const sameJob = d => {
        if (!d) return false;
        const jobId = d.jobId || d.id;
        const matchId = d?.job?.jobId || d?.job?.id || jobId;
        // OLD tolerated empty/omitted jobId; only reject on a *mismatched* non-empty id
        if (!config.jobId) return true;
        if (!matchId) return true;
        return String(config.jobId) === String(matchId);
      };

      const onMessage = msg => {
        let d;
        try { d = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch { return; }
        if (!d || (d.panel && d.panel !== 'adobe-utilities')) return;
        const type = d.type || '';

        if (type === 'queue-job-complete') {
          const isJsx = d?.origin === 'jsx' || d?.job?.origin === 'jsx';
          if (isJsx && sameJob(d)) return finalize('jsx');
          return;
        }
        if (type === 'queue-job-progress') {
          if (!sameJob(d)) return;
          const st = String(d.stage || '').toLowerCase();
          const status = String(d.status || '').toLowerCase();
          const pct = Number(d.percent || 0);

          // Any proxy progress implies activity (prevents false stall).
          if (st === 'proxies') {
            lastActivityAt = Date.now();
          }

          // Explicit AME error → fallback (or fail if disabled).
          if (st === 'proxies' && status === 'error') {
            const detail = d.message || d.error || d.detail || '';
            const reason = detail ? `AME proxy error: ${detail}` : 'AME proxy error.';
            if (ffmpegFallbackEnabled) {
              void performFfmpegFallback(reason);
            } else {
              finalizeError(`AME proxy generation failed and FFmpeg fallback is disabled. ${reason}`, 'ame-error');
            }
            return;
          }

          if (st === 'proxies' && status === 'complete' && pct >= 100) {
            armFallback();
          }
        }
      };

      global.cepBridge.on('queue-job-complete', onMessage);
      global.cepBridge.on('queue-job-progress', onMessage);
      global.cepBridge.on('message', onMessage);

      const watchdogTick = async () => {
        if (settled) return;
        if (watchdogInFlight) return;
        watchdogInFlight = true;

        const iterationStartedAt = Date.now();
        let scanDurationMs = 0;
        let filesVisited = 0;

        try {
          // Cancellation should always break the wait (especially for stalled AME runs).
          if (config.signal?.aborted) {
            return finalizeCancelled();
          }

          // No disk watcher possible without a proxy dest.
          if (!proxyDest || !plannedProxySources.length) {
            return;
          }

          const scanStartedAt = Date.now();
          const scan = await resolveExistingProxyPairsForSources(
            plannedProxySources,
            proxyDest,
            ameProxyPresetExt
          );
          scanDurationMs = Date.now() - scanStartedAt;

          const snap = scan.snapshot || {};
          filesVisited = Number(snap.fileCount || scan.items?.length || 0);
          const changed =
            snap.totalBytes !== lastSnapshot.totalBytes ||
            snap.newestMtime !== lastSnapshot.newestMtime ||
            snap.fileCount !== lastSnapshot.fileCount;

          if (changed) {
            lastActivityAt = Date.now();
            lastSnapshot = snap;
            allProxiesStableSince = null;
          }

          const missing = scan.missingSources || [];
          const now = Date.now();

          // If every proxy file exists on disk and appears stable, finalize even if JSX never emits.
          if (missing.length === 0 && plannedProxySources.length > 0) {
            if (!allProxiesStableSince) allProxiesStableSince = now;
            const stableForMs = now - allProxiesStableSince;
            if (stableForMs >= 25000 && !settled) {
              pushLogI18n('adobeUtilities.log.allProxyFilesDetectedFinalizingViaWatchdog');
              safeAttachPairs(scan.pairs, 'watchdog');
              requestPremiereProxyReset();
              return finalize('watchdog');
            }
          }

          // Only do AME stall detection if we actually dispatched an AME proxy job.
          const watchAme = !forceFfmpegForMatchSource && ameProxyDispatched;
          if (!watchAme) return;

          const sinceStart = now - watchdogStartedAt;
          const sinceActivity = now - lastActivityAt;

          // Grace period for AME to spin up.
          const startupGraceMs = 90000;
          if (sinceStart < startupGraceMs) return;

          // If we haven't seen any disk/progress activity for a while, assume AME is wedged.
          const stallThresholdMs = 180000;
          if (sinceActivity < stallThresholdMs) return;

          const ameRunning = await isAdobeMediaEncoderRunning();
          const runningNote = ameRunning === null ? 'unknown' : ameRunning ? 'running' : 'not running';
          const reason = `No proxy activity for ${Math.round(sinceActivity / 1000)}s (AME ${runningNote}).`;

          if (ffmpegFallbackEnabled) {
            void performFfmpegFallback(reason);
          } else {
            finalizeError(`AME stalled and FFmpeg fallback disabled. ${reason}`, 'ame-stall');
          }
        } finally {
          const iterationDurationMs = Date.now() - iterationStartedAt;
          if (process.env.NODE_ENV === 'production') {
            pushLogI18n('adobeUtilities.log.watchdogIteration', {
              scanDurationMs,
              iterationDurationMs,
              filesVisited
            });
          }

          watchdogInFlight = false;
          // Schedule next tick (randomized "check randomly" behavior).
          if (!settled) {
            try { clearTimeout(watchdogTimer); } catch {}
            watchdogTimer = setTimeout(watchdogTick, jitterMs(25000, 55000));
          }
        }
      };

      // Prime the watchdog snapshot and start random checks.
      if (proxyDest && plannedProxySources.length) {
        void resolveExistingProxyPairsForSources(
          plannedProxySources,
          proxyDest,
          ameProxyPresetExt
        )
          .then(scan => {
            lastSnapshot = scan.snapshot || lastSnapshot;
          })
          .catch(() => {
            // ignore
          });
      }

      // Defensive: if proxies are enabled but we never dispatched a proxy job AND we didn't
      // start FFmpeg proxy generation inline, fail fast (prevents silent hangs).
      const ffmpegRanInline = forceFfmpegForMatchSource || (!ameAvailable && ffmpegFallbackEnabled);
      if (!ffmpegRanInline && !ameProxyDispatched) {
        return finalizeError('No proxy job was dispatched (and no FFmpeg proxy run started).', 'proxy-dispatch');
      }

      // Start watchdog ticks for cancellation + AME stall detection.
      watchdogTimer = setTimeout(watchdogTick, jitterMs(15000, 25000));
    });
  }

  // No proxies: finish immediately (legacy behavior).
  try { removeForward?.(); } catch {}
  if (config.jobId) activeAdobeJobs.delete(config.jobId);
  if (!structuredLogPath) {
    jobLogger.setStage('complete');
    structuredLogPath = structuredLogPath || jobLogger.getStructuredLogPath?.() || null;
  }

  persistJobLogs();
  refreshSavedJobReportCopies();

  const hardFail =
    (config.destination && copyOkCount === 0) ||
    (config.importPremiere && ingestEligibleCount === 0 && Array.isArray(sourceList) && sourceList.length > 0);

  return {
    success: !hardFail,
    cancelled: false,
    log,
    logText: log.join('\n'),
    archivePath,
    structuredLogPath,
    jobId: config.jobId,
    config
  };
}

function cancelAdobeUtilities(jobId) {
  const job = activeAdobeJobs.get(jobId);
  if (job) {
    job.cancelled = true;
    sendLogMessage(
      'adobe-utilities',
      `🛑 Cancel requested for ${jobId}`,
      '',
      false,
      jobId,
      'warn',
      jobId,
      'cancel-request',
      { jobId },
      Date.now()
    );
    activeAdobeJobs.delete(jobId);
    if (global.cepBridge) {
      global.cepBridge.broadcast({
        type: 'queue-job-cancelled',
        panel: 'adobe-utilities',
        id: jobId
      });
    }
  }
}

module.exports = {
  runAdobeUtilities,
  cancelAdobeUtilities,
  validateAdobeConfig,
  StageProgressManager
};
