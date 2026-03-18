import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, shell } from 'electron';

// Fix for Linux/Wayland + AMD radeonsi/Mesa stability issues.
// Root cause chain (diagnosed 2025-03):
//   1. --ozone-platform=wayland required to prevent X11 shared-memory FATALs
//   2. GPU process causes network service crash via pidfd shared-memory race
//   3. --no-zygote avoids the zygote-pidfd handshake that returns ESRCH in
//      child processes on this kernel/namespace configuration
//   4. app.disableHardwareAcceleration() + --disable-gpu eliminate GPU process
//   5. --no-sandbox / --disable-gpu-sandbox prevent remaining sandbox failures
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('ozone-platform', 'wayland');
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-zygote');
}
import { initDB } from './db/migrations.js';
import {
  createPlaylist,
  getPlaylists,
  getPlaylist,
  renamePlaylist,
  updatePlaylistColor,
  deletePlaylist,
  addTracksToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  getPlaylistsForTrack,
  getPlaylistTracks,
  clearPlaylists,
} from './db/playlistRepository.js';
import {
  addTrack,
  getTracks,
  getTrackIds,
  getTrackById,
  removeTrack,
  updateTrack,
  normalizeLibrary,
  clearTracks,
} from './db/trackRepository.js';
import { getSetting, setSetting } from './db/settingsRepository.js';
import { importAudioFile, spawnAnalysis, getLibraryBase } from './audio/importManager.js';
import { searchMusicBrainz, searchDiscogs } from './audio/autoTagger.js';
import { downloadUrl as ytDlpDownloadUrl } from './audio/ytDlpManager.js';
import { ensureDeps } from './deps.js';
import {
  getInstalledVersions,
  checkForUpdates,
  updateAnalyzer,
  updateYtDlp,
  updateAll,
} from './deps.js';
import { initLogger, getLogDir } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

// Register media:// protocol to serve local audio files from the renderer.
// Must be called before app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true },
  },
]);

