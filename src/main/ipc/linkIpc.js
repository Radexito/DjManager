/**
 * Linking, remapping and moving between libraries (tor B, slice 17).
 *
 * Eight channels moved out of `src/main.js`. They all reach the filesystem and
 * all of them extend the explorer/media-server allowlist, so they are the last
 * block where path handling matters.
 *
 * Two things changed on the way in, both deliberate:
 *
 *   - `remap-folder` used to build its prefix from the raw `oldDir` string that
 *     the renderer sent. `/music/../etc` and `/music` are the same directory but
 *     two different prefixes, so a caller could remap rows it should not reach.
 *     Both sides are resolved first, the same rule the allowlist itself uses.
 *   - `link-directory` swallowed every error with an empty catch, so a folder
 *     where nothing could be linked looked exactly like an empty one. Failures
 *     are counted and reported per path instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail, handle, ok } from './response.js';

/**
 * Register the linking channels: computer root listing, link files and
 * directories, remap a track or a folder after a move, and move tracks into
 * another library. Paths are resolved before use, so a prefix cannot reach
 * outside the explorer allowlist.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @param {string} [deps.platform] defaults to process.platform
 * @param {object} [deps.fsImpl] filesystem implementation to use instead of node:fs
 * @throws {Error} when ipcMain is missing
 */
export function registerLinkIpc({
  ipcMain,
  send = () => {},
  getMainWindow = () => null,

  showOpenDialog,
  detectWindowsDrives,
  platform = process.platform,

  getTracksByPaths,
  linkAudioFile,
  addTrackToPlaylist,
  allowExplorerBase,
  runtime,
  audioExtensions,
  updateTrack,
  remapTracksByPrefix,
  moveTrackToLibrary,
  error = () => {},
  fsImpl = fs,
}) {
  if (!ipcMain) throw new Error('registerLinkIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...a) => console.error(...a) });

  register('get-computer-root', () => {
    const home = os.homedir();
    let root;
    let drives = [];

    if (platform === 'win32') {
      root = path.parse(home).root || 'C:\\';
      drives = detectWindowsDrives();
      if (!drives.includes(root)) drives.unshift(root);
    } else {
      root = '/';
    }

    return { root, home, drives };
  });

  register('get-tracks-by-paths', (_, filePaths) => getTracksByPaths(filePaths));

  register('link-audio-files', async (_, { filePaths, playlistId }) => {
    const results = [];

    for (const filePath of filePaths) {
      try {
        const result = await linkAudioFile(filePath);
        if (!result.duplicate && playlistId) {
          await addTrackToPlaylist(playlistId, result.id);
        }
        allowExplorerBase(runtime, path.dirname(filePath));
        results.push(result);
      } catch (err) {
        results.push({ id: null, duplicate: false, error: err.message, path: filePath });
      }
    }

    send('library-updated');
    if (playlistId) send('playlists-updated');
    return results;
  });

  register('link-directory', async (_, { dirPath, recursive, playlistId }) => {
    allowExplorerBase(runtime, dirPath);
    const filePaths = [];

    const collectFiles = (dir) => {
      let entries;
      try {
        entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (recursive && entry.isDirectory() && !entry.name.startsWith('.')) {
          collectFiles(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (audioExtensions.has(ext)) filePaths.push(fullPath);
        }
      }
    };
    collectFiles(dirPath);

    let linked = 0;
    const failed = [];
    for (const filePath of filePaths) {
      try {
        const result = await linkAudioFile(filePath);
        if (!result.duplicate) linked++;
        if (!result.duplicate && playlistId) await addTrackToPlaylist(playlistId, result.id);
        allowExplorerBase(runtime, path.dirname(filePath));
      } catch (err) {
        failed.push({ path: filePath, error: err.message });
      }
    }

    send('library-updated');
    if (playlistId) send('playlists-updated');
    return ok({ linked, total: filePaths.length, filePaths, failed });
  });

  register('remap-track', async (_, { trackId, newPath }) => {
    const result = await showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      defaultPath: newPath || undefined,
      filters: [
        {
          name: 'Audio Files',
          extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'aiff', 'aif', 'opus'],
        },
      ],
    });
    if (result.canceled || !result.filePaths.length) return fail('cancelled');

    const resolvedPath = result.filePaths[0];
    updateTrack(trackId, { file_path: resolvedPath });
    allowExplorerBase(runtime, path.dirname(resolvedPath));
    return ok({ newPath: resolvedPath });
  });

  register('remap-folder', async (_, { oldDir }) => {
    const result = await showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
      title: `Select new location for folder: ${path.basename(oldDir ?? '')}`,
    });
    if (result.canceled || !result.filePaths.length) return fail('cancelled');

    const newDir = result.filePaths[0];
    const oldSep = path.resolve(oldDir) + path.sep;
    const newSep = path.resolve(newDir) + path.sep;
    const count = remapTracksByPrefix(oldSep, newSep);
    allowExplorerBase(runtime, newDir);
    return ok({ count, newDir });
  });

  register('move-track-to-library', async (_, { trackId, targetLibraryId }) => {
    const result = await moveTrackToLibrary(trackId, targetLibraryId);
    send('library-updated');
    return result;
  });

  register('move-tracks-to-library', async (_, { trackIds, targetLibraryId }) => {
    const total = trackIds.length;
    const moved = [];
    const failed = [];

    for (let i = 0; i < total; i++) {
      const trackId = trackIds[i];
      try {
        const result = await moveTrackToLibrary(trackId, targetLibraryId);
        moved.push({ trackId, newPath: result.newPath ?? null });
      } catch (err) {
        error('moveTrackToLibrary failed:', trackId, err);
        failed.push(trackId);
      }
      send('move-tracks-to-library-progress', { completed: i + 1, total });
    }

    if (moved.length > 0) send('library-updated');
    send('move-tracks-to-library-progress', { completed: total, total, done: true });
    return { moved, failed };
  });
}
