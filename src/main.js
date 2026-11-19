import path from 'path';
import { fileURLToPath } from 'url';
import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import {
  readGraphicsConfig,
  readGraphicsState,
  writeGraphicsState,
} from './main/graphics/graphicsConfig.js';
import { isRelevantCrash, recordCrash } from './main/graphics/crashRecorder.js';
import { buildCrashReport, readLogTail } from './main/graphics/crashReport.js';
import { createAppLifecycle } from './main/appLifecycle.js';
import { allowExplorerBase, createRuntime } from './main/runtime.js';
import { createAppServices } from './main/services/createAppServices.js';
import { registerAllIpc } from './main/ipc/registerAllIpc.js';
import { registerAppEvents } from './main/lifecycle/registerAppEvents.js';
import { logStartupDiagnostics } from './main/startupDiagnostics.js';
import { bindRuntime, sendToRenderer } from './main/rendererBridge.js';
import { resolveLaunchProfile } from './main/graphics/launchProfile.js';
import { applyLaunchProfile } from './main/graphics/applyLaunchProfile.js';
import { getLogDir, initLogger, initRendererLogger, logRendererMessage } from './logger.js';
import { ensureDeps, getFfmpegRuntimePath } from './deps.js';
import { initDB } from './db/migrations.js';
import { getSetting, setSetting } from './db/settingsRepository.js';
import {
  clearLegacyNormalizedPaths,
  getLegacyNormalizedTracks,
  getLinkedTrackDirs,
  getTrackById,
  getTracks,
  updateTrackWaveform,
} from './db/trackRepository.js';
import { generateWaveformOverview } from './audio/waveformGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.name = 'Dj Manager';

/** The one place that restarts the app (D7): crash fallback, database move, settings. */
function relaunchApp() {
  app.relaunch();
  app.exit(0);
}

/** Send one event to the renderer window, if there is one. */
function send(channel, data) {
  sendToRenderer(channel, data);
}

/**
 * Launch profile, resolved at module load because Chromium reads both the
 * acceleration flag and the switches before `ready`; anything later is ignored.
 * `app.name` above must stay first: the userData path is derived from it.
 */
const graphicsConfig = readGraphicsConfig(app.getPath('userData'));
const launchProfile = resolveLaunchProfile({
  platform: process.platform,
  env: process.env,
  config: graphicsConfig,
  cliArgs: process.argv.slice(1),
});

if (process.platform === 'linux') {
  app.setDesktopName('dj_manager.desktop');
}

applyLaunchProfile(app, launchProfile);

const runtime = createRuntime();
bindRuntime(runtime);

const services = createAppServices({ app, runtime, send, relaunchApp });

const lifecycle = createAppLifecycle({
  ipcMain,
  app,
  BrowserWindow,
  Menu,
  shell,
  runtime,
  send,
  showOpenDialog: (parent, options) => dialog.showOpenDialog(parent, options),
  runFfprobe: async (filePath) => {
    const { ffprobe } = await import('./audio/ffmpeg.js');
    return ffprobe(filePath);
  },
  readGraphicsState,
  writeGraphicsState,
  buildCrashReport,
  readLogTail,
  getLogDir,
  getVersion: () => app.getVersion(),
  relaunchApp,
  isRelevantCrash,
  recordCrash,
  gpuSnapshot: () => services.graphicsCrashService.snapshot(),
  initDB,
  getSetting,
  setSetting,
  getLinkedTrackDirs,
  getTracks,
  getTrackById,
  updateTrackWaveform,
  getLegacyNormalizedTracks,
  clearLegacyNormalizedPaths,
  cleanupLegacyNormalizedFiles: () => services.legacyCleanupService.cleanupNormalizedFiles(),
  autoGenerateMissingWaveforms: () => services.waveformService.generateMissingOverviews(),
  initLogger,
  initRendererLogger,
  logRendererMessage,
  logDiagnostics: () =>
    logStartupDiagnostics({ userDataPath: app.getPath('userData'), appVersion: app.getVersion() }),
  startMediaServer: () => services.mediaServerService.start(),
  applyLaunchProfile,
  ensureDeps,
  getFfmpegRuntimePath,
  generateWaveformOverview,
  restartLibraryWatcher: () => services.watcherService.restart(),
  scanWatchFolders: () => services.watcherService.scan(),
  refreshFolderPlaylists: () => services.watcherService.refreshFolderPlaylists(),
  startUsbCueWatch: services.pioneerExport.startUsbCueWatch,
  allowExplorerBase,
  handleGraphicsCrash: (details) => services.graphicsCrashService.handle(details),
  mainDir: __dirname,
});

app.on('ready', lifecycle.initApp);

registerAllIpc({
  ipcMain,
  app,
  dialog,
  shell,
  getMainWindow: () => runtime.mainWindow,
  send,
  runtime,
  services,
  relaunchApp,
});

registerAppEvents({
  app,
  watcherService: services.watcherService,
  graphicsCrashService: services.graphicsCrashService,
  isRelevantCrash,
});
