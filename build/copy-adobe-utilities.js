/*
  build/copy-adobe-utilities.js

  Packaging helper.

  The Electron app's index.html conditionally loads CEP's CSInterface.js from:
    resources/cep/extensions/com.leadae.panel/CSInterface.js

  Source-of-truth lives in:
    cep/extensions/com.leadae.panel/

  This script treats cep/extensions as canonical and regenerates
  resources/cep/extensions from it so packaged builds always have
  the expected relative path.

  It is safe to run multiple times.
*/

const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyRecursive(src, dst) {
  // Node >=16: fs.cpSync exists
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true, force: true });
    return;
  }

  // Fallback for older Nodes
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dst);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const src = path.join(projectRoot, 'cep', 'extensions');
  const dst = path.join(projectRoot, 'resources', 'cep', 'extensions');

  if (!fs.existsSync(src)) {
    console.warn(`[copy-adobe-utilities] Source CEP extensions directory not found: ${src}`);
    process.exit(0);
  }

  // Canonical source-of-truth is cep/extensions. Remove destination first so
  // stale files cannot survive across runs.
  fs.rmSync(dst, { recursive: true, force: true });
  ensureDir(path.dirname(dst));
  copyRecursive(src, dst);

  // Basic sanity check for the main file index.html expects
  const csInterface = path.join(dst, 'com.leadae.panel', 'CSInterface.js');
  if (!fs.existsSync(csInterface)) {
    console.warn(`[copy-adobe-utilities] WARNING: CSInterface.js not found after copy: ${csInterface}`);
  } else {
    console.log(`[copy-adobe-utilities] Copied CEP extensions to ${dst}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[copy-adobe-utilities] Failed:', err);
    process.exit(1);
  }
}