function createWindow() {
  // Handle media:// scheme with Range request support so seeking works.
  const MIME = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.opus': 'audio/ogg; codecs=opus',
    '.webm': 'audio/webm',
    '.weba': 'audio/webm',
  };
  protocol.handle('media', async (request) => {
    try {
      const filePath = decodeURIComponent(new URL(request.url).pathname);
      const stat = await fs.promises.stat(filePath);
      const total = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'audio/mpeg';
      const range = request.headers.get('Range');
      const name = path.basename(filePath);
      const t = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

      const makeStream = (start, end) => {
        const nodeStream = fs.createReadStream(filePath, { start, end });
        console.log(`[media] ${t()} OPEN  bytes=${start}-${end} (${end - start + 1}B) [${name}]`);
        nodeStream.on('close', () =>
          console.log(`[media] ${t()} CLOSE bytes=${start}-${end} [${name}]`)
        );
        nodeStream.on('error', (err) => {
          const expected = ['ERR_STREAM_DESTROYED', 'ECONNRESET', 'ABORT_ERR', 'ERR_ABORTED'];
          if (expected.includes(err.code)) {
            console.log(`[media] ${t()} ABORT bytes=${start}-${end} err=${err.code} [${name}]`);
          } else {
            console.error(
              `[media] ${t()} ERROR bytes=${start}-${end} err=${err.code} ${err.message} [${name}]`
            );
          }
        });
        return Readable.toWeb(nodeStream);
      };

      if (range) {
        const [, s, e] = range.match(/bytes=(\d+)-(\d*)/) || [];
        const start = parseInt(s, 10);
        const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        return new Response(makeStream(start, end), {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
          },
        });
      }

      return new Response(makeStream(0, total - 1), {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
        },
      });
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('media:// error:', err.code, err.message);
      return new Response('Not found', { status: 404 });
    }
  });

  mainWindow = new BrowserWindow({
    title: 'DjManager - RWTechWorks.pl',
    width: 1200,
    height: 800,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  global.mainWindow = mainWindow; // make accessible to workers

  if (process.env.E2E_TEST === '1') {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  } else if (!app.isPackaged) {
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

  // Skip dep download in E2E tests — binary not needed for UI tests and the
  // pending download blocks app.close(), causing afterEach timeouts.
  if (process.env.E2E_TEST === '1') return;

  // Download deps if not already present
  let _lastDepLog = '';
  ensureDeps((msg, pct) => {
    if ((pct === 0 || pct === 100 || pct === undefined) && msg !== _lastDepLog) {
      _lastDepLog = msg;
      console.log('[deps]', msg);
    }
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
  })
    .then(() => {
      if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
    })
    .catch((err) => {
      console.error('[deps] Failed to download FFmpeg:', err.message);
      if (global.mainWindow)
        global.mainWindow.webContents.send('deps-progress', {
          msg: `Error: ${err.message}`,
          pct: -1,
        });
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
ipcMain.handle('get-library-path', () => getLibraryBase());
ipcMain.handle('move-library', async (event, newDir) => {
  const oldBase = getLibraryBase();

  if (!newDir || newDir === oldBase) throw new Error('Same directory selected.');

  // Ensure destination exists
  fs.mkdirSync(newDir, { recursive: true });

  // Gather all tracks
  const tracks = getTracks({ limit: 999999 });
  const total = tracks.length;
  let moved = 0;

  for (const track of tracks) {
    const oldPath = track.file_path;
    if (!fs.existsSync(oldPath)) {
      moved++;
      continue;
    }

    // Preserve shard/filename structure relative to oldBase
    const rel = path.relative(oldBase, oldPath);
    const newPath = path.join(newDir, rel);
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
    updateTrack(track.id, { file_path: newPath });
    moved++;

    const pct = Math.round((moved / total) * 100);
    if (global.mainWindow)
      global.mainWindow.webContents.send('move-library-progress', { moved, total, pct });
  }

  // Remove old empty shard dirs (best-effort)
  try {
    for (const entry of fs.readdirSync(oldBase)) {
      const d = path.join(oldBase, entry);
      if (fs.statSync(d).isDirectory() && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    }
    if (fs.readdirSync(oldBase).length === 0) fs.rmdirSync(oldBase);
  } catch {
    /* ignore */
  }

  setSetting('library_path', newDir);
  return { moved, total };
});
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
ipcMain.handle('update-track', (_, { id, data }) => {
  updateTrack(id, data);
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

ipcMain.handle('export-playlist-m3u', async (_, playlistId) => {
  const playlist = getPlaylist(playlistId);
  if (!playlist) throw new Error(`Playlist ${playlistId} not found`);

  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose export destination folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return { canceled: true };

  // Sanitize playlist name for use as a folder/file name
  const safeName = playlist.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const destDir = path.join(filePaths[0], safeName);
  fs.mkdirSync(destDir, { recursive: true });

  const tracks = getPlaylistTracks(playlistId);
  const total = tracks.length;
  const m3uLines = ['#EXTM3U'];
  const usedNames = new Set();

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const ext = path.extname(t.file_path);
    const rawBase =
      [t.artist, t.title].filter(Boolean).join(' - ') || path.basename(t.file_path, ext);
    const safeBase = rawBase.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    const pad = String(i + 1).padStart(2, '0');
    let filename = `${pad} - ${safeBase}${ext}`;
    // Resolve any collisions
    let n = 1;
    while (usedNames.has(filename)) filename = `${pad} - ${safeBase} (${n++})${ext}`;
    usedNames.add(filename);

    if (fs.existsSync(t.file_path)) {
      fs.copyFileSync(t.file_path, path.join(destDir, filename));
    }

    const duration = Math.floor(t.duration ?? -1);
    const label = [t.artist, t.title].filter(Boolean).join(' - ') || safeBase;
    m3uLines.push(`#EXTINF:${duration},${label}`);
    m3uLines.push(filename); // relative — same folder as M3U

    const pct = Math.round(((i + 1) / total) * 100);
    if (global.mainWindow)
      global.mainWindow.webContents.send('export-m3u-progress', { copied: i + 1, total, pct });
  }

  const m3uPath = path.join(destDir, `${safeName}.m3u`);
  await fs.promises.writeFile(m3uPath, m3uLines.join('\n') + '\n', 'utf8');
  if (global.mainWindow) global.mainWindow.webContents.send('export-m3u-progress', null);
  return { destDir, trackCount: tracks.length };
});

ipcMain.handle('add-track', (event, track) => addTrack(track));
// Remove old commented-out stubs

ipcMain.handle('select-audio-files', async () => {
  console.log('Selecting audio files');
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'm4a'] }],
  });

  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('open-dir-dialog', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
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
  clearPlaylists();
  if (fs.existsSync(audioBase)) fs.rmSync(audioBase, { recursive: true, force: true });
  if (global.mainWindow) {
    global.mainWindow.webContents.send('library-updated');
    global.mainWindow.webContents.send('playlists-updated');
  }
});

ipcMain.handle('clear-user-data', async () => {
  const toDelete = [app.getPath('userData'), app.getPath('cache'), app.getPath('logs')];
  app.on('quit', () => {
    for (const p of toDelete) {
      try {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
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
ipcMain.handle('update-analyzer', async (_event) => {
  await updateAnalyzer((msg, pct) => {
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
  });
  if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
});

ipcMain.handle('update-yt-dlp', async (_event) => {
  await updateYtDlp((msg, pct) => {
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
  });
  if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
});
ipcMain.handle('update-all-deps', async (_event) => {
  await updateAll((msg, pct) => {
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
  });
  if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
});

// ─── Auto-tagger ──────────────────────────────────────────────────────────────

ipcMain.handle('auto-tag-search', async (_, { query }) => {
  try {
    const [mbRes, discogsRes] = await Promise.allSettled([
      searchMusicBrainz(query),
      searchDiscogs(query),
    ]);
    const results = [
      ...(mbRes.status === 'fulfilled' ? mbRes.value : []),
      ...(discogsRes.status === 'fulfilled' ? discogsRes.value : []),
    ];
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── yt-dlp URL download ──────────────────────────────────────────────────────

ipcMain.handle('ytdlp-download-url', async (_event, url) => {
  try {
    const sendProgress = (msg, pct) => {
      if (global.mainWindow) global.mainWindow.webContents.send('ytdlp-progress', { msg, pct });
    };

    sendProgress('Starting download…', 0);
    const { filePath, originalUrl, platform, quality } = await ytDlpDownloadUrl(url, sendProgress);

    sendProgress('Importing to library…', 99);
    const trackId = await importAudioFile(filePath, {
      source_url: originalUrl,
      source_platform: platform,
      source_quality: quality,
    });

    if (global.mainWindow) {
      global.mainWindow.webContents.send('library-updated');
      global.mainWindow.webContents.send('ytdlp-progress', null);
    }

    return { ok: true, trackId };
  } catch (err) {
    if (global.mainWindow) global.mainWindow.webContents.send('ytdlp-progress', null);
    return { ok: false, error: err.message };
  }
});

app.on('ready', initApp);
app.on('window-all-closed', () => {
  console.log('All windows closed.');
  if (process.platform !== 'darwin') app.quit();
});

// Log child process crashes (network service, GPU process, etc.) for diagnostics
app.on('child-process-gone', (_event, details) => {
  console.error(
    `[crash] child-process-gone type=${details.type} reason=${details.reason}` +
      ` exitCode=${details.exitCode} name=${details.name || '?'}`
  );
});
