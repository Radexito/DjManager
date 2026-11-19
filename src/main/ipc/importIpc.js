/**
 * Import, file pickers and the two destructive clears (tor B, slice 14).
 *
 * Six channels moved out of `src/main.js`: add-track, the two dialogs, the
 * import loop, clear-library and clear-user-data.
 *
 * The dialogs belong here rather than with the explorer because they exist to
 * feed the import loop, and the loop's contract is what matters: one bad file
 * must not abort the rest, and progress is reported for every file whether it
 * imported or not.
 */
import fs from 'node:fs';
import { handle } from './response.js';

/**
 * Register the import channels: the file dialogs, the import loop, add-track,
 * clear-library and clear-user-data. A file that fails to import is reported
 * and skipped, never aborting the batch.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @param {object} [deps.fsImpl] filesystem implementation to use instead of node:fs
 * @throws {Error} when ipcMain is missing
 */
export function registerImportIpc({
  ipcMain,
  send = () => {},
  showOpenDialog,
  log = () => {},
  error = () => {},

  addTrack,
  importAudioFile,
  addTracksToPlaylist,

  getCurrentLibraryId,
  getLibraryBase,
  clearTracksForLibrary,

  getResetPaths,
  getResetCleanupTargets,
  closeDB,
  startResetCleanup,
  quitApp,
  parentPid,

  fsImpl = fs,
}) {
  if (!ipcMain) throw new Error('registerImportIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('add-track', (_, track) => addTrack(track));

  register('select-audio-files', async () => {
    log('Selecting audio files');
    const result = await showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'm4a'] }],
    });
    return result.canceled ? [] : result.filePaths;
  });

  register('open-dir-dialog', async () => {
    const result = await showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  register('import-audio-files', async (_, filePaths, playlistId, libraryId) => {
    const trackIds = [];
    const total = filePaths.length;

    for (let i = 0; i < total; i++) {
      try {
        const trackId = await importAudioFile(filePaths[i], {}, libraryId);
        trackIds.push(trackId);
      } catch (err) {
        error('Import failed:', filePaths[i], err);
      }
      send('import-progress', { completed: i + 1, total });
    }

    if (trackIds.length > 0) {
      if (playlistId) {
        addTracksToPlaylist(playlistId, trackIds);
        send('playlists-updated');
      }
      send('library-updated');
    }

    return trackIds;
  });

  register('clear-library', async (_, libraryId) => {
    const id = libraryId ?? getCurrentLibraryId();
    const audioBase = getLibraryBase(id);
    clearTracksForLibrary(id);
    if (fsImpl.existsSync(audioBase)) fsImpl.rmSync(audioBase, { recursive: true, force: true });
    send('library-updated');
    send('playlists-updated');
  });

  register('clear-user-data', async () => {
    const toDelete = getResetCleanupTargets(getResetPaths());
    closeDB();
    startResetCleanup({ parentPid, targets: toDelete });
    quitApp();
  });
}
