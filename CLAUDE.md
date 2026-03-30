# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (starts Vite dev server + Electron concurrently)
npm run dev

# Lint main process / all / renderer only
npm run lint
npm run lint:all
cd renderer && npm run lint

# Format
npm run format
npm run format:check

# Build renderer for production
npm run build

# Package (all platforms or specific)
npm run dist
npm run dist:linux   # or :win / :mac

# Unit tests (Vitest) — covers src/db/**, src/audio/**, src/usb/**
npm test
npx vitest run src/__tests__/trackRepository.test.js
npm run test:coverage

# Renderer unit tests (React Testing Library)
cd renderer && npm test
cd renderer && npx vitest run src/__tests__/MusicLibrary.contextmenu.test.jsx
cd renderer && npm run test:coverage

# E2E tests (Playwright) — not yet in CI
npm run test:e2e
```

**Before running tests**: the Electron app must be closed. `pretest` rebuilds `better-sqlite3` for Node.js (needed by Vitest); if Electron holds the `.node` file open the rebuild fails with EBUSY. `posttest` rebuilds it back for Electron automatically.

Coverage thresholds (v8): 65% statements/lines, 44% branches, 70% functions for `src/db/**`. Renderer thresholds are minimal (7%).

**Vitest projects** (`vitest.config.js`):

- `db` — tests needing real SQLite (in-memory via `DB_PATH=:memory:`): `trackRepository`, `playlistRepository`. Uses `src/__tests__/setup.js` which calls `initDB()`.
- `unit` — no DB, no setup: `importManager`, `ytDlpManager`, `mediaServer`, `anlzWriter`, `waveformGenerator`, `usbUtils`, `settingWriter`, `pdbWriter`.

## Architecture

Three distinct execution contexts:

1. **Main process** (`src/main.js`) — Node.js ESM. Owns SQLite database, file system, IPC handlers, local media HTTP server. Runs at startup before any window loads.

2. **Renderer process** (`renderer/`) — React 19 + Vite. Sandboxed browser context; no direct Node.js access. Communicates with main exclusively via `window.api` (exposed by preload).

3. **Worker threads** (`src/audio/analysisWorker.js`) — Spawned per-import by main. Runs `mixxx-analyzer` binary (BPM, key, loudness, intro/outro). Results go back via `parentPort.postMessage` → written to DB → pushed to renderer via `mainWindow.webContents.send('track-updated', ...)`.

### IPC Pattern

- `src/preload.js` (CommonJS — Electron requirement) bridges main ↔ renderer via `contextBridge.exposeInMainWorld('api', ...)`
- Main registers handlers: `ipcMain.handle('<channel>', handler)`
- Renderer calls: `window.api.<method>(...)` → `ipcRenderer.invoke('<channel>', ...)`
- **Adding a new IPC channel requires changes in all three**: `preload.js`, `main.js`, and the renderer component
- All `window.api.on*()` methods return a cleanup function — always call it in `useEffect` cleanup
- `global.mainWindow` is set in `main.js` so analysis worker result handlers can push IPC events to the renderer without importing BrowserWindow directly

### Dev Server Signaling

`npm run dev` uses a `.dev-url` file (not `wait-on http://localhost:5173`). Vite writes the URL to `.dev-url` when ready; Electron waits on `file:.dev-url`. The dev script deletes `.dev-url` first to avoid stale signals. `.dev-url` is gitignored.

### Audio Import Pipeline

```
selectAudioFiles → dialog → filePaths
importAudioFiles(filePaths) →
  for each file:
    1. SHA-1 hash → copy to userData/audio/{hash[0:2]}/{hash}.ext (deduplication)
    2. ffprobe → extract tags + format metadata
    3. addTrack() → insert row into SQLite (analyzed = 0)
    4. spawn Worker(analysisWorker.js, { filePath, trackId })
       → mixxx-analyzer binary (BPM, key, loudness, intro/outro)
       → parentPort.postMessage(result)
    5. updateTrack(trackId, analysis) → sets analyzed = 1
    6. send 'track-updated' IPC → renderer updates row in-place
```

`spawnAnalysis()` **must** attach `worker.on('error', ...)` and `worker.on('exit', ...)` — an unhandled `'error'` event on a Worker crashes the main process.

### Rekordbox USB Export Pipeline

`src/usb/` contains the full Pioneer CDJ-compatible export. Triggered via `export-rekordbox` / `export-all` IPC handlers in `main.js`.

```
export-rekordbox IPC →
  1. Collect tracks from playlist(s) (deduplicated by trackId)
  2. copyTrackToUsb() → copy audio to {usbRoot}/music/ (skipped if file exists)
  3. writeAnlz() → per track: ANLZ0000.DAT + .EXT + .2EX in PIONEER/USBANLZ/{hash}/
  4. writePdb() → export.pdb (DeviceSQL binary, full rebuild every time)
  5. writeSettingFiles() → PIONEER/MYSETTING.DAT, MYSETTING2.DAT, DEVSETTING.DAT
```

Key files:

- `src/audio/anlzWriter.js` — writes all ANLZ binary sections. Section order matters; PVBR **must** appear between PPTH and PQTZ in the DAT file or Rekordbox silently ignores waveform/beatgrid data.
- `src/audio/waveformGenerator.js` — generates waveform data from PCM via ffmpeg. `COLS_PER_SEC = 150` (not 10ms/col).
- `src/usb/pdbWriter.js` — pure JS DeviceSQL PDB writer.
- `src/usb/settingWriter.js` — SETTING.DAT files with CRC-16/XMODEM checksums.
- `src/usb/usbUtils.js` — filesystem detection (platform-branching: lsblk/diskutil/fsutil).
- `protocol_rekordbox.md` — full reverse-engineered binary format spec.

### Database

- **better-sqlite3** (synchronous API) — all DB calls in main process are blocking, no async needed
- Production DB: `app.getPath('userData')/library.db`
- Dev/test DB: `./library.db` in project root (when Electron `app` is unavailable)
- WAL mode + foreign keys enforced via pragmas in `database.js`
- Schema lives in `src/db/migrations.js` — add new columns/tables there; `initDB()` called once at startup
- New columns: add `ALTER TABLE … ADD COLUMN …` inside the safe try-catch loop in `initDB()` — **never** change the `CREATE TABLE IF NOT EXISTS` block
- `updateTrack()` in `trackRepository.js` builds SET clauses dynamically from object keys — always sets `analyzed = 1`
- `addTrack()` SQL must include **all** tag columns (`year`, `label`, `genres`, `source_url`, `source_link`, etc.) — omitting a column silently stores NULL even if the caller passes a value

### Media Server

Audio is served over a local HTTP server (`src/audio/mediaServer.js`) instead of a custom Electron protocol. Electron 28+'s `protocol.handle` has unreliable Range request handling, causing `PIPELINE_ERROR_READ` errors on seek.

- `startMediaServer(audioBase, artworkBase?)` starts on `127.0.0.1` on an ephemeral port
- Called in `initApp()` **before** `createWindow()` so the port is ready before any IPC
- Security: only files inside `audioBase` or `artworkBase` are served (403 otherwise)
- Port exposed via `ipcMain.handle('get-media-port', () => port)` → `window.api.getMediaPort()`
- URL format: `http://127.0.0.1:${port}/${encodedPath.replace(/^\//, '')}?t=${gen}` — on Windows the path is `/C:/path/to/file`; the server strips the leading slash and converts to backslashes. `?t=` cache-busts the pipeline when replaying the same file.

### yt-dlp Download Flow (2-step)

`src/audio/ytDlpManager.js`:

1. **Fetch metadata**: `fetchPlaylistInfo(url)` — runs yt-dlp with `--flat-playlist --dump-single-json`. Returns `{ type, title, entries }`. Fast — reads only the index page.
2. **Download**: `downloadUrl(url, onProgress, { playlistItems })` — primary file detection via `--print after_move:__YTDLP_FILE__:%(filepath)s` marker on stdout. Falls back to scanning tmpDir.

`--playlist-items "1,3,5"` is passed when the user deselects tracks in the selection step.

### Renderer / UI

- Track list uses `react-window` (`FixedSizeList`) for virtualization — `ROW_HEIGHT = 50`, `PAGE_SIZE = 50`
- Pagination is scroll-triggered: loads next page when within `PRELOAD_TRIGGER = 3` rows of the end
- Sorting is client-side on the loaded `tracks` array, not a DB query
- Drag-and-drop via `@dnd-kit` — `SortableRow` is defined **outside** `MusicLibrary` to prevent remounts
- Player state (queue, playback, shuffle/repeat) lives in `PlayerContext.jsx` using React Context + `Audio` element
- `window.api.onTrackUpdated(callback)` listens for background analysis results and updates rows in-place

### Search

Handled client-side by `renderer/src/searchParser.js`. Supports field-qualified queries (e.g. `BPM >= 120 AND KEY:12A GENRE is Psytrance`). Parsed AST filters the already-loaded `tracks` array — no extra DB queries.

### Dependencies & External Binaries

- On first launch, `src/deps.js` downloads FFmpeg and the mixxx-analyzer binary
- Progress is pushed to renderer via `onDepsProgress` IPC events (shown as overlay in `App.jsx`)
- **FFmpeg binaries**: `analysisWorker.js` and `ffmpeg.js` check `./ffmpeg/<binary>` first, then fall back to system PATH
- **mixxx-analyzer**: located via `workerData.analyzerPath` (runtime-downloaded) or `build-resources/analysis` (dev). Called with `--json <filePath>`, outputs a JSON array
- Logs: daily to `~/.config/dj_manager/logs/app-YYYY-MM-DD.log`

## Key Conventions

- **ESM throughout**: root `package.json` has `"type": "module"`; `src/` uses `import/export`. `preload.js` uses `require()` (CommonJS, Electron requirement).
- **Code style**: Prettier (100-char width, 2-space indent, single quotes) enforced via Husky pre-commit hook with lint-staged.
- **Genres** stored as JSON-stringified array in the `genres TEXT` column.
- **Playlists**: mutations (`createPlaylist`, `addTracksToPlaylist`, etc.) always emit a `playlists-updated` IPC event so the sidebar stays in sync.
- **Renderer test mocks**: `renderer/src/__tests__/setup.js` defines the full `window.api` mock. When adding a new IPC method, add a corresponding `vi.fn()` entry there or renderer tests that mount components will fail.
- **Platform-specific test stubs**: `usbUtils.test.js` stubs `process.platform` via `vi.stubGlobal` so Linux-branch tests run correctly on Windows. Use the same pattern for any test that branches on `process.platform`.
- **Windows path in tests**: when constructing HTTP URLs from OS file paths in tests, convert with `'/' + filePath.replace(/\\/g, '/')` so paths are valid on Windows (e.g. `/C:/path/to/file`).

## Known Issues

- **yt-dlp ffmpeg path**: yt-dlp spawned as subprocess can't find bundled ffmpeg. Pass `--ffmpeg-location <bundled ffmpeg dir>` to the yt-dlp spawn call using `getFfmpegRuntimePath()` from `deps.js`.
