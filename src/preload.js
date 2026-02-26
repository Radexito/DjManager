const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Track library
  getTracks: (params) => ipcRenderer.invoke('get-tracks', params),
  getTrackIds: (params) => ipcRenderer.invoke('get-track-ids', params),
  reanalyzeTrack: (trackId) => ipcRenderer.invoke('reanalyze-track', trackId),
  removeTrack: (trackId) => ipcRenderer.invoke('remove-track', trackId),
  adjustBpm: (payload) => ipcRenderer.invoke('adjust-bpm', payload),

  // Import
  selectAudioFiles: () => ipcRenderer.invoke('select-audio-files'),
  importAudioFiles: (files) => ipcRenderer.invoke('import-audio-files', files),

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

  // Settings
  getSetting: (key, def) => ipcRenderer.invoke('get-setting', key, def),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  normalizeLibrary: (payload) => ipcRenderer.invoke('normalize-library', payload),

  // Events
  onTrackUpdated: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('track-updated', handler);
    return () => ipcRenderer.removeListener('track-updated', handler);
  },
  onLibraryUpdated: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('library-updated', handler);
    return () => ipcRenderer.removeListener('library-updated', handler);
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
