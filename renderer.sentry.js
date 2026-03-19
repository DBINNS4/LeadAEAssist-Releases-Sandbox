/*
  renderer.sentry.js

  Sentry renderer init bundle.

  This file is bundled via webpack into:
    dist-obfuscated/renderer.sentry.js

  Why a bundle?
  - This app's BrowserWindows run with nodeIntegration: false and contextIsolation: true.
  - Renderer scripts cannot import npm packages directly.
  - We bundle the official Sentry Electron renderer SDK so it can run in the isolated
    renderer context without exposing Node/Electron globals.

  Notes:
  - The main process owns DSN/release/environment and the consent gate.
  - Per Sentry's Electron SDK docs, renderer init can be called without options.
  - This init is best-effort: telemetry must never brick the UI.
*/

import { init } from '@sentry/electron/renderer';

try {
  // Initialize as early as possible in the renderer.
  // Do not pass DSN here; the main process owns DSN/release/env.
  init();
} catch (err) {
  // Never crash the app UI because telemetry failed.
   
  console.warn('[telemetry] Sentry renderer init failed:', err);
}
