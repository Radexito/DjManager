import '@testing-library/jest-dom';

/** In-memory `Storage` implementation used when the test environment provides none. */
function memoryStorage() {
  const entries = new Map();
  return {
    get length() {
      return entries.size;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key) {
      return entries.has(String(key)) ? entries.get(String(key)) : null;
    },
    setItem(key, value) {
      entries.set(String(key), String(value));
    },
    removeItem(key) {
      entries.delete(String(key));
    },
    clear() {
      entries.clear();
    },
  };
}

for (const name of ['localStorage', 'sessionStorage']) {
  const existing = typeof globalThis[name] === 'undefined' ? window?.[name] : globalThis[name];
  const storage = existing ?? memoryStorage();
  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}

const noop = () => () => {};

window.api = {
  getTracks: vi.fn().mockResolvedValue([]),
  getUsbDevices: vi.fn().mockResolvedValue([]),
  refreshUsbDevices: vi.fn().mockResolvedValue([]),
  getUsbWatchRoots: vi.fn().mockResolvedValue({ roots: [], enabled: true }),
  getUsbContents: vi.fn().mockResolvedValue(null),
  onUsbDevicesChanged: () => () => {},
  countTracks: vi.fn().mockResolvedValue(0),
  getTrackRank: vi.fn().mockResolvedValue(null),
  getTrackIds: vi.fn().mockResolvedValue([]),
  getTrackById: vi.fn().mockResolvedValue(null),
  listLibraries: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: 'Default',
      storage_format: 'hashed',
      root_path: null,
      effective_root_path: '/tmp/userData/audio',
    },
  ]),
  listLibrariesWithFreeSpace: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: 'Default',
      storage_format: 'hashed',
      root_path: null,
      effective_root_path: '/tmp/userData/audio',
      free_bytes: 1024 ** 3,
    },
  ]),
  getLibrarySize: vi.fn().mockResolvedValue(0),
  getCurrentLibraryId: vi.fn().mockResolvedValue(1),
  setCurrentLibraryId: vi.fn().mockResolvedValue(undefined),
  createLibrary: vi
    .fn()
    .mockResolvedValue({ id: 2, name: 'New Library', storage_format: 'hashed' }),
  renameLibrary: vi.fn().mockResolvedValue({ id: 1, name: 'Renamed' }),
  getLibraryStorageFormat: vi.fn().mockResolvedValue('hashed'),
  convertStorageFormat: vi.fn().mockResolvedValue({ moved: 0, total: 0 }),
  onConvertStorageFormatProgress: vi.fn().mockImplementation(noop),
  getDbPath: vi.fn().mockResolvedValue('/tmp/library.db'),
  getDbSize: vi.fn().mockResolvedValue(0),
  moveDatabase: vi.fn().mockResolvedValue(undefined),
  getUnavailableLinkedTracks: vi.fn().mockResolvedValue([]),
  getCuePoints: vi.fn().mockResolvedValue([]),
  addCuePoint: vi.fn().mockResolvedValue({ id: 1 }),
  updateCuePoint: vi.fn().mockResolvedValue({ ok: true }),
  deleteCuePoint: vi.fn().mockResolvedValue({ ok: true }),
  generateCuePoints: vi.fn().mockResolvedValue([]),
  generateCuePointsLibrary: vi.fn().mockResolvedValue({ generated: 0, skipped: 0, total: 0 }),
  deleteAllCuePointsLibrary: vi.fn().mockResolvedValue({ deleted: 0 }),
  scanUsbCues: vi.fn().mockResolvedValue({
    ok: true,
    mode: 'extend',
    tracks: [],
    summary: { tracks: 0, cues: 0, add: 0, update: 0, skip: 0, remove: 0 },
  }),
  importUsbCues: vi.fn().mockResolvedValue({
    ok: true,
    mode: 'extend',
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    tracks: 0,
  }),
  getPlaylists: vi.fn().mockResolvedValue([]),
  getPlaylist: vi.fn().mockResolvedValue(null),
  createPlaylist: vi.fn().mockResolvedValue({ id: 1 }),
  renamePlaylist: vi.fn().mockResolvedValue(undefined),
  updatePlaylistColor: vi.fn().mockResolvedValue(undefined),
  deletePlaylist: vi.fn().mockResolvedValue(undefined),
  addTracksToPlaylist: vi.fn().mockResolvedValue(undefined),
  removeTrackFromPlaylist: vi.fn().mockResolvedValue(undefined),
  reorderPlaylist: vi.fn().mockResolvedValue(undefined),
  getPlaylistsForTrack: vi.fn().mockResolvedValue([]),
  selectAudioFiles: vi.fn().mockResolvedValue([]),
  importAudioFiles: vi.fn().mockResolvedValue([]),
  reanalyzeTrack: vi.fn().mockResolvedValue({ ok: true }),
  getZoomFactor: vi.fn().mockReturnValue(1.0),
  setZoomFactor: vi.fn(),
  removeTrack: vi.fn().mockResolvedValue({ ok: true }),
  removeTracks: vi.fn().mockResolvedValue({ ok: true, total: 0 }),
  onRemoveTracksProgress: vi.fn().mockImplementation(noop),
  removeLinkedFile: vi.fn().mockResolvedValue({ ok: true }),
  adjustBpm: vi.fn().mockResolvedValue([]),
  updateTrack: vi.fn().mockResolvedValue({}),
  getEditorWaveform: vi.fn().mockResolvedValue(null),
  getGraphicsState: vi.fn().mockResolvedValue({
    mode: 'auto',
    activeProfile: 'auto',
    notice: null,
    crashCount: 0,
    lastCrashAt: null,
  }),
  getGraphicsReport: vi.fn().mockResolvedValue(null),
  setGraphicsMode: vi.fn().mockResolvedValue({ ok: true }),
  relaunchApp: vi.fn().mockResolvedValue(undefined),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  normalizeLibrary: vi.fn().mockResolvedValue({ normalized: 0, skipped: 0, total: 0 }),
  normalizeTracksAudio: vi.fn().mockResolvedValue({ normalized: 0, skipped: 0 }),
  getNormalizedCount: vi.fn().mockResolvedValue(0),
  getLibraryPath: vi.fn().mockResolvedValue('/tmp/audio'),
  moveLibrary: vi.fn().mockResolvedValue({ moved: 0, total: 0 }),
  openDirDialog: vi.fn().mockResolvedValue(null),
  getDepVersions: vi.fn().mockResolvedValue({}),
  checkDepUpdates: vi.fn().mockResolvedValue({}),
  updateAllDeps: vi.fn().mockResolvedValue(undefined),
  retryDeps: vi.fn().mockResolvedValue(undefined),
  updateTidalDlNg: vi.fn().mockResolvedValue({ ok: true }),
  clearLibrary: vi.fn().mockResolvedValue(undefined),
  clearUserData: vi.fn().mockResolvedValue(undefined),
  getLogDir: vi.fn().mockResolvedValue('/tmp/logs'),
  openLogDir: vi.fn().mockResolvedValue(undefined),
  log: vi.fn(),
  onTrackUpdated: vi.fn().mockImplementation(noop),
  onCuePointsUpdated: vi.fn().mockImplementation(noop),
  onUsbCuesDetected: vi.fn().mockImplementation(noop),
  onLibraryUpdated: vi.fn().mockImplementation(noop),
  onPlaylistsUpdated: vi.fn().mockImplementation(noop),
  onFolderPlaylistUpdated: vi.fn().mockImplementation(noop),
  createFolderPlaylist: vi.fn().mockResolvedValue({ ok: true, added: 0, imported: 0 }),
  refreshFolderPlaylist: vi
    .fn()
    .mockResolvedValue({ ok: true, added: 0, imported: 0, missing: [] }),
  refreshFolderPlaylists: vi.fn().mockResolvedValue([]),
  removeFolderPlaylistTracks: vi.fn().mockResolvedValue({ ok: true, removed: 0 }),
  stopFolderPlaylist: vi.fn().mockResolvedValue({ ok: true }),
  setFolderPlaylistRecursive: vi.fn().mockResolvedValue({ ok: true }),
  onOpenSettings: vi.fn().mockImplementation(noop),
  onDepsProgress: vi.fn().mockImplementation(noop),
  onMoveLibraryProgress: vi.fn().mockImplementation(noop),
  onImportProgress: vi.fn().mockImplementation(noop),
  onNormalizeProgress: vi.fn().mockImplementation(noop),
  onAnalysisProgress: vi.fn().mockImplementation(noop),
  onCueGenProgress: vi.fn().mockImplementation(noop),
  getTrackWaveform: vi.fn().mockResolvedValue(null),
  onWaveformReady: vi.fn().mockImplementation(noop),
  generateWaveformsLibrary: vi.fn().mockResolvedValue({ generated: 0, skipped: 0, total: 0 }),
  onWaveformGenProgress: vi.fn().mockImplementation(noop),
  getMediaPort: vi.fn().mockResolvedValue(19876),
  ytDlpFetchInfo: vi.fn().mockResolvedValue({ ok: false, error: 'not configured' }),
  checkDuplicateUrls: vi.fn().mockResolvedValue([]),
  getPlaylistSourceUrls: vi.fn().mockResolvedValue([]),
  ytDlpDownloadUrl: vi.fn().mockResolvedValue({ ok: true, trackIds: [] }),
  onYtDlpProgress: vi.fn().mockImplementation(() => () => {}),
  onYtDlpCheckProgress: vi.fn().mockImplementation(() => () => {}),
  onYtDlpEntriesReady: vi.fn().mockImplementation(() => () => {}),
  onYtDlpEntryChecked: vi.fn().mockImplementation(() => () => {}),
  onYtDlpTrackUpdate: vi.fn().mockImplementation(() => () => {}),
  tidalCheck: vi.fn().mockResolvedValue({ installed: false, loggedIn: false, path: null }),
  tidalInstall: vi.fn().mockResolvedValue({ ok: true }),
  tidalFetchInfo: vi.fn().mockResolvedValue({ ok: false, error: 'not configured' }),
  tidalLogin: vi.fn().mockResolvedValue({ ok: true }),
  tidalListCollections: vi.fn().mockResolvedValue({ ok: true, collections: [], warnings: [] }),
  tidalCollectionTracks: vi.fn().mockResolvedValue({ ok: true, entries: [], title: '' }),
  tidalDownloadCollection: vi.fn().mockResolvedValue({ ok: true, trackIds: [], playlistId: null }),
  tidalDownloadUrl: vi.fn().mockResolvedValue({ ok: true, trackIds: [], playlistId: null }),
  cloudSearch: vi.fn().mockResolvedValue({ ok: true, results: [] }),
  cloudSearchPreview: vi
    .fn()
    .mockResolvedValue({ ok: true, url: 'https://example.com/preview.mp3' }),
  onTidalProgress: vi.fn().mockImplementation(() => () => {}),
  onTidalLoginUrl: vi.fn().mockImplementation(() => () => {}),
  onTidalInstallProgress: vi.fn().mockImplementation(() => () => {}),
  onTidalTrackUpdate: vi.fn().mockImplementation(() => () => {}),
  openExternal: vi.fn().mockResolvedValue(undefined),
  getComputerRoot: vi.fn().mockResolvedValue({ root: '/', home: '/home/user' }),
  browseDirectory: vi.fn().mockResolvedValue({ dirs: [], files: [] }),
  selectExplorerFolder: vi.fn().mockResolvedValue(null),
  getTracksByPaths: vi.fn().mockResolvedValue([]),
  explorerStartRecursive: vi.fn().mockResolvedValue(undefined),
  explorerCancelRecursive: vi.fn().mockResolvedValue(undefined),
  onExplorerRecursiveBatch: vi.fn().mockImplementation(noop),
  onExplorerRecursiveDone: vi.fn().mockImplementation(noop),
  linkAudioFiles: vi.fn().mockResolvedValue([]),
  linkDirectory: vi.fn().mockResolvedValue({ ok: true, linked: 0, total: 0 }),
  remapTrack: vi.fn().mockResolvedValue({ ok: true }),
  remapFolder: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
  moveTrackToLibrary: vi.fn().mockResolvedValue({ ok: true, moved: true }),
  moveTracksToLibrary: vi.fn().mockResolvedValue({ moved: [], failed: [] }),
  onMoveTracksToLibraryProgress: vi.fn().mockImplementation(noop),
  checkLinkedTrackStatus: vi.fn().mockResolvedValue([]),
  getLinkedTracksBasic: vi.fn().mockResolvedValue([]),
  checkUsbFormat: vi
    .fn()
    .mockResolvedValue({ needsFormat: false, fs: 'fat32', fsLabel: 'fat32', device: '/dev/sdb1' }),
  formatUsb: vi.fn().mockResolvedValue({ ok: true }),
  exportAll: vi
    .fn()
    .mockResolvedValue({ ok: true, trackCount: 5, playlistCount: 2, usbRoot: '/tmp/usb' }),
  onExportAllProgress: vi.fn().mockImplementation(noop),
  onFormatUsbProgress: vi.fn().mockImplementation(noop),
  autoTagSearch: vi.fn().mockResolvedValue({ ok: true, results: [] }),
  fetchArtworkUrl: vi.fn().mockResolvedValue({ ok: true, artwork_path: '/tmp/artwork.jpg' }),
};

/** Minimal Web Audio context: every node factory is a spy, so the player graph stays inert. */
class MockAudioContext {
  /** Creates the node factories the player calls, all returning connectable stubs. */
  constructor() {
    this.destination = {};
    this.createMediaElementSource = vi.fn().mockReturnValue({ connect: vi.fn() });
    this.createGain = vi.fn().mockReturnValue({ gain: { value: 1 }, connect: vi.fn() });
    this.createDynamicsCompressor = vi.fn().mockReturnValue({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 1 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn(),
    });
    this.setSinkId = vi.fn().mockResolvedValue(undefined);
    this.resume = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
  }
}
window.AudioContext = MockAudioContext;
