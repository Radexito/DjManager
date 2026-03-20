# Copilot Instructions

## Commands

```bash
# Development (starts Vite dev server + Electron concurrently)
npm run dev

# Renderer only (Vite at http://localhost:5173)
npm run react

# Lint src/ (main process)
npm run lint
# Lint everything (main + renderer)
npm run lint:all
# Lint renderer only
cd renderer && npm run lint

# Format all files
npm run format
# Check formatting without writing
npm run format:check

# Build renderer for production
npm run build

# Package app (all platforms / specific platform)
npm run dist
npm run dist:linux   # or :win / :mac

# Run in production mode (after build)
npm run electron-prod

# Unit tests (Vitest) — covers src/db/** and src/audio/**
npm test
# Run a single main-process test file
npx vitest run src/__tests__/trackRepository.test.js
# Test with coverage
npm run test:coverage

# Renderer unit tests (React Testing Library)
cd renderer && npm test
# Run a single renderer test file
cd renderer && npx vitest run src/__tests__/MusicLibrary.contextmenu.test.jsx
# Renderer coverage
cd renderer && npm run test:coverage

# E2E tests (Playwright) — not yet in CI
npm run test:e2e
```

Coverage thresholds (v8): 65% statements/lines, 44% branches, 70% functions for `src/db/**`. Renderer thresholds are minimal (7%).

**Vitest projects** (`vitest.config.js`):

- `db` — tests needing real SQLite (in-memory via `DB_PATH=:memory:`): `trackRepository`, `playlistRepository`. Uses `src/__tests__/setup.js` which calls `initDB()`.
- `unit` — no DB, no setup: `importManager`, `ytDlpManager`, `mediaServer`. Add new non-DB tests here.

## Architecture

This is an **Electron desktop app** with three distinct execution contexts:

1. **Main process** (`src/main.js`) — Node.js ESM. Owns the SQLite database, file system, IPC handlers, and the local media HTTP server. Runs at startup before any window loads.

2. **Renderer process** (`renderer/`) — React 19 + Vite. Runs in a sandboxed browser context with no direct Node access. Communicates with main exclusively through `window.api` (exposed by preload).

3. **Worker threads** (`src/audio/analysisWorker.js`) — Spawned per-import by main. Runs the `mixxx-analyzer` binary (BPM, key, loudness, intro/outro) in parallel with the main process. Results are sent back via `parentPort.postMessage` and written to DB, then pushed to the renderer via `mainWindow.webContents.send('track-updated', ...)`.

### IPC Pattern

- `src/preload.js` bridges main ↔ renderer by exposing `window.api` via `contextBridge`
- Main registers handlers with `ipcMain.handle('<channel>', handler)`
- Renderer calls `window.api.<method>(...)` which resolves to `ipcRenderer.invoke('<channel>', ...)`
- **Adding a new IPC channel requires changes in all three**: `preload.js`, `main.js`, and the renderer component
- All `window.api.on*()` methods return a cleanup function — always call it in `useEffect` cleanup

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

### Database

- **better-sqlite3** (synchronous API) — all DB calls in main process are blocking, no async needed
- Production DB: `app.getPath('userData')/library.db`
- Dev/test DB: `./library.db` in project root (when Electron `app` is unavailable)
- WAL mode + foreign keys enforced via pragmas in `database.js`
- Schema lives in `src/db/migrations.js` — add new columns/tables there; `initDB()` is called once at startup
- New columns: add `ALTER TABLE … ADD COLUMN …` inside the safe try-catch loop in `initDB()` — never change the `CREATE TABLE IF NOT EXISTS` block
- `updateTrack()` in `trackRepository.js` builds SET clauses dynamically from object keys — always sets `analyzed = 1`
- `addTrack()` SQL must include **all** tag columns (`year`, `label`, `genres`, `source_url`, `source_link`, etc.) — omitting a column silently stores NULL even if the caller passes a value

### Media Server

Audio files are served over a local HTTP server (`src/audio/mediaServer.js`) instead of a custom Electron protocol. Electron 28+'s `protocol.handle` has unreliable Range request handling, causing `PIPELINE_ERROR_READ` errors on seek.

