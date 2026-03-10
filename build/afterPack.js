 /*
  electron-builder afterPack hook

  Goals:
  - Ensure bundled helper binaries (ffmpeg/ffprobe) are executable after packaging.
  - Keep hook resilient across platforms/targets.
  - Ensure embedded Python + OpenSSL are fully relocatable (no /Library/Frameworks deps),
    so WhisperX HTTPS works on clean macOS 12+ Apple Silicon machines.

  Notes:
  - We intentionally keep this minimal and side-effect-limited.
  - This runs after files have been copied into the app bundle.
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PY_VER = '3.11';

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

function listRpaths(machoPath) {
  const out = execFileSync('/usr/bin/otool', ['-l', machoPath], { encoding: 'utf8' });
  const lines = out.split('\n');
  const rpaths = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'cmd LC_RPATH') {
      // look ahead for "path <...> (offset ...)"
      for (let j = i; j < Math.min(i + 10, lines.length); j++) {
        const m = lines[j].trim().match(/^path (.+) \(offset \d+\)$/);
        if (m) rpaths.push(m[1]);
      }
    }
  }
  return rpaths;
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function findFirstExisting(candidates) {
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

function safeRmTree(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function isExecutableMode(mode) {
  // Any of the execute bits set.
  return (mode & 0o111) !== 0;
}

function shouldKeepExecutable(filePath, venvRoot) {
  // Preserve executability for venv/bin/* (mac/linux) or venv/Scripts/* (windows)
  // and for native shared objects.
  const rel = path.relative(venvRoot, filePath).replace(/\\/g, '/');
  if (rel.startsWith('bin/')) return true;
  if (rel.startsWith('Scripts/')) return true;

  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.so') ||
    lower.endsWith('.dylib') ||
    lower.endsWith('.node')
  );
}

function tryChmod(p, mode) {
  try {
    fs.chmodSync(p, mode);
    return true;
  } catch {
    return false;
  }
}

function collectDirsAndFiles(rootDir) {
  const stack = [rootDir];
  const dirs = [];
  const files = [];

  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        dirs.push(p);
        stack.push(p);
      } else if (ent.isFile()) {
        files.push(p);
      }
    }
  }

  return { dirs, files };
}

function resolveUnpackedVenvPath(context) {
  // The venv may be bundled either directly into Resources/venv (current Lead AE Assist layout)
  // or inside app.asar.unpacked/venv (alternate layout).
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    const direct = path.join(
      context.appOutDir,
      appName,
      'Contents',
      'Resources',
      'venv'
    );

    if (fs.existsSync(direct)) return direct;

    const unpacked = path.join(
      context.appOutDir,
      appName,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'venv'
    );
    return unpacked;
  }

  const direct = path.join(context.appOutDir, 'resources', 'venv');
  if (fs.existsSync(direct)) return direct;
  return path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'venv');
}

function resolveEmbeddedPythonRoot(context) {
  // We copy python_embedded into Contents/Resources/python_embedded
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    return path.join(
      context.appOutDir,
      appName,
      'Contents',
      'Resources',
      'python_embedded'
    );
  }
  return path.join(context.appOutDir, 'resources', 'python_embedded');
}

function prunePythonEmbeddedCaches(context) {
  const pyRoot = resolveEmbeddedPythonRoot(context);
  if (!fs.existsSync(pyRoot)) return { prunedDirs: 0, prunedFiles: 0, pyRoot };

  let prunedDirs = 0;
  let prunedFiles = 0;

  const { dirs, files } = collectDirsAndFiles(pyRoot);
  for (const d of dirs) {
    if (path.basename(d) === '__pycache__') {
      if (safeRmTree(d)) prunedDirs++;
    }
  }
  for (const f of files) {
    if (f.toLowerCase().endsWith('.pyc')) {
      if (safeUnlink(f)) prunedFiles++;
    }
  }

  return { prunedDirs, prunedFiles, pyRoot };
}

function patchPythonOpenSSLOnMac({ dstFramework }) {
  // Make embedded Python SSL fully relocatable:
  // - _ssl + _hashlib must NOT reference /Library/Frameworks/.../libssl|libcrypto
  // - libssl/libcrypto install-ids must be @rpath/...
  // - Python executable must have LC_RPATH @loader_path/lib so @rpath resolves to Versions/3.11/lib
  //
  // This prevents WhisperX HTTPS failures on clean machines.
  if (!dstFramework || !fs.existsSync(dstFramework)) {
    return { didWork: false, reason: 'dstFramework missing' };
  }

  const verRoot = path.join(dstFramework, 'Versions', PY_VER);
  const pyExe = path.join(verRoot, 'Python');
  const libDir = path.join(verRoot, 'lib');
  const dynloadDir = path.join(verRoot, 'lib', `python${PY_VER}`, 'lib-dynload');

  const sysLibSSL = `/Library/Frameworks/Python.framework/Versions/${PY_VER}/lib/libssl.3.dylib`;
  const sysLibCrypto = `/Library/Frameworks/Python.framework/Versions/${PY_VER}/lib/libcrypto.3.dylib`;

  const libSSL = path.join(libDir, 'libssl.3.dylib');
  const libCrypto = path.join(libDir, 'libcrypto.3.dylib');

  const sslSo = path.join(dynloadDir, `_ssl.cpython-311-darwin.so`);
  const hashlibSo = path.join(dynloadDir, `_hashlib.cpython-311-darwin.so`);

  const results = {
    didWork: true,
    pyExe,
    libSSL,
    libCrypto,
    sslSo,
    hashlibSo,
    ops: []
  };

  const mustExist = [pyExe, libSSL, libCrypto, sslSo, hashlibSo];
  for (const p of mustExist) {
    if (!fs.existsSync(p)) {
      throw new Error(`[afterPack] missing Python/OpenSSL component: ${p}`);
    }
  }

  const run = (args) => {
    execFileSync('/usr/bin/install_name_tool', args, { stdio: 'inherit' });
    results.ops.push(args.join(' '));
  };

  // 1) Fix dylib install-ids to be portable.
  //    (Avoids dylibs identifying themselves as /Library/Frameworks/... which breaks relocation.)
  run(['-id', '@rpath/libssl.3.dylib', libSSL]);
  run(['-id', '@rpath/libcrypto.3.dylib', libCrypto]);
  run(['-change', sysLibCrypto, '@rpath/libcrypto.3.dylib', libSSL]);

  // 2) Ensure extension modules depend on @rpath, not /Library/Frameworks and not absolute app paths.
  // _ssl links to both libssl + libcrypto
  run(['-change', sysLibSSL, '@rpath/libssl.3.dylib', sslSo]);
  run(['-change', sysLibCrypto, '@rpath/libcrypto.3.dylib', sslSo]);
  // _hashlib links to libcrypto
  run(['-change', sysLibCrypto, '@rpath/libcrypto.3.dylib', hashlibSo]);

  // 3) Ensure Python executable has the correct rpath for @rpath/libssl.3.dylib to resolve.
  //    Python lives at: Versions/3.11/Python
  //    libssl/libcrypto live at: Versions/3.11/lib/
  //    therefore: @loader_path/lib is correct.
  const otoolL = execFileSync('/usr/bin/otool', ['-l', pyExe], { encoding: 'utf8' });

  // If an incorrect rpath is present (common mistake), remove it.
  if (otoolL.includes('@loader_path/../lib')) {
    run(['-delete_rpath', '@loader_path/../lib', pyExe]);
  }

  // Add correct rpath if missing.
  const otoolL2 = execFileSync('/usr/bin/otool', ['-l', pyExe], { encoding: 'utf8' });
  if (!otoolL2.includes('@loader_path/lib')) {
    run(['-add_rpath', '@loader_path/lib', pyExe]);
  }

  // 4) Safety check: ensure _ssl no longer references /Library/Frameworks.
  const sslLinks = execFileSync('/usr/bin/otool', ['-L', sslSo], { encoding: 'utf8' });
  if (sslLinks.includes('/Library/Frameworks/Python.framework')) {
    throw new Error(`[afterPack] _ssl still references system Python.framework:\n${sslLinks}`);
  }

  const hashlibLinks = execFileSync('/usr/bin/otool', ['-L', hashlibSo], { encoding: 'utf8' });
  if (hashlibLinks.includes('/Library/Frameworks/Python.framework')) {
    throw new Error(`[afterPack] _hashlib still references system Python.framework:\n${hashlibLinks}`);
  }

  return results;
}

function patchPythonFrameworkOnMac(context) {
  if (context.electronPlatformName !== 'darwin') return { didWork: false };

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appRoot = path.join(context.appOutDir, appName, 'Contents');
  const frameworks = path.join(appRoot, 'Frameworks');

  const venvRoot = resolveUnpackedVenvPath(context);
  const pyEmbedRoot = resolveEmbeddedPythonRoot(context);

  const srcFramework = path.join(pyEmbedRoot, 'Python.framework');
  const dstFramework = path.join(frameworks, 'Python.framework');
  const dstPyLib = path.join(dstFramework, 'Versions', PY_VER, 'Python');

  if (!fs.existsSync(srcFramework)) {
    throw new Error(`[afterPack] missing python framework source: ${srcFramework}`);
  }

  // Copy the framework into Contents/Frameworks (so dyld can resolve it via @rpath)
  ensureDir(frameworks);
  if (!fs.existsSync(dstFramework)) {
    execFileSync('/usr/bin/ditto', [srcFramework, dstFramework], { stdio: 'inherit' });
  }

  // Make the Python dylib itself relocatable.
  execFileSync(
    '/usr/bin/install_name_tool',
    ['-id', `@rpath/Python.framework/Versions/${PY_VER}/Python`, dstPyLib],
    { stdio: 'inherit' }
  );

  const SYSTEM_PYLIB = `/Library/Frameworks/Python.framework/Versions/${PY_VER}/Python`;
  const BUNDLED_PYLIB = `@rpath/Python.framework/Versions/${PY_VER}/Python`;

  const toPosix = (p) => p.split(path.sep).join('/');

  const computeFrameworksRpath = (realBinPath) => {
    const rel = path.relative(path.dirname(realBinPath), frameworks);
    return `@loader_path/${toPosix(rel)}`;
  };

  const ensureRpath = (realBinPath, rpath) => {
    const otoolL = execFileSync('/usr/bin/otool', ['-l', realBinPath], { encoding: 'utf8' });
    if (!otoolL.includes(rpath)) {
      execFileSync('/usr/bin/install_name_tool', ['-add_rpath', rpath, realBinPath], {
        stdio: 'inherit'
      });
    }
  };

  const patchBinary = (binPath, label) => {
    if (!fs.existsSync(binPath)) return { label, binPath, realBinPath: null, skipped: true };

    const realBinPath = fs.realpathSync(binPath);
    const linksBefore = execFileSync('/usr/bin/otool', ['-L', realBinPath], { encoding: 'utf8' });

    // Only patch if this binary actually links against the system framework path.
    if (linksBefore.includes(SYSTEM_PYLIB)) {
      execFileSync(
        '/usr/bin/install_name_tool',
        ['-change', SYSTEM_PYLIB, BUNDLED_PYLIB, realBinPath],
        { stdio: 'inherit' }
      );
    }

    const rpath = computeFrameworksRpath(realBinPath);
    ensureRpath(realBinPath, rpath);

    const linksAfter = execFileSync('/usr/bin/otool', ['-L', realBinPath], { encoding: 'utf8' });
    if (linksAfter.includes(SYSTEM_PYLIB)) {
      throw new Error(
        `[afterPack] ${label} still links to system /Library/Frameworks Python.framework:\n${linksAfter}`
      );
    }

    return { label, binPath, realBinPath, rpath, skipped: false };
  };

  // Patch every python entrypoint we might accidentally execute.
  const pyBinVenv = path.join(venvRoot, 'bin', 'python3.11');
  const pyBinVenvAlt = path.join(venvRoot, 'bin', 'python3');

  if (!fs.existsSync(pyBinVenv) && !fs.existsSync(pyBinVenvAlt)) {
    throw new Error(
      `[afterPack] missing venv python executable (expected ${pyBinVenv} or ${pyBinVenvAlt})`
    );
  }

  const pyBinFramework = path.join(dstFramework, 'Versions', PY_VER, 'bin', 'python3.11');
  const pyBinFrameworkAlt = path.join(dstFramework, 'Versions', PY_VER, 'bin', 'python3');

  const pyAppBin = path.join(
    dstFramework,
    'Versions',
    PY_VER,
    'Resources',
    'Python.app',
    'Contents',
    'MacOS',
    'Python'
  );

  const patched = [
    patchBinary(pyBinVenv, 'venv python3.11'),
    patchBinary(pyBinVenvAlt, 'venv python3'),
    patchBinary(pyBinFramework, 'framework python3.11'),
    patchBinary(pyBinFrameworkAlt, 'framework python3'),
    patchBinary(pyAppBin, 'Python.app launcher')
  ];

  const patchedCount = patched.filter((p) => !p.skipped).length;
  if (patchedCount === 0) {
    throw new Error(
      '[afterPack] could not find any python entrypoints to patch (checked venv + framework + Python.app)'
    );
  }

  // NEW: ensure OpenSSL linkage is fully relocatable and rpaths are correct.
  const openSSL = patchPythonOpenSSLOnMac({ dstFramework });

  return { didWork: true, pyBin: pyBinVenv, dstFramework, patched, openSSL };
}

function pruneVenvForSigning(context) {
  const venvRoot = resolveUnpackedVenvPath(context);
  if (!fs.existsSync(venvRoot)) return { pruned: 0, deexec: 0, venvRoot };

  let pruned = 0;
  let deexec = 0;

  // 1) Remove Python cache directories (huge win: size + signing time)
  //    Do this first because it can eliminate thousands of tiny files.
  const { dirs, files } = collectDirsAndFiles(venvRoot);
  for (const d of dirs) {
    if (path.basename(d) === '__pycache__') {
      if (safeRmTree(d)) pruned++;
    }
  }

  // 2) Remove stray .pyc files that may have slipped in via extraResources.
  for (const f of files) {
    if (f.toLowerCase().endsWith('.pyc')) {
      if (safeUnlink(f)) pruned++;
    }
  }

  // 3) Remove executable bit from non-executables to stop electron-builder from
  //    attempting to codesign arbitrary files (e.g., .pyc, .json, etc.).
  //
  //    Keep executable permissions for venv/bin/* and native shared libs.
  const { files: files2 } = collectDirsAndFiles(venvRoot);
  for (const f of files2) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }

    if (!st.isFile()) continue;

    const mode = st.mode & 0o777;
    if (!isExecutableMode(mode)) continue;
    if (shouldKeepExecutable(f, venvRoot)) continue;

    // Remove execute bits while preserving read/write bits.
    const newMode = mode & ~0o111;
    if (newMode !== mode && tryChmod(f, newMode)) deexec++;
  }

  return { pruned, deexec, venvRoot };
}

function fixWhisperCppDylibsOnMac(context) {
  if (!isMac(context)) return { didWork: false };

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resources = path.join(context.appOutDir, appName, 'Contents', 'Resources');

  const whisperBin = path.join(resources, 'whisper-static', 'bin', 'whisper-cli');
  if (!fs.existsSync(whisperBin)) {
    throw new Error(`[afterPack] whisper-cli missing at: ${whisperBin}`);
  }

  // Source dylibs currently being bundled from the whisper.cpp build tree
  const srcW = path.join(resources, 'whisper.cpp', 'build_compat', 'src');
  const srcG = path.join(resources, 'whisper.cpp', 'build_compat', 'ggml', 'src');
  // Whisper models are runtime assets now; only the build outputs stay bundled here.
  // If build_compat is absent, skip the dylib extraction step entirely.
  if (!fs.existsSync(srcW)) {
    return { didWork: false, skipped: true, reason: `missing build_compat (expected ${srcW})` };
  }
  const srcB = path.join(srcG, 'ggml-blas');

  // Find the versioned libwhisper dylib (e.g. libwhisper.1.7.5.dylib)
  let libwhisperVersioned = null;
  try {
    const entries = fs.readdirSync(srcW);
    libwhisperVersioned = entries.find((n) => /^libwhisper\.1\..+\.dylib$/.test(n));
  } catch {
    // handled below by the existence checks
  }
  if (!libwhisperVersioned) {
    throw new Error(`[afterPack] could not find libwhisper.1.*.dylib in: ${srcW}`);
  }

  const srcLibWhisper = path.join(srcW, libwhisperVersioned);
  const srcGgml = path.join(srcG, 'libggml.dylib');
  const srcGgmlBase = path.join(srcG, 'libggml-base.dylib');
  const srcGgmlCpu = path.join(srcG, 'libggml-cpu.dylib');
  const srcGgmlBlas = path.join(srcB, 'libggml-blas.dylib');

  const required = [srcLibWhisper, srcGgml, srcGgmlBase, srcGgmlCpu, srcGgmlBlas];
  for (const p of required) {
    if (!fs.existsSync(p)) {
      throw new Error(`[afterPack] missing whisper/ggml dylib in bundle: ${p}`);
    }
  }

  // Destination: next to whisper-cli so @loader_path/../lib works with @rpath/*
  const dstLibDir = path.join(resources, 'whisper-static', 'lib');
  ensureDir(dstLibDir);

  execFileSync('/usr/bin/ditto', [srcLibWhisper, path.join(dstLibDir, path.basename(srcLibWhisper))], {
    stdio: 'inherit'
  });
  execFileSync('/usr/bin/ditto', [srcGgml, path.join(dstLibDir, 'libggml.dylib')], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', [srcGgmlBase, path.join(dstLibDir, 'libggml-base.dylib')], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', [srcGgmlCpu, path.join(dstLibDir, 'libggml-cpu.dylib')], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', [srcGgmlBlas, path.join(dstLibDir, 'libggml-blas.dylib')], { stdio: 'inherit' });

  // Provide the exact filename the whisper-cli binary expects
  const linkPath = path.join(dstLibDir, 'libwhisper.1.dylib');
  safeUnlink(linkPath);
  fs.symlinkSync(path.basename(srcLibWhisper), linkPath);

  // Make the dylib's install id relocatable (helps if anything else references it)
  try {
    execFileSync(
      '/usr/bin/install_name_tool',
      ['-id', '@rpath/libwhisper.1.dylib', path.join(dstLibDir, path.basename(srcLibWhisper))],
      {
        stdio: 'inherit'
      }
    );
  } catch {
    // ignore; not fatal for loading
  }

  // Ensure @rpath resolves to ../lib relative to whisper-cli
  try {
    execFileSync('/usr/bin/install_name_tool', ['-add_rpath', '@loader_path/../lib', whisperBin], {
      stdio: 'inherit'
    });
  } catch {
    // ignore if already present
  }

  return { didWork: true, whisperBin, dstLibDir };
}

function fixWhisperStaticOnMac(context, bundleName = 'whisper-static') {
  if (context.electronPlatformName !== 'darwin') return { didWork: false, skipped: true, reason: 'not darwin' };

  const appResources = context.appOutDir
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'Contents', 'Resources');

  const whisperCli = path.join(appResources, bundleName, 'bin', 'whisper-cli');
  if (!fs.existsSync(whisperCli)) {
    return { didWork: false, skipped: true, reason: `missing whisper-cli at ${whisperCli}` };
  }

  const projectRoot = context.packager.projectDir;

  // Source dylibs from the repo build output (NOT bundled in the app)
  const srcLibWhisper = findFirstExisting([
    path.join(projectRoot, 'whisper.cpp', 'build_compat', 'src', 'libwhisper.1.7.5.dylib')
    // fallback: any libwhisper.1.*.dylib
  ]);
  let libwhisperReal = srcLibWhisper;
  if (!libwhisperReal) {
    const srcDir = path.join(projectRoot, 'whisper.cpp', 'build_compat', 'src');
    if (fs.existsSync(srcDir)) {
      const cand = fs.readdirSync(srcDir).find((f) => /^libwhisper\.1\..+\.dylib$/.test(f));
      if (cand) libwhisperReal = path.join(srcDir, cand);
    }
  }
  if (!libwhisperReal) {
    return { didWork: false, skipped: false, reason: 'missing libwhisper build output in whisper.cpp/build_compat/src' };
  }

  const srcGgmlDir = path.join(projectRoot, 'whisper.cpp', 'build_compat', 'ggml', 'src');
  const srcGgmlBlasDir = path.join(srcGgmlDir, 'ggml-blas');

  const needed = [
    { src: libwhisperReal, dstName: 'libwhisper.1.dylib' },
    { src: path.join(srcGgmlDir, 'libggml.dylib'), dstName: 'libggml.dylib' },
    { src: path.join(srcGgmlDir, 'libggml-base.dylib'), dstName: 'libggml-base.dylib' },
    { src: path.join(srcGgmlDir, 'libggml-cpu.dylib'), dstName: 'libggml-cpu.dylib' },
    { src: path.join(srcGgmlBlasDir, 'libggml-blas.dylib'), dstName: 'libggml-blas.dylib' }
  ];

  // Copy dylibs into the app next to whisper-cli
  const dstLibDir = path.join(appResources, bundleName, 'lib');
  ensureDir(dstLibDir);

  for (const item of needed) {
    if (!fs.existsSync(item.src)) {
      return { didWork: false, skipped: false, reason: `missing required dylib source: ${item.src}` };
    }
    const dst = path.join(dstLibDir, item.dstName);
    copyFile(item.src, dst);
  }

  // Fix dylib IDs to @rpath names (so they load from our added rpath)
  const run = (args) => execFileSync('/usr/bin/install_name_tool', args, { stdio: 'inherit' });
  for (const item of needed) {
    const dst = path.join(dstLibDir, item.dstName);
    run(['-id', `@rpath/${item.dstName}`, dst]);
  }

  // Fix whisper-cli rpaths: remove dev paths; add loader_path-based rpath
  const currentRpaths = listRpaths(whisperCli);
  for (const rp of currentRpaths) {
    if (rp.includes('/Users/') || rp.includes('whisper.cpp/build_compat')) {
      try {
        run(['-delete_rpath', rp, whisperCli]);
      } catch {
        /* ignore */
      }
    }
  }
  // Ensure our packaged lib directory is on rpath
  run(['-add_rpath', '@loader_path/../lib', whisperCli]);

  // Rewrite whisper-cli dependencies to @rpath/* (explicit)
  const deps = [
    'libwhisper.1.dylib',
    'libggml.dylib',
    'libggml-base.dylib',
    'libggml-cpu.dylib',
    'libggml-blas.dylib'
  ];
  for (const d of deps) {
    // replace any previous reference (absolute or @rpath) with @rpath/<d>
    run(['-change', d, `@rpath/${d}`, whisperCli]);
    run(['-change', `@rpath/${d}`, `@rpath/${d}`, whisperCli]);
  }

  return { didWork: true };
}

