# Startup Notes

## IPC filesystem bridge mode

The default and supported startup path is the **async IPC filesystem bridge** exposed by `preload.js` (`readdirAsync`, `mkdirAsync`, `copyFileAsync`, `readTextFileAsync`, `writeTextFileAsync`, `fileExistsAsync`, `fsStat`).

### Temporary legacy fallback

If you must temporarily run older sync-only renderer flows while migrating, you can opt in to the legacy sync bridge helpers by setting:

```bash
LEAD_AE_ENABLE_LEGACY_SYNC_FS=1
```

This is a short-term compatibility workaround only. Remove it once async bridge wiring is available in your target environment.

## Sync IPC budget

`ipcRenderer.sendSync` is budgeted for boot-critical, one-time preload reads only (currently app info + user data path).

When adding helpers that can run in loops, render passes, drag/drop, file grids, or progress updates, expose an async `ipcRenderer.invoke` path and use it from renderer code. Prefer batching (`Promise.all`) over per-item chatty sync calls.

## Auto-update preference canonical default

`preferences.autoUpdateCheckOnLaunch` has a canonical product default of `true`.

QA validation expectations:
- **First run / seeded config**: `config/state.json` should initialize `preferences.autoUpdateCheckOnLaunch` to `true`.
- **Preferences reset**: using **Reset Preferences** in the UI should restore `autoUpdateCheckOnLaunch` to `true`.
