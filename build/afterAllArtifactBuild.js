 
// build/afterAllArtifactBuild.js
// SAFE PKG notarization + stapling.
//
// CRITICAL:
// - DO NOT modify the PKG contents here (no expand/flatten, no injection).
// - electron-builder will embed pkg scripts via "build.pkg.scripts".
// - This hook only notarizes the final .pkg output artifact.
//
// Requires ONE of:
//  - APPLE_NOTARYTOOL_PROFILE
// or
//  - APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD (+ APPLE_TEAM_ID recommended)

'use strict';

const { spawn } = require('child_process');

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function getNotaryArgs(filePath) {
  const profile = process.env.APPLE_NOTARYTOOL_PROFILE;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  const args = ['notarytool', 'submit', filePath, '--wait'];

  if (profile && profile.trim()) {
    args.push('--keychain-profile', profile.trim());
    return args;
  }

  if (appleId && appleIdPassword) {
    args.push('--apple-id', appleId, '--password', appleIdPassword);
    if (teamId) args.push('--team-id', teamId);
    return args;
  }

  return null;
}

function shouldNotarizePkgs() {
  // Allow an explicit kill switch if you ever need to skip notarization in CI.
  if (process.env.NOTARIZE_PKG === '0') return false;
  return true;
}

exports.default = async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== 'darwin') return;
  if (!shouldNotarizePkgs()) {
    console.log('[afterAllArtifactBuild] PKG notarization disabled (NOTARIZE_PKG=0)');
    return;
  }

  const artifactPaths = Array.isArray(buildResult?.artifactPaths)
    ? buildResult.artifactPaths
    : (Array.isArray(buildResult) ? buildResult : []);

  const pkgs = artifactPaths.filter(
    (p) => typeof p === 'string' && p.toLowerCase().endsWith('.pkg')
  );

  if (pkgs.length === 0) return;

  for (const pkgPath of pkgs) {
    const notaryArgs = getNotaryArgs(pkgPath);
    if (!notaryArgs) {
      throw new Error(
        '[afterAllArtifactBuild] Missing notarytool auth. Set APPLE_NOTARYTOOL_PROFILE or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD (and APPLE_TEAM_ID).'
      );
    }

    console.log(`[afterAllArtifactBuild] Notarizing PKG: ${pkgPath}`);
    await spawnAsync('xcrun', notaryArgs);

    console.log(`[afterAllArtifactBuild] Stapling PKG: ${pkgPath}`);
    await spawnAsync('xcrun', ['stapler', 'staple', '-v', pkgPath]);
  }
};

module.exports = exports.default;
