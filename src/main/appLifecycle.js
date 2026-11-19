import { MenuItem } from 'electron';
import { CLI_FLAGS, hasCliFlag } from './cliFlags.js';
import { resolveRendererSource } from './rendererSource.js';
import { ensurePhraseMask, setPhraseMask, writePhraseMask } from '../audio/phraseMask.js';
import { fetchPhraseTable } from '../audio/rekordboxInstaller.js';
import { isExternalTermination } from './graphics/crashRecorder.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Application lifecycle: window creation and startup sequence (tor B, composition root).
 *
 * Extracted from src/main.js so main.js becomes a thin entry point: register IPC
 * modules, then start the app. Everything here is injected, so the lifecycle can
 * be driven without booting Electron.
 *
 * The renderer process crash handler lives here because it is tightly coupled
 * to the window's webContents; it delegates to handleGraphicsCrash for state
 * persistence.
 */
export function createAppLifecycle({
  ipcMain,
  app,
  BrowserWindow,
  Menu,
  runtime,
  send = () => {},
  initDB,
  getSetting,
  setSetting,
  getLinkedTrackDirs,
  cleanupLegacyNormalizedFiles,
  autoGenerateMissingWaveforms,
  initLogger,
  initRendererLogger,
  logRendererMessage,
  logDiagnostics,
  startMediaServer,
  ensureDeps,
  restartLibraryWatcher,
  scanWatchFolders,
  refreshFolderPlaylists,
  startUsbCueWatch,
  allowExplorerBase,
  handleGraphicsCrash,
  mainDir = __dirname,
}) {
  if (!ipcMain) throw new Error('createAppLifecycle: ipcMain is required');
  if (!app) throw new Error('createAppLifecycle: app is required');
  if (!BrowserWindow) throw new Error('createAppLifecycle: BrowserWindow is required');
  if (!runtime) throw new Error('createAppLifecycle: runtime is required');

  let mainWindow = null;
  let _lastDepLog = '';

  /**
   * Forward dependency-download progress to the renderer. Only pct 0/100 change
   * the terminal log; the renderer gets every tick.
   */
  function sendDepsProgress(data) {
    if (data && (data.pct === 0 || data.pct === 100) && data.msg !== _lastDepLog) {
      _lastDepLog = data.msg;
      console.log('[deps]', data.msg);
    }
    send('deps-progress', data);
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      title: 'DjManager - RWTechWorks.pl',
      width: 1200,
      height: 800,
      backgroundColor: '#0f0f0f',
      icon: path.join(app.getAppPath(), 'build-resources/icon.png'),
      webPreferences: {
        preload: path.join(mainDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    runtime.mainWindow = mainWindow;

    mainWindow.on('closed', () => {
      if (runtime.mainWindow === mainWindow) runtime.mainWindow = null;
      mainWindow = null;
    });
    mainWindow.maximize();

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      if (isExternalTermination(details)) return;
      handleGraphicsCrash({
        type: 'Renderer',
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: '',
      });
    });

    mainWindow.webContents.on('context-menu', (_e, params) => {
      const menu = new Menu();
      if (params.isEditable) {
        if (params.editFlags.canUndo) menu.append(new MenuItem({ role: 'undo', label: 'Undo' }));
        if (params.editFlags.canRedo) menu.append(new MenuItem({ role: 'redo', label: 'Redo' }));
        if (params.editFlags.canUndo || params.editFlags.canRedo)
          menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ role: 'cut', label: 'Cut', enabled: params.editFlags.canCut }));
        menu.append(
          new MenuItem({ role: 'copy', label: 'Copy', enabled: params.editFlags.canCopy })
        );
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

    mainWindow.webContents.on('console-message', ({ level, message }) => {
      logRendererMessage(level, message);
      if (!app.isPackaged) console.log(`[renderer:${level}]`, message);
    });

    const requestLogSession = mainWindow.webContents.session;
    requestLogSession.webRequest.onErrorOccurred((details) => {
      if (details.error.includes('ERR_ABORTED')) return;
      logRendererMessage('error', `Failed to load resource: ${details.error} ${details.url}`);
    });
    requestLogSession.webRequest.onCompleted((details) => {
      if (details.statusCode < 400) return;
      logRendererMessage(
        'error',
        `Failed to load resource: the server responded with a status of ${details.statusCode} ${details.url}`
      );
    });

    const devUrlPath = path.join(mainDir, '../.dev-url');
    const loadBuiltRenderer = hasCliFlag(CLI_FLAGS.loadBuiltRenderer);
    const source = resolveRendererSource({
      isPackaged: app.isPackaged,
      loadBuiltRenderer,
      devUrlExists: fs.existsSync(devUrlPath),
    });

    if (source === 'dev-server') {
      mainWindow.loadURL(fs.readFileSync(devUrlPath, 'utf8').trim());
      mainWindow.webContents.openDevTools();
    } else {
      if (!app.isPackaged && !loadBuiltRenderer) {
        console.warn('[window] no .dev-url, loading the built renderer instead');
      }
      mainWindow.loadFile(path.join(mainDir, '../renderer/dist/index.html'));
      mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (
          input.key === 'F12' ||
          (input.control && input.shift && input.key.toUpperCase() === 'I')
        ) {
          event.preventDefault();
          mainWindow.webContents.toggleDevTools();
        }
      });
    }

    return mainWindow;
  }

  async function fetchPhraseInBackground() {
    const userDataPath = app.getPath('userData');
    let lastLogged = 0;
    try {
      const result = await fetchPhraseTable({
        binDir: path.join(userDataPath, 'bin'),
        log: (line) => console.log(`[phrases] ${line}`),
        onProgress: (progress) => {
          if (progress.phase !== 'download' || !progress.total) return;
          const percent = Math.floor((progress.received / progress.total) * 100);
          if (percent >= lastLogged + 10) {
            lastLogged = percent;
            console.log(`[phrases] installer download ${percent}%`);
          }
        },
      });
      setPhraseMask(result.table);
      writePhraseMask(userDataPath, result.table, result.source);
      console.log(`[phrases] phrase table ready (${result.source})`);
    } catch (error) {
      console.error(`[phrases] fetch failed: ${error.message}`);
    }
  }

  async function initApp() {
    initLogger();
    initRendererLogger();
    if (process.platform === 'win32') logDiagnostics();
    console.log('Initializing database...');
    initDB();
    const phraseMask = ensurePhraseMask({ userDataPath: app.getPath('userData') });
    console.log(
      phraseMask
        ? `[phrases] phrase table ready (${phraseMask.source})`
        : '[phrases] phrase table unavailable, masked PSSI phrases are disabled'
    );
    if (!phraseMask && hasCliFlag(CLI_FLAGS.fetchPhraseTable)) {
      void fetchPhraseInBackground();
    }
    cleanupLegacyNormalizedFiles();
    if (getSetting('normalize_target_lufs') == null) setSetting('normalize_target_lufs', '-9');
    for (const dir of getLinkedTrackDirs()) {
      allowExplorerBase(runtime, dir);
    }
    await startMediaServer();
    console.log('Creating window.');
    createWindow();

    if (hasCliFlag(CLI_FLAGS.noDepsBootstrap)) return;

    ensureDeps(sendDepsProgress)
      .then(() => {
        sendDepsProgress(null);
        autoGenerateMissingWaveforms();
        restartLibraryWatcher();
        if (getSetting('autoscan_on_startup', 'false') === 'true') {
          scanWatchFolders().catch((err) =>
            console.error('[watcher] startup scan failed:', err.message)
          );
        }
        refreshFolderPlaylists().catch((err) =>
          console.error('[folder-playlist] startup refresh failed:', err.message)
        );
        startUsbCueWatch();
      })
      .catch((err) => {
        console.error('[deps] Failed to download FFmpeg:', err.message);
        sendDepsProgress({ msg: `Error: ${err.message}`, pct: -1, error: err.message });
      });

    Menu.setApplicationMenu(null);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }

  return { createWindow, initApp, mainWindow: () => mainWindow };
}
