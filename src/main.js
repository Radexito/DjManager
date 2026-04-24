import path from 'path';
import fs from 'fs';
import os from 'os';
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
app.name = 'Dj Manager';

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
import { closeDB } from './db/database.js';
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
  getTracksByPaths,
  getLinkedTrackDirs,
  getLinkedTracksBasic,
  remapTracksByPrefix,
  removeTrack,
  updateTrack,
  resetNormalization,
  clearTracks,
  getTrackIdsNeedingNormalization,
  getNormalizedTrackCount,
  getExistingSourceUrls,
  getPlaylistSourceUrls,
  getTrackWaveform,
  updateTrackWaveform,
} from './db/trackRepository.js';
import { getSetting, setSetting } from './db/settingsRepository.js';
import {
  importAudioFile,
  linkAudioFile,
  spawnAnalysis,
  cancelAnalysis,
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
import {
  checkTidalSetup,
  startLogin as tidalStartLogin,
  downloadTidal,
  fetchTidalInfo,
} from './audio/tidalDlManager.js';
import { generateWaveformOverview } from './audio/waveformGenerator.js';
import { ensureDeps, getFfmpegRuntimePath } from './deps.js';
import { generateEditorWaveform } from './audio/waveformGenerator.js';
import {
  getInstalledVersions,
  checkForUpdates,
  updateAnalyzer,
  updateYtDlp,
  updateTidalDlNg,
  ensureTidalDlNg,
  updateAll,
} from './deps.js';
import { initLogger, getLogDir } from './logger.js';
import { detectFilesystem, formatDrive, describeFilesystem } from './usb/usbUtils.js';
import { writeAnlz, getAnlzFolder } from './audio/anlzWriter.js';
import { writeSettingFiles } from './usb/settingWriter.js';
import { writePdb } from './usb/pdbWriter.js';
import { getResetCleanupTargets, startResetCleanup } from './resetCleanup.js';
import {
  getCuePoints,
  addCuePoint,
  updateCuePoint,
  deleteCuePoint,
  deleteAllCuePoints,
  deleteAllCuePointsLibrary,
} from './db/cuePointRepository.js';
import { generateCuePoints } from './audio/cueGen.js';

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

// Mutable list of extra allowed base paths for the media server.
// Push the explorer root folder here when the user picks one so the server
// will serve files from that directory tree.
const explorerAllowedBases = [];

function startMediaServer() {
  const audioBase = path.join(app.getPath('userData'), 'audio');
  const artworkBase = getArtworkBase();
  return _startMediaServer(audioBase, artworkBase, explorerAllowedBases).then(({ port }) => {
    mediaServerPort = port;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'DjManager - RWTechWorks.pl',
    width: 1200,
    height: 800,
    backgroundColor: '#0f0f0f',
    icon: path.join(app.getAppPath(), 'build-resources/icon.png'),
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
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        event.preventDefault();
      }
    });
  }
}

function logDiagnostics() {
  const userData = app.getPath('userData');
  const binDir = path.join(userData, 'bin');
  const keyPaths = {
    userData,
    bin: binDir,
    'ffmpeg.exe': path.join(binDir, 'ffmpeg', 'ffmpeg.exe'),
    'ffprobe.exe': path.join(binDir, 'ffmpeg', 'ffprobe.exe'),
    'analysis.exe': path.join(binDir, 'analysis.exe'),
    'yt-dlp.exe': path.join(binDir, 'yt-dlp.exe'),
  };

  console.log('[diag] ── Windows 11 diagnostics ──────────────────────────');
  console.log(`[diag] os.platform   = ${os.platform()}`);
  console.log(`[diag] os.release    = ${os.release()}`);
  console.log(`[diag] os.version    = ${os.version()}`);
  console.log(`[diag] process.arch  = ${process.arch}`);
  console.log(`[diag] app.version   = ${app.getVersion()}`);
  console.log('[diag] key paths (length / exists):');
  for (const [label, p] of Object.entries(keyPaths)) {
    const exists = fs.existsSync(p);
    const tooLong = p.length >= 260;
    console.log(
      `[diag]   ${label.padEnd(14)} len=${p.length}${tooLong ? ' ⚠ NEAR/OVER MAX_PATH' : ''} exists=${exists}  ${p}`
    );
  }
  console.log('[diag] ─────────────────────────────────────────────────────');
}

