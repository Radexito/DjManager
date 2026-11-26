import path from 'path';

import {
  addTracksToPlaylist,
  addTrackToPlaylist,
  getFolderPlaylists,
  getPlaylist,
  getPlaylistTracks,
  markPlaylistFolderSynced,
} from '../../db/playlistRepository.js';
import {
  clearLegacyNormalizedPaths,
  getLegacyNormalizedTracks,
  getTracks,
  getTracksByPaths,
  updateTrackDetailHires,
  updateTrackWaveform,
} from '../../db/trackRepository.js';
import { getSetting } from '../../db/settingsRepository.js';
import {
  getArtworkBase,
  getLibraryBase,
  importAudioFile,
  linkAudioFile,
  scanFoldersForNewTracks,
  spawnAnalysis,
} from '../../audio/importManager.js';
import { createLibraryWatcher, listAudioFiles } from '../../library/libraryWatcher.js';
import { createLibraryWatcherService } from '../libraryWatcherService.js';
import { createUsbWatchService } from '../usbWatchService.js';
import { isInsideFolder, planFolderSync } from '../../library/folderPlaylistSync.js';
import { getDefaultLibraryId, listLibraries } from '../../db/libraryRepository.js';
import { generateEditorWaveform, generateWaveformOverview } from '../../audio/waveformGenerator.js';
import { getFfmpegRuntimePath } from '../../deps.js';
import { createPreviewAudioStream } from '../../audio/ytDlpManager.js';
import { startMediaServer } from '../../audio/mediaServer.js';
import { allowExplorerBase } from '../runtime.js';
import { shouldAllowAutomaticFallback } from '../graphics/launchProfile.js';
import {
  graphicsReportPath,
  readGraphicsState,
  writeGraphicsState,
} from '../graphics/graphicsConfig.js';
import { markFallback, recordCrash } from '../graphics/crashRecorder.js';
import { buildCrashReport, readLogTail, writeCrashReport } from '../graphics/crashReport.js';
import { getLogDir } from '../../logger.js';
import { createPioneerExportService } from './pioneerExportService.js';
import { createMediaServerService } from './mediaServerService.js';
import { createGraphicsCrashService } from './graphicsCrashService.js';
import { createWaveformService } from './waveformService.js';
import { createDepsProgressService } from './depsProgressService.js';
import { createLegacyCleanupService } from './legacyCleanupService.js';
import { createTidalImportService } from './tidalImportService.js';
import { createYtPreviewRegistry } from '../ytPreview.js';

/**
 * Build every long-lived service the main process owns.
 *
 * This is the composition root for services: it is the one module allowed to
 * know which concrete repository and audio module each service needs. The
 * services themselves stay dependency-injected, so their own tests keep passing
 * whatever they are wired to here.
 * @param {object} deps
 * @param {object} deps.app the Electron app, for paths and version
 * @param {object} deps.runtime the shared runtime object (window, ports, allowlist)
 * @param {Function} deps.send pushes an event to the renderer, a no-op without a window
 * @param {Function} deps.relaunchApp restarts the app after a crash fallback
 * @returns {object} the services, each with a single owner
 */
export function createAppServices({ app, runtime, send, relaunchApp }) {
  const pioneerExport = createPioneerExportService({ app, send });

  const watcherService = createLibraryWatcherService({
    getSetting,
    getFolderPlaylists,
    getPlaylist,
    getPlaylistTracks,
    getTracksByPaths,
    listAudioFiles,
    linkAudioFile,
    importAudioFile,
    spawnAnalysis,
    addTrackToPlaylist,
    addTracksToPlaylist,
    markPlaylistFolderSynced,
    planFolderSync,
    isInsideFolder,
    scanFoldersForNewTracks,
    createLibraryWatcher,
    send: (channel, data) => send(channel, data),
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  });

  // Notices a medium being mounted or removed, so the sidebar can follow it.
  const usbWatchService = createUsbWatchService({
    getSetting,
    send: (channel, data) => send(channel, data),
  });

  const ytPreview = createYtPreviewRegistry({
    createStream: createPreviewAudioStream,
    previewDir: path.join(app.getPath('temp'), 'djman-preview'),
    getMediaServerPort: () => runtime.mediaServerPort,
  });

  const mediaServerService = createMediaServerService({
    runtime,
    ytPreview,
    listLibraries,
    getDefaultLibraryId,
    getLibraryBase,
    getArtworkBase,
    allowExplorerBase,
    startServer: startMediaServer,
  });

  const graphicsCrashService = createGraphicsCrashService({
    app,
    readGraphicsState,
    writeGraphicsState,
    graphicsReportPath,
    buildCrashReport,
    writeCrashReport,
    readLogTail,
    getLogDir,
    recordCrash,
    markFallback,
    shouldAllowAutomaticFallback,
    relaunchApp,
  });

  const waveformService = createWaveformService({
    getTracks,
    updateTrackWaveform,
    updateTrackDetailHires,
    generateWaveformOverview,
    generateEditorWaveform,
    getFfmpegRuntimePath,
    send,
  });

  const depsProgressService = createDepsProgressService({ send });

  const legacyCleanupService = createLegacyCleanupService({
    getLegacyNormalizedTracks,
    clearLegacyNormalizedPaths,
  });

  const tidalImport = createTidalImportService({
    send,
    getTempDir: () => app.getPath('userData'),
  });

  return {
    pioneerExport,
    watcherService,
    usbWatchService,
    ytPreview,
    mediaServerService,
    graphicsCrashService,
    waveformService,
    depsProgressService,
    legacyCleanupService,
    tidalImport,
  };
}