- `startMediaServer(audioBase)` starts `http.createServer()` bound to `127.0.0.1` on an ephemeral port and returns `{ server, port }`
- Called in `initApp()` **before** `createWindow()` so the port is ready before any IPC
- Security: only files inside `audioBase` are served (403 for anything outside)
- Port exposed to renderer via `ipcMain.handle('get-media-port', () => port)` → `window.api.getMediaPort()`
- Player fetches the port once on mount: `mediaPortRef.current = await window.api.getMediaPort()`
- Audio src URL: `` `http://127.0.0.1:${port}${encodedPath}?t=${gen}` `` — `?t=` cache-busts the pipeline when replaying the same file

### yt-dlp Download Flow (2-step)

`src/audio/ytDlpManager.js` implements a 2-step download:

1. **Fetch metadata**: `fetchPlaylistInfo(url)` — runs yt-dlp with `--flat-playlist --dump-single-json`. Returns `{ type, title, entries: [{index, id, title, url, duration}] }`. Fast because it reads only the index page.

2. **Download**: `downloadUrl(url, onProgress, { playlistItems })` — primary file detection via `--print after_move:__YTDLP_FILE__:%(filepath)s` (marker on stdout after all post-processing). Falls back to scanning tmpDir. Resolves to `{ files, playlistName }`.

`--playlist-items "1,3,5"` is passed when the user deselects some tracks in the selection step.

### Renderer / UI

- Track list uses `react-window` (`FixedSizeList`) for virtualization — `ROW_HEIGHT = 50`, `PAGE_SIZE = 50`
- Pagination is scroll-triggered: loads next page when within `PRELOAD_TRIGGER = 3` rows of the end
- Sorting is client-side (on the loaded `tracks` array), not a DB query
- `window.api.onTrackUpdated(callback)` listens for background analysis results and updates rows in-place
- Drag-and-drop via `@dnd-kit` — `SortableRow` is defined outside `MusicLibrary` to prevent remounts
- Player state (queue, playback, shuffle/repeat) lives in `PlayerContext.jsx` using React Context + `Audio` element

### Dependencies & Auto-download

- On first launch, `src/deps.js` downloads FFmpeg and the mixxx-analyzer binary
- Progress is pushed to renderer via `onDepsProgress` IPC events (shown as overlay in `App.jsx`)
- `src/logger.js` writes daily logs to `~/.config/dj_manager/logs/app-YYYY-MM-DD.log`

## Key Conventions

- **ESM throughout**: root `package.json` has `"type": "module"`; `src/` uses `import/export`. Preload uses `require()` (CommonJS, Electron requirement).
- **Code style**: Prettier (100-char width, 2-space indent, single quotes) enforced via Husky pre-commit hook with lint-staged.
- **FFmpeg binaries**: `analysisWorker.js` and `src/audio/ffmpeg.js` check `./ffmpeg/<binary>` first, then fall back to system PATH. Local binaries installed via `scripts/install-ffmpeg.sh`.
- **mixxx-analyzer binary**: located via `workerData.analyzerPath` (runtime-downloaded) or `build-resources/analysis` (dev). Called with `--json <filePath>`, outputs a JSON array. Source lives in the [mixxx-analyzer](https://github.com/Radexito/mixxx-analyzer) repo.
- **Genres** stored as JSON-stringified array in the `genres TEXT` column.
- **Playlists**: mutations (`createPlaylist`, `addTracksToPlaylist`, etc.) always emit a `playlists-updated` IPC event so the sidebar stays in sync. `createPlaylist(name, color, sourceUrl)` accepts an optional source URL.
- **Search** is handled client-side by `renderer/src/searchParser.js`, which supports field-qualified queries (e.g. `bpm >= 120 AND key:12A artist:"Daft Punk"`). The parsed AST filters the already-loaded `tracks` array — no extra DB queries.
- **`global.mainWindow`** is set in `main.js` so the analysis worker result handler can push IPC events to the renderer without importing BrowserWindow directly.
- **Renderer test mocks**: `renderer/src/__tests__/setup.js` defines the full `window.api` mock. When adding a new IPC method, add a corresponding `vi.fn()` entry there or renderer tests that mount components will fail.
