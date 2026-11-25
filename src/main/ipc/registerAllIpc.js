import { closeDB } from '../../db/database.js';
import { buildCrashReport, readLogTail } from '../graphics/crashReport.js';
import { readGraphicsState, writeGraphicsState } from '../graphics/graphicsConfig.js';
import { allowExplorerBase } from '../runtime.js';
import { getDbPath, setDbPath } from '../../db/dbLocation.js';
import {
  createLibrary,
  getCurrentLibraryId,
  listLibraries,
  renameLibrary,
  setCurrentLibraryId,
  setLibraryRootPath,
} from '../../db/libraryRepository.js';
import {
  addTracksToPlaylist,
  clearPlaylistFolder,
  createPlaylist,
  deletePlaylist,
  findOrCreatePlaylist,
  getPlaylist,
  getPlaylists,
  getPlaylistTracks,
  getPlaylistsForTrack,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  renamePlaylist,
  reorderPlaylistTracks,
  setPlaylistFolder,
  updatePlaylistColor,
} from '../../db/playlistRepository.js';
import { getSetting, setSetting } from '../../db/settingsRepository.js';
import {
  addTrack,
  clearTracksForLibrary,
  countTracks,
  getExistingSourceUrls,
  getLinkedTracksBasic,
  getNormalizedTrackCount,
  getPlaylistSourceUrls,
  getTrackById,
  getTrackCountByFilePath,
  getTrackIds,
  getTrackIdsNeedingNormalization,
  getTrackRank,
  getTracks,
  getTracksByPaths,
  getTrackWaveform,
  normalizeLibrary,
  normalizeTracksByIds,
  remapTracksByPrefix,
  removeTrack,
  removeTracks,
  resetNormalization,
  updateTrack,
  updateTrackWaveform,
  getAllTracks,
} from '../../db/trackRepository.js';
import {
  cancelAnalysis,
  convertStorageFormat,
  getArtworkBase,
  getLibraryBase,
  getLibraryDiskUsage,
  getLibraryFreeSpace,
  getStorageFormat,
  importAudioFile,
  isAnalysisBusy,
  linkAudioFile,
  moveTrackToLibrary,
  spawnAnalysis,
  writeBpmKeyTagsForTrack,
} from '../../audio/importManager.js';
import { writeId3Tags } from '../../audio/id3Writer.js';
import {
  addCuePoint,
  deleteAllCuePoints,
  deleteAllCuePointsLibrary,
  deleteCuePoint,
  getCuePointById,
  getCuePoints,
  renumberSequentialCuesAfter,
  updateCuePoint,
} from '../../db/cuePointRepository.js';
import { generateCuePoints } from '../../audio/cueGen.js';
import {
  backfillPdbSampleInfo,
  resolveExportSampleInfo,
  sampleInfoFromProbe,
} from '../../audio/sampleInfo.js';
import {
  searchDeezer,
  searchDiscogs,
  searchItunes,
  searchMusicBrainz,
} from '../../audio/autoTagger.js';
import {
  downloadUrl as ytDlpDownloadUrl,
  fetchPlaylistInfo as ytDlpFetchPlaylistInfo,
  searchYouTube,
} from '../../audio/ytDlpManager.js';
import {
  checkTidalSetup,
  fetchTidalCollectionTracks,
  fetchTidalCollections,
  fetchTidalInfo,
  getTidalPreviewUrl,
  searchTidal,
  splitTidalCollectionEntries,
  startLogin as tidalStartLogin,
} from '../../audio/tidalDlManager.js';
import { generateEditorWaveform, generateWaveformOverview } from '../../audio/waveformGenerator.js';
import {
  checkForUpdates,
  ensureDeps,
  ensureTidalDlNg,
  getFfmpegRuntimePath,
  getInstalledVersions,
  updateAll,
  updateAnalyzer,
  updateTidalDlNg,
  updateYtDlp,
} from '../../deps.js';
import { getLogDir, log } from '../../logger.js';
import { describeFilesystem, detectFilesystem, formatDrive } from '../../usb/generic/fs.js';
import { writeAnlz } from '../../usb/pioneer/formats/anlz.js';
import { writePdb } from '../../usb/pioneer/formats/pdb.js';
import { reuseExistingUsbTrack } from '../../usb/pioneer/formats/reuse.js';
import { writeSettingFiles } from '../../usb/pioneer/formats/settings.js';
import { detectWindowsDrives } from '../../explorer/drives.js';
import { getResetCleanupTargets, startResetCleanup } from '../../resetCleanup.js';
import { moveFileSafe } from '../../utils/fsMove.js';
import { AUDIO_EXTENSIONS } from '../audioExtensions.js';
import { registerCuePointIpc } from './cuePointIpc.js';
import { registerDiagnosticsIpc, registerRendererLogChannel } from './diagnosticsIpc.js';
import { registerExplorerIpc } from './explorerIpc.js';
import { registerFolderPlaylistIpc } from './folderPlaylistIpc.js';
import { registerGraphicsIpc } from './graphicsIpc.js';
import { registerImportIpc } from './importIpc.js';
import { registerLibraryIpc } from './libraryIpc.js';
import { registerLinkIpc } from './linkIpc.js';
import { registerMetadataIpc } from './metadataIpc.js';
import { registerNormalizeIpc } from './normalizeIpc.js';
import { registerPlaylistIpc } from './playlistIpc.js';
import { registerSettingsIpc } from './settingsIpc.js';
import { registerTidalIpc } from './tidalIpc.js';
import { registerTrackEditIpc } from './trackEditIpc.js';
import { registerTrackIpc } from './trackIpc.js';
import { registerUsbIpc } from './usbIpc.js';
import { registerSyncIpc } from './syncIpc.js';
import { candidateRoots } from '../../usb/generic/roots.js';
import { createPioneerExportRunner } from '../../usb/pioneer/exportRunner.js';
import { createSyncService, hasDjManagerData } from '../../sync/service.js';
import { createWriteActivity } from '../../sync/writeActivity.js';
import { hasPendingWork } from '../../sync/pendingWork.js';
import { recordExportState } from '../../sync/recordExportState.js';
import { revisionSummary } from '../../db/revision.js';
import {
  getLastPlan,
  getSelection as getSyncSelection,
  saveLastPlan,
  saveSelection as saveSyncSelection,
} from '../../db/selectionRepository.js';
import { getPlaylistStates, getTrackStates } from '../../db/deviceStateRepository.js';
import { createSelectiveSyncService } from '../services/selectiveSyncService.js';
import { readTrackCues } from '../../usb/pioneer/formats/cues.js';
import { readDeviceIdentity } from '../../usb/generic/identity.js';
import { registerYtdlpIpc } from './ytdlpIpc.js';
import { registerMyTagIpc } from './myTagIpc.js';
import {
  assignMyTag,
  createMyTag,
  deleteMyTag,
  getAssignmentsForTracks,
  getMyTagMasterId,
  getMyTagTree,
  getTagsForTrack,
  listMyTags,
  renameMyTag,
} from '../../db/myTagRepository.js';

