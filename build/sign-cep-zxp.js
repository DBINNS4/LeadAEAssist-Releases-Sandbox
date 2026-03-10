'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFileSync } = require('child_process');

const EXT_ID = 'com.leadae.panel';

const ROOT = path.resolve(__dirname, '..');
const ZXPSIGN = path.join(ROOT, 'tools', 'zxpsigncmd', 'CEP-Resources', 'ZXPSignCMD', '4.1.3', 'macOS', 'ZXPSignCmd');

const SRC_EXT = path.join(ROOT, 'cep', 'extensions', EXT_ID);
const STAGE_DIR = path.join(ROOT, 'build', 'cep_signing', EXT_ID);
const OUT_DIR = path.join(ROOT, 'resources', 'cep', 'zxp');
const OUT_ZXP = path.join(OUT_DIR, 'LeadAEAssist_CEP.zxp');

const P12 = process.env.CEP_P12_PATH;
const P12_PASS = process.env.CEP_P12_PASSWORD;
const TSA = process.env.CEP_TSA_URL || 'http://time.certum.pl/';

function die(msg) {
  console.error(`[sign-cep-zxp] ERROR: ${msg}`);
  process.exit(1);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function run(cmd, args) {
  console.log(`[sign-cep-zxp] ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

async function main() {
  if (!exists(ZXPSIGN)) die(`ZXPSignCmd not found at ${ZXPSIGN}`);
  if (!exists(SRC_EXT)) die(`CEP source folder not found at ${SRC_EXT}`);
  if (!P12 || !P12_PASS) die(`Missing env vars: CEP_P12_PATH and/or CEP_P12_PASSWORD`);
  if (!exists(P12)) die(`P12 not found at ${P12}`);

  // Fresh stage
  await fsp.rm(path.join(ROOT, 'build', 'cep_signing'), { recursive: true, force: true });
  await fsp.mkdir(path.join(ROOT, 'build', 'cep_signing'), { recursive: true });
  await fsp.mkdir(OUT_DIR, { recursive: true });

  // Use rsync to exclude Finder junk
  run('/usr/bin/rsync', ['-a', '--delete', '--exclude', '.DS_Store', '--exclude', '__MACOSX', `${SRC_EXT}/`, `${STAGE_DIR}/`]);

  const manifest = path.join(STAGE_DIR, 'CSXS', 'manifest.xml');
  if (!exists(manifest)) die(`Staged extension missing CSXS/manifest.xml at ${manifest}`);

  // Sign + timestamp
  run(ZXPSIGN, ['-sign', STAGE_DIR, OUT_ZXP, P12, P12_PASS, '-tsa', TSA]);
  
  // Verify
  run(ZXPSIGN, ['-verify', OUT_ZXP, '-certInfo']);

  if (!exists(OUT_ZXP)) die(`Expected output ZXP not created at ${OUT_ZXP}`);

  console.log(`[sign-cep-zxp] OK: ${OUT_ZXP}`);
}

main().catch(err => die(err && err.stack ? err.stack : String(err)));
