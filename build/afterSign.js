/*
  build/afterSign.js

  electron-builder afterSign hook

  Purpose:
  - Notarize the signed .app so end users don't get Gatekeeper warnings like:
      “Apple could not verify … is free of malware…”

  Notes:
  - This hook runs AFTER signing but BEFORE the final distributable format
    (e.g. DMG) is produced. This is the right time to notarize.
  - Only runs on macOS builds, and only when credentials are present.

  Required env vars (pick ONE auth strategy):

  Strategy A (app-specific password):
    APPLE_ID
    APPLE_APP_SPECIFIC_PASSWORD
    APPLE_TEAM_ID

  Strategy B (keychain profile created by `xcrun notarytool store-credentials`):
    APPLE_NOTARYTOOL_PROFILE

  This file intentionally NEVER hardcodes credentials.
*/

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

function tryRequireElectronNotarize() {
  try {
    // electron-builder may already pull this in transitively in some setups.
    // We treat it as optional and fall back to `xcrun notarytool` if missing.
     
    return require('@electron/notarize');
  } catch {
    return null;
  }
}

function createNotarizationZip(appPath) {
  const base = path.basename(appPath).replace(/\.app$/i, '');
  const zipPath = path.join(os.tmpdir(), `${base}-${Date.now()}.zip`);

  // `ditto` preserves resource forks and is the Apple-recommended zipper for .app bundles.
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'inherit' });
  return zipPath;
}

function notarizeWithNotarytoolZip(zipPath) {
  const profile = process.env.APPLE_NOTARYTOOL_PROFILE;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  const args = ['notarytool', 'submit', zipPath, '--wait'];

  if (profile && profile.trim()) {
    args.push('--keychain-profile', profile.trim());
  } else {
    args.push('--apple-id', appleId, '--password', appleIdPassword, '--team-id', teamId);
  }

  execFileSync('xcrun', args, { stdio: 'inherit' });
}

async function notarizeApp(appPath) {
  const lib = tryRequireElectronNotarize();
  const profile = process.env.APPLE_NOTARYTOOL_PROFILE;

  // Prefer @electron/notarize when available (it handles zipping and waiting internally).
  if (lib && typeof lib.notarize === 'function') {
    if (profile && profile.trim()) {
      await lib.notarize({ appPath, keychainProfile: profile.trim() });
      return;
    }

    const appleId = process.env.APPLE_ID;
    const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
    const teamId = process.env.APPLE_TEAM_ID;
    await lib.notarize({ appPath, appleId, appleIdPassword, teamId });
    return;
  }

  // Fallback: use Apple's `notarytool` directly.
  const zipPath = createNotarizationZip(appPath);
  try {
    notarizeWithNotarytoolZip(zipPath);
  } finally {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      // ignore
    }
  }
}

function tryStaple(appPath) {
  try {
    execFileSync('xcrun', ['stapler', 'staple', '-v', appPath], { stdio: 'inherit' });
  } catch (err) {
    // stapling isn't strictly required (Gatekeeper can fetch tickets online), but it's nice.
    // Don't fail the build on stapler issues.
     
    console.warn('[afterSign] stapler failed (continuing):', err?.message || err);
  }
}

function hasCreds() {
  if (process.env.APPLE_NOTARYTOOL_PROFILE && process.env.APPLE_NOTARYTOOL_PROFILE.trim()) {
    return true;
  }
  return Boolean(
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
  );
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.NOTARIZE_APP !== '1') {
     
    console.log('[afterSign] app notarization skipped (PKG-only shipping). Set NOTARIZE_APP=1 to enable.');
    return;
  }

  if (!hasCreds()) {
     
    console.log('[afterSign] notarization skipped (missing APPLE_* env vars)');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[afterSign] app not found for notarization: ${appPath}`);
  }

   
  console.log('[afterSign] notarizing app:', appPath);
  await notarizeApp(appPath);
   
  console.log('[afterSign] notarization complete');

  tryStaple(appPath);
};

module.exports = exports.default;