function normalizeWhisperStaticDylibRpathsOnMac(context) {
  if (context.electronPlatformName !== 'darwin') return { didWork: false, skipped: true, reason: 'not darwin' };

  const appResources = context.appOutDir
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'Contents', 'Resources');

  const whisperRoot = path.join(appResources, 'whisper-static');
  if (!fs.existsSync(whisperRoot)) {
    return { didWork: false, skipped: true, reason: `missing whisper-static at ${whisperRoot}` };
  }

  // We scrub LC_RPATH entries inside shipped dylibs because whisper.cpp builds can embed
  // absolute build-machine paths (e.g. /Users/.../whisper.cpp/build_compat/...).
  //
  // Strategy:
  //  - delete any absolute rpath (starts with "/") that is not inside the app bundle
  //  - ensure "@loader_path" exists so @rpath/lib*.dylib resolves within the same folder
  //
  // This is intentionally conservative: it only touches whisper-static dylibs.
  const installNameTool = '/usr/bin/install_name_tool';
  const appRoot = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  const shouldDeleteRpath = (rp) => {
    if (!rp) return false;
    if (rp === '@loader_path') return false;
    if (rp.startsWith('@')) return false; // @loader_path, @executable_path, etc.
    if (!rp.startsWith('/')) return false; // non-absolute, keep
    // Keep absolute rpaths that are actually inside the app bundle (rare, but safe).
    // Anything outside the bundle is non-relocatable by definition.
    try {
      const rel = path.relative(appRoot, rp);
      const insideBundle = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (insideBundle) return false;
    } catch {
      // fall through to delete
    }
    return true;
  };

  const run = (args) => execFileSync(installNameTool, args, { stdio: 'inherit' });

  // Scan whisper-static for any dylibs, including future toolchain folders
  // like whisper-static/metal/lib/*.dylib.
  const { files } = collectDirsAndFiles(whisperRoot);
  const dylibs = files.filter((f) => f.toLowerCase().endsWith('.dylib'));
  if (dylibs.length === 0) {
    return { didWork: false, skipped: true, reason: 'no dylibs found under whisper-static' };
  }

  let deleted = 0;
  let added = 0;
  for (const f of dylibs) {
    let rpaths = [];
    try {
      rpaths = listRpaths(f);
    } catch {
      continue;
    }

    for (const rp of rpaths) {
      if (!shouldDeleteRpath(rp)) continue;
      try {
        run(['-delete_rpath', rp, f]);
        deleted++;
      } catch {
        /* ignore */
      }
    }

    // Ensure @loader_path exists (idempotent).
    try {
      const rpaths2 = listRpaths(f);
      if (!rpaths2.includes('@loader_path')) {
        run(['-add_rpath', '@loader_path', f]);
        added++;
      }
    } catch {
      /* ignore */
    }
  }

  return { didWork: true, scanned: dylibs.length, deleted, added, whisperRoot };
}

