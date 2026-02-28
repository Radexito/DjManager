# Copilot Instructions

## Commands

```bash
# Development (starts Vite dev server + Electron concurrently)
npm run dev

# Renderer only (Vite at http://localhost:5173)
npm run react

# Lint renderer
cd renderer && npm run lint

# Build renderer for production
npm run build

# Run in production mode (after build)
npm run electron-prod
```

There is no automated test suite.

## Architecture

This is an **Electron desktop app** with three distinct execution contexts:

1. **Main process** (`src/main.js`) — Node.js ESM. Owns the SQLite database, file system, and IPC handlers. Runs at startup before any window loads.

2. **Renderer process** (`renderer/`) — React 19 + Vite. Runs in a sandboxed browser context with no direct Node access. Communicates with main exclusively through `window.api` (exposed by preload).

3. **Worker threads** (`src/audio/analysisWorker.js`) — Spawned per-import by main. Runs the `mixxx-analyzer` binary (BPM, key, loudness, intro/outro) in parallel with the main process. Results are sent back via `parentPort.postMessage` and written to DB, then pushed to the renderer via `mainWindow.webContents.send('track-updated', ...)`.

### IPC Pattern

- `src/preload.js` bridges main ↔ renderer by exposing `window.api` via `contextBridge`
- Main registers handlers with `ipcMain.handle('<channel>', handler)`
- Renderer calls `window.api.<method>(...)` which resolves to `ipcRenderer.invoke('<channel>', ...)`
- Adding a new IPC channel requires changes in all three: `preload.js`, `main.js`, and the renderer component

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

### Database

- **better-sqlite3** (synchronous API) — all DB calls in main process are blocking, no async needed
- Production DB: `app.getPath('userData')/library.db`
- Dev/test DB: `./library.db` in project root (when Electron `app` is unavailable)
- WAL mode + foreign keys enforced via pragmas in `database.js`
- Schema lives in `src/db/migrations.js` — add new columns/tables there; `initDB()` is called once at startup
- `updateTrack()` in `trackRepository.js` builds SET clauses dynamically from object keys — always sets `analyzed = 1`

### Renderer / UI

- Track list uses `react-window` (`FixedSizeList`) for virtualization — `ROW_HEIGHT = 50`, `PAGE_SIZE = 50`
- Pagination is scroll-triggered: loads next page when within `PRELOAD_TRIGGER = 3` rows of the end
- Sorting is client-side (on the loaded `tracks` array), not a DB query
- `window.api.onTrackUpdated(callback)` listens for background analysis results and updates rows in-place

## Key Conventions

- **ESM throughout**: root `package.json` has `"type": "module"`; `src/` uses `import/export`. Preload uses `require()` (CommonJS, Electron requirement).
- **FFmpeg binaries**: `analysisWorker.js` and `src/audio/ffmpeg.js` check `./ffmpeg/<binary>` first, then fall back to system PATH. Local binaries installed via `scripts/install-ffmpeg.sh`.
- **mixxx-analyzer binary**: located via `workerData.analyzerPath` (runtime-downloaded) or `build-resources/analysis` (dev). Called with `--json <filePath>`, outputs a JSON array. Source lives in the [mixxx-analyzer](https://github.com/Radexito/mixxx-analyzer) repo.
- **Genres** stored as JSON-stringified array in the `genres TEXT` column.
- **Playlist tables** exist in the schema (`playlists`, `playlist_tracks`) but all related IPC handlers and repository calls are commented out — they are not yet active.
- **`global.mainWindow`** is set in `main.js` so the analysis worker result handler can push IPC events to the renderer without importing BrowserWindow directly.
