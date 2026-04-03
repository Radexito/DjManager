import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, shell } from 'electron';

// Fix for Linux/Wayland + AMD radeonsi/Mesa stability issues.
// Root cause chain (diagnosed 2025-03):
//   1. --ozone-platform=wayland required to prevent X11 shared-memory FATALs on Wayland
//   2. GPU process causes network service crash via pidfd shared-memory race
//   3. --no-zygote avoids the zygote-pidfd handshake that returns ESRCH in
//      child processes on this kernel/namespace configuration
//   4. app.disableHardwareAcceleration() + --disable-gpu eliminate GPU process
//   5. --no-sandbox / --disable-gpu-sandbox prevent remaining sandbox failures
//
// NOTE: --ozone-platform=wayland is ONLY set when WAYLAND_DISPLAY is present.
// Forcing Wayland on X11/xvfb (e.g. CI) breaks Playwright click interactions.
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  if (process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch('ozone-platform', 'wayland');
    app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  }
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-zygote');
}
import { initDB } from './db/migrations.js';
import {
  createPlaylist,
  findOrCreatePlaylist,
  getPlaylists,
  getPlaylist,
  renamePlaylist,
  updatePlaylistColor,
  deletePlaylist,
  addTrackToPlaylist,
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
  resetNormalization,
  clearTracks,
  getTrackIdsNeedingNormalization,
  getNormalizedTrackCount,
  getExistingSourceUrls,
  getPlaylistSourceUrls,
} from './db/trackRepository.js';
import { getSetting, setSetting } from './db/settingsRepository.js';
import {
  importAudioFile,
  spawnAnalysis,
  getLibraryBase,
  normalizeAudioFile,
} from './audio/importManager.js';

import {
  searchMusicBrainz,
  searchDiscogs,
  searchItunes,
  searchDeezer,
} from './audio/autoTagger.js';
import {
  downloadUrl as ytDlpDownloadUrl,
  fetchPlaylistInfo as ytDlpFetchPlaylistInfo,
} from './audio/ytDlpManager.js';
import { ensureDeps, getFfmpegRuntimePath } from './deps.js';
import {
  getInstalledVersions,
  checkForUpdates,
  updateAnalyzer,
  updateYtDlp,
  updateAll,
} from './deps.js';
import { initLogger, getLogDir } from './logger.js';
import { detectFilesystem, formatDrive, describeFilesystem } from './usb/usbUtils.js';
import { writeAnlz, getAnlzFolder } from './audio/anlzWriter.js';
import { writeSettingFiles } from './usb/settingWriter.js';
import { writePdb } from './usb/pdbWriter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

import { startMediaServer as _startMediaServer } from './audio/mediaServer.js';
import { getArtworkBase } from './audio/importManager.js';
import { writeId3Tags } from './audio/id3Writer.js';

// Serve audio files over a local HTTP server so Chromium's media pipeline can
// issue standard Range requests during seeking. Custom Electron protocols have
// unreliable Range support in Electron 28+ and cause PIPELINE_ERROR_READ on seek.
let mediaServerPort = null;

function startMediaServer() {
  const audioBase = path.join(app.getPath('userData'), 'audio');
  const artworkBase = getArtworkBase();
  return _startMediaServer(audioBase, artworkBase).then(({ port }) => {
    mediaServerPort = port;
  });
}