async function autoGenerateMissingWaveforms() {
  const tracks = getTracks({ limit: 999999 });
  const missing = tracks.filter((t) => t.analyzed === 1 && t.waveform_overview == null);
  if (missing.length === 0) return;

  console.log(`[waveform] generating overviews for ${missing.length} tracks…`);
  let completed = 0;

  const sendProgress = (done = false) => {
    if (global.mainWindow) {
      global.mainWindow.webContents.send('waveform-gen-progress', {
        completed,
        total: missing.length,
        done,
      });
    }
  };

  for (const track of missing) {
    try {
      const buf = await generateWaveformOverview(track.file_path, getFfmpegRuntimePath());
      updateTrackWaveform(track.id, buf);
    } catch (err) {
      console.warn(`[waveform] failed for track ${track.id}:`, err.message);
    }
    completed++;
    sendProgress();
  }

  sendProgress(true);
  console.log(`[waveform] done — generated ${completed} overviews`);
}

async function initApp() {
  initLogger();
  if (process.platform === 'win32') logDiagnostics();
  console.log('Initializing database...');
  initDB();
  // Pre-allow all directories of existing linked tracks so the media server
  // can serve them without requiring the user to re-open the Explorer.
  for (const dir of getLinkedTrackDirs()) {
    if (!explorerAllowedBases.includes(dir)) explorerAllowedBases.push(dir);
  }
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
      // Auto-generate waveforms for any analyzed tracks missing overview data
      autoGenerateMissingWaveforms();
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
ipcMain.handle('get-track-waveform', (_, trackId) => {
  const buf = getTrackWaveform(trackId);
  return buf ? new Uint8Array(buf) : null;
});
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
ipcMain.handle('cancel-analysis', (_, trackId) => {
  const cancelled = cancelAnalysis(trackId);
  return { cancelled };
});
ipcMain.handle('remove-track', (_, trackId) => {
  removeTrack(trackId); // ON DELETE CASCADE removes playlist_tracks rows
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
  return { ok: true };
});
ipcMain.handle('remove-linked-file', async (_, trackId) => {
  const track = getTrackById(trackId);
  if (!track) return { ok: false, error: 'not found' };
  const filePath = track.file_path;
  removeTrack(trackId);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
  send('library-updated');
  if (global.mainWindow) global.mainWindow.webContents.send('playlists-updated');
  return { ok: true };
});
ipcMain.handle('update-track', (_, { id, data }) => {
  updateTrack(id, data);
  const track = getTrackById(id);
  // Notify renderer so MusicLibrary + PlayerContext stay in sync
  if (global.mainWindow) {
    global.mainWindow.webContents.send('track-updated', { trackId: id, analysis: data });
  }
  // Fire-and-forget ID3 tag write-back (non-blocking, best-effort)
  if (track?.file_path) {
    writeId3Tags(track.file_path, data).catch((e) =>
      console.error('[update-track] id3 write failed:', e.message)
    );
  }
  return { ok: true };
});
ipcMain.handle('get-editor-waveform', async (_, trackId) => {
  const track = getTrackById(trackId);
  if (!track?.file_path) return null;
  try {
    const result = await generateEditorWaveform(track.file_path, getFfmpegRuntimePath());
    return result;
  } catch (e) {
    console.error('[get-editor-waveform]', e.message);
    return null;
  }
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
// ── Cue point IPC handlers ────────────────────────────────────────────────────
ipcMain.handle('get-cue-points', (_, trackId) => getCuePoints(trackId));

ipcMain.handle('add-cue-point', (_, { trackId, positionMs, label, color, hotCueIndex }) => {
  const id = addCuePoint({ trackId, positionMs, label, color, hotCueIndex });
  return { id };
});

ipcMain.handle('update-cue-point', (_, { id, label, color, hotCueIndex, enabled }) => {
  updateCuePoint(id, { label, color, hotCueIndex, enabled });
  return { ok: true };
});

ipcMain.handle('delete-cue-point', (_, id) => {
  deleteCuePoint(id);
  return { ok: true };
});

ipcMain.handle('generate-cue-points', (_, trackId) => {
  const track = getTrackById(trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  deleteAllCuePoints(trackId);
  const generated = generateCuePoints(track);
  generated.forEach((cue) => addCuePoint({ trackId, ...cue }));
  return getCuePoints(trackId);
});

ipcMain.handle('generate-cue-points-library', (_, { overwrite = false } = {}) => {
  const tracks = getTracks({ limit: 999999 });
  const analyzed = tracks.filter((t) => t.analyzed === 1);
  const total = analyzed.length;
  let generated = 0;
  let skipped = 0;

  const sendProgress = (done = false) => {
    if (global.mainWindow) {
      global.mainWindow.webContents.send('cue-gen-progress', {
        completed: generated + skipped,
        total,
        done,
      });
    }
  };

  for (const track of analyzed) {
    const existing = getCuePoints(track.id);
    if (!overwrite && existing.length > 0) {
      skipped++;
      sendProgress();
      continue;
    }
    deleteAllCuePoints(track.id);
    const cues = generateCuePoints(track);
    cues.forEach((cue) => addCuePoint({ trackId: track.id, ...cue }));
    generated++;
    if (global.mainWindow) {
      global.mainWindow.webContents.send('cue-points-updated', {
        trackId: track.id,
        cueCount: cues.length,
      });
    }
    sendProgress();
  }

  sendProgress(true);
  return { generated, skipped, total };
});

ipcMain.handle('delete-all-cue-points-library', () => {
  const affected = deleteAllCuePointsLibrary();
  if (global.mainWindow) {
    for (const trackId of affected) {
      global.mainWindow.webContents.send('cue-points-updated', { trackId, cueCount: 0 });
    }
  }
  return { deleted: affected.length };
});

// Generate waveform overviews for all analyzed tracks in the library
ipcMain.handle('generate-waveforms-library', async (_, { overwrite = false } = {}) => {
  const tracks = getTracks({ limit: 999999 });
  const analyzed = tracks.filter((t) => t.analyzed === 1);
  const total = analyzed.length;
  let generated = 0;
  let skipped = 0;

  const sendProgress = (done = false) => {
    if (global.mainWindow) {
      global.mainWindow.webContents.send('waveform-gen-progress', {
        completed: generated + skipped,
        total,
        done,
      });
    }
  };

  for (const track of analyzed) {
    if (!overwrite && track.waveform_overview != null) {
      skipped++;
      sendProgress();
      continue;
    }
    try {
      const buf = await generateWaveformOverview(track.file_path, getFfmpegRuntimePath());
      updateTrackWaveform(track.id, buf);
      generated++;
    } catch (err) {
      console.warn(`[waveform-gen] failed for track ${track.id}:`, err.message);
      skipped++;
    }
    sendProgress();
  }

  sendProgress(true);
  return { generated, skipped, total };
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
ipcMain.handle('import-audio-files', async (event, filePaths, playlistId) => {
  console.log('Importing audio files:', filePaths);
  const trackIds = [];
  const total = filePaths.length;

  for (let i = 0; i < total; i++) {
    try {
      const trackId = await importAudioFile(filePaths[i]);
      trackIds.push(trackId);
    } catch (err) {
      console.error('Import failed:', filePaths[i], err);
    }
    if (global.mainWindow) {
      global.mainWindow.webContents.send('import-progress', { completed: i + 1, total });
    }
  }

  if (trackIds.length > 0 && global.mainWindow) {
    if (playlistId) {
      addTracksToPlaylist(playlistId, trackIds);
      global.mainWindow.webContents.send('playlists-updated');
    }
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
  const toDelete = getResetCleanupTargets({
    userDataPath: app.getPath('userData'),
    cachePath: app.getPath('cache'),
    logsPath: app.getPath('logs'),
  });
  // Run the actual deletion in a detached helper after this process exits so
  // Windows/Electron file handles cannot keep the database or userData tree
  // alive during the reset.
  closeDB();
  startResetCleanup({ parentPid: process.pid, targets: toDelete });
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

ipcMain.handle('update-tidal-dl-ng', async (_event) => {
  try {
    await updateTidalDlNg((msg, pct) => {
      if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', { msg, pct });
    });
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
    return { ok: true };
  } catch (err) {
    if (global.mainWindow) global.mainWindow.webContents.send('deps-progress', null);
    return { ok: false, error: err.message };
  }
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
        channel,
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
            channel: channel || null,
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

// ─── TIDAL download ───────────────────────────────────────────────────────────

ipcMain.handle('tidal-check', async () => {
  return checkTidalSetup();
});

ipcMain.handle('tidal-install', async () => {
  try {
    await ensureTidalDlNg((line) => {
      if (global.mainWindow)
        global.mainWindow.webContents.send('tidal-install-progress', { msg: line });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('tidal-fetch-info', async (_event, url) => {
  console.log('[tidal-fetch-info] fetching info for:', url);
  try {
    const info = await fetchTidalInfo(url);
    console.log(`[tidal-fetch-info] ok — type=${info.type} entries=${info.entries?.length}`);
    return info;
  } catch (err) {
    console.error('[tidal-fetch-info] error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('tidal-login', async () => {
  try {
    await tidalStartLogin((url) => {
      if (global.mainWindow) global.mainWindow.webContents.send('tidal-login-url', url);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle(
  'tidal-download-url',
  async (_event, { url, selectedEntries, linkTrackIds, existingPlaylistId, newPlaylistName }) => {
    const send = (ch, data) => {
      if (global.mainWindow) global.mainWindow.webContents.send(ch, data);
    };
    const sendTrackUpdate = (data) => send('tidal-track-update', data);
    const sendProgress = (msg) => send('tidal-progress', { msg });

    try {
      const tmpDir = path.join(app.getPath('userData'), 'tidal_tmp');

      // Resolve the download URLs: individual track URLs when selectedEntries are provided,
      // otherwise the raw URL (for mixes and direct single-URL downloads).
      const downloadUrls =
        selectedEntries?.length > 0
          ? selectedEntries.map((e) => `https://tidal.com/browse/track/${e.id}`)
          : [url];

      // Create playlist before starting download so tracks can be added progressively.
      let playlistId = null;
      if (existingPlaylistId) {
        playlistId = existingPlaylistId;
      } else if (newPlaylistName?.trim()) {
        try {
          const { id } = findOrCreatePlaylist(newPlaylistName.trim(), null, url);
          playlistId = id;
          send('playlists-updated');
        } catch (err) {
          console.error('[tidal] findOrCreatePlaylist failed:', err.message);
        }
      }

      // Emit init event so the UI can render the full track list immediately.
      if (selectedEntries?.length > 0) {
        sendTrackUpdate({ type: 'init', tracks: selectedEntries });
      }

      const trackIds = [];
      // fileIndex tracks which selectedEntry corresponds to the next file reported by onFileReady.
      // tdn downloads in the order we pass URLs, so positional matching is reliable.
      let fileIndex = 0;

      const onFileReady = async (filePath) => {
        const entry = selectedEntries?.[fileIndex] ?? null;
        const idx = fileIndex;
        fileIndex++;

        if (entry) {
          sendTrackUpdate({
            index: idx,
            title: entry.title,
            artist: entry.artist,
            status: 'importing',
          });
        } else {
          // No entry info (e.g. mix download) — emit a generic update
          sendTrackUpdate({
            index: idx,
            title: path.basename(filePath),
            artist: '',
            status: 'importing',
          });
        }

        try {
          const trackSourceUrl = entry?.id ? `https://tidal.com/browse/track/${entry.id}` : url;
          const trackId = await importAudioFile(filePath, {
            source_url: trackSourceUrl,
            source_link: url !== trackSourceUrl ? url : null,
            source_platform: 'tidal',
          });
          trackIds.push(trackId);
          if (playlistId) {
            addTrackToPlaylist(playlistId, trackId);
            send('playlists-updated');
          }
          send('library-updated');
          sendTrackUpdate({
            index: idx,
            title: entry?.title ?? path.basename(filePath),
            artist: entry?.artist ?? '',
            status: 'done',
            trackId,
          });
        } catch (err) {
          console.error('[tidal] importAudioFile failed:', err.message);
          sendTrackUpdate({
            index: idx,
            title: entry?.title ?? path.basename(filePath),
            artist: entry?.artist ?? '',
            status: 'failed',
            error: err.message,
          });
        }
      };

      sendProgress('Starting download…');

      // Only call tdn if there are new tracks to download
      const hasDownloads = selectedEntries?.length > 0 || !selectedEntries;
      if (hasDownloads) {
        const files = await downloadTidal(downloadUrls, tmpDir, sendProgress, { onFileReady });
        if (files.length === 0 && trackIds.length === 0 && (linkTrackIds?.length ?? 0) === 0) {
          send('tidal-progress', null);
          return { ok: false, error: 'Download finished but no audio files were found.' };
        }
      }

      // Link already-in-library tracks to the playlist (no re-download needed)
      if (linkTrackIds?.length > 0 && playlistId) {
        for (const tid of linkTrackIds) {
          try {
            addTrackToPlaylist(playlistId, tid);
          } catch {
            // ignore duplicate playlist entry errors
          }
        }
        send('playlists-updated');
      }

      send('tidal-progress', null);
      return { ok: true, trackIds, playlistId: playlistId ?? null };
    } catch (err) {
      send('tidal-progress', null);
      return { ok: false, error: err.message };
    }
  }
);

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

// ── File Explorer IPC ──────────────────────────────────────────────────────────

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.opus',
]);

ipcMain.handle('select-explorer-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Folder to Browse',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const folderPath = result.filePaths[0];
  if (!explorerAllowedBases.includes(folderPath)) {
    explorerAllowedBases.push(folderPath);
  }
  return folderPath;
});

ipcMain.handle('browse-directory', (_, dirPath) => {
  if (!explorerAllowedBases.some((base) => dirPath.startsWith(base))) {
    explorerAllowedBases.push(dirPath);
  }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        dirs.push({ name: entry.name, path: fullPath });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          let size = 0;
          try {
            size = fs.statSync(fullPath).size;
          } catch {}
          files.push({ name: entry.name, path: fullPath, size });
        }
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { dirs, files };
  } catch (err) {
    return { dirs: [], files: [], error: err.message };
  }
});

ipcMain.handle('get-explorer-track-metadata', async (_, filePath) => {
  try {
    const { ffprobe: runFfprobe } = await import('./audio/ffmpeg.js');
    const data = await runFfprobe(filePath);
    const tags = data.format?.tags || {};
    const stream = data.streams?.find((s) => s.codec_type === 'audio') || {};
    const bpmTag = tags.bpm || tags.BPM || tags.TBPM || tags['tbpm'];
    const keyTag = tags.key || tags.KEY || tags.initialkey || tags.INITIALKEY || null;
    return {
      title: tags.title || path.basename(filePath, path.extname(filePath)),
      artist: tags.artist || '',
      album: tags.album || '',
      year: tags.date ? parseInt(tags.date.slice(0, 4)) : null,
      label: tags.label || '',
      genre: tags.genre ? tags.genre.split(',').map((g) => g.trim()) : [],
      bpm: bpmTag ? parseFloat(bpmTag) || null : null,
      key_raw: keyTag,
      duration: parseFloat(data.format?.duration) || null,
      bitrate: parseInt(stream.bit_rate || data.format?.bit_rate || 0, 10) || null,
    };
  } catch (err) {
    return {
      title: path.basename(filePath, path.extname(filePath)),
      artist: '',
      album: '',
      bpm: null,
      key_raw: null,
      duration: null,
      bitrate: null,
      error: err.message,
    };
  }
});

ipcMain.handle('export-explorer-to-usb', async (_, { filePaths, usbRoot, playlistName }) => {
  try {
    const total = filePaths.length;
    send('export-explorer-progress', { msg: `Exporting ${total} tracks to USB…`, pct: 0 });

    const usedNames = new Map();
    const pdbTracks = [];
    const anlzPaths = new Map();

    for (let i = 0; i < filePaths.length; i++) {
      const srcPath = filePaths[i];
      const ext = path.extname(srcPath);

      // Extract metadata
      let meta = {
        title: path.basename(srcPath, ext),
        artist: '',
        album: '',
        bpm: null,
        key_raw: '',
        duration: 0,
        bitrate: 0,
      };
      try {
        const { ffprobe: runFfprobe } = await import('./audio/ffmpeg.js');
        const data = await runFfprobe(srcPath);
        const tags = data.format?.tags || {};
        const stream = data.streams?.find((s) => s.codec_type === 'audio') || {};
        const bpmTag = tags.bpm || tags.BPM || tags.TBPM || tags['tbpm'];
        meta = {
          title: tags.title || path.basename(srcPath, ext),
          artist: tags.artist || '',
          album: tags.album || '',
          bpm: bpmTag ? parseFloat(bpmTag) || null : null,
          key_raw: tags.key || tags.KEY || tags.initialkey || tags.INITIALKEY || '',
          duration: parseFloat(data.format?.duration) || 0,
          bitrate: parseInt(stream.bit_rate || data.format?.bit_rate || 0, 10) || 0,
        };
      } catch {}

      // Copy to USB /music/
      const rawBase =
        [meta.artist, meta.title].filter(Boolean).join(' - ') || path.basename(srcPath, ext);
      const safeBase = rawBase.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
      let filename = `${safeBase}${ext}`;
      let n = 1;
      while (usedNames.has(filename.toLowerCase())) {
        filename = `${safeBase} (${n++})${ext}`;
      }
      usedNames.set(filename.toLowerCase(), true);

      const destDir = path.join(usbRoot, 'music');
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, filename);
      if (!fs.existsSync(destPath)) fs.copyFileSync(srcPath, destPath);
      const usbFilePath = `/music/${filename}`;

      // Write minimal ANLZ (path + beatgrid only, no waveform for speed)
      try {
        const anlzDat = await writeAnlz({
          usbFilePath,
          sourceFilePath: null,
          beatgrid: null,
          bpm: meta.bpm || 0,
          beatgridOffset: 0,
          usbRoot,
          ffmpegPath: getFfmpegRuntimePath(),
          cuePoints: [],
        });
        anlzPaths.set(i, anlzDat);
      } catch {}

      let fileSize = 0;
      try {
        fileSize = fs.statSync(destPath).size;
      } catch {}

      pdbTracks.push({
        id: i + 1,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration: meta.duration,
        bpm: meta.bpm || 0,
        key_raw: meta.key_raw,
        file_path: usbFilePath,
        track_number: i + 1,
        year: '',
        label: '',
        genres: [],
        file_size: fileSize,
        bitrate: meta.bitrate,
        comments: '',
        rating: 0,
        analyzePath: anlzPaths.get(i) || '',
      });

      const pct = Math.round(((i + 1) / total) * 90);
      send('export-explorer-progress', { msg: `Copying ${i + 1}/${total}: ${filename}`, pct });
    }

    send('export-explorer-progress', { msg: 'Writing PDB database…', pct: 92 });

    const pdbPlaylists = playlistName
      ? [{ id: 1, name: playlistName, track_ids: pdbTracks.map((t) => t.id) }]
      : [];

    const outputPath = path.join(usbRoot, 'PIONEER', 'rekordbox', 'export.pdb');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    writePdb({ tracks: pdbTracks, playlists: pdbPlaylists }, outputPath);

    send('export-explorer-progress', { msg: 'Writing settings files…', pct: 96 });
    try {
      await writeSettingFiles(usbRoot);
    } catch {}

    send('export-explorer-progress', null);
    return { ok: true, trackCount: pdbTracks.length, usbRoot };
  } catch (err) {
    send('export-explorer-progress', null);
    return { ok: false, error: err.message };
  }
});

// ── File Explorer v2 IPC ───────────────────────────────────────────────────────

ipcMain.handle('get-computer-root', () => {
  const home = os.homedir();
  let root;
  if (process.platform === 'win32') {
    root = path.parse(home).root || 'C:\\';
  } else {
    root = '/';
  }
  return { root, home };
});

ipcMain.handle('get-tracks-by-paths', (_, filePaths) => {
  return getTracksByPaths(filePaths);
});

let activeRecursiveWalker = null;

ipcMain.handle('explorer-start-recursive', (_, dirPath) => {
  if (activeRecursiveWalker) activeRecursiveWalker.cancelled = true;
  const walker = { cancelled: false };
  activeRecursiveWalker = walker;

  if (!explorerAllowedBases.includes(dirPath)) explorerAllowedBases.push(dirPath);

  async function walk(d) {
    if (walker.cancelled) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const batch = [];
    const dirs = [];
    for (const entry of entries) {
      if (walker.cancelled) return;
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        dirs.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          let size = 0;
          try {
            size = fs.statSync(fullPath).size;
          } catch {}
          batch.push({ name: entry.name, path: fullPath, size });
        }
      }
    }
    if (batch.length > 0 && !walker.cancelled) {
      send('explorer-recursive-batch', batch);
    }
    for (const subdir of dirs) {
      if (walker.cancelled) return;
      await new Promise((r) => setImmediate(r));
      await walk(subdir);
    }
  }

  walk(dirPath).then(() => {
    if (!walker.cancelled) send('explorer-recursive-done', null);
  });

  return { ok: true };
});

ipcMain.handle('explorer-cancel-recursive', () => {
  if (activeRecursiveWalker) activeRecursiveWalker.cancelled = true;
  activeRecursiveWalker = null;
});

ipcMain.handle('link-audio-files', async (_, { filePaths, playlistId }) => {
  const results = [];
  for (const filePath of filePaths) {
    try {
      const result = await linkAudioFile(filePath);
      if (!result.duplicate && playlistId) {
        await addTrackToPlaylist(playlistId, result.id);
      }
      const dir = path.dirname(filePath);
      if (!explorerAllowedBases.includes(dir)) explorerAllowedBases.push(dir);
      results.push(result);
    } catch (err) {
      results.push({ id: null, duplicate: false, error: err.message, path: filePath });
    }
  }
  send('library-updated');
  if (playlistId) send('playlists-updated');
  return results;
});

ipcMain.handle('link-directory', async (_, { dirPath, recursive, playlistId }) => {
  if (!explorerAllowedBases.includes(dirPath)) explorerAllowedBases.push(dirPath);
  const filePaths = [];

  function collectFiles(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (recursive && entry.isDirectory() && !entry.name.startsWith('.')) {
        collectFiles(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) filePaths.push(fullPath);
      }
    }
  }
  collectFiles(dirPath);

  let linked = 0;
  for (const filePath of filePaths) {
    try {
      const result = await linkAudioFile(filePath);
      if (!result.duplicate) linked++;
      if (!result.duplicate && playlistId) await addTrackToPlaylist(playlistId, result.id);
      const dir = path.dirname(filePath);
      if (!explorerAllowedBases.includes(dir)) explorerAllowedBases.push(dir);
    } catch {}
  }

  send('library-updated');
  if (playlistId) send('playlists-updated');
  return { ok: true, linked, total: filePaths.length };
});

ipcMain.handle('remap-track', async (_, { trackId, newPath }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    defaultPath: newPath || undefined,
    filters: [
      {
        name: 'Audio Files',
        extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'aiff', 'aif', 'opus'],
      },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const resolvedPath = result.filePaths[0];
  updateTrack(trackId, { file_path: resolvedPath });
  const dir = path.dirname(resolvedPath);
  if (!explorerAllowedBases.includes(dir)) explorerAllowedBases.push(dir);
  return { ok: true, newPath: resolvedPath };
});

ipcMain.handle('remap-folder', async (_, { oldDir }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: `Select new location for folder: ${path.basename(oldDir)}`,
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const newDir = result.filePaths[0];
  const oldSep = oldDir.endsWith(path.sep) ? oldDir : oldDir + path.sep;
  const newSep = newDir.endsWith(path.sep) ? newDir : newDir + path.sep;
  const count = remapTracksByPrefix(oldSep, newSep);
  if (!explorerAllowedBases.includes(newDir)) explorerAllowedBases.push(newDir);
  return { ok: true, count, newDir };
});

ipcMain.handle('check-linked-track-status', (_, trackIds) => {
  return trackIds.map((id) => {
    const t = getTrackById(id);
    if (!t) return { id, exists: false };
    return { id, exists: !t.is_linked || fs.existsSync(t.file_path) };
  });
});

ipcMain.handle('get-linked-tracks-basic', () => {
  return getLinkedTracksBasic();
});

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
            beatgridOffset: t.beatgrid_offset ?? 0,
            usbRoot,
            ffmpegPath: getFfmpegRuntimePath(),
            cuePoints: getCuePoints(t.id).filter((c) => c.enabled !== 0),
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
        replay_gain: t.replay_gain ?? null,
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
            beatgridOffset: t.beatgrid_offset ?? 0,
            usbRoot,
            ffmpegPath: getFfmpegRuntimePath(),
            cuePoints: getCuePoints(t.id).filter((c) => c.enabled !== 0),
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
        replay_gain: t.replay_gain ?? null,
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
