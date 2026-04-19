const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Track library
  getTracks: (params) => ipcRenderer.invoke('get-tracks', params),
  getTrackIds: (params) => ipcRenderer.invoke('get-track-ids', params),
  getTrackWaveform: (trackId) => ipcRenderer.invoke('get-track-waveform', trackId),
  onWaveformReady: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('waveform-ready', handler);
    return () => ipcRenderer.removeListener('waveform-ready', handler);
  },
  generateWaveformsLibrary: (opts) => ipcRenderer.invoke('generate-waveforms-library', opts),
  onWaveformGenProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('waveform-gen-progress', handler);
    return () => ipcRenderer.removeListener('waveform-gen-progress', handler);
  },
  reanalyzeTrack: (trackId) => ipcRenderer.invoke('reanalyze-track', trackId),
  cancelAnalysis: (trackId) => ipcRenderer.invoke('cancel-analysis', trackId),
  removeTrack: (trackId) => ipcRenderer.invoke('remove-track', trackId),
  removeLinkedFile: (trackId) => ipcRenderer.invoke('remove-linked-file', trackId),
  updateTrack: (id, data) => ipcRenderer.invoke('update-track', { id, data }),
  getEditorWaveform: (trackId) => ipcRenderer.invoke('get-editor-waveform', trackId),
  adjustBpm: (payload) => ipcRenderer.invoke('adjust-bpm', payload),

  // Cue points
  getCuePoints: (trackId) => ipcRenderer.invoke('get-cue-points', trackId),
  addCuePoint: (payload) => ipcRenderer.invoke('add-cue-point', payload),
  updateCuePoint: (id, update) => ipcRenderer.invoke('update-cue-point', { id, ...update }),
  deleteCuePoint: (id) => ipcRenderer.invoke('delete-cue-point', id),
  generateCuePoints: (trackId) => ipcRenderer.invoke('generate-cue-points', trackId),
  generateCuePointsLibrary: (opts) => ipcRenderer.invoke('generate-cue-points-library', opts),
  deleteAllCuePointsLibrary: () => ipcRenderer.invoke('delete-all-cue-points-library'),

  // Import
  selectAudioFiles: () => ipcRenderer.invoke('select-audio-files'),
  importAudioFiles: (files, playlistId) =>
    ipcRenderer.invoke('import-audio-files', files, playlistId),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  getPlaylist: (id) => ipcRenderer.invoke('get-playlist', id),
  createPlaylist: (name, color) => ipcRenderer.invoke('create-playlist', { name, color }),
  renamePlaylist: (id, name) => ipcRenderer.invoke('rename-playlist', { id, name }),
  updatePlaylistColor: (id, color) => ipcRenderer.invoke('update-playlist-color', { id, color }),
  deletePlaylist: (id) => ipcRenderer.invoke('delete-playlist', id),
  addTracksToPlaylist: (playlistId, trackIds) =>
    ipcRenderer.invoke('add-tracks-to-playlist', { playlistId, trackIds }),
  removeTrackFromPlaylist: (playlistId, trackId) =>
    ipcRenderer.invoke('remove-track-from-playlist', { playlistId, trackId }),
  reorderPlaylist: (playlistId, orderedTrackIds) =>
    ipcRenderer.invoke('reorder-playlist', { playlistId, orderedTrackIds }),
  getPlaylistsForTrack: (trackId) => ipcRenderer.invoke('get-playlists-for-track', trackId),
  exportPlaylistAsM3U: (playlistId) => ipcRenderer.invoke('export-playlist-m3u', playlistId),
  onExportM3UProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('export-m3u-progress', handler);
    return () => ipcRenderer.removeListener('export-m3u-progress', handler);
  },

  // USB / Rekordbox export
  checkUsbFormat: (mountPath) => ipcRenderer.invoke('check-usb-format', mountPath),
  formatUsb: (opts) => ipcRenderer.invoke('format-usb', opts),
  exportRekordbox: (opts) => ipcRenderer.invoke('export-rekordbox', opts),
  exportAll: (opts) => ipcRenderer.invoke('export-all', opts),
  onFormatUsbProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('format-usb-progress', handler);
    return () => ipcRenderer.removeListener('format-usb-progress', handler);
  },
  onExportRekordboxProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('export-rekordbox-progress', handler);
    return () => ipcRenderer.removeListener('export-rekordbox-progress', handler);
  },
  onExportAllProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('export-all-progress', handler);
    return () => ipcRenderer.removeListener('export-all-progress', handler);
  },

  // Settings
  getSetting: (key, def) => ipcRenderer.invoke('get-setting', key, def),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getLibraryPath: () => ipcRenderer.invoke('get-library-path'),
  moveLibrary: (newDir) => ipcRenderer.invoke('move-library', newDir),
  openDirDialog: () => ipcRenderer.invoke('open-dir-dialog'),
  onMoveLibraryProgress: (cb) => {
    ipcRenderer.on('move-library-progress', (_, data) => cb(data));
    return () => ipcRenderer.removeAllListeners('move-library-progress');
  },
  normalizeLibrary: () => ipcRenderer.invoke('normalize-library'),
  getNormalizedCount: () => ipcRenderer.invoke('get-normalized-count'),
  normalizeTracksAudio: (payload) => ipcRenderer.invoke('normalize-tracks-audio', payload),
  resetNormalization: (payload) => ipcRenderer.invoke('reset-normalization', payload),

  // Events
  onTrackUpdated: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('track-updated', handler);
    return () => ipcRenderer.removeListener('track-updated', handler);
  },
  onCuePointsUpdated: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('cue-points-updated', handler);
    return () => ipcRenderer.removeListener('cue-points-updated', handler);
  },
  onNormalizeProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('normalize-progress', handler);
    return () => ipcRenderer.removeListener('normalize-progress', handler);
  },
  onAnalysisProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('analysis-progress', handler);
    return () => ipcRenderer.removeListener('analysis-progress', handler);
  },
  onCueGenProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('cue-gen-progress', handler);
    return () => ipcRenderer.removeListener('cue-gen-progress', handler);
  },
  onLibraryUpdated: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('library-updated', handler);
    return () => ipcRenderer.removeListener('library-updated', handler);
  },
  onImportProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('import-progress', handler);
    return () => ipcRenderer.removeListener('import-progress', handler);
  },
  onPlaylistsUpdated: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('playlists-updated', handler);
    return () => ipcRenderer.removeListener('playlists-updated', handler);
  },
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings', handler);
    return () => ipcRenderer.removeListener('open-settings', handler);
  },
  // Auto-tagger
  autoTagSearch: (query) => ipcRenderer.invoke('auto-tag-search', { query }),
  fetchArtworkUrl: ({ trackId, url }) => ipcRenderer.invoke('fetch-artwork-url', { trackId, url }),

  // yt-dlp URL download
  getMediaPort: () => ipcRenderer.invoke('get-media-port'),
  ytDlpFetchInfo: (url) => ipcRenderer.invoke('ytdlp-fetch-info', url),
  checkDuplicateUrls: (urls) => ipcRenderer.invoke('check-duplicate-urls', urls),
  getPlaylistSourceUrls: (playlistId) => ipcRenderer.invoke('get-playlist-source-urls', playlistId),
  ytDlpDownloadUrl: ({ url, playlistItems, playlistTitle, existingPlaylistId, newPlaylistName }) =>
    ipcRenderer.invoke('ytdlp-download-url', {
      url,
      playlistItems,
      playlistTitle,
      existingPlaylistId,
      newPlaylistName,
    }),
  onYtDlpProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('ytdlp-progress', handler);
    return () => ipcRenderer.removeListener('ytdlp-progress', handler);
  },
  onYtDlpCheckProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('ytdlp-check-progress', handler);
    return () => ipcRenderer.removeListener('ytdlp-check-progress', handler);
  },
  onYtDlpEntriesReady: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('ytdlp-entries-ready', handler);
    return () => ipcRenderer.removeListener('ytdlp-entries-ready', handler);
  },
  onYtDlpEntryChecked: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('ytdlp-entry-checked', handler);
    return () => ipcRenderer.removeListener('ytdlp-entry-checked', handler);
  },
  onYtDlpTrackUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('ytdlp-track-update', handler);
    return () => ipcRenderer.removeListener('ytdlp-track-update', handler);
  },
  updateYtDlp: (tag) => ipcRenderer.invoke('update-yt-dlp', tag ?? null),
  updateTidalDlNg: () => ipcRenderer.invoke('update-tidal-dl-ng'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // TIDAL download
  tidalCheck: () => ipcRenderer.invoke('tidal-check'),
  tidalInstall: () => ipcRenderer.invoke('tidal-install'),
  tidalFetchInfo: (url) => ipcRenderer.invoke('tidal-fetch-info', url),
  tidalLogin: () => ipcRenderer.invoke('tidal-login'),
  tidalDownloadUrl: (opts) => ipcRenderer.invoke('tidal-download-url', opts),
  onTidalProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('tidal-progress', handler);
    return () => ipcRenderer.removeListener('tidal-progress', handler);
  },
  onTidalLoginUrl: (cb) => {
    const handler = (_, url) => cb(url);
    ipcRenderer.on('tidal-login-url', handler);
    return () => ipcRenderer.removeListener('tidal-login-url', handler);
  },
  onTidalInstallProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('tidal-install-progress', handler);
    return () => ipcRenderer.removeListener('tidal-install-progress', handler);
  },
  onTidalTrackUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('tidal-track-update', handler);
    return () => ipcRenderer.removeListener('tidal-track-update', handler);
  },

  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),

  // File Explorer
  getComputerRoot: () => ipcRenderer.invoke('get-computer-root'),
  browseDirectory: (dirPath) => ipcRenderer.invoke('browse-directory', dirPath),
  selectExplorerFolder: () => ipcRenderer.invoke('select-explorer-folder'),
  getTracksByPaths: (filePaths) => ipcRenderer.invoke('get-tracks-by-paths', filePaths),
  explorerStartRecursive: (dirPath) => ipcRenderer.invoke('explorer-start-recursive', dirPath),
  explorerCancelRecursive: () => ipcRenderer.invoke('explorer-cancel-recursive'),
  onExplorerRecursiveBatch: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('explorer-recursive-batch', handler);
    return () => ipcRenderer.removeListener('explorer-recursive-batch', handler);
  },
  onExplorerRecursiveDone: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('explorer-recursive-done', handler);
    return () => ipcRenderer.removeListener('explorer-recursive-done', handler);
  },
  linkAudioFiles: (filePaths, playlistId) =>
    ipcRenderer.invoke('link-audio-files', { filePaths, playlistId }),
  linkDirectory: (dirPath, recursive, playlistId) =>
    ipcRenderer.invoke('link-directory', { dirPath, recursive, playlistId }),
  remapTrack: (trackId, newPath) => ipcRenderer.invoke('remap-track', { trackId, newPath }),
  remapFolder: (oldDir) => ipcRenderer.invoke('remap-folder', { oldDir }),
  checkLinkedTrackStatus: (trackIds) => ipcRenderer.invoke('check-linked-track-status', trackIds),
  getLinkedTracksBasic: () => ipcRenderer.invoke('get-linked-tracks-basic'),

  clearLibrary: () => ipcRenderer.invoke('clear-library'),
  clearUserData: () => ipcRenderer.invoke('clear-user-data'),
  getLogDir: () => ipcRenderer.invoke('get-log-dir'),
  openLogDir: () => ipcRenderer.invoke('open-log-dir'),
  log: (level, ...args) => ipcRenderer.send('renderer-log', { level, msg: args.join(' ') }),
  getDepVersions: () => ipcRenderer.invoke('get-dep-versions'),
  checkDepUpdates: () => ipcRenderer.invoke('check-dep-updates'),
  updateAnalyzer: () => ipcRenderer.invoke('update-analyzer'),
  updateAllDeps: () => ipcRenderer.invoke('update-all-deps'),
  onDepsProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('deps-progress', handler);
    return () => ipcRenderer.removeListener('deps-progress', handler);
  },
});