function createWindow() {
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
  mainWindow.maximize();

  // Native right-click context menu for editable inputs and text selections
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = new Menu();
    if (params.isEditable) {
      if (params.editFlags.canUndo) menu.append(new MenuItem({ role: 'undo', label: 'Undo' }));
      if (params.editFlags.canRedo) menu.append(new MenuItem({ role: 'redo', label: 'Redo' }));
      if (params.editFlags.canUndo || params.editFlags.canRedo)
        menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'cut', label: 'Cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ role: 'copy', label: 'Copy', enabled: params.editFlags.canCopy }));
      menu.append(
        new MenuItem({ role: 'paste', label: 'Paste', enabled: params.editFlags.canPaste })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll', label: 'Select All' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy', label: 'Copy' }));
    }
    if (menu.items.length > 0) menu.popup();
  });

  if (process.env.E2E_TEST === '1') {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  } else if (!app.isPackaged) {
    mainWindow.loadURL(fs.readFileSync(path.join(__dirname, '../.dev-url'), 'utf8').trim());
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
  await startMediaServer();
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

  Menu.setApplicationMenu(null);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// IPC Handlers
ipcMain.handle('get-media-port', () => mediaServerPort);
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

ipcMain.handle('normalize-library', async () => {
  const targetLufs = Number(getSetting('normalize_target_lufs', '-9'));
  const trackIds = getTrackIdsNeedingNormalization();
  const total = trackIds.length;
  let completed = 0;
  let normalized = 0;
  let skipped = 0;

  const sendProgress = (done = false) => {
    if (global.mainWindow) {
      global.mainWindow.webContents.send('normalize-progress', { completed, total, done });
    }
  };

  const notifyTrack = (trackId, extra = {}) => {
    if (global.mainWindow) {
      global.mainWindow.webContents.send('track-updated', { trackId, analysis: extra });
    }
  };

  sendProgress();

  for (const trackId of trackIds) {
    const track = getTrackById(trackId);
    if (!track || track.loudness == null) {
      skipped++;
      completed++;
      sendProgress();
      continue;
    }
    try {
      const normalizedPath = await normalizeAudioFile(track, targetLufs);
      console.log(`[normalize-library] created: ${normalizedPath}`);
      const dbUpdate = { normalized_file_path: normalizedPath };
      if (track.source_loudness == null) dbUpdate.source_loudness = track.loudness;
      updateTrack(trackId, dbUpdate);
      notifyTrack(trackId, { normalized_file_path: normalizedPath, analyzed: 0 });
      spawnAnalysis(trackId, normalizedPath);
      normalized++;
    } catch (err) {
      console.error(`normalize-library failed for track ${trackId}:`, err.message);
      skipped++;
    }
    completed++;
    sendProgress();
  }

  sendProgress(true);
  return { normalized, skipped, total };
});

ipcMain.handle('reset-normalization', (_, { trackIds } = {}) => {
  const ids = trackIds?.length ? trackIds : null;
  const updated = resetNormalization(ids);

  // Re-analyze affected tracks on their original files to restore loudness data
  if (ids) {
    for (const id of ids) {
      const track = getTrackById(id);
      if (track?.file_path) spawnAnalysis(id, track.file_path);
    }
  }

  return { updated };
});

ipcMain.handle('get-normalized-count', () => getNormalizedTrackCount());

ipcMain.handle('normalize-tracks-audio', async (_, { trackIds }) => {
  const targetLufs = Number(getSetting('normalize_target_lufs', '-9'));
  const total = trackIds.length;
  let completed = 0;
  let normalized = 0;
  let skipped = 0;

  const sendProgress = (done = false) => {
    if (global.mainWindow) {
      global.mainWindow.webContents.send('normalize-progress', { completed, total, done });
    }
  };

  const notifyTrack = (trackId, extra = {}) => {
    if (global.mainWindow) {
      global.mainWindow.webContents.send('track-updated', { trackId, analysis: extra });
    }
  };

  sendProgress();

  for (const trackId of trackIds) {
    const track = getTrackById(trackId);
    if (!track || (track.source_loudness == null && track.loudness == null)) {
      skipped++;
      completed++;
      sendProgress();
      continue;
    }
    try {
      const normalizedPath = await normalizeAudioFile(track, targetLufs);
      console.log(`[normalize] created normalized file: ${normalizedPath}`);
      // Persist source_loudness once so re-normalization always uses the original baseline
      const dbUpdate = { normalized_file_path: normalizedPath };
      if (track.source_loudness == null) dbUpdate.source_loudness = track.loudness;
      updateTrack(trackId, dbUpdate);
      // Immediately tell renderer about the normalized file and mark as re-analyzing
      notifyTrack(trackId, { normalized_file_path: normalizedPath, analyzed: 0 });
      spawnAnalysis(trackId, normalizedPath);
      normalized++;
    } catch (err) {
      console.error(`Audio normalization failed for track ${trackId}:`, err.message);
      skipped++;
    }
    completed++;
    sendProgress();
  }

  sendProgress(true);
  return { normalized, skipped };
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
  // Fire-and-forget ID3 tag write-back (non-blocking, best-effort)
  const track = getTrackById(id);
  if (track?.file_path) {
    writeId3Tags(track.file_path, data).catch((e) =>
      console.error('[update-track] id3 write failed:', e.message)
    );
  }
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
  try {
    const id = createPlaylist(name, color ?? null);
    if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
    return { id };
  } catch (err) {
    if (err.code === 'DUPLICATE_PLAYLIST_NAME') return { error: 'duplicate', message: err.message };
    throw err;
  }
});
ipcMain.handle('rename-playlist', (_, { id, name }) => {
  try {
    renamePlaylist(id, name);
    if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
    return {};
  } catch (err) {
    if (err.code === 'DUPLICATE_PLAYLIST_NAME') return { error: 'duplicate', message: err.message };
    throw err;
  }
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

ipcMain.handle('update-yt-dlp', async (_event, tag = null) => {
  await updateYtDlp((msg, pct) => {
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
  }, tag);
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
    const [mbRes, discogsRes, itunesRes, deezerRes] = await Promise.allSettled([
      searchMusicBrainz(query),
      searchDiscogs(query),
      searchItunes(query),
      searchDeezer(query),
    ]);
    const results = [
      ...(mbRes.status === 'fulfilled' ? mbRes.value : []),
      ...(discogsRes.status === 'fulfilled' ? discogsRes.value : []),
      ...(itunesRes.status === 'fulfilled' ? itunesRes.value : []),
      ...(deezerRes.status === 'fulfilled' ? deezerRes.value : []),
    ];
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fetch-artwork-url', async (_, { trackId, url }) => {
  try {
    const artworkBase = getArtworkBase();
    fs.mkdirSync(artworkBase, { recursive: true });

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    const ext = contentType.includes('png') ? '.png' : '.jpg';

    const buf = Buffer.from(await res.arrayBuffer());
    // Name file by track ID so it's easily associated
    const artworkPath = path.join(artworkBase, `track_${trackId}${ext}`);
    fs.writeFileSync(artworkPath, buf);

    await updateTrack(trackId, { has_artwork: 1, artwork_path: artworkPath });
    return { ok: true, artwork_path: artworkPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── yt-dlp playlist info fetch ──────────────────────────────────────────────

ipcMain.handle('ytdlp-fetch-info', async (_event, url) => {
  console.log('[ytdlp-fetch-info] fetching info for:', url);
  try {
    const cookiesBrowser = getSetting('ytdlp_cookies_browser', '') || null;
    if (cookiesBrowser)
      console.log('[ytdlp-fetch-info] using cookies from browser:', cookiesBrowser);
    const info = await ytDlpFetchPlaylistInfo(url, {
      cookiesBrowser,
      onBeforeCheck: (entries) => {
        if (global.mainWindow) global.mainWindow.webContents.send('ytdlp-entries-ready', entries);
      },
      onCheckProgress: ({ checked, total }) => {
        if (global.mainWindow)
          global.mainWindow.webContents.send('ytdlp-check-progress', { checked, total });
      },
      onEntryChecked: (entry) => {
        if (global.mainWindow) global.mainWindow.webContents.send('ytdlp-entry-checked', entry);
      },
    });
    if (global.mainWindow) global.mainWindow.webContents.send('ytdlp-check-progress', null);
    console.log(`[ytdlp-fetch-info] ok — type=${info.type} entries=${info.entries?.length}`);
    return { ok: true, ...info };
  } catch (err) {
    if (global.mainWindow) global.mainWindow.webContents.send('ytdlp-check-progress', null);
    console.error('[ytdlp-fetch-info] error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-duplicate-urls', (_event, entries) => {
  return getExistingSourceUrls(entries); // [{url, trackId}]
});

ipcMain.handle('get-playlist-source-urls', (_event, playlistId) => {
  return getPlaylistSourceUrls(playlistId); // [{trackId, source_url, source_link}]
});

// ─── yt-dlp URL download ──────────────────────────────────────────────────────

ipcMain.handle(
  'ytdlp-download-url',
  async (_event, { url, playlistItems, playlistTitle, existingPlaylistId, newPlaylistName }) => {
    try {
      const send = (channel, data) => {
        if (global.mainWindow) global.mainWindow.webContents.send(channel, data);
      };
      const sendProgress = (data) => send('ytdlp-progress', data);
      const sendTrackUpdate = (data) => send('ytdlp-track-update', data);

      const cookiesBrowser = getSetting('ytdlp_cookies_browser', '') || null;

      sendProgress({
        msg: 'Starting download…',
        pct: 0,
        trackPct: 0,
        overallCurrent: 1,
        overallTotal: 1,
      });

      let playlistId = null;
      const trackIds = [];
      const importPromises = [];
      // Track which files were already handled by onFileReady (avoid double-import)
      const handledPaths = new Set();

      // Create or assign playlist upfront so every onFileReady can add tracks immediately
      if (existingPlaylistId) {
        playlistId = existingPlaylistId;
      } else if (newPlaylistName) {
        try {
          const { id } = findOrCreatePlaylist(newPlaylistName, null, url);
          playlistId = id;
          send('playlists-updated');
        } catch (err) {
          console.error('[ytdlp] findOrCreatePlaylist failed:', err.message);
        }
      }

      const handleFileReady = async ({
        filePath,
        originalUrl,
        trackUrl,
        platform,
        quality,
        title,
        index,
      }) => {
        handledPaths.add(filePath);
        sendTrackUpdate({ type: 'update', index, title, url: trackUrl, status: 'importing' });
        try {
          const trackId = await importAudioFile(filePath, {
            source_url: originalUrl,
            source_link: trackUrl !== originalUrl ? trackUrl : null,
            source_platform: platform,
            source_quality: quality,
          });
          trackIds.push(trackId);
          if (playlistId) {
            addTrackToPlaylist(playlistId, trackId);
            send('playlists-updated');
          }
          sendTrackUpdate({ type: 'update', index, title, url: trackUrl, status: 'done', trackId });
          send('library-updated');
        } catch (err) {
          sendTrackUpdate({
            type: 'update',
            index,
            title,
            url: trackUrl,
            status: 'failed',
            error: err.message,
          });
        }
      };

      let lastOverallCurrent = 0;

      const {
        files,
        playlistName: detectedPlaylistName,
        unavailableCount = 0,
      } = await ytDlpDownloadUrl(
        url,
        (data) => {
          // When a new playlist item starts downloading, emit a 'downloading' track update
          if (data.overallTotal > 1 && data.overallCurrent !== lastOverallCurrent) {
            lastOverallCurrent = data.overallCurrent;
            sendTrackUpdate({
              type: 'update',
              index: data.overallCurrent - 1,
              status: 'downloading',
            });
          }
          sendProgress(data);
        },
        {
          cookiesBrowser,
          playlistItems: playlistItems || null,
          onFileReady: (f) => {
            importPromises.push(handleFileReady(f));
          },
          onTrackMeta: ({ index, title }) => {
            sendTrackUpdate({ type: 'update', index, title, status: 'downloading' });
          },
          onTrackUnavailable: ({ videoId, reason }) => {
            // Find the track index by matching videoId in the pre-populated track list
            sendTrackUpdate({ type: 'unavailable', videoId, reason, status: 'failed' });
          },
          onPlaylistDetected: ({ name, total }) => {
            if (total > 1) {
              // Create playlist if not already assigned (fallback for non-interactive downloads)
              if (!playlistId) {
                try {
                  const { id } = findOrCreatePlaylist(
                    name || playlistTitle || 'Imported Playlist',
                    null,
                    url
                  );
                  playlistId = id;
                  send('playlists-updated');
                } catch (err) {
                  console.error('[ytdlp] findOrCreatePlaylist failed:', err.message);
                }
              }
              sendTrackUpdate({ type: 'init', total });
            }
          },
        }
      );

      // Wait for any in-flight imports to complete
      await Promise.allSettled(importPromises);

      // Fallback: import any files that weren't handled by onFileReady (e.g. fallback scan files)
      for (const { filePath, originalUrl, trackUrl, platform, quality } of files) {
        if (handledPaths.has(filePath)) continue;
        sendProgress({
          msg: 'Importing to library…',
          pct: 99,
          trackPct: 99,
          overallCurrent: 1,
          overallTotal: 1,
        });
        try {
          const trackId = await importAudioFile(filePath, {
            source_url: originalUrl,
            source_link: trackUrl !== originalUrl ? trackUrl : null,
            source_platform: platform,
            source_quality: quality,
          });
          trackIds.push(trackId);
          send('library-updated');
        } catch {
          // ignore individual import errors in fallback path
        }
      }

      sendProgress(null);

      // Post-download fallback: if yt-dlp never emitted "Downloading item X of Y"
      // (some extractors skip that line) but we imported multiple tracks, create the
      // playlist now using the final trackIds list.
      if (!playlistId && trackIds.length > 1) {
        try {
          const name =
            detectedPlaylistName || playlistTitle || `Playlist ${new Date().toLocaleDateString()}`;
          const { id: pid } = findOrCreatePlaylist(name, null, url);
          playlistId = pid;
          for (const tid of trackIds) {
            try {
              addTrackToPlaylist(playlistId, tid);
            } catch {
              /* dupe guard */
            }
          }
          send('playlists-updated');
        } catch (err) {
          console.error('[ytdlp] post-download createPlaylist failed:', err.message);
        }
      }

      return { ok: true, trackIds, playlistId: playlistId ?? null, unavailableCount };
    } catch (err) {
      if (global.mainWindow) global.mainWindow.webContents.send('ytdlp-progress', null);
      return { ok: false, error: err.message };
    }
  }
);

ipcMain.handle('open-external', async (_event, url) => {
  shell.openExternal(url);
});

// ─── USB / Rekordbox Export ────────────────────────────────────────────────────

function send(channel, data) {
  if (global.mainWindow) global.mainWindow.webContents.send(channel, data);
}

/** Shared: derive a safe filename from a track object. */
function trackToFilename(track, ext) {
  const rawBase =
    [track.artist, track.title].filter(Boolean).join(' - ') ||
    path.basename(track.file_path || '', ext || path.extname(track.file_path || ''));
  return (
    rawBase.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() +
    (ext || path.extname(track.file_path || ''))
  );
}

ipcMain.handle('check-usb-format', async (_, mountPath) => {
  const info = await detectFilesystem(mountPath);
  return {
    ...info,
    fsLabel: describeFilesystem(info.fs),
  };
});

ipcMain.handle('format-usb', async (_, { device, mountPoint }) => {
  try {
    await formatDrive(device, mountPoint, (msg) => send('format-usb-progress', { msg }));
    send('format-usb-progress', null);
    return { ok: true };
  } catch (err) {
    send('format-usb-progress', null);
    return { ok: false, error: err.message };
  }
});

/** Copies a track's audio file to {usbRoot}/music/, returns the USB path or null on error. */
function copyTrackToUsb(track, usbRoot, usedNames, useNormalized = false) {
  const srcPath =
    useNormalized && track.normalized_file_path && fs.existsSync(track.normalized_file_path)
      ? track.normalized_file_path
      : track.file_path;
  const ext = path.extname(srcPath || '');
  const filename = trackToFilename(track, ext);
  // Deduplicate filename
  let finalName = filename;
  let n = 1;
  while (usedNames.has(finalName.toLowerCase())) {
    finalName = filename.replace(ext, ` (${n++})${ext}`);
  }
  usedNames.set(finalName.toLowerCase(), true);

  const destDir = path.join(usbRoot, 'music');
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, finalName);

  if (!fs.existsSync(destPath) && fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
  }

  return `/music/${finalName}`;
}

/** Writes the Rekordbox PDB database file using the pure-JS writer. */
function runPdbExporter(payload, usbRoot) {
  const outputPath = path.join(usbRoot, 'PIONEER', 'rekordbox', 'export.pdb');
  writePdb(payload, outputPath);
}

// ── USB export manifest ────────────────────────────────────────────────────────
// Stored at {usbRoot}/PIONEER/rekordbox/export-manifest.json.
// Allows subsequent exports to the same USB to merge with existing data
// instead of rebuilding the PDB from only the current playlist's tracks.

function getManifestPath(usbRoot) {
  return path.join(usbRoot, 'PIONEER', 'rekordbox', 'export-manifest.json');
}

/** Returns { tracks: Map<id, pdbTrack>, playlists: Map<id, pdbPlaylist> } */
function loadManifest(usbRoot) {
  const p = getManifestPath(usbRoot);
  if (!fs.existsSync(p)) return { tracks: new Map(), playlists: new Map() };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      tracks: new Map((data.tracks || []).map((t) => [t.id, t])),
      playlists: new Map((data.playlists || []).map((pl) => [pl.id, pl])),
    };
  } catch {
    return { tracks: new Map(), playlists: new Map() };
  }
}

function saveManifest(usbRoot, tracksMap, playlistsMap) {
  const p = getManifestPath(usbRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      tracks: [...tracksMap.values()],
      playlists: [...playlistsMap.values()],
    }),
    'utf8'
  );
}

ipcMain.handle(
  'export-rekordbox',
  async (_, { usbRoot, playlistIds, playlistId, useNormalized = false }) => {
    try {
      const ids = playlistIds?.length ? playlistIds : playlistId ? [playlistId] : null;
      const allPlaylists = ids?.length
        ? ids.map((id) => getPlaylist(id)).filter(Boolean)
        : getPlaylists();

      const trackMap = new Map();
      for (const pl of allPlaylists) {
        for (const t of getPlaylistTracks(pl.id)) {
          if (!trackMap.has(t.id)) trackMap.set(t.id, t);
        }
      }
      const tracks = [...trackMap.values()];
      const total = tracks.length;

      // Load existing manifest so we can merge with previously exported tracks/playlists
      const { tracks: existingTracks, playlists: existingPlaylists } = loadManifest(usbRoot);
      const existingCount = existingTracks.size;

      send('export-rekordbox-progress', {
        msg: existingCount
          ? `Merging ${total} tracks into existing export (${existingCount} tracks already on USB)…`
          : `Exporting ${total} tracks…`,
        pct: 0,
      });

      // Pre-populate usedNames from existing manifest so copyTrackToUsb won't assign duplicate filenames
      const usedNames = new Map();
      for (const et of existingTracks.values()) {
        const name = path.basename(et.file_path || '').toLowerCase();
        if (name) usedNames.set(name, true);
      }

      // 2. Copy files to USB, build USB path map
      const usbPaths = new Map(); // trackId → USB path
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const usbPath = copyTrackToUsb(t, usbRoot, usedNames, useNormalized);
        usbPaths.set(t.id, usbPath);
        send('export-rekordbox-progress', {
          msg: `Copying files… ${i + 1}/${total}`,
          pct: Math.round(((i + 1) / total) * 40),
        });
      }

      // 3. Write ANLZ beat grid files (only for tracks in the current export)
      send('export-rekordbox-progress', { msg: 'Writing beat grids & waveforms…', pct: 40 });
      const anlzPaths = new Map(); // trackId → Pioneer analyze_path string for PDB
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const usbFilePath = usbPaths.get(t.id);
        if (!usbFilePath) continue;
        const anlzFolder = getAnlzFolder(usbFilePath).replace(/\\/g, '/');
        anlzPaths.set(t.id, `/${anlzFolder}/ANLZ0000.DAT`);
        const sourceFilePath =
          useNormalized && t.normalized_file_path && fs.existsSync(t.normalized_file_path)
            ? t.normalized_file_path
            : t.file_path || null;
        try {
          await writeAnlz({
            usbFilePath,
            sourceFilePath,
            beatgrid: t.beatgrid ?? null,
            bpm: t.bpm_override ?? t.bpm ?? 0,
            usbRoot,
            ffmpegPath: getFfmpegRuntimePath(),
          });
        } catch (err) {
          console.warn(`ANLZ write failed for track ${t.id}:`, err.message);
        }
        send('export-rekordbox-progress', {
          msg: `Beat grids & waveforms… ${i + 1}/${total}`,
          pct: 40 + Math.round(((i + 1) / total) * 30),
        });
      }

      // 4. Build PDB tracks for the current export
      send('export-rekordbox-progress', { msg: 'Writing Rekordbox database…', pct: 70 });
      const newPdbTracks = tracks.map((t) => ({
        id: t.id,
        title: t.title || '',
        artist: t.artist || '',
        album: t.album || '',
        duration: t.duration || 0,
        bpm: t.bpm_override ?? t.bpm ?? 0,
        key_raw: t.key_raw || '',
        file_path: usbPaths.get(t.id) || '',
        track_number: t.track_number || 0,
        year: t.year || '',
        label: t.label || '',
        genres: t.genres ? JSON.parse(t.genres) : [],
        file_size: t.file_size || 0,
        bitrate: t.bitrate || 0,
        comments: t.comments || '',
        rating: t.rating || 0,
        analyzePath: anlzPaths.get(t.id) || '',
      }));

      const newPdbPlaylists = allPlaylists.map((pl) => ({
        id: pl.id,
        name: pl.name,
        track_ids: getPlaylistTracks(pl.id)
          .map((t) => t.id)
          .filter((id) => usbPaths.has(id)),
      }));

      // Merge: existing data is the base; new export overrides by id
      const mergedTracks = new Map(existingTracks);
      for (const t of newPdbTracks) mergedTracks.set(t.id, t);

      const mergedPlaylists = new Map(existingPlaylists);
      for (const pl of newPdbPlaylists) mergedPlaylists.set(pl.id, pl);

      runPdbExporter(
        { usbRoot, tracks: [...mergedTracks.values()], playlists: [...mergedPlaylists.values()] },
        usbRoot
      );
      writeSettingFiles(usbRoot);
      saveManifest(usbRoot, mergedTracks, mergedPlaylists);

      send('export-rekordbox-progress', { msg: 'Done!', pct: 100 });
      send('export-rekordbox-progress', null);
      return { ok: true, trackCount: mergedTracks.size, newTrackCount: total, usbRoot };
    } catch (err) {
      send('export-rekordbox-progress', null);
      return { ok: false, error: err.message };
    }
  }
);

ipcMain.handle(
  'export-all',
  async (_, { usbRoot, playlistIds, playlistId, useNormalized = false }) => {
    try {
      const ids = playlistIds?.length ? playlistIds : playlistId ? [playlistId] : null;
      const allPlaylists = ids?.length
        ? ids.map((id) => getPlaylist(id)).filter(Boolean)
        : getPlaylists();

      // Build deduped track map once, shared by both M3U and Rekordbox
      const trackMap = new Map();
      for (const pl of allPlaylists) {
        for (const t of getPlaylistTracks(pl.id)) {
          if (!trackMap.has(t.id)) trackMap.set(t.id, t);
        }
      }
      const allTracks = [...trackMap.values()];
      const total = allTracks.length;

      // Load existing manifest for merging
      const { tracks: existingTracks, playlists: existingPlaylists } = loadManifest(usbRoot);
      const existingCount = existingTracks.size;

      send('export-all-progress', {
        msg: existingCount
          ? `Merging ${total} tracks into existing export (${existingCount} tracks already on USB)…`
          : `Exporting ${total} tracks…`,
        pct: 0,
      });

      // Pre-populate usedNames from manifest to avoid filename collisions
      const usedNames = new Map();
      for (const et of existingTracks.values()) {
        const name = path.basename(et.file_path || '').toLowerCase();
        if (name) usedNames.set(name, true);
      }

      // Copy files once
      const usbPaths = new Map();
      for (let i = 0; i < allTracks.length; i++) {
        const t = allTracks[i];
        usbPaths.set(t.id, copyTrackToUsb(t, usbRoot, usedNames, useNormalized));
        send('export-all-progress', {
          msg: `Copying files… ${i + 1}/${total}`,
          pct: Math.round(((i + 1) / total) * 35),
        });
      }

      // Write M3U playlists (USB path mode)
      send('export-all-progress', { msg: 'Writing M3U playlists…', pct: 35 });
      const playlistDir = path.join(usbRoot, 'playlists');
      fs.mkdirSync(playlistDir, { recursive: true });
      for (const pl of allPlaylists) {
        const tracks = getPlaylistTracks(pl.id);
        const safeName = pl.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
        const lines = ['#EXTM3U'];
        for (const t of tracks) {
          const usbPath = usbPaths.get(t.id);
          if (!usbPath) continue;
          const duration = Math.floor(t.duration ?? -1);
          const label = [t.artist, t.title].filter(Boolean).join(' - ') || path.basename(usbPath);
          lines.push(`#EXTINF:${duration},${label}`);
          lines.push(usbPath);
        }
        fs.writeFileSync(
          path.join(playlistDir, `${safeName}.m3u`),
          lines.join('\n') + '\n',
          'utf8'
        );
      }

      // Write ANLZ beat grids + waveforms (only for tracks in the current export)
      send('export-all-progress', { msg: 'Writing beat grids & waveforms…', pct: 50 });
      for (let i = 0; i < allTracks.length; i++) {
        const t = allTracks[i];
        const usbFilePath = usbPaths.get(t.id);
        if (!usbFilePath) continue;
        const sourceFilePath =
          useNormalized && t.normalized_file_path && fs.existsSync(t.normalized_file_path)
            ? t.normalized_file_path
            : t.file_path || null;
        try {
          await writeAnlz({
            usbFilePath,
            sourceFilePath,
            beatgrid: t.beatgrid ?? null,
            bpm: t.bpm_override ?? t.bpm ?? 0,
            usbRoot,
            ffmpegPath: getFfmpegRuntimePath(),
          });
        } catch (err) {
          console.warn(`ANLZ write failed for track ${t.id}:`, err.message);
        }
        send('export-all-progress', {
          msg: `Beat grids & waveforms… ${i + 1}/${total}`,
          pct: 50 + Math.round(((i + 1) / total) * 20),
        });
      }

      // Write PDB — merge with existing manifest
      send('export-all-progress', { msg: 'Writing Rekordbox database…', pct: 70 });
      const newPdbTracks = allTracks.map((t) => ({
        id: t.id,
        title: t.title || '',
        artist: t.artist || '',
        album: t.album || '',
        duration: t.duration || 0,
        bpm: t.bpm_override ?? t.bpm ?? 0,
        key_raw: t.key_raw || '',
        file_path: usbPaths.get(t.id) || '',
        track_number: t.track_number || 0,
        year: t.year || '',
        label: t.label || '',
        genres: t.genres ? JSON.parse(t.genres) : [],
        file_size: t.file_size || 0,
        bitrate: t.bitrate || 0,
        comments: t.comments || '',
        rating: t.rating || 0,
        analyzePath: (() => {
          const usbFP = usbPaths.get(t.id);
          if (!usbFP) return '';
          const folder = getAnlzFolder(usbFP).replace(/\\/g, '/');
          return folder ? `/${folder}/ANLZ0000.DAT` : '';
        })(),
      }));
      const newPdbPlaylists = allPlaylists.map((pl) => ({
        id: pl.id,
        name: pl.name,
        track_ids: getPlaylistTracks(pl.id)
          .map((t) => t.id)
          .filter((id) => usbPaths.has(id)),
      }));

      const mergedTracks = new Map(existingTracks);
      for (const t of newPdbTracks) mergedTracks.set(t.id, t);

      const mergedPlaylists = new Map(existingPlaylists);
      for (const pl of newPdbPlaylists) mergedPlaylists.set(pl.id, pl);

      runPdbExporter(
        { usbRoot, tracks: [...mergedTracks.values()], playlists: [...mergedPlaylists.values()] },
        usbRoot
      );
      writeSettingFiles(usbRoot);
      saveManifest(usbRoot, mergedTracks, mergedPlaylists);

      send('export-all-progress', { msg: 'Done!', pct: 100 });
      send('export-all-progress', null);
      return {
        ok: true,
        trackCount: mergedTracks.size,
        newTrackCount: total,
        playlistCount: mergedPlaylists.size,
        usbRoot,
      };
    } catch (err) {
      send('export-all-progress', null);
      return { ok: false, error: err.message };
    }
  }
);

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
