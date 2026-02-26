import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, shell } from 'electron';
import { initDB } from './db/migrations.js';
import { createPlaylist, getPlaylists, getPlaylist, renamePlaylist, updatePlaylistColor, deletePlaylist, addTrackToPlaylist, addTracksToPlaylist, removeTrackFromPlaylist, reorderPlaylistTracks, getPlaylistsForTrack } from './db/playlistRepository.js';
import { addTrack, getTracks, getTrackIds, getTrackById, removeTrack, updateTrack, normalizeLibrary, clearTracks } from './db/trackRepository.js';
import { getSetting, setSetting } from './db/settingsRepository.js';
import { importAudioFile, spawnAnalysis } from './audio/importManager.js';
import { ensureDeps } from './deps.js';
import { getInstalledVersions, checkForUpdates, updateAnalyzer } from './deps.js';
import { initLogger, log, getLogDir } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV !== 'production';
let mainWindow;

// Register media:// protocol to serve local audio files from the renderer.
// Must be called before app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } },
]);

function createWindow() {
  // Handle media:// scheme with Range request support so seeking works.
  const MIME = { '.mp3':'audio/mpeg', '.flac':'audio/flac', '.wav':'audio/wav',
                 '.ogg':'audio/ogg',  '.m4a':'audio/mp4',  '.aac':'audio/aac' };
  protocol.handle('media', async (request) => {
    try {
      const filePath = decodeURIComponent(new URL(request.url).pathname);
      const stat     = await fs.promises.stat(filePath);
      const total    = stat.size;
      const ext      = path.extname(filePath).toLowerCase();
      const mime     = MIME[ext] || 'audio/mpeg';
      const range    = request.headers.get('Range');

      const makeStream = (opts) => {
        const nodeStream = fs.createReadStream(filePath, opts);
        // Suppress abort errors when Chromium cancels a request mid-stream
        nodeStream.on('error', (err) => {
          // Suppress normal abort errors from Chromium cancelling requests on track switch
          const expected = ['ERR_STREAM_DESTROYED', 'ECONNRESET', 'ABORT_ERR', 'ERR_ABORTED'];
          if (!expected.includes(err.code)) {
            console.error('media:// stream error:', err.code, filePath);
          }
        });
        return Readable.toWeb(nodeStream);
      };

      if (range) {
        const [, s, e] = range.match(/bytes=(\d+)-(\d*)/) || [];
        const start    = parseInt(s, 10);
        const end      = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        return new Response(makeStream({ start, end }), {
          status: 206,
          headers: {
            'Content-Type':   mime,
            'Content-Range':  `bytes ${start}-${end}/${total}`,
            'Accept-Ranges':  'bytes',
            'Content-Length': String(end - start + 1),
          },
        });
      }

      return new Response(makeStream({}), {
        status: 200,
        headers: {
          'Content-Type':   mime,
          'Accept-Ranges':  'bytes',
          'Content-Length': String(total),
        },
      });
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('media:// error:', err.code, err.message);
      return new Response('Not found', { status: 404 });
    }
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  global.mainWindow = mainWindow; // make accessible to workers

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
    // Block DevTools keyboard shortcut in production
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        event.preventDefault();
      }
    });
  }
}

