/**
 * Folder-backed playlists (tor B, slice 15).
 *
 * Seven channels moved out of `src/main.js`. A folder playlist mirrors the
 * contents of a directory: `syncFolderPlaylist` reconciles the playlist with
 * what is on disk, and the library watcher calls the same function when files
 * appear or vanish.
 *
 * Every mutation restarts the watcher, because its watched set is derived from
 * which folders are currently tracked. A stale watched set is why a folder
 * playlist silently stops picking up new files.
 *
 * First domain on the response contract (faza 5, point 5): failures carry a
 * machine `code` next to the human `message`, and every channel is registered
 * through `handle()`, so a throw answers with a failure body instead of
 * rejecting the renderer's `invoke()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail, handle, ok } from './response.js';

/**
 * Register the folder-playlist channels: create, sync against the directory,
 * clear the folder, add and drop tracks. Every mutation restarts the library
 * watcher because its watched set comes from the tracked folders.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @param {object} [deps.fsImpl] filesystem implementation to use instead of node:fs
 * @throws {Error} when ipcMain is missing
 */
export function registerFolderPlaylistIpc({
  ipcMain,
  send = () => {},

  getPlaylist,
  createPlaylist,
  setPlaylistFolder,
  clearPlaylistFolder,
  removeTrackFromPlaylist,
  syncFolderPlaylist,
  refreshFolderPlaylists,
  restartLibraryWatcher,

  fsImpl = fs,
  log = (...args) => console.error(...args),
}) {
  if (!ipcMain) throw new Error('registerFolderPlaylistIpc: ipcMain is required');

  const register = (channel, fn) => handle(ipcMain, channel, fn, { log });

  register('create-folder-playlist', async (_, { folderPath, name, recursive = false } = {}) => {
    if (!folderPath || !fsImpl.existsSync(folderPath)) {
      return fail('folder-missing', `Folder not found: ${folderPath ?? '(none)'}`, {
        folder: folderPath ?? null,
      });
    }
    const playlistName = (name || '').trim() || path.basename(folderPath) || 'Watched folder';

    let id;
    try {
      id = createPlaylist(playlistName, null, null);
    } catch (err) {
      return fail(
        err.code === 'DUPLICATE_PLAYLIST_NAME' ? 'duplicate-name' : 'failed',
        err.message
      );
    }

    setPlaylistFolder(id, folderPath, recursive);
    send('playlists-updated');
    restartLibraryWatcher();
    const sync = await syncFolderPlaylist(id);
    return ok({ playlistId: id, name: playlistName, recursive, ...sync });
  });

  register('refresh-folder-playlist', (_, playlistId) => syncFolderPlaylist(playlistId));
  register('refresh-folder-playlists', () => refreshFolderPlaylists());

  register('remove-folder-playlist-tracks', (_, { playlistId, trackIds = [] } = {}) => {
    for (const trackId of trackIds) removeTrackFromPlaylist(playlistId, trackId);
    if (trackIds.length > 0) {
      send('library-updated');
      send('playlists-updated');
    }
    return ok({ playlistId, removed: trackIds.length });
  });

  register('stop-folder-playlist', (_, playlistId) => {
    clearPlaylistFolder(playlistId);
    restartLibraryWatcher();
    send('playlists-updated');
    return ok({ playlistId });
  });

  register('set-playlist-folder', async (_, { playlistId, folderPath, recursive } = {}) => {
    const playlist = getPlaylist(playlistId);
    if (!playlist) return fail('unknown-playlist', `No playlist with id ${playlistId}`);
    if (!folderPath) return fail('no-folder', 'No folder given');
    if (!fsImpl.existsSync(folderPath)) {
      return fail('missing-folder', `Folder not found: ${folderPath}`, { folder: folderPath });
    }
    const useRecursive = recursive ?? playlist.folder_recursive === 1;
    setPlaylistFolder(playlistId, folderPath, useRecursive);
    restartLibraryWatcher();
    send('playlists-updated');
    return syncFolderPlaylist(playlistId);
  });

  register('set-folder-playlist-recursive', async (_, { playlistId, recursive = false } = {}) => {
    const playlist = getPlaylist(playlistId);
    if (!playlist?.folder_path) {
      return fail('not-a-folder-playlist', `Playlist ${playlistId} is not folder-backed`, {
        playlistId,
      });
    }
    setPlaylistFolder(playlistId, playlist.folder_path, recursive);
    restartLibraryWatcher();
    return syncFolderPlaylist(playlistId);
  });
}
