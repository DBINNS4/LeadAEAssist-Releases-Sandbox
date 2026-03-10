/*
  build/webpack.renderer.sentry.config.js

  Webpack config to bundle the Sentry Electron *renderer* SDK into a single file
  which can be loaded in our renderer with nodeIntegration disabled.

  Output:
    dist-obfuscated/renderer.sentry.js

  Constraints:
  - Must be CSP-safe: NO eval-based devtools, no inline source maps.
  - Must be deterministic: stable chunk/module IDs and a single output chunk.
  - Must not wipe dist-obfuscated/ (obfuscate-all.js writes other artifacts there).
*/

'use strict';

const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

module.exports = {
  mode: 'production',

  entry: {
    'renderer.sentry': path.join(projectRoot, 'renderer.sentry.js')
  },

  target: 'web',

  devtool: 'source-map',

  output: {
    path: path.join(projectRoot, 'dist-obfuscated'),
    filename: '[name].js',

    // IMPORTANT: Do not delete dist-obfuscated; obfuscate-all writes other files.
    clean: false,

    // Safer global reference in Electron renderer (avoids `window` in workers etc).
    globalObject: 'self'
  },

  // Deterministic, single-file bundle.
  optimization: {
    // Keep one file; no split chunks.
    splitChunks: false,
    runtimeChunk: false,

    // Deterministic build output across machines.
    moduleIds: 'deterministic',
    chunkIds: 'deterministic'
  },

  // Keep resolution predictable.
  resolve: {
    extensions: ['.js', '.mjs', '.json']
  },

  // Silence size warnings; this bundle may be large by design.
  performance: {
    hints: false
  }
};
