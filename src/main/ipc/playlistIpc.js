/**
 * Playlist IPC (tor B, slice 10).
 *
 * Eleven channels moved out of `src/main.js`: the curated playlists the user
 * builds by hand. Folder-backed playlists are a different feature with their
 * own watcher and stay in their own module.
 *
 * Every mutation broadcasts `playlists-updated` through the injected `send`
 * instead of reaching for `global.mainWindow`. That broadcast is the only way
 * the renderer learns a playlist changed, so a mutation that forgets it leaves
 * a stale sidebar behind.
 */

import { handle } from './response.js';
/**
 * Register the curated-playlist channels: list, create, rename, recolour,
 * delete, add and remove tracks, reorder. Every mutation broadcasts
 * `playlists-updated` through `send`, which is how the sidebar stays current.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @throws {Error} when ipcMain is missing
 */
export function registerPlaylistIpc({
  ipcMain,
  send = () => {},

  getPlaylists,
  createPlaylist,
  renamePlaylist,
  updatePlaylistColor,
  deletePlaylist,
  addTracksToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  getPlaylistsForTrack,
  getPlaylist,
  getPlaylistSourceUrls,
}) {
  if (!ipcMain) throw new Error('registerPlaylistIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  const changed = () => send('playlists-updated');

  register('get-playlists', () => getPlaylists());

  register('create-playlist', (_, { name, color }) => {
    try {
      const id = createPlaylist(name, color ?? null);
      changed();
      return { id };
    } catch (err) {
      if (err.code === 'DUPLICATE_PLAYLIST_NAME')
        return { error: 'duplicate', message: err.message };
      throw err;
    }
  });

  register('rename-playlist', (_, { id, name }) => {
    try {
      renamePlaylist(id, name);
      changed();
      return {};
    } catch (err) {
      if (err.code === 'DUPLICATE_PLAYLIST_NAME')
        return { error: 'duplicate', message: err.message };
      throw err;
    }
  });

  register('update-playlist-color', (_, { id, color }) => {
    updatePlaylistColor(id, color);
    changed();
  });

  register('delete-playlist', (_, id) => {
    deletePlaylist(id);
    changed();
  });

  register('add-tracks-to-playlist', (_, { playlistId, trackIds }) => {
    if (!Array.isArray(trackIds) || !trackIds.length) return;
    addTracksToPlaylist(playlistId, trackIds);
    changed();
  });

  register('remove-track-from-playlist', (_, { playlistId, trackId }) => {
    removeTrackFromPlaylist(playlistId, trackId);
    changed();
  });

  register('reorder-playlist', (_, { playlistId, orderedTrackIds }) => {
    reorderPlaylistTracks(playlistId, orderedTrackIds);
  });

  register('get-playlists-for-track', (_, trackId) => getPlaylistsForTrack(trackId));
  register('get-playlist', (_, id) => getPlaylist(id) ?? null);

  register('get-playlist-source-urls', (_, playlistId) => getPlaylistSourceUrls(playlistId));
}