function chmodIfExists(p, mode = 0o755) {
  try {
    if (fs.existsSync(p)) {
      fs.chmodSync(p, mode);
      return true;
    }
  } catch {
    // swallow; packaging should not fail due to chmod
  }
  return false;
}

function candidateBinaryPaths(context) {
  const candidates = [];

  const pushDirFiles = (dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile()) candidates.push(p);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  };

  // macOS (.app bundle)
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    const resources = path.join(context.appOutDir, appName, 'Contents', 'Resources');
    const unpacked = path.join(resources, 'app.asar.unpacked');

    // ffmpeg/ffprobe shipped with the app
    candidates.push(path.join(unpacked, 'extra', 'ffmpeg', 'ffmpeg'));
    candidates.push(path.join(unpacked, 'extra', 'ffmpeg', 'ffprobe'));

    // whisper.cpp / whisper-static helper binaries.
    // These MUST be executable + signed under hardened runtime, or macOS may SIGKILL them at launch.
    pushDirFiles(path.join(resources, 'whisper-static', 'bin'));
    pushDirFiles(path.join(unpacked, 'whisper-static', 'bin'));
    pushDirFiles(path.join(resources, 'whisper.cpp', 'bin'));
    pushDirFiles(path.join(resources, 'whisper.cpp', 'build', 'bin'));
  }

  // Windows/Linux (directory-based)
  // Most targets place app resources under a 'resources' directory next to the exe.
  const resources = path.join(context.appOutDir, 'resources');
  const unpacked = path.join(resources, 'app.asar.unpacked');

  candidates.push(path.join(unpacked, 'extra', 'ffmpeg', 'ffmpeg'));
  candidates.push(path.join(unpacked, 'extra', 'ffmpeg', 'ffprobe'));
  candidates.push(path.join(unpacked, 'extra', 'ffmpeg', 'ffmpeg.exe'));
  candidates.push(path.join(unpacked, 'extra', 'ffmpeg', 'ffprobe.exe'));

  // whisper-static (Windows/Linux/mac fallback if extraResources ended up in unpacked)
  pushDirFiles(path.join(resources, 'whisper-static', 'bin'));
  pushDirFiles(path.join(unpacked, 'whisper-static', 'bin'));

  // whisper.cpp binaries (if present)
  pushDirFiles(path.join(resources, 'whisper.cpp', 'bin'));
  pushDirFiles(path.join(resources, 'whisper.cpp', 'build', 'bin'));

  return [...new Set(candidates)];
}

