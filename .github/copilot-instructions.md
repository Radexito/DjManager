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

---

## Current Work in Progress

### Branch: `feat/player-library-enhancements` (from `dev`)

Implements **Issue #18 — Player & Library Enhancements**. All changes are uncommitted on this branch.

#### ✅ COMPLETED

1. **DB schema** (`src/db/migrations.js`)
   - Added `ALTER TABLE tracks ADD COLUMN user_tags TEXT`
   - Added `ALTER TABLE tracks ADD COLUMN has_artwork INTEGER DEFAULT 0`

2. **PlayerContext** (`renderer/src/PlayerContext.jsx`)
   - `currentPlaylistName` state + ref — passed through `play()` and `playAtIndex()` as 5th arg
   - `volume` state (0–1, default 1.0) + `setVolume()` — combined with per-track `replay_gain` via `audio.volume = min(1, volume * 10^(rg/20))`
   - Playback history ring buffer (`history` state, max 50 tracks) — current track pushed on every switch
   - `next()` / `prev()` / `onEnded()` updated to propagate `playlistName`
   - All new state/functions exposed in context value

3. **PlayerBar** (`renderer/src/PlayerBar.jsx` + `PlayerBar.css`)
   - Volume slider (🔊/🔉/🔇 icon + range input, 0–100%) next to device picker
   - "Playing from: X" label below artist (shows `currentPlaylistName`)
   - Album art thumbnail `<img class="player-art">` (52×52px) on the left — uses `currentTrack.artwork_path`
   - History dropdown button 🕐 — lists recent tracks, click to replay
   - Device picker icon changed from 🔊 to 🎧

4. **MusicLibrary** (`renderer/src/MusicLibrary.jsx`)
   - `play()` call now passes `playlistInfo?.name` as 5th arg
   - Added `rating` column (shows ★★★☆☆ style) to `ALL_COLUMNS` / `DEFAULT_COL_VIS` (hidden by default)
   - Added `user_tags` column to `ALL_COLUMNS` / `DEFAULT_COL_VIS` (hidden by default)
   - `renderCell` handles `'rating'` (unicode stars) and `'user_tags'` (plain text)

5. **RatingStars component** (`renderer/src/RatingStars.jsx` + `RatingStars.css`)
   - 5-star click-to-set widget; hover preview; click current rating to clear (set 0)
   - `readOnly` prop for display-only mode

6. **TrackDetails** (`renderer/src/TrackDetails.jsx`)
   - `rating` field (type `'rating'`, `bulkSupported: true`) — renders `<RatingStars>`
   - `user_tags` field (type `'tags'`, `bulkSupported: true`) — free-text comma-separated tags
   - Both fields included in `trackToForm()`, `EMPTY_BULK_FORM`, and `handleSave()` (single + bulk)

7. **Media Server** (`src/audio/mediaServer.js`)
   - `createMediaRequestHandler(audioBase, artworkBase = null)` — accepts optional second base
   - Security check allows paths under either `audioBase` OR `artworkBase`
   - `IMAGE_MIME` map (jpg, jpeg, png, webp) for artwork content-type
   - `startMediaServer(audioBase, artworkBase = null)` — backwards-compatible

#### 🔄 IN PROGRESS (partially done, need to continue)

8. **importManager** (`src/audio/importManager.js`) — **NOT YET MODIFIED**
   - After copying audio to `dest`, run ffmpeg to extract embedded cover art:
     ```js
     // Pseudocode
     const artworkDir = path.join(app.getPath('userData'), 'artwork');
     const artworkPath = path.join(artworkDir, `${hash}.jpg`);
     await extractArtwork(dest, artworkPath); // ffmpeg -i dest -map 0:v:0 -c:v copy artworkPath
     if (artworkExtracted) { addTrack({ ..., has_artwork: 1 }); }
     ```
   - `artwork_path` should be stored in DB as the absolute file path (so media server can serve it)
   - Add `artwork_path TEXT` to DB schema as well (`src/db/migrations.js`)
   - Use `getArtworkBase()` helper similar to `getLibraryBase()`
   - `extractArtwork(srcPath, destPath)` — wrap ffmpeg spawn, resolve `true`/`false`

