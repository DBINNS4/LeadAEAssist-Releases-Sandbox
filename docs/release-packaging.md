# Release Packaging

## Prerequisites

### Supported host OS

- Packaging is configured for macOS distribution artifacts (`zip` and `pkg`, arm64).
- Run release packaging on a macOS host with Xcode command line tools and Apple signing access.

### Required environment variables

Set these in your shell/CI environment before running a signing/notarized package build:

- `LEADAE_BUILD_ENV` — runtime selection mode (`sandbox` or `prod`).
- `CEP_P12_PATH` — path to the CEP signing certificate (`.p12`).
- `CEP_P12_PASSWORD` — password for the CEP signing certificate.
- `CSC_NAME` — Apple code-signing identity name used by electron-builder.
- `APPLE_NOTARYTOOL_PROFILE` — notarytool keychain profile used for notarization.

Optional override:

- `CEP_TSA_URL` — timestamp server URL for CEP signing.

## Supported packaging commands

Use `scripts/dist.sh` for all packaging builds. It selects the runtime config at build-time using `LEADAE_BUILD_ENV`, regenerates `config/public.runtime.selected.json`, stages runtime assets into `release/runtime-assets/`, refreshes `config/runtime.assets.manifest.json`, and writes a publish manifest to `release/runtime-assets/runtime.assets.manifest.json` before electron-builder runs.

### Canonical sandbox/test package

```bash
./scripts/dist.sh
```

### Canonical production release package

```bash
LEADAE_BUILD_ENV=prod ./scripts/dist.sh
```

> These commands assume your current directory is the repository root (`<repo-root>`).

## Runtime asset publish commands

The app bundle no longer carries Chromium or Whisper model files. `npm run assets:prepare` now produces:

- staged runtime assets under `release/runtime-assets/`
- updated packaged metadata in `config/runtime.assets.manifest.json`
- a release upload manifest at `release/runtime-assets/runtime.assets.manifest.json`

To upload the staged runtime assets to the GitHub release that matches the app version and selected runtime config:

```bash
npm run assets:publish -- --clobber
```

Optional source overrides for `npm run assets:prepare` / `./scripts/dist.sh`:

- `LEADAE_WHISPER_BASE_EN_PATH` — source file for `ggml-base.en.bin`
- `LEADAE_WHISPER_BASE_MULTI_PATH` — source file for `ggml-base.bin`
- `LEADAE_CHROMIUM_STAGE_DIR` — source directory for the staged Chrome-for-Testing tree
  - legacy alias: `LEADAE_PUPPETEER_CHROME_DIR`
  - default fallback: `vendor/puppeteer/chrome`

Requirements:

- `gh` must be installed and authenticated
- the matching GitHub release tag must already exist, unless you add `--create-if-missing`

To have `scripts/dist.sh` publish runtime assets immediately after electron-builder finishes, opt in with:

```bash
LEADAE_PUBLISH_RUNTIME_ASSETS=1 ./scripts/dist.sh
```

## Verification checklist

After packaging, verify the runtime config and runtime-assets behavior:

- Confirm `config/public.runtime.selected.json` exists and was regenerated during the build.
- Confirm `release/runtime-assets/runtime.assets.manifest.json` exists and contains the expected runtime asset checksums and download URLs.
- Confirm `LEADAE_BUILD_ENV=prod` produces production runtime values and `LEADAE_BUILD_ENV=sandbox` produces sandbox runtime values.
- Confirm packaging maps `config/public.runtime.selected.json` into the app as `config/public.runtime.json`.
- Confirm the packaged app includes `legal/LICENSE`, `legal/NOTICE`, `legal/THIRD_PARTY_LICENSES`, and `legal/APP-LICENSE.txt`.
- Confirm the packaged app can read `config/runtime.assets.manifest.json` from the bundle.
- Confirm the packaged app does **not** contain `Contents/Resources/puppeteer`.
- Confirm the packaged app does **not** contain `Contents/Resources/whisper.cpp/models`.

## Important

- Do **not** manually copy/switch runtime config files before release.
- Do **not** use ad-hoc runtime switching helpers for release builds.
- Do **not** reintroduce legacy Chrome prefetch helpers or vendored Chromium resources into packaging; Chrome is now a runtime asset, not a bundled dependency.
- The release path now fails automatically if runtime config content is inconsistent with `LEADAE_BUILD_ENV`.