/** Handler modules already own their behaviour; this file only wires them. */
export function registerAllIpc({
  ipcMain,
  app,
  dialog,
  shell,
  getMainWindow,
  send,
  runtime,
  services,
  relaunchApp,
}) {
  const { tidalCollectionUrl, runTidalDownload } = services.tidalImport;
  const {
    copyTrackToUsb,
    resolveExportTrim,
    exportDurationSec,
    runPdbExporter,
    loadManifest,
    saveManifest,
    scanUsbCues,
    applyUsbCues,
  } = services.pioneerExport;

  const writeActivity = createWriteActivity();
  const exportRunner = createPioneerExportRunner({
    getSetting,
    getPlaylist,
    getPlaylists,
    getPlaylistTracks,
    getLibraryTracks: getAllTracks,
    getCuePoints,
    loadManifest,
    saveManifest,
    reuseExistingUsbTrack,
    copyTrackToUsb,
    resolveExportTrim,
    exportDurationSec,
    resolveExportSampleInfo,
    backfillPdbSampleInfo,
    writeAnlz,
    writeSettingFiles,
    runPdbExporter,
    getFfmpegRuntimePath,
    send,
    hasPendingWork: (usbRoot) => hasPendingWork({ usbRoot, getPlaylist, getPlaylistTracks }),
    recordExportState,
    revisionSummary,
    getMyTags: listMyTags,
    getTagAssignmentsForTracks: getAssignmentsForTracks,
    getMyTagMasterId,
  });
  const syncService = createSyncService({
    send,
    findRoots: () => candidateRoots(),
    isLibraryBusy: () => writeActivity.isBusy() || isAnalysisBusy(),
    planFor: (usbRoot) => (hasDjManagerData(usbRoot) ? exportRunner.planFor(usbRoot) : null),
    logger: console,
  });
  const selectiveSync = createSelectiveSyncService({
    readIdentity: readDeviceIdentity,
    getSelection: getSyncSelection,
    saveSelection: saveSyncSelection,
    saveLastPlan,
    getLastPlan,
    getTrackStates,
    getPlaylistStates,
    loadManifest,
    getPlaylist,
    getPlaylistTracks,
    getCuePoints,
    readTrackCues,
    exportRunner,
    syncService,
    recordExportState,
    getRetentionMs: () =>
      Math.max(0, Number(getSetting('sync_trash_retention_days', '7')) || 0) * 86_400_000,
    log: (...args) => console.log(...args),
  });
  services.syncService = syncService;
  services.selectiveSync = selectiveSync;
  services.writeActivity = writeActivity;

  registerLibraryIpc({
    ipcMain,
    send,
    userDataDir: app.getPath('userData'),
    runtime,
    allowExplorerBase,
    getLibraryBase,
    getArtworkBase,
    getTracks,
    updateTrack,
    setLibraryRootPath,
    listLibraries,
    getLibraryDiskUsage,
    getLibraryFreeSpace,
    getCurrentLibraryId,
    setCurrentLibraryId,
    createLibrary,
    renameLibrary,
    getStorageFormat,
    convertStorageFormat,
    getDbPath,
    closeDB,
    setDbPath,
    relaunchApp,
    moveFileSafe,
  });

  registerPlaylistIpc({
    ipcMain,
    send,
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
  });

  registerMyTagIpc({
    ipcMain,
    send,
    listMyTags,
    getMyTagTree,
    createMyTag,
    renameMyTag,
    deleteMyTag,
    assignMyTag,
    getTagsForTrack,
  });

  registerCuePointIpc({
    ipcMain,
    send,
    getCuePoints,
    addCuePoint,
    getCuePointById,
    updateCuePoint,
    deleteCuePoint,
    deleteAllCuePoints,
    deleteAllCuePointsLibrary,
    generateCuePoints,
    renumberSequentialCuesAfter,
    getTrackById,
    getTracks,
    generateWaveformOverview,
    updateTrackWaveform,
    getFfmpegRuntimePath,
    warn: (...args) => console.warn(...args),
  });

  registerTrackIpc({
    ipcMain,
    getTracks,
    countTracks,
    getTrackRank,
    getTrackIds,
    getTrackById,
    getLinkedTracksBasic,
    getTrackWaveform,
    writeBpmKeyTagsForTrack,
  });

  registerTrackEditIpc({
    ipcMain,
    send,
    getTrackById,
    updateTrack,
    removeTrack,
    removeTracks,
    getTrackCountByFilePath,
    spawnAnalysis,
    cancelAnalysis,
    writeId3Tags,
    generateEditorWaveform,
    regenerateHiresWaveform: (trackId, filePath) =>
      services.waveformService.regenerateHires(trackId, filePath),
    getFfmpegRuntimePath,
    error: (...args) => console.error(...args),
  });

  registerImportIpc({
    ipcMain,
    send,
    showOpenDialog: (opts) => dialog.showOpenDialog(opts),
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
    addTrack,
    importAudioFile: async (...args) => {
      const release = writeActivity.begin('import');
      try {
        return await importAudioFile(...args);
      } finally {
        release();
      }
    },
    addTracksToPlaylist,
    getCurrentLibraryId,
    getLibraryBase,
    clearTracksForLibrary,
    getResetPaths: () => ({
      userDataPath: app.getPath('userData'),
      cachePath: app.getPath('cache'),
      logsPath: app.getPath('logs'),
    }),
    getResetCleanupTargets,
    closeDB,
    startResetCleanup,
    quitApp: () => app.quit(),
    parentPid: process.pid,
  });

  registerFolderPlaylistIpc({
    ipcMain,
    send,
    getPlaylist,
    createPlaylist,
    setPlaylistFolder,
    clearPlaylistFolder,
    removeTrackFromPlaylist,
    syncFolderPlaylist: (id) => services.watcherService.syncFolderPlaylist(id),
    refreshFolderPlaylists: () => services.watcherService.refreshFolderPlaylists(),
    restartLibraryWatcher: () => services.watcherService.restart(),
  });

  registerNormalizeIpc({
    ipcMain,
    send,
    getSetting,
    getTrackById,
    getTrackIdsNeedingNormalization,
    getNormalizedTrackCount,
    normalizeLibrary,
    normalizeTracksByIds,
    resetNormalization,
  });

  registerLinkIpc({
    ipcMain,
    send,
    getMainWindow,
    showOpenDialog: (win, opts) => dialog.showOpenDialog(win, opts),
    detectWindowsDrives,
    getTracksByPaths,
    linkAudioFile,
    addTrackToPlaylist,
    allowExplorerBase,
    runtime,
    audioExtensions: AUDIO_EXTENSIONS,
    updateTrack,
    remapTracksByPrefix,
    moveTrackToLibrary,
    error: (...args) => console.error(...args),
  });

  registerMetadataIpc({
    ipcMain,
    searchMusicBrainz,
    searchDiscogs,
    searchItunes,
    searchDeezer,
    getTrackById,
    getCurrentLibraryId,
    getArtworkBase,
    updateTrack,
    getExistingSourceUrls,
    openExternal: (url) => shell.openExternal(url),
  });

  registerRendererLogChannel(ipcMain);

  registerGraphicsIpc({
    ipcMain,
    graphicsUserDataDir: () => app.getPath('userData'),
    readGraphicsState,
    writeGraphicsState,
    buildCrashReport,
    readLogTail,
    getLogDir,
    getVersion: () => app.getVersion(),
    relaunchApp,
  });

  registerDiagnosticsIpc({
    ipcMain,
    getLogDir,
    openPath: (target) => shell.openPath(target),
    openDevTools: () => {
      if (app.isPackaged) {
        return { ok: false, error: 'DevTools are disabled in packaged builds' };
      }
      getMainWindow()?.webContents.openDevTools();
      return { ok: true };
    },
    getInstalledVersions,
    checkForUpdates,
    updateAnalyzer,
    updateYtDlp,
    updateAll,
    updateTidalDlNg,
    sendProgress: send,
  });

  registerYtdlpIpc({
    ipcMain,
    getSetting,
    ytDlpFetchPlaylistInfo,
    ytDlpDownloadUrl,
    findOrCreatePlaylist,
    addTrackToPlaylist,
    importAudioFile,
    send,
  });

  registerTidalIpc({
    ipcMain,
    runtime,
    send,
    getSetting,
    checkTidalSetup,
    ensureTidalDlNg,
    fetchTidalInfo,
    searchYouTube,
    searchTidal,
    getTidalPreviewUrl,
    registerYtPreviewStream: (url, cookiesBrowser) =>
      services.ytPreview.register(url, cookiesBrowser),
    tidalStartLogin,
    runTidalDownload,
    fetchTidalCollections,
    fetchTidalCollectionTracks,
    splitTidalCollectionEntries,
    tidalCollectionUrl,
    getTempDir: () => app.getPath('temp'),
  });

  registerSettingsIpc({
    ipcMain,
    getSetting,
    setSetting,
    restartLibraryWatcher: () => services.watcherService.restart(),
    scanWatchFolders: () => services.watcherService.scan(),
    getWatchFolders: () => services.watcherService.getWatchFolders(),
    watchFoldersEnabled: () => services.watcherService.isEnabled(),
    isWatchScanRunning: () => services.watcherService.isScanRunning(),
    ensureDeps,
    sendDepsProgress: (data) => services.depsProgressService.forward(data),
    send,
    getMediaServerPort: () => runtime.mediaServerPort,
  });

  registerExplorerIpc({
    ipcMain,
    runtime,
    send,
    showOpenDialog: (parent, options) => dialog.showOpenDialog(parent, options),
    getMainWindow,
    runFfprobe: async (filePath) => {
      const { ffprobe } = await import('../../audio/ffmpeg.js');
      return ffprobe(filePath);
    },
  });

  registerUsbIpc({
    ipcMain,
    send,
    logAudit: (message) => log('audit', message),
    getTrackById,
    getLinkedTracksBasic,
    detectFilesystem,
    describeFilesystem,
    formatDrive,
    writeAnlz,
    writeSettingFiles,
    writePdb,
    sampleInfoFromProbe,
    scanUsbCues,
    applyUsbCues,
    getFfmpegRuntimePath,
    exportRunner,
    syncService,
    getTempDir: () => app.getPath('temp'),
  });

  registerSyncIpc({
    ipcMain,
    syncService,
    selectiveSync,
    log: (...args) => console.error(...args),
  });
}
