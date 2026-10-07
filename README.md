# GitPulse

Local-first Git dashboard for desktop (Tauri v2 · Rust · React/TypeScript · Tailwind). It finds every Git repository on your drives, keeps them up to date in real time, and lets you browse commits and diffs like on GitHub. Nothing leaves your machine, and GitPulse never modifies a repository.

## Features

- **All drives by default** – scans every available drive; toggle individual drives or enter custom folders to scan only those.
- **Persistent** – results are cached in the app data directory (`cache.json`), so the app opens instantly with your last scan. Cached repos are re-checked in the background on startup; a full background rescan runs only if the last scan is older than 12 hours (or on the first launch).
- **Real time** – a recursive `notify` watcher on the scanned drives (Windows/macOS) updates dirty/ahead/behind state, branches and history as you work, and automatically adds newly created repositories and removes deleted ones. On Linux each known repository is watched instead (new repositories appear after a rescan).
- **Fast and light** – non-blocking parallel scan (`jwalk`) with live progress, Cancel, and a 2-thread low-priority mode for background rescans; system/dependency folders are skipped; events are debounced (400 ms); the repository table is virtualized; commits load 50 at a time.
- **Repository overview** – branch, upstream, ahead/behind, remote, last commit, and modified/staged/untracked/deleted/conflicted counts. Click the header counters (repositories, dirty, unpushed, behind) to filter the list.
- **GitHub-style commit view** – full message, author/committer, hashes, parents, per-file Added/Modified/Deleted/Renamed status with +/− counts, and line-numbered diffs.
- **Always tells you what it is doing** – splash screen on launch, a status bar (starting, scanning folder X, inspecting repo N/M, checking for changes, idle/watching), a welcome card on first run, and a live progress panel during scans.
- **Working-tree details** – click the modified/staged/untracked/deleted/conflict counters (or their rows) to list the exact files.
- **Responsive** – layout adapts from phone-width windows to ultrawide (columns collapse, the detail panel becomes an overlay on narrow windows); drag the panel edge to resize it (width is remembered).
- **Settings (⚙)** – add your own folder names to skip while scanning (saved with the cache).
- **Accessible** – keyboard friendly (`/` or Ctrl+K focuses the filter, `Esc` closes panels), visible focus rings, ARIA labels, live status announcements, reduced-motion support.
- **Robust** – single running instance, app-wide error screen, strict Content-Security-Policy, lazily rendered diffs.
- **Actions** – open a terminal in the repository, or open its remote in the browser (shown only for repos with commits and a web remote).
- Window, taskbar and executable icons come from `src-tauri/icons/app-icon.svg`.

## Development

Requires Node.js 20+ and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev
```

Opening the Vite URL in a browser shows a notice instead of data, since native features need the Tauri runtime.

## Build

```bash
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml   # needs git on PATH
npm run tauri build
```

Tagging a release (`git tag v1.0.0 && git push origin v1.0.0`) builds Windows (NSIS), macOS (DMG) and Linux (AppImage) bundles via GitHub Actions. CI runs type-check, frontend build and `cargo test` on every push.

## Project layout

- `src-tauri/src/main.rs` – scanner, Git inspection, cache, live watcher, commands
- `src/App.tsx` – entire UI
- `src-tauri/icons/` – generated from `app-icon.svg` with `npx tauri icon src-tauri/icons/app-icon.svg`

## Data

The cache lives in the OS app-data folder for `com.gitpulse.desktop` (on Windows `%APPDATA%\com.gitpulse.desktop\cache.json`). Delete it to reset. Repositories on drives that are currently disconnected stay in the list until the drive returns.

## Notes for users

• The installers are unsigned. Windows SmartScreen shows "Unknown publisher"; click More info → Run anyway.
• On macOS, right-click the app and choose Open the first time.

**Note**: before moving this project, delete src-tauri\target and node_modules, since both are regenerated anyway. This also keeps the folder small. Both are already in .gitignore.

## License

MIT

Not included: code signing and auto-update (they need your own certificates/keys).