9. **main.js** — **NOT YET MODIFIED** for artwork
   - `getArtworkBase()` must be called and passed to `startMediaServer(audioBase, artworkBase)`
   - Add IPC: `ipcMain.handle('get-artwork-base', () => artworkBase)` (or just expose via `getMediaPort`)
   - The renderer constructs artwork URL as `http://127.0.0.1:${port}${track.artwork_path}` (same as audio)

10. **id3Writer.js** (`src/audio/id3Writer.js`) — **NOT YET CREATED**
    - `writeId3Tags(filePath, tags)` — uses ffmpeg to write metadata back to file
    - Approach: temp file + atomic rename
    - Fields: `TITLE`, `ARTIST`, `ALBUM`, `DATE` (year), `GENRE`, `LABEL`, `COMMENT`, `BPM`
    - Skip silently if ffmpeg unavailable or file is read-only

    ```js
    // Template:
    import { spawn } from 'child_process';
    import { getFfmpegPath } from './ffmpeg.js';
    import path from 'path';
    import fs from 'fs';

    export async function writeId3Tags(filePath, tags) {
      const ffmpegBin = getFfmpegPath();
      const tmp = filePath + '.tmp_meta';
      const args = ['-y', '-i', filePath, '-map_metadata', '0'];
      const fieldMap = {
        title: 'TITLE',
        artist: 'ARTIST',
        album: 'ALBUM',
        year: 'DATE',
        label: 'LABEL',
        comments: 'COMMENT',
      };
      for (const [key, tag] of Object.entries(fieldMap)) {
        if (tags[key] != null) args.push('-metadata', `${tag}=${String(tags[key])}`);
      }
      if (tags.genres) {
        const g = JSON.parse(tags.genres ?? '[]').join(', ');
        if (g) args.push('-metadata', `GENRE=${g}`);
      }
      const bpm = tags.bpm_override ?? tags.bpm;
      if (bpm != null) args.push('-metadata', `BPM=${Math.round(bpm)}`);
      args.push('-c', 'copy', tmp);
      // spawn ffmpeg, await exit code 0, then fs.renameSync(tmp, filePath)
    }
    ```

11. **main.js** — `update-track` handler — **NOT YET MODIFIED** for ID3 write-back
    - After `updateTrack(id, data)` succeeds, call `writeId3Tags(track.file_path, data)`
    - Import `writeId3Tags` from `./audio/id3Writer.js`
    - Must be non-blocking (don't await in the IPC handler; fire-and-forget with error logging)

#### ⏳ NOT STARTED

- `renderer/src/__tests__/setup.js` — may need `getArtworkBase` mock added if any new renderer tests mount components that call it

#### Important Notes for Resuming

- **Branch**: `feat/player-library-enhancements` — checked out, all changes unstaged/uncommitted
- **Renderer install**: `cd renderer && npm install --legacy-peer-deps` (eslint-plugin-react-hooks peer dep workaround)
- **Test baseline**: 74 main-process tests + 98 renderer tests all pass on `dev`
- **`artwork_path` column**: needs to be added to `src/db/migrations.js` (currently only `has_artwork` was added — `artwork_path TEXT` is also needed so the renderer can build the media server URL)
- **`addTrack()` SQL**: when adding `artwork_path` to migrations, also add it to `addTrack()` INSERT in `trackRepository.js` — otherwise it silently stores NULL
- **Media server artwork URL pattern**: `http://127.0.0.1:${port}${track.artwork_path}` — same pattern as audio (absolute filesystem path as URL path)
- **ffmpeg path**: use `getFfmpegPath()` from `src/audio/ffmpeg.js` for both artwork extraction and ID3 write-back
- **`updateTrack()` always sets `analyzed = 1`** — this is intentional; be aware when calling it for metadata-only updates

#### Files modified so far (all unstaged):

```
M renderer/src/MusicLibrary.jsx
M renderer/src/PlayerBar.css
M renderer/src/PlayerBar.jsx
M renderer/src/PlayerContext.jsx
M renderer/src/TrackDetails.jsx
M src/audio/mediaServer.js
M src/db/migrations.js
+ renderer/src/RatingStars.css    (new)
+ renderer/src/RatingStars.jsx    (new)
```