async function initApp() {
  initLogger();
  console.log('Initializing database...');
  initDB();
  console.log('Creating window.');
  createWindow();

  // Download deps if not already present
  let _lastDepLog = '';
  ensureDeps((msg, pct) => {
    if ((pct === 0 || pct === 100 || pct === undefined) && msg !== _lastDepLog) {
      _lastDepLog = msg;
      console.log('[deps]', msg);
    }
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
  }).then(() => {
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
  }).catch((err) => {
    console.error('[deps] Failed to download FFmpeg:', err.message);
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg: `Error: ${err.message}`, pct: -1 });
  });

  // Application menu
  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (global.mainWindow) global.mainWindow.webContents.send('open-settings');
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// IPC Handlers
ipcMain.handle('get-tracks', (_, params) => getTracks(params));
ipcMain.handle('get-track-ids', (_, params) => getTrackIds(params));
ipcMain.handle('get-setting', (_, key, def) => getSetting(key, def));
ipcMain.handle('set-setting', (_, key, value) => setSetting(key, value));
ipcMain.handle('normalize-library', (_, { targetLufs }) => {
  const parsed = Number(targetLufs);
  if (!Number.isFinite(parsed) || parsed < -60 || parsed > 0) {
    throw new Error(`Invalid targetLufs: must be a finite number between -60 and 0`);
  }
  const updated = normalizeLibrary(parsed);
  setSetting('normalize_target_lufs', String(parsed));
  return { updated };
});
ipcMain.handle('reanalyze-track', (_, trackId) => {
  const track = getTrackById(trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  spawnAnalysis(trackId, track.file_path);
  return { ok: true };
});
ipcMain.handle('remove-track', (_, trackId) => {
  removeTrack(trackId); // ON DELETE CASCADE removes playlist_tracks rows
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
  return { ok: true };
});
ipcMain.handle('adjust-bpm', (_, { trackIds, factor }) => {
  if (factor !== 2 && factor !== 0.5) throw new Error('Invalid factor: must be 2 or 0.5');
  if (!Array.isArray(trackIds) || trackIds.length === 0 || trackIds.length > 500) {
    throw new Error('Invalid trackIds: must be a non-empty array of up to 500 IDs');
  }
  const results = [];
  for (const id of trackIds) {
    const track = getTrackById(id);
    if (!track) continue;
    const base = track.bpm_override ?? track.bpm;
    if (base == null) continue;
    const newBpm = Math.round(base * factor * 10) / 10;
    updateTrack(id, { bpm_override: newBpm });
    results.push({ id, bpm_override: newBpm });
  }
  return results;
});
// Playlist IPC handlers
ipcMain.handle('get-playlists', () => getPlaylists());
ipcMain.handle('create-playlist', (_, { name, color }) => {
  const id = createPlaylist(name, color ?? null);
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
  return id;
});
ipcMain.handle('rename-playlist', (_, { id, name }) => {
  renamePlaylist(id, name);
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
});
ipcMain.handle('update-playlist-color', (_, { id, color }) => {
  updatePlaylistColor(id, color);
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
});
ipcMain.handle('delete-playlist', (_, id) => {
  deletePlaylist(id);
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
});
ipcMain.handle('add-tracks-to-playlist', (_, { playlistId, trackIds }) => {
  if (!Array.isArray(trackIds) || !trackIds.length) return;
  addTracksToPlaylist(playlistId, trackIds);
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
});
ipcMain.handle('remove-track-from-playlist', (_, { playlistId, trackId }) => {
  removeTrackFromPlaylist(playlistId, trackId);
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
});
ipcMain.handle('reorder-playlist', (_, { playlistId, orderedTrackIds }) => {
  reorderPlaylistTracks(playlistId, orderedTrackIds);
});
ipcMain.handle('get-playlists-for-track', (_, trackId) => getPlaylistsForTrack(trackId));
ipcMain.handle('get-playlist', (_, id) => getPlaylist(id));

ipcMain.handle('add-track', (event, track) => addTrack(track));
// Remove old commented-out stubs

ipcMain.handle('select-audio-files', async () => {
  console.log('Selecting audio files');
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'm4a'] },
    ],
  });

  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('import-audio-files', async (event, filePaths) => {
  console.log('Importing audio files:', filePaths);
  const trackIds = [];

  for (const filePath of filePaths) {
    try {
      const trackId = await importAudioFile(filePath);
      trackIds.push(trackId);
    } catch (err) {
      console.error('Import failed:', filePath, err);
    }
  }

  if (trackIds.length > 0 && global.mainWindow) {
    global.mainWindow.webContents.send('library-updated');
  }

  return trackIds;
});

ipcMain.handle('clear-library', async () => {
  const audioBase = path.join(app.getPath('userData'), 'audio');
  clearTracks();
  if (fs.existsSync(audioBase)) fs.rmSync(audioBase, { recursive: true, force: true });
  if (global.mainWindow) global.mainWindow.webContents.send('library-updated');
});

ipcMain.handle('clear-user-data', async () => {
  const toDelete = [app.getPath('userData'), app.getPath('cache'), app.getPath('logs')];
  app.on('quit', () => {
    for (const p of toDelete) {
      try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  });
  app.quit();
});

// IPC: renderer → log file
ipcMain.on('renderer-log', (_, { level, msg }) => {
  const line = `[renderer] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
});

ipcMain.handle('get-log-dir', () => getLogDir());
ipcMain.handle('open-log-dir', () => shell.openPath(getLogDir()));
ipcMain.handle('get-dep-versions', () => getInstalledVersions());
ipcMain.handle('check-dep-updates', () => checkForUpdates());
ipcMain.handle('update-analyzer', async (event) => {
  await updateAnalyzer((msg, pct) => {
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
  });
  if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
});

app.on('ready', initApp);
app.on('window-all-closed', () => {
  console.log('All windows closed.');
  if (process.platform !== 'darwin') app.quit();
});
