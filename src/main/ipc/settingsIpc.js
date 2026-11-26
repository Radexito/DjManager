/**
 * Settings, folder-watch and dependency IPC (tor B, slice 8).
 *
 * Six channels moved out of `src/main.js`:
 *   get-setting, set-setting, scan-watch-folders, get-watch-state,
 *   retry-deps, get-media-port
 *
 * Handler bodies are unchanged. Everything the handlers touch is injected, so
 * the module never reaches back into `main.js`: the settings store, the watcher
 * controls, the dependency downloader and the media server port all arrive as
 * arguments. `watchScanRunning` is module state in `main.js`, so it comes in as
 * a getter - a plain boolean parameter would freeze at registration time.
 */

import { handle } from './response.js';
/**
 * Register the settings channels: get/set a setting, rescan the watch folders,
 * report the watcher state, retry the dependency install and expose the media
 * server port. Changing a watch setting restarts the library watcher.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(): boolean} deps.isWatchScanRunning getter, read at call time
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @throws {Error} when ipcMain is missing
 */
export function registerSettingsIpc({
  ipcMain,
  getSetting,
  setSetting,
  restartLibraryWatcher,
  restartUsbWatch = () => {},
  scanWatchFolders,
  getWatchFolders,
  watchFoldersEnabled,
  isWatchScanRunning,
  ensureDeps,
  sendDepsProgress,
  send = () => {},
  getMediaServerPort,
}) {
  if (!ipcMain) throw new Error('registerSettingsIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('get-setting', (_, key, def) => getSetting(key, def) ?? null);

  register('set-setting', (_, key, value) => {
    setSetting(key, value);
    if (key === 'watch_folders' || key === 'watch_enabled') restartLibraryWatcher();
    if (key === 'usb_watch_enabled' || key === 'usb_watch_roots') restartUsbWatch();
    send('settings-updated', { key, value });
  });

  register('scan-watch-folders', () => scanWatchFolders());

  register('get-watch-state', () => ({
    folders: getWatchFolders(),
    enabled: watchFoldersEnabled(),
    scanning: isWatchScanRunning(),
  }));

  register('retry-deps', () => {
    ensureDeps(sendDepsProgress)
      .then(() => sendDepsProgress(null))
      .catch((err) =>
        sendDepsProgress({ msg: `Error: ${err.message}`, pct: -1, error: err.message })
      );
  });

  register('get-media-port', () => getMediaServerPort());
}
