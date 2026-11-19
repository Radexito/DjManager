/**
 * Diagnostics and dependency-update IPC, the second domain lifted out of
 * `src/main.js` (tor B, slice 2).
 *
 * Same shape as the graphics module: channel names, payloads and return shapes
 * are unchanged, and every side effect arrives as an argument. The progress
 * notifications go through `sendProgress`, so this module never touches
 * `global.mainWindow`, so a caller can observe exactly what the UI would see.
 */
import { failFromError, handle, ok } from './response.js';

/**
 * Register the diagnostics channels: log directory, DevTools, installed
 * dependency versions and the dependency update triggers. Progress is sent as
 * `deps-progress` payloads through `sendProgress`.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, object|null): void} [deps.sendProgress]
 * @throws {Error} when ipcMain is missing
 */
export function registerDiagnosticsIpc({
  ipcMain,
  getLogDir,
  openPath,
  openDevTools,
  getInstalledVersions,
  checkForUpdates,
  updateAnalyzer,
  updateYtDlp,
  updateAll,
  updateTidalDlNg,
  sendProgress = () => {},
}) {
  if (!ipcMain) throw new Error('registerDiagnosticsIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...a) => console.error(...a) });

  const report = (msg, pct) => sendProgress('deps-progress', { msg, pct });
  const clear = () => sendProgress('deps-progress', null);

  register('get-log-dir', () => getLogDir());
  register('open-log-dir', () => openPath(getLogDir()));
  register('open-devtools', () => openDevTools());
  register('get-dep-versions', () => getInstalledVersions());
  register('check-dep-updates', () => checkForUpdates());

  register('update-analyzer', async () => {
    await updateAnalyzer(report);
    clear();
  });

  register('update-yt-dlp', async (_event, tag = null) => {
    await updateYtDlp(report, tag);
    clear();
  });

  register('update-all-deps', async () => {
    await updateAll(report);
    clear();
  });

  register('update-tidal-dl-ng', async () => {
    try {
      await updateTidalDlNg(report);
      clear();
      return ok();
    } catch (err) {
      clear();
      return failFromError(err);
    }
  });
}

/**
 * Renderer -> log file. This is the one channel that is fire-and-forget
 * (`ipcMain.on`, not `ipcMain.handle`), so it is registered separately instead
 * of through `handle()`: there is nothing to answer.
 *
 * It lived in `src/main.js` until the cleanup step; the level mapping is the same
 * one the renderer logger used there.
 */
export function registerRendererLogChannel(ipcMain) {
  if (!ipcMain) throw new Error('registerRendererLogChannel: ipcMain is required');

  ipcMain.on('renderer-log', (_event, { level, msg } = {}) => {
    const line = `[renderer] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  });
}