function isMac(context) {
  return context.electronPlatformName === 'darwin';
}

function clearQuarantine(p) {
  try {
    if (!fs.existsSync(p)) return false;
    // Remove only the Gatekeeper quarantine attribute if present.
    execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', p], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

function resolveSigningIdentity(context) {
  // Prefer explicit env/config; fall back to electron-builder autodiscovery.
  const env = process.env.CSC_NAME || process.env.CODESIGN_IDENTITY;
  if (env && env.trim()) return env.trim();

  const opt = context?.packager?.platformSpecificBuildOptions;
  const id = opt?.identity;
  if (typeof id === 'string' && id.trim()) return id.trim();
  return null;
}

function codesignIfPossible(identity, p) {
  if (!identity) return false;
  try {
    if (!fs.existsSync(p)) return false;
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', p], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

function isMachOFile(p) {
  try {
    if (!fs.existsSync(p)) return false;
    const out = execFileSync('/usr/bin/file', ['-b', p], { encoding: 'utf8' });
    return typeof out === 'string' && out.includes('Mach-O');
  } catch {
    return false;
  }
}

function codesignOne(identity, p, { entitlementsPath = null, runtime = false } = {}) {
  if (!identity) return false;
  try {
    if (!fs.existsSync(p)) return false;
    if (!isMachOFile(p)) return false;

    const args = ['--force', '--sign', identity, '--timestamp'];
    if (runtime) args.push('--options', 'runtime');
    if (entitlementsPath && fs.existsSync(entitlementsPath)) {
      args.push('--entitlements', entitlementsPath);
    }
    args.push(p);
    execFileSync('/usr/bin/codesign', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function signVenvMachO(context, identity) {
  if (context.electronPlatformName !== 'darwin') return { signed: 0, scanned: 0, venvRoot: null };

  const venvRoot = resolveUnpackedVenvPath(context);
  if (!venvRoot || !fs.existsSync(venvRoot)) return { signed: 0, scanned: 0, venvRoot };

  // Use your inherited entitlements for spawned/helper binaries.
  const entitlementsInherit =
    context?.packager?.platformSpecificBuildOptions?.entitlementsInherit ||
    path.join(context.packager.projectDir, 'build', 'entitlements.mac.inherit.plist');

  // 1) Sign venv/bin executables (python + entrypoints) with runtime+entitlements.
  let signed = 0;
  let scanned = 0;
  const binDir = path.join(venvRoot, 'bin');
  if (fs.existsSync(binDir)) {
    const entries = fs.readdirSync(binDir);
    for (const name of entries) {
      const p = path.join(binDir, name);
      scanned++;
      // Only sign real files we might execute
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      if (codesignOne(identity, p, { entitlementsPath: entitlementsInherit, runtime: true })) signed++;
    }
  }

  // 2) Sign native extensions (.so/.dylib) with plain codesign (no runtime/entitlements).
  // These are what torch/ctranslate2/etc load, and they're currently adhoc/mixed.
  const { files } = collectDirsAndFiles(venvRoot);
  for (const f of files) {
    const lower = f.toLowerCase();
    if (!(lower.endsWith('.so') || lower.endsWith('.dylib'))) continue;
    scanned++;
    if (codesignOne(identity, f, { runtime: false })) signed++;
  }

  return { signed, scanned, venvRoot };
}

module.exports = async function afterPack(context) {
  // IMPORTANT:
  // electron-builder may attempt to codesign any file that is marked executable.
  // If our bundled Python venv contains files with stray +x bits (common when
  // copying venvs across systems), mac signing can stall for a long time.
  //
  // We proactively:
  //  - remove __pycache__ and .pyc
  //  - strip executable bits from non-executables
  // before the app bundle is signed.
  const venvResult = pruneVenvForSigning(context);
  const pyEmbed = prunePythonEmbeddedCaches(context);
  const pyPatch = patchPythonFrameworkOnMac(context);
  const whisperFix = fixWhisperCppDylibsOnMac(context);
  if (whisperFix.didWork) {
     
    console.log(`[afterPack] fixed whisper.cpp dylibs for whisper-cli (lib dir: ${whisperFix.dstLibDir})`);
  }

  // Fix whisper-static whisper-cli dylib loading (ship required dylibs and correct rpaths)
  try {
    const whisperStaticFix = fixWhisperStaticOnMac(context, 'whisper-static');
    if (whisperStaticFix?.didWork) {
       
      console.log('[afterPack] fixed whisper-static dylib loading for whisper-cli');
    } else if (whisperStaticFix?.skipped) {
       
      console.log('[afterPack] whisper-static fix skipped:', whisperStaticFix.reason || '');
    } else if (whisperStaticFix?.reason) {
      throw new Error(`[afterPack] whisper-static fix failed: ${whisperStaticFix.reason}`);
    }
  } catch (e) {
    throw e;
  }

  // Fix whisper-static-metal whisper-cli dylib loading (optional metal toolchain)
  try {
    const appResources = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources'
    );
    const metalRoot = path.join(appResources, 'whisper-static-metal');
    if (fs.existsSync(metalRoot)) {
      const whisperMetalFix = fixWhisperStaticOnMac(context, 'whisper-static-metal');
      if (whisperMetalFix?.didWork) {
         
        console.log('[afterPack] fixed whisper-static-metal dylib loading for whisper-cli');
      } else if (whisperMetalFix?.reason) {
        throw new Error(`[afterPack] whisper-static-metal fix failed: ${whisperMetalFix.reason}`);
      }
    } else {
       
      console.log('[afterPack] whisper-static-metal not present; skipping');
    }
  } catch (e) {
    throw e;
  }

  // Normalize LC_RPATH entries inside shipped whisper dylibs so they are relocatable.
  // (Prevents build-machine absolute paths from leaking into production dylibs.)
  try {
    const rpathFix = normalizeWhisperStaticDylibRpathsOnMac(context);
    if (rpathFix?.didWork) {
       
      console.log(
        `[afterPack] normalized whisper-static dylib rpaths: scanned=${rpathFix.scanned} deleted=${rpathFix.deleted} added=${rpathFix.added} root=${rpathFix.whisperRoot}`
      );
    } else if (rpathFix?.skipped) {
       
      console.log('[afterPack] whisper-static dylib rpath normalization skipped:', rpathFix.reason || '');
    }
  } catch (e) {
    throw e;
  }

  // Normalize whisper-static-metal dylib rpaths if present.
  try {
    const appResources = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources'
    );
    const metalRoot = path.join(appResources, 'whisper-static-metal');
    if (fs.existsSync(metalRoot)) {
      const { files } = collectDirsAndFiles(metalRoot);
      const dylibs = files.filter((f) => f.toLowerCase().endsWith('.dylib'));
      for (const f of dylibs) {
        let rpaths = [];
        try {
          rpaths = listRpaths(f);
        } catch {
          continue;
        }
        for (const rp of rpaths) {
          if (rp && rp.startsWith('/') && !rp.includes(`${context.packager.appInfo.productFilename}.app`)) {
            try {
              execFileSync('/usr/bin/install_name_tool', ['-delete_rpath', rp, f], { stdio: 'ignore' });
            } catch {
              // ignore
            }
          }
        }
        try {
          execFileSync('/usr/bin/install_name_tool', ['-add_rpath', '@loader_path', f], { stdio: 'ignore' });
        } catch {
          // ignore
        }
      }
       
      console.log(`[afterPack] normalized whisper-static-metal dylib rpaths: scanned=${dylibs.length}`);
    }
  } catch (e) {
    throw e;
  }

  if (pyPatch.didWork) {
    const patched = (pyPatch.patched || []).filter((p) => p && !p.skipped);
     
    console.log(
      `[afterPack] patched python entrypoints:\n${patched
        .map((p) => `- ${p.label}: ${p.realBinPath} (rpath=${p.rpath})`)
        .join('\n')}`
    );

    if (pyPatch.openSSL && pyPatch.openSSL.didWork) {
       
      console.log(
        `[afterPack] patched embedded Python OpenSSL for relocation:\n` +
          `- Python: ${pyPatch.openSSL.pyExe}\n` +
          `- libssl: ${pyPatch.openSSL.libSSL}\n` +
          `- libcrypto: ${pyPatch.openSSL.libCrypto}\n` +
          `- ops: ${pyPatch.openSSL.ops.length}`
      );
    }
  }

  const paths = candidateBinaryPaths(context);
  let touched = 0;
  let dequarantined = 0;
  let signed = 0;
  const identity = isMac(context) ? resolveSigningIdentity(context) : null;

  for (const p of paths) {
    if (chmodIfExists(p)) touched++;

    // Strip quarantine on macOS so we don't ship Gatekeeper-tainted helper tools.
    if (isMac(context) && clearQuarantine(p)) dequarantined++;

    // Ensure nested helper binaries are signed prior to app signing/notarization.
    if (isMac(context) && identity && codesignIfPossible(identity, p)) signed++;
  }

  // CRITICAL: venv code signing.
  // Without this, macOS can SIGKILL python when it loads torch/whisperx native extensions.
  let venvSigned = { signed: 0, scanned: 0, venvRoot: null };
  if (isMac(context) && identity) {
    venvSigned = signVenvMachO(context, identity);
    if (venvSigned.signed > 0) {
       
      console.log(
        `[afterPack] codesigned venv Mach-O files: signed=${venvSigned.signed} scanned=${venvSigned.scanned} root=${venvSigned.venvRoot}`
      );
    }
  }

  if (touched > 0) {
     
    console.log(`[afterPack] ensured executable permissions on ${touched} bundled binary/binaries`);
  }

  if (dequarantined > 0) {
     
    console.log(`[afterPack] removed quarantine attribute from ${dequarantined} bundled binary/binaries`);
  }

  if (signed > 0) {
     
    console.log(`[afterPack] codesigned ${signed} bundled binary/binaries (nested helper tools)`);
  }

  if (venvResult.pruned > 0 || venvResult.deexec > 0) {
     
    console.log(
      `[afterPack] pruned venv caches (${venvResult.pruned}) and stripped executable bits (${venvResult.deexec}) in ${venvResult.venvRoot}`
    );
  }

  if (pyEmbed.prunedDirs > 0 || pyEmbed.prunedFiles > 0) {
     
    console.log(
      `[afterPack] pruned python_embedded caches (dirs=${pyEmbed.prunedDirs}, files=${pyEmbed.prunedFiles}) in ${pyEmbed.pyRoot}`
    );
  }
};
