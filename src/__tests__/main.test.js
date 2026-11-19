/**
 * Contract tests for the Electron main process (src/main.js).
 *
 * WHY THIS SHAPE: `main.js` is slated for a rewrite/refactor, so this file pins
 * *observable behaviour*, never source layout. Nothing here reads the file as
 * text, greps for IPC registrations or asserts on function order — a refactor
 * that keeps the same IPC surface, return shapes, DB effects and renderer
 * notifications keeps this suite green, and a regression turns it red.
 *
 * HOW: the module is imported for real against a real in-memory SQLite DB
 * (`DB_PATH=':memory:'`, see vitest.config.js) with the repo's own repositories.
 * Only true OS/process boundaries are stubbed: Electron itself, ffmpeg/yt-dlp/
 * tidal-dl-ng/deps downloads, media server sockets, chokidar and the binary
 * writers whose output formats already have their own unit suites.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map(),
  listeners: new Map(),
  appEvents: new Map(),
  windowInstances: [],
  menuInstances: [],
  duplicateHandles: [],
  userData: '',
}));

vi.mock('electron', () => {
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.sent = [];
      this.events = {};
      this.webContents = {
        sent: this.sent,
        events: this.events,
        on: vi.fn((name, fn) => {
          this.events[name] = fn;
        }),
        send: vi.fn((channel, payload) => {
          this.sent.push([channel, payload]);
        }),
        openDevTools: vi.fn(),
        toggleDevTools: vi.fn(),
        session: {
          webRequest: {
            onErrorOccurred: vi.fn((fn) => {
              this.onErrorOccurred = fn;
            }),
            onCompleted: vi.fn((fn) => {
              this.onCompleted = fn;
            }),
          },
        },
      };
      h.windowInstances.push(this);
    }
    static getAllWindows() {
      return [];
    }
    maximize() {}
    loadURL() {}
    loadFile() {}
    on() {}
  }

  class Menu {
    constructor() {
      this.items = [];
      this.popup = vi.fn();
      h.menuInstances.push(this);
    }
    static setApplicationMenu = vi.fn();
    append(item) {
      this.items.push(item);
    }
  }

  class MenuItem {
    constructor(options) {
      Object.assign(this, options);
    }
  }

  const app = {
    name: '',
    isPackaged: false,
    setDesktopName: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn((event, fn) => {
      const list = h.appEvents.get(event) ?? [];
      list.push(fn);
      h.appEvents.set(event, list);
    }),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn((name) => (name === 'userData' ? h.userData : path.join(h.userData, name))),
    getAppPath: vi.fn(() => h.userData),
    getVersion: vi.fn(() => '1.0.24'),
    quit: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
  };

  return {
    app,
    BrowserWindow,
    Menu,
    MenuItem,
    ipcMain: {
      handle: vi.fn((channel, fn) => {
        if (h.handlers.has(channel)) h.duplicateHandles.push(channel);
        h.handlers.set(channel, fn);
      }),
      on: vi.fn((channel, fn) => {
        h.listeners.set(channel, fn);
      }),
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
    },
    shell: {
      openPath: vi.fn(async () => ''),
      openExternal: vi.fn(async () => ''),
    },
  };
});

vi.mock('../deps.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureDeps: vi.fn(async () => {}),
  checkForUpdates: vi.fn(async () => ({})),
  updateAnalyzer: vi.fn(async () => {}),
  updateYtDlp: vi.fn(async () => {}),
  updateTidalDlNg: vi.fn(async () => {}),
  updateAll: vi.fn(async () => {}),
  ensureTidalDlNg: vi.fn(async () => {}),
}));

vi.mock('../audio/ytDlpManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  downloadUrl: vi.fn(async () => ({ files: [] })),
  fetchPlaylistInfo: vi.fn(async () => ({ type: 'video', entries: [] })),
  searchYouTube: vi.fn(async () => []),
  createPreviewAudioStream: vi.fn(() => 'preview-token'),
}));

vi.mock('../audio/tidalDlManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkTidalSetup: vi.fn(async () => ({ ok: true, installed: true })),
  startLogin: vi.fn(async () => {}),
  downloadTidal: vi.fn(async () => []),
  fetchTidalInfo: vi.fn(async () => ({ type: 'track', entries: [] })),
  fetchTidalCollections: vi.fn(async () => ({ ok: true, collections: [] })),
  fetchTidalCollectionTracks: vi.fn(async () => ({ ok: true, entries: [] })),
  searchTidal: vi.fn(async () => ({ ok: true, results: [] })),
  getTidalPreviewUrl: vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1/tidal.mp3' })),
}));

vi.mock('../audio/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  convertAudio: vi.fn(async () => {}),
  ffprobe: vi.fn(async () => ({ format: {}, streams: [] })),
}));

vi.mock('../audio/waveformGenerator.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateWaveformOverview: vi.fn(async () => Buffer.from([1, 2, 3])),
  generateEditorWaveform: vi.fn(async () => ({
    detail: Buffer.from([1, 2, 3]),
    detailHires: Buffer.from([5, 6, 7]),
    overview: Buffer.from([4]),
    numCols: 4,
  })),
}));

vi.mock('../audio/mediaServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startMediaServer: vi.fn(async () => ({ port: 4321 })),
}));

vi.mock('../audio/autoTagger.js', async (importOriginal) => ({
  ...(await importOriginal()),
  searchMusicBrainz: vi.fn(async () => []),
  searchDiscogs: vi.fn(async () => []),
  searchItunes: vi.fn(async () => []),
  searchDeezer: vi.fn(async () => []),
}));

vi.mock('../audio/importManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  importAudioFile: vi.fn(async (_filePath, _extra, _libraryId) => 1),
  linkAudioFile: vi.fn(async () => ({ id: 1 })),
  spawnAnalysis: vi.fn(),
  cancelAnalysis: vi.fn(() => true),
  scanFoldersForNewTracks: vi.fn(async () => ({ found: 0, imported: 0, skipped: 0, failed: 0 })),
  moveTrackToLibrary: vi.fn(),
  convertStorageFormat: vi.fn(),
  writeBpmKeyTagsForTrack: vi.fn(async () => ({ ok: true, wrote: [] })),
}));

vi.mock('../audio/id3Writer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writeId3Tags: vi.fn(async () => {}),
  writeBpmKeyTags: vi.fn(async () => {}),
}));

vi.mock('../audio/sampleInfo.js', async (importOriginal) => ({
  ...(await importOriginal()),
  backfillPdbSampleInfo: vi.fn(async () => {}),
  resolveExportSampleInfo: vi.fn(async () => new Map()),
}));

vi.mock('../audio/trackTrim.js', async (importOriginal) => ({
  ...(await importOriginal()),
  exportTrimRange: vi.fn(() => null),
}));

vi.mock('../usb/pioneer/formats/anlz.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writeAnlz: vi.fn(),
}));

vi.mock('../usb/pioneer/formats/pdb.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writePdb: vi.fn(),
}));

vi.mock('../usb/pioneer/formats/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writeSettingFiles: vi.fn(),
}));

vi.mock('../usb/generic/fs.js', async (importOriginal) => ({
  ...(await importOriginal()),
  detectFilesystem: vi.fn(async () => ({ fs: 'vfat', device: '/dev/sdb1' })),
  formatDrive: vi.fn(async () => {}),
}));

vi.mock('../usb/pioneer/formats/cues.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readTrackCues: vi.fn(() => []),
}));

vi.mock('../library/libraryWatcher.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createLibraryWatcher: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../db/database.js', async (importOriginal) => ({
  ...(await importOriginal()),
  closeDB: vi.fn(),
}));

vi.mock('../resetCleanup.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startResetCleanup: vi.fn(),
}));

import { app, dialog, Menu, shell } from 'electron';
import db from '../db/database.js';
import { createLibrary } from '../db/libraryRepository.js';

/** Path of the entry point, imported once in `beforeAll` so the electron mocks are in place. */
const mainModule = '../main.js';

let launchProfileCalls;
let bridge;

beforeAll(async () => {
  await import(mainModule);
  bridge = await import('../main/rendererBridge.js');
  launchProfileCalls = {
    disableAcceleration: app.disableHardwareAcceleration.mock.calls.length,
    switches: app.commandLine.appendSwitch.mock.calls.map(([name]) => name),
  };
});

let userDataDir;
const createdDirs = [];

beforeEach(() => {
  vi.clearAllMocks();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-main-test-'));
  createdDirs.push(userDataDir);
  fs.mkdirSync(path.join(userDataDir, 'logs'), { recursive: true });
  h.userData = userDataDir;
  h.windowInstances.length = 0;
  h.menuInstances.length = 0;
  bridge.getRuntime().mainWindow = null;

  for (const table of ['cue_points', 'playlist_tracks', 'playlists', 'tracks', 'settings']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  try {
    db.prepare('DELETE FROM libraries').run();
  } catch {}
});

afterEach(() => {
  bridge.getRuntime().mainWindow = null;
});

afterAll(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Looks up a registered IPC handler, failing loudly when the channel was never registered. */
function handler(channel) {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No IPC handler registered for "${channel}"`);
  return fn;
}

/** Invokes a registered IPC handler with a stand-in sender and the given arguments. */
async function call(channel, ...args) {
  return handler(channel)({ sender: null }, ...args);
}

/**
 * Renderer bridge attached to `runtime.mainWindow`, which is what createWindow()
 * sets. The old global is gone, so the harness uses the real hook instead of
 * writing into process scope.
 */
function attachRenderer() {
  const win = { webContents: { send: vi.fn(), openDevTools: vi.fn() } };
  bridge.getRuntime().mainWindow = win;
  return win;
}

/** Payloads the main process pushed to a window on one channel, in send order. */
function sent(win, channel) {
  return win.webContents.send.mock.calls
    .filter(([name]) => name === channel)
    .map(([, payload]) => payload);
}

/** Channel names the main process pushed to a window, in send order. */
function sentChannels(win) {
  return win.webContents.send.mock.calls.map(([name]) => name);
}

/** Creates a real temporary file so path-based handlers have something that exists on disk. */
function audioFile(name = 'track.mp3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-audio-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'not-really-audio');
  return file;
}

/** Counter behind `seedTrack`, keeping generated titles, paths and hashes unique per insert. */
let trackSeq = 0;
/** Inserts a fully populated track row, temp audio file included, and returns its id. */
function seedTrack(overrides = {}) {
  trackSeq += 1;
  const filePath = overrides.file_path ?? audioFile(`seed-${trackSeq}.mp3`);
  const row = {
    title: `Track ${trackSeq}`,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    bpm: 128,
    file_path: filePath,
    file_hash: `hash-${trackSeq}`,
    format: 'mp3',
    bitrate: 320000,
    analyzed: 1,
    is_linked: 0,
    waveform_overview: null,
    waveform_detail_hires: null,
    bpm_override: null,
    library_id: null,
    loudness: null,
    source_url: null,
    source_link: null,
    key_raw: null,
    key_camelot: null,
    beatgrid: null,
    beatgrid_offset: 0,
    trim_start_ms: null,
    trim_end_ms: null,
    genres: null,
    comments: '',
    rating: 0,
    ...overrides,
  };
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO tracks (${columns.join(', ')})
       VALUES (${columns.map((c) => `@${c}`).join(', ')})`
    )
    .run(row).lastInsertRowid;
}

/** Reads a track row straight from the database. */
function trackRow(id) {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
}

/** Creates a library row and returns the new library id. */
function createLibraryId(name, rootPath = null) {
  return createLibrary({ name, rootPath }).id;
}

/** Track ids of a playlist in playback order, read from `playlist_tracks`. */
function playlistTrackIds(playlistId) {
  return db
    .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, rowid')
    .all(playlistId)
    .map((row) => row.track_id);
}

describe('IPC surface', () => {
  it('registers the main-process command surface', () => {
    expect(h.handlers.size).toBeGreaterThan(100);
    for (const channel of h.handlers.keys()) expect(typeof channel).toBe('string');
  });

  it('registers every channel exactly once', () => {
    expect(h.duplicateHandles).toEqual([]);
  });

  it('keeps the track, playlist and cue channels the renderer depends on', () => {
    const required = [
      'get-tracks',
      'count-tracks',
      'get-track-rank',
      'get-track-ids',
      'get-track-by-id',
      'get-track-waveform',
      'get-editor-waveform',
      'adjust-bpm',
      'remove-track',
      'remove-tracks',
      'remove-linked-file',
      'update-track',
      'reanalyze-track',
      'cancel-analysis',
      'get-playlists',
      'create-playlist',
      'rename-playlist',
      'delete-playlist',
      'add-tracks-to-playlist',
      'get-cue-points',
      'add-cue-point',
      'update-cue-point',
      'delete-cue-point',
      'scan-watch-folders',
      'get-watch-state',
      'refresh-folder-playlist',
      'refresh-folder-playlists',
      'remove-folder-playlist-tracks',
      'stop-folder-playlist',
      'set-playlist-folder',
    ];

    for (const channel of required) expect(h.handlers.has(channel), channel).toBe(true);
  });

  it('listens for renderer log lines pushed from the UI', () => {
    expect(h.listeners.has('renderer-log')).toBe(true);
  });

  it('boots with hardware acceleration on in the default (auto) profile', () => {
    expect(launchProfileCalls.disableAcceleration).toBe(0);
    for (const name of ['disable-gpu', 'disable-gpu-sandbox', 'no-sandbox']) {
      expect(launchProfileCalls.switches, name).not.toContain(name);
    }
  });
});

describe('track reads', () => {
  it('returns tracks, counts and ids from the library', async () => {
    const id = seedTrack();

    expect(await call('get-tracks', {})).toHaveLength(1);
    expect(await call('count-tracks', {})).toBe(1);
    expect(await call('get-track-ids', {})).toEqual([id]);
    expect((await call('get-track-by-id', id)).title).toBe('Track 1');
  });

  it('coalesces a missing track to null instead of undefined', async () => {
    expect(await call('get-track-by-id', 9999)).toBe(null);
  });

  it('delegates ranking to the repository', async () => {
    seedTrack();
    await expect(call('get-track-rank', {})).resolves.not.toBeUndefined();
  });

  it('returns waveform bytes as Uint8Array and null when absent', async () => {
    const id = seedTrack();

    expect(await call('get-track-waveform', id)).toBe(null);

    db.prepare('UPDATE tracks SET waveform_overview = ? WHERE id = ?').run(
      Buffer.from([9, 8, 7]),
      id
    );

    const wave = await call('get-track-waveform', id);
    expect(wave).toBeInstanceOf(Uint8Array);
    expect(Array.from(wave)).toEqual([9, 8, 7]);
  });

  it('lists linked tracks whose file is currently unreachable', async () => {
    const present = seedTrack({ is_linked: 1 });
    const missing = seedTrack({ is_linked: 1, file_path: '/nope/gone.mp3' });
    seedTrack({ is_linked: 0, file_path: '/nope/imported.mp3' });

    const unavailable = await call('get-unavailable-linked-tracks');
    expect(unavailable).toEqual([missing]);
    expect(unavailable).not.toContain(present);
  });
});

describe('write-bpm-key-tags', () => {
  it('aggregates per-track results and survives one failure', async () => {
    const importManager = await import('../audio/importManager.js');
    importManager.writeBpmKeyTagsForTrack
      .mockResolvedValueOnce({ trackId: 1, ok: true, wrote: ['bpm'] })
      .mockRejectedValueOnce(new Error('permission denied'));

    const res = await call('write-bpm-key-tags', { trackIds: [1, 2] });

    expect(res.ok).toBe(true);
    expect(res.written).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.results[1]).toMatchObject({ trackId: 2, ok: false, reason: 'error' });
  });

  it('treats a missing argument object as no tracks', async () => {
    const res = await call('write-bpm-key-tags');
    expect(res).toEqual({ ok: true, written: 0, skipped: 0, results: [] });
  });
});

describe('update-track', () => {
  it('persists the edit before answering the renderer', async () => {
    const win = attachRenderer();
    const id = seedTrack({ title: 'Old' });

    const res = await call('update-track', { id, data: { title: 'New', bpm: 130 } });

    expect(res).toEqual({ ok: true });
    expect(trackRow(id).title).toBe('New');
    expect(sent(win, 'track-updated')).toEqual([
      { trackId: id, analysis: { title: 'New', bpm: 130 } },
    ]);
  });

  it('writes the tags in the background, without blocking the response', async () => {
    const id3 = await import('../audio/id3Writer.js');
    attachRenderer();
    const id = seedTrack();

    await call('update-track', { id, data: { title: 'Tagged' } });

    expect(id3.writeId3Tags).toHaveBeenCalledWith(expect.any(String), { title: 'Tagged' });
  });

  it('logs and swallows a failed tag write', async () => {
    const id3 = await import('../audio/id3Writer.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    attachRenderer();
    const id = seedTrack();
    id3.writeId3Tags.mockRejectedValueOnce(new Error('EBUSY'));

    await call('update-track', { id, data: { title: 'X' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalledWith('[update-track] id3 write failed:', 'EBUSY');
    errorSpy.mockRestore();
  });

  it('skips the tag write for a track without a file', async () => {
    const id3 = await import('../audio/id3Writer.js');
    attachRenderer();
    const id = seedTrack();
    db.prepare('UPDATE tracks SET file_path = NULL WHERE id = ?').run(id);

    await call('update-track', { id, data: { title: 'No file' } });

    expect(id3.writeId3Tags).not.toHaveBeenCalled();
  });
});

describe('adjust-bpm', () => {
  beforeEach(async () => {
    attachRenderer();
  });

  it('answers a code for a factor other than 2 or 0.5', async () => {
    expect(await call('adjust-bpm', { trackIds: [1], factor: 1.5 })).toMatchObject({
      ok: false,
      code: 'invalid-factor',
      message: 'Invalid factor: must be 2 or 0.5',
    });
  });

  it('answers a code for empty, oversized and non-array selections', async () => {
    expect(await call('adjust-bpm', { trackIds: [], factor: 2 })).toMatchObject({
      ok: false,
      code: 'invalid-selection',
    });
    expect(await call('adjust-bpm', { trackIds: 'x', factor: 2 })).toMatchObject({
      ok: false,
      code: 'invalid-selection',
    });
    expect(
      await call('adjust-bpm', { trackIds: Array.from({ length: 501 }, (_, i) => i), factor: 2 })
    ).toMatchObject({ ok: false, code: 'invalid-selection' });
  });

  it('doubles and halves analysed BPM, rounded to one decimal', async () => {
    const a = seedTrack({ bpm: 128 });
    const b = seedTrack({ bpm: 174.5 });

    const doubled = await call('adjust-bpm', { trackIds: [a, b], factor: 2 });
    expect(doubled).toEqual([
      { id: a, bpm_override: 256 },
      { id: b, bpm_override: 349 },
    ]);
    expect(trackRow(a).bpm_override).toBe(256);

    const halved = await call('adjust-bpm', { trackIds: [b], factor: 0.5 });
    expect(halved).toEqual([{ id: b, bpm_override: 174.5 }]);
  });

  it('prefers the existing override as the base value', async () => {
    const id = seedTrack({ bpm: 128, bpm_override: 100 });

    expect(await call('adjust-bpm', { trackIds: [id], factor: 2 })).toEqual([
      { id, bpm_override: 200 },
    ]);
  });

  it('skips tracks that are gone or have no BPM', async () => {
    const noBpm = seedTrack({ bpm: null });

    expect(await call('adjust-bpm', { trackIds: [noBpm, 9999], factor: 2 })).toEqual([]);
  });
});

describe('track deletion', () => {
  beforeEach(() => {
    attachRenderer();
  });

  it('deletes the row and the managed audio file', async () => {
    const id = seedTrack();
    const filePath = trackRow(id).file_path;

    expect(await call('remove-track', id)).toEqual({ ok: true });
    expect(trackRow(id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('keeps the audio file of a linked (Explorer) track', async () => {
    const id = seedTrack({ is_linked: 1 });
    const filePath = trackRow(id).file_path;

    await call('remove-track', id);

    expect(trackRow(id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('keeps a file still referenced by another track row', async () => {
    const first = seedTrack();
    const sharedPath = trackRow(first).file_path;
    const second = seedTrack({ file_path: sharedPath });

    await call('remove-track', second);

    expect(fs.existsSync(sharedPath)).toBe(true);
    expect(trackRow(first)).toBeDefined();
  });

  it('tolerates an already-deleted file', async () => {
    const id = seedTrack({ file_path: path.join(os.tmpdir(), 'djman-definitely-gone.mp3') });

    await expect(call('remove-track', id)).resolves.toEqual({ ok: true });
    expect(trackRow(id)).toBeUndefined();
  });

  it('notifies the sidebar about playlist counts after a delete', async () => {
    const win = attachRenderer();
    const id = seedTrack();

    await call('remove-track', id);

    expect(sentChannels(win)).toContain('playlists-updated');
  });

  it('reports progress while deleting a batch and finishes with done', async () => {
    const win = attachRenderer();
    const ids = [seedTrack(), seedTrack()];
    const paths = ids.map((id) => trackRow(id).file_path);

    const res = await call('remove-tracks', ids);

    expect(res).toEqual({ ok: true, total: 2 });
    expect(sent(win, 'remove-tracks-progress')).toEqual([
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
      { completed: 2, total: 2, done: true },
    ]);
    for (const file of paths) expect(fs.existsSync(file)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n).toBe(0);
  });

  it('removes a linked track together with its file on request', async () => {
    const win = attachRenderer();
    const id = seedTrack({ is_linked: 1 });
    const filePath = trackRow(id).file_path;

    expect(await call('remove-linked-file', id)).toEqual({ ok: true });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(sentChannels(win)).toContain('library-updated');
  });

  it('reports an unknown track instead of throwing', async () => {
    expect(await call('remove-linked-file', 4242)).toEqual({ ok: false, error: 'not found' });
  });
});

describe('analysis commands', () => {
  it('queues a re-analysis for an existing track', async () => {
    const importManager = await import('../audio/importManager.js');
    const id = seedTrack();

    expect(await call('reanalyze-track', id)).toEqual({ ok: true });
    expect(importManager.spawnAnalysis).toHaveBeenCalledWith(id, trackRow(id).file_path);
  });

  it('refuses to re-analyse a track that does not exist', async () => {
    expect(await call('reanalyze-track', 777)).toMatchObject({
      ok: false,
      code: 'track-not-found',
      message: 'Track 777 not found',
    });
  });

  it('passes cancellation through and reports the outcome', async () => {
    const importManager = await import('../audio/importManager.js');
    importManager.cancelAnalysis.mockReturnValueOnce(false);

    expect(await call('cancel-analysis', 5)).toEqual({ cancelled: false });
    expect(importManager.cancelAnalysis).toHaveBeenCalledWith(5);
  });
});

describe('get-editor-waveform', () => {
  it('returns null for a track without a file', async () => {
    expect(await call('get-editor-waveform', 12345)).toBe(null);
  });

  it('serves a cached hires buffer without decoding audio', async () => {
    const waveform = await import('../audio/waveformGenerator.js');
    const detail = Buffer.alloc(30, 1);
    const id = seedTrack({ waveform_detail_hires: detail, waveform_overview: Buffer.from([2]) });

    const res = await call('get-editor-waveform', id);

    expect(res.detail).toEqual(detail);
    expect(res.overview).toEqual(Buffer.from([2]));
    expect(res.numCols).toBe(10);
    expect(waveform.generateEditorWaveform).not.toHaveBeenCalled();
  });

  it('generates a legacy waveform and caches the hires buffer in the background', async () => {
    const waveform = await import('../audio/waveformGenerator.js');
    const win = attachRenderer();
    const id = seedTrack();

    const res = await call('get-editor-waveform', id);

    expect(res).toMatchObject({ numCols: 4 });
    await vi.waitFor(() => expect(trackRow(id).waveform_detail_hires).not.toBe(null));
    expect(sent(win, 'waveform-ready')).toEqual([{ trackId: id }]);
    expect(waveform.generateEditorWaveform).toHaveBeenCalledTimes(2);
  });

  it('returns null when waveform generation fails', async () => {
    const waveform = await import('../audio/waveformGenerator.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    waveform.generateEditorWaveform.mockRejectedValueOnce(new Error('ffmpeg missing'));

    expect(await call('get-editor-waveform', seedTrack())).toBe(null);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('settings', () => {
  it('round-trips a value through the settings table', async () => {
    await call('set-setting', 'theme', 'dark');

    expect(await call('get-setting', 'theme', 'light')).toBe('dark');
  });

  it('falls back to the supplied default for an unknown key', async () => {
    expect(await call('get-setting', 'nope', 'fallback')).toBe('fallback');
  });

  it('tells the renderer about every change', async () => {
    const win = attachRenderer();

    await call('set-setting', 'cue_indicator', 'false');

    expect(sent(win, 'settings-updated')).toEqual([{ key: 'cue_indicator', value: 'false' }]);
  });

  it('rebuilds the folder watcher when watch settings change', async () => {
    const watcher = await import('../library/libraryWatcher.js');
    attachRenderer();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-watch-'));
    await call('set-setting', 'watch_enabled', 'true');
    await call('set-setting', 'watch_folders', JSON.stringify([folder]));

    watcher.createLibraryWatcher.mockClear();
    await call('set-setting', 'watch_folders', JSON.stringify([folder]));

    expect(watcher.createLibraryWatcher).toHaveBeenCalled();
    const options = watcher.createLibraryWatcher.mock.calls.at(-1)[0];
    expect(options.folders).toContain(folder);
  });

  it('does not rebuild the watcher for unrelated settings', async () => {
    const watcher = await import('../library/libraryWatcher.js');
    await call('set-setting', 'watch_folders', '[]');
    watcher.createLibraryWatcher.mockClear();

    await call('set-setting', 'theme', 'light');

    expect(watcher.createLibraryWatcher).not.toHaveBeenCalled();
  });
});

describe('ingest folder watching', () => {
  it('reports folders, the enabled flag and the scan state', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-state-'));
    await call('set-setting', 'watch_enabled', 'true');
    await call('set-setting', 'watch_folders', JSON.stringify([folder, '', 42]));

    expect(await call('get-watch-state')).toEqual({
      folders: [folder],
      enabled: true,
      scanning: false,
    });
  });

  it('treats corrupt watch_folders JSON as no folders', async () => {
    await call('set-setting', 'watch_folders', '{not json');

    expect((await call('get-watch-state')).folders).toEqual([]);
  });

  it('scans the configured folders and reports progress', async () => {
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-scan-'));
    await call('set-setting', 'watch_folders', JSON.stringify([folder]));
    importManager.scanFoldersForNewTracks.mockResolvedValueOnce({
      found: 3,
      imported: 2,
      skipped: 1,
      failed: 0,
    });

    const res = await call('scan-watch-folders');

    expect(res).toMatchObject({ found: 3, imported: 2 });
    expect(importManager.scanFoldersForNewTracks).toHaveBeenCalledWith(
      [folder],
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
    expect(sent(win, 'library-updated')).toHaveLength(1);
    expect(sent(win, 'watch-status')[0]).toMatchObject({ event: 'scan-started' });
    expect(sent(win, 'watch-status').at(-1)).toMatchObject({ event: 'scan-done' });
  });

  it('answers with zeroes when nothing is configured', async () => {
    expect(await call('scan-watch-folders')).toEqual({
      found: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('reports a failed scan instead of throwing', async () => {
    const importManager = await import('../audio/importManager.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const win = attachRenderer();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-scan-fail-'));
    await call('set-setting', 'watch_folders', JSON.stringify([folder]));
    importManager.scanFoldersForNewTracks.mockRejectedValueOnce(new Error('EACCES'));

    const res = await call('scan-watch-folders');

    expect(res).toMatchObject({ found: 0, error: 'EACCES' });
    expect(sent(win, 'watch-status').at(-1)).toMatchObject({
      event: 'scan-failed',
      error: 'EACCES',
    });
    errorSpy.mockRestore();
  });
});

describe('cue points', () => {
  it('adds, lists, renames and deletes a cue', async () => {
    const trackId = seedTrack();

    const { id } = await call('add-cue-point', { trackId, positionMs: 1000, label: 'Cue 1' });
    expect((await call('get-cue-points', trackId)).map((c) => c.label)).toEqual(['Cue 1']);

    expect(await call('update-cue-point', { id, label: 'Intro' })).toEqual({ ok: true });
    expect((await call('get-cue-points', trackId))[0].label).toBe('Intro');

    expect(await call('delete-cue-point', id)).toEqual({ ok: true });
    expect(await call('get-cue-points', trackId)).toEqual([]);
  });

  it('renumbers the following auto-named cues when one is inserted', async () => {
    const trackId = seedTrack();
    await call('add-cue-point', { trackId, positionMs: 1000, label: 'Cue 1' });
    await call('add-cue-point', { trackId, positionMs: 2000, label: 'Cue 2' });
    const { id } = await call('add-cue-point', { trackId, positionMs: 500, label: 'Cue 1' });

    const cues = await call('get-cue-points', trackId);

    expect(cues).toHaveLength(3);
    expect(cues.map((c) => c.id)).toContain(id);
    expect(new Set(cues.map((c) => c.label)).size).toBe(3);
  });

  it('updates a cue without a label without touching other cues', async () => {
    const trackId = seedTrack();
    const { id } = await call('add-cue-point', { trackId, positionMs: 1000, label: 'Cue 1' });

    await call('update-cue-point', { id, color: '#ff0000' });

    const cue = (await call('get-cue-points', trackId))[0];
    expect(cue.color).toBe('#ff0000');
    expect(cue.label).toBe('Cue 1');
  });

  it('refuses to generate cues for a missing track', async () => {
    expect(await call('generate-cue-points', 909090)).toMatchObject({
      ok: false,
      code: 'internal',
      message: 'Track 909090 not found',
    });
  });

  it('replaces existing cues when generating for one track', async () => {
    const trackId = seedTrack({ bpm: 128, beatgrid: '0,0.46875' });
    await call('add-cue-point', { trackId, positionMs: 1000, label: 'stale' });

    const generated = await call('generate-cue-points', trackId);

    expect(Array.isArray(generated)).toBe(true);
    expect(generated.every((c) => c.label !== 'stale')).toBe(true);
  });

  it('skips analysed tracks that already have cues and overwrites on request', async () => {
    const win = attachRenderer();
    const trackId = seedTrack({ bpm: 128, beatgrid: '0,0.46875' });
    await call('add-cue-point', { trackId, positionMs: 1000, label: 'existing' });

    const skipped = await call('generate-cue-points-library', { overwrite: false });
    expect(skipped).toEqual({ generated: 0, skipped: 1, total: 1 });

    const overwritten = await call('generate-cue-points-library', { overwrite: true });
    expect(overwritten.generated).toBe(1);
    expect(sentChannels(win)).toContain('cue-gen-progress');
  });

  it('clears every cue in the library and tells the renderer per track', async () => {
    const win = attachRenderer();
    const trackId = seedTrack();
    await call('add-cue-point', { trackId, positionMs: 1000, label: 'Cue 1' });

    const res = await call('delete-all-cue-points-library');

    expect(res).toEqual({ deleted: 1 });
    expect(sent(win, 'cue-points-updated')).toEqual([{ trackId, cueCount: 0 }]);
  });
});

describe('generate-waveforms-library', () => {
  it('generates missing overviews and skips tracks that already have one', async () => {
    const waveform = await import('../audio/waveformGenerator.js');
    const win = attachRenderer();
    const missing = seedTrack();
    const done = seedTrack({ waveform_overview: Buffer.from([1]) });

    const res = await call('generate-waveforms-library', { overwrite: false });

    expect(res).toMatchObject({ generated: 1, skipped: 1, total: 2 });
    expect(trackRow(missing).waveform_overview).not.toBe(null);
    expect(trackRow(done).waveform_overview).not.toBe(null);
    expect(waveform.generateWaveformOverview).toHaveBeenCalledTimes(1);
    expect(sentChannels(win)).toContain('waveform-gen-progress');
  });

  it('counts a failing track as skipped and keeps going', async () => {
    const waveform = await import('../audio/waveformGenerator.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    attachRenderer();
    seedTrack();
    waveform.generateWaveformOverview.mockRejectedValueOnce(new Error('decode failed'));

    const res = await call('generate-waveforms-library', {});

    expect(res).toMatchObject({ generated: 0, skipped: 1, total: 1 });
    warnSpy.mockRestore();
  });
});

describe('playlists', () => {
  beforeEach(() => {
    attachRenderer();
  });

  it('creates a playlist and notifies the sidebar', async () => {
    const win = attachRenderer();

    const res = await call('create-playlist', { name: 'Warmup', color: '#ff0000' });

    expect(res.id).toBeGreaterThan(0);
    expect((await call('get-playlists'))[0]).toMatchObject({
      name: 'Warmup',
      color: '#ff0000',
    });
    expect(sentChannels(win)).toContain('playlists-updated');
  });

  it('reports a duplicate name instead of throwing', async () => {
    await call('create-playlist', { name: 'Warmup' });

    const res = await call('create-playlist', { name: 'Warmup' });

    expect(res).toMatchObject({ error: 'duplicate' });
    expect(res.message).toMatch(/Warmup/);
  });

  it('renames a playlist and reports a duplicate rename', async () => {
    const { id } = await call('create-playlist', { name: 'One' });
    await call('create-playlist', { name: 'Two' });

    expect(await call('rename-playlist', { id, name: 'Three' })).toEqual({});
    expect((await call('get-playlist', id)).name).toBe('Three');

    const clash = await call('rename-playlist', { id, name: 'Two' });
    expect(clash).toMatchObject({ error: 'duplicate' });
  });

  it('updates the colour and deletes a playlist', async () => {
    const { id } = await call('create-playlist', { name: 'Hue' });

    await call('update-playlist-color', { id, color: '#00ff00' });
    expect((await call('get-playlist', id)).color).toBe('#00ff00');

    await call('delete-playlist', id);
    expect(await call('get-playlist', id)).toBeFalsy();
  });

  it('adds, reorders and removes playlist entries', async () => {
    const { id } = await call('create-playlist', { name: 'Set' });
    const a = seedTrack();
    const b = seedTrack();

    await call('add-tracks-to-playlist', { playlistId: id, trackIds: [a, b] });
    expect(playlistTrackIds(id)).toEqual([a, b]);

    await call('reorder-playlist', { playlistId: id, orderedTrackIds: [b, a] });
    expect(playlistTrackIds(id)).toEqual([b, a]);

    await call('remove-track-from-playlist', { playlistId: id, trackId: b });
    expect(playlistTrackIds(id)).toEqual([a]);
  });

  it('ignores an empty add request', async () => {
    const { id } = await call('create-playlist', { name: 'Empty' });

    await call('add-tracks-to-playlist', { playlistId: id, trackIds: [] });
    await call('add-tracks-to-playlist', { playlistId: id });

    expect(playlistTrackIds(id)).toEqual([]);
  });

  it('lists the playlists a track belongs to', async () => {
    const { id } = await call('create-playlist', { name: 'Has' });
    const trackId = seedTrack();
    await call('add-tracks-to-playlist', { playlistId: id, trackIds: [trackId] });

    expect((await call('get-playlists-for-track', trackId)).map((p) => p.id)).toEqual([id]);
  });

  it('appends a raw track row through add-track', async () => {
    const id = await call('add-track', {
      title: 'Raw',
      artist: 'A',
      file_path: audioFile('raw.mp3'),
      file_hash: 'raw-hash',
      format: 'mp3',
    });

    expect(trackRow(id).title).toBe('Raw');
  });
});

describe('folder-tracked playlists', () => {
  function folderWith(trackNames) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-folder-'));
    for (const name of trackNames) fs.writeFileSync(path.join(dir, name), 'audio');
    return dir;
  }

  it('refuses a folder that does not exist', async () => {
    const res = await call('create-folder-playlist', { folderPath: '/does/not/exist' });

    expect(res).toMatchObject({ ok: false, error: 'folder-missing' });
  });

  it('creates the playlist, links existing files and reports the sync', async () => {
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    const folder = folderWith(['a.mp3']);
    importManager.linkAudioFile.mockResolvedValue({ id: 11 });

    const res = await call('create-folder-playlist', { folderPath: folder, name: 'Mirror' });

    expect(res).toMatchObject({ ok: true, name: 'Mirror', found: 1, linked: 1 });
    expect((await call('get-playlist', res.playlistId)).folder_path).toBe(folder);
    expect(sentChannels(win)).toContain('folder-playlist-updated');
  });

  it('derives the name from the folder when none is given', async () => {
    const folder = folderWith([]);

    const res = await call('create-folder-playlist', { folderPath: folder });

    expect(res.name).toBe(path.basename(folder));
  });

  it('reports a duplicate playlist name', async () => {
    const folder = folderWith([]);
    await call('create-playlist', { name: 'Mirror' });

    const res = await call('create-folder-playlist', { folderPath: folder, name: 'Mirror' });

    expect(res).toMatchObject({ ok: false, error: 'duplicate-name' });
  });

  it('validates the target playlist and folder when attaching a folder', async () => {
    const { id } = await call('create-playlist', { name: 'Plain' });

    expect(
      await call('set-playlist-folder', { playlistId: 4242, folderPath: '/tmp' })
    ).toMatchObject({ ok: false, error: 'unknown-playlist' });
    expect(await call('set-playlist-folder', { playlistId: id })).toMatchObject({
      ok: false,
      error: 'no-folder',
    });
    expect(
      await call('set-playlist-folder', { playlistId: id, folderPath: '/does/not/exist' })
    ).toMatchObject({ ok: false, error: 'missing-folder' });
  });

  it('attaches a folder to an existing playlist and syncs it', async () => {
    const folder = folderWith(['b.mp3']);
    const { id } = await call('create-playlist', { name: 'Later' });

    const res = await call('set-playlist-folder', { playlistId: id, folderPath: folder });

    expect(res).toMatchObject({ ok: true, folder, found: 1 });
    expect((await call('get-playlist', id)).folder_recursive).toBe(0);
  });

  it('only flips recursion for playlists that already track a folder', async () => {
    const { id } = await call('create-playlist', { name: 'Plain' });

    expect(
      await call('set-folder-playlist-recursive', { playlistId: id, recursive: true })
    ).toMatchObject({
      ok: false,
      code: 'not-a-folder-playlist',
      playlistId: id,
      error: 'not-a-folder-playlist',
    });

    const folder = folderWith([]);
    await call('set-playlist-folder', { playlistId: id, folderPath: folder });
    expect(
      (await call('set-folder-playlist-recursive', { playlistId: id, recursive: true })).ok
    ).toBe(true);
    expect((await call('get-playlist', id)).folder_recursive).toBe(1);
  });

  it('removes selected tracks from a mirror and stays quiet for an empty request', async () => {
    const win = attachRenderer();
    const { id } = await call('create-playlist', { name: 'Set' });
    const tracks = [seedTrack(), seedTrack()];
    await call('add-tracks-to-playlist', { playlistId: id, trackIds: tracks });

    expect(
      await call('remove-folder-playlist-tracks', { playlistId: id, trackIds: tracks })
    ).toEqual({ ok: true, playlistId: id, removed: 2 });
    expect(playlistTrackIds(id)).toEqual([]);

    win.webContents.send.mockClear();
    expect(await call('remove-folder-playlist-tracks', { playlistId: id })).toMatchObject({
      removed: 0,
    });
    expect(sentChannels(win)).not.toContain('library-updated');
  });

  it('stops tracking the folder without deleting the playlist', async () => {
    const folder = folderWith([]);
    const { playlistId: id } = await call('create-folder-playlist', {
      folderPath: folder,
      name: 'Stop me',
    });

    expect(await call('stop-folder-playlist', id)).toEqual({ ok: true, playlistId: id });
    expect((await call('get-playlist', id)).folder_path).toBe(null);
  });

  it('refreshes one mirror and then all mirrors', async () => {
    const folder = folderWith(['c.mp3']);
    const { playlistId: id } = await call('create-folder-playlist', {
      folderPath: folder,
      name: 'All',
    });

    expect((await call('refresh-folder-playlist', id)).ok).toBe(true);

    const all = await call('refresh-folder-playlists');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ ok: true, playlistId: id });
  });

  it('reports a mirror whose folder disappeared', async () => {
    const folder = folderWith([]);
    const { playlistId: id } = await call('create-folder-playlist', {
      folderPath: folder,
      name: 'Gone',
    });
    fs.rmSync(folder, { recursive: true, force: true });

    expect(await call('refresh-folder-playlist', id)).toMatchObject({
      ok: false,
      error: 'folder-missing',
    });
  });

  it('answers not-a-folder-playlist for a plain playlist refresh', async () => {
    const { id } = await call('create-playlist', { name: 'Plain' });

    expect(await call('refresh-folder-playlist', id)).toMatchObject({
      ok: false,
      error: 'not-a-folder-playlist',
    });
  });
});

describe('libraries', () => {
  it('lists libraries with their effective root path', async () => {
    const lib = await call('create-library', { name: 'House' });

    const list = await call('list-libraries');

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: lib.id, name: 'House' });
    expect(list[0].effective_root_path).toEqual(expect.any(String));
  });

  it('reports free space and disk usage per library', async () => {
    const lib = await call('create-library', { name: 'Space' });

    const withSpace = await call('list-libraries-with-free-space');
    expect(withSpace[0]).toHaveProperty('free_bytes');

    expect(await call('get-library-size', lib.id)).toEqual(expect.any(Number));
  });

  it('switches the import target library', async () => {
    const first = await call('create-library', { name: 'One' });
    const second = await call('create-library', { name: 'Two' });

    await call('set-current-library-id', second.id);

    expect(await call('get-current-library-id')).toBe(second.id);
    expect(await call('get-library-path')).toBe(
      (await call('list-libraries')).find((l) => l.id === second.id).effective_root_path
    );
    expect(await call('get-library-path', first.id)).toEqual(expect.any(String));
  });

  it('renames a library', async () => {
    const lib = await call('create-library', { name: 'Old' });

    await call('rename-library', lib.id, 'New');

    expect((await call('list-libraries'))[0].name).toBe('New');
  });

  it('exposes and converts the storage format', async () => {
    const importManager = await import('../audio/importManager.js');
    const lib = await call('create-library', { name: 'Fmt' });

    expect(await call('get-library-storage-format', lib.id)).toBe('hashed');

    await call('convert-storage-format', lib.id, 'flat');
    expect(importManager.convertStorageFormat).toHaveBeenCalledWith(lib.id, 'flat');
  });
});

describe('database location', () => {
  it('reports the database path and its size', async () => {
    const dbPath = await call('get-db-path');

    expect(dbPath).toEqual(expect.any(String));
    expect(await call('get-db-size')).toBeGreaterThanOrEqual(0);
  });

  it('reports a zero size when the file is not there yet', async () => {
    fs.rmSync(await call('get-db-path'), { force: true });

    expect(await call('get-db-size')).toBe(0);
  });

  it('refuses to "move" the database onto itself', async () => {
    const dbPath = await call('get-db-path');

    expect(await call('move-database', path.dirname(dbPath))).toMatchObject({
      ok: false,
      code: 'same-location',
      message: 'Same location selected.',
    });
  });
});

describe('move-library', () => {
  function libraryWithTrack() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-lib-old-'));
    const libId = createLibraryId('Movable', root);
    const file = path.join(root, 'shard-0', 'song.mp3');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'audio');
    const trackId = seedTrack({ file_path: file, library_id: libId });
    return { root, libId, file, trackId };
  }

  it('moves the files, rewrites the paths and reports progress', async () => {
    const win = attachRenderer();
    const { root, libId, file, trackId } = libraryWithTrack();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-lib-new-'));

    const res = await call('move-library', target, libId);

    expect(res).toEqual({ moved: 1, total: 1 });
    const newPath = path.join(target, 'shard-0', 'song.mp3');
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(trackRow(trackId).file_path).toBe(newPath);
    expect(db.prepare('SELECT root_path FROM libraries WHERE id = ?').get(libId).root_path).toBe(
      target
    );
    expect(sent(win, 'move-library-progress')).toEqual([{ moved: 1, total: 1, pct: 100 }]);
    expect(sent(win, 'track-updated')).toEqual([
      { trackId, analysis: { file_path: newPath, analyzed: 1 } },
    ]);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('creates the destination when it does not exist yet', async () => {
    attachRenderer();
    const { libId } = libraryWithTrack();
    const target = path.join(os.tmpdir(), `djman-lib-created-${Date.now()}`);

    await call('move-library', target, libId);

    expect(fs.existsSync(target)).toBe(true);
  });

  it('counts tracks whose file vanished, without failing', async () => {
    attachRenderer();
    const { libId } = libraryWithTrack();
    seedTrack({ file_path: path.join(os.tmpdir(), 'djman-vanished.mp3'), library_id: libId });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-lib-new-'));

    expect(await call('move-library', target, libId)).toEqual({ moved: 2, total: 2 });
  });

  it('rejects the current directory', async () => {
    const { root, libId } = libraryWithTrack();

    expect(await call('move-library', root, libId)).toMatchObject({
      ok: false,
      code: 'same-directory',
      message: 'Same directory selected.',
    });
  });
});

describe('normalization', () => {
  it('normalizes the library and reports the totals', async () => {
    const win = attachRenderer();
    seedTrack({ loudness: -14 });

    const res = await call('normalize-library');

    expect(res).toMatchObject({ skipped: 0 });
    expect(typeof res.normalized).toBe('number');
    expect(sentChannels(win)).toContain('normalize-progress');
  });

  it('resets normalization for explicit ids and for the whole library', async () => {
    const win = attachRenderer();
    const id = seedTrack({ loudness: -14 });
    db.prepare('UPDATE tracks SET replay_gain = 1.5 WHERE id = ?').run(id);

    expect(await call('reset-normalization', { trackIds: [id] })).toEqual({ updated: 1 });
    expect(sent(win, 'track-updated')).toEqual([{ trackId: id, analysis: { replay_gain: null } }]);

    win.webContents.send.mockClear();
    expect(await call('reset-normalization', {})).toMatchObject({ updated: expect.any(Number) });
  });

  it('normalizes a selection and reports how many were skipped', async () => {
    attachRenderer();
    const a = seedTrack({ loudness: -14 });
    const b = seedTrack({ loudness: -14 });

    const res = await call('normalize-tracks-audio', { trackIds: [a, b] });

    expect(res.normalized + res.skipped).toBe(2);
    expect(await call('get-normalized-count')).toEqual(expect.any(Number));
  });
});

describe('file dialogs', () => {
  it('returns the picked audio files', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/a.mp3'] });

    expect(await call('select-audio-files')).toEqual(['/a.mp3']);
  });

  it('returns an empty selection when the dialog is cancelled', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    expect(await call('select-audio-files')).toEqual([]);
  });

  it('returns the picked directory or null', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/music'] });
    expect(await call('open-dir-dialog')).toBe('/music');

    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await call('open-dir-dialog')).toBe(null);
  });
});

describe('import-audio-files', () => {
  it('imports every file and reports progress', async () => {
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    importManager.importAudioFile
      .mockResolvedValueOnce(101)
      .mockRejectedValueOnce(new Error('unsupported'));

    const ids = await call('import-audio-files', ['/a.mp3', '/b.wav'], null, 3);

    expect(ids).toEqual([101]);
    expect(importManager.importAudioFile).toHaveBeenCalledWith('/a.mp3', {}, 3);
    expect(sent(win, 'import-progress')).toEqual([
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
    expect(sentChannels(win)).toContain('library-updated');
  });

  it('adds the imported tracks to the requested playlist', async () => {
    const importManager = await import('../audio/importManager.js');
    const { id } = await call('create-playlist', { name: 'Target' });
    const win = attachRenderer();
    const imported = seedTrack();
    importManager.importAudioFile.mockResolvedValueOnce(imported);

    await call('import-audio-files', ['/a.mp3'], id);

    expect(playlistTrackIds(id)).toEqual([imported]);
    expect(sentChannels(win)).toContain('playlists-updated');
  });

  it('stays quiet when nothing was imported', async () => {
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    importManager.importAudioFile.mockRejectedValue(new Error('bad file'));

    expect(await call('import-audio-files', ['/x.mp3'])).toEqual([]);
    expect(sentChannels(win)).not.toContain('library-updated');
  });
});

describe('clearing data', () => {
  it('clears only the requested library and its audio folder', async () => {
    const win = attachRenderer();
    const lib = await call('create-library', { name: 'Wipe' });
    const audioBase = await call('get-library-path', lib.id);
    fs.mkdirSync(audioBase, { recursive: true });
    fs.writeFileSync(path.join(audioBase, 'f.mp3'), 'audio');
    seedTrack({ library_id: lib.id });
    const keep = seedTrack();

    await call('clear-library', lib.id);

    expect(fs.existsSync(audioBase)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n).toBe(1);
    expect(trackRow(keep)).toBeDefined();
    expect(sentChannels(win)).toEqual(
      expect.arrayContaining(['library-updated', 'playlists-updated'])
    );
  });
});

describe('renderer-log', () => {
  it('forwards renderer lines at the right console level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listener = h.listeners.get('renderer-log');

    listener({}, { level: 'error', msg: 'boom' });
    listener({}, { level: 'warn', msg: 'careful' });
    listener({}, { level: 'info', msg: 'hello' });

    expect(error).toHaveBeenCalledWith('[renderer] boom');
    expect(warn).toHaveBeenCalledWith('[renderer] careful');
    expect(log).toHaveBeenCalledWith('[renderer] hello');

    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  });
});

describe('dependency updates', () => {
  it('streams analyser update progress and clears it afterwards', async () => {
    const deps = await import('../deps.js');
    const win = attachRenderer();
    deps.updateAnalyzer.mockImplementationOnce(async (onProgress) => onProgress('downloading', 40));

    await call('update-analyzer');

    expect(sent(win, 'deps-progress')).toEqual([{ msg: 'downloading', pct: 40 }, null]);
  });

  it('passes the requested yt-dlp tag through', async () => {
    const deps = await import('../deps.js');
    attachRenderer();

    await call('update-yt-dlp', '2024.01.01');

    expect(deps.updateYtDlp).toHaveBeenCalledWith(expect.any(Function), '2024.01.01');
  });

  it('updates every dependency', async () => {
    const deps = await import('../deps.js');
    const win = attachRenderer();

    await call('update-all-deps');

    expect(deps.updateAll).toHaveBeenCalled();
    expect(sent(win, 'deps-progress').at(-1)).toBe(null);
  });

  it('reports a failed tidal-dl-ng update instead of throwing', async () => {
    const deps = await import('../deps.js');
    const win = attachRenderer();
    deps.updateTidalDlNg.mockRejectedValueOnce(new Error('network down'));

    expect(await call('update-tidal-dl-ng')).toMatchObject({
      ok: false,
      code: 'failed',
      error: 'network down',
    });
    expect(sent(win, 'deps-progress').at(-1)).toBe(null);
  });

  it('reports the successful tidal-dl-ng update', async () => {
    attachRenderer();

    expect(await call('update-tidal-dl-ng')).toEqual({ ok: true });
  });

  it('exposes versions, update checks and the log folder action', async () => {
    await call('open-log-dir');

    expect(shell.openPath).toHaveBeenCalledWith(await call('get-log-dir'));
    expect(await call('get-dep-versions')).toBeTruthy();
    expect(await call('check-dep-updates')).toBeTruthy();
  });
});

describe('auto-tagging', () => {
  it('merges every provider that answered and ignores failures', async () => {
    const tagger = await import('../audio/autoTagger.js');
    tagger.searchMusicBrainz.mockResolvedValueOnce([{ from: 'mb' }]);
    tagger.searchDiscogs.mockRejectedValueOnce(new Error('rate limited'));
    tagger.searchItunes.mockResolvedValueOnce([{ from: 'itunes' }]);
    tagger.searchDeezer.mockResolvedValueOnce([{ from: 'deezer' }]);

    const res = await call('auto-tag-search', { query: 'daft punk' });

    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.from)).toEqual(['mb', 'itunes', 'deezer']);
  });
});

describe('fetch-artwork-url', () => {
  function stubFetch(response) {
    globalThis.fetch = vi.fn(async () => response);
  }

  afterEach(() => {
    delete globalThis.fetch;
  });

  it('stores a PNG cover next to the library artwork', async () => {
    const trackId = seedTrack();
    stubFetch({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    const res = await call('fetch-artwork-url', { trackId, url: 'https://example.test/a.png' });

    expect(res.ok).toBe(true);
    expect(res.artwork_path.endsWith('.png')).toBe(true);
    expect(fs.existsSync(res.artwork_path)).toBe(true);
    expect(trackRow(trackId).has_artwork).toBe(1);
  });

  it('falls back to the JPEG extension for other content types', async () => {
    const trackId = seedTrack();
    stubFetch({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });

    const res = await call('fetch-artwork-url', { trackId, url: 'https://example.test/a.jpg' });

    expect(res.artwork_path.endsWith('.jpg')).toBe(true);
  });

  it('reports an HTTP failure without touching the track', async () => {
    const trackId = seedTrack();
    stubFetch({ ok: false, status: 404, headers: { get: () => '' } });

    const res = await call('fetch-artwork-url', { trackId, url: 'https://example.test/missing' });

    expect(res).toMatchObject({ ok: false, code: 'failed', error: 'HTTP 404' });
    expect(trackRow(trackId).has_artwork).toBeFalsy();
  });
});

describe('yt-dlp playlist info', () => {
  it('streams entry checks to the renderer and returns the info', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    const win = attachRenderer();
    await call('set-setting', 'ytdlp_cookies_browser', 'firefox');
    yt.fetchPlaylistInfo.mockImplementationOnce(async (url, options) => {
      expect(options.cookiesBrowser).toBe('firefox');
      options.onBeforeCheck([{ id: 'v1' }]);
      options.onCheckProgress({ checked: 1, total: 1 });
      options.onEntryChecked({ id: 'v1', available: true });
      return { type: 'playlist', entries: [{ id: 'v1' }] };
    });

    const res = await call('ytdlp-fetch-info', 'https://youtu.be/list');

    expect(res).toMatchObject({ ok: true, type: 'playlist' });
    expect(sent(win, 'ytdlp-entries-ready')).toEqual([[{ id: 'v1' }]]);
    expect(sent(win, 'ytdlp-entry-checked')).toEqual([{ id: 'v1', available: true }]);
    expect(sent(win, 'ytdlp-check-progress').at(-1)).toBe(null);
  });

  it('reports a failed info fetch', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    const win = attachRenderer();
    yt.fetchPlaylistInfo.mockRejectedValueOnce(new Error('private video'));

    expect(await call('ytdlp-fetch-info', 'https://youtu.be/x')).toEqual({
      ok: false,
      error: 'private video',
    });
    expect(sent(win, 'ytdlp-check-progress').at(-1)).toBe(null);
  });
});

describe('yt-dlp download', () => {
  function fakeDownload(behaviour) {
    return async (url, onProgress, options) => behaviour(url, onProgress, options);
  }

  it('imports files as they land, reports per-track status and returns the ids', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    const imported = seedTrack();
    importManager.importAudioFile.mockResolvedValueOnce(imported);
    yt.downloadUrl.mockImplementationOnce(
      fakeDownload(async (url, onProgress, options) => {
        onProgress({ pct: 10, overallCurrent: 1, overallTotal: 1 });
        options.onTrackMeta({ index: 0, title: 'Song' });
        options.onFileReady({
          filePath: '/tmp/dl.mp3',
          originalUrl: url,
          trackUrl: url,
          platform: 'youtube',
          quality: 'best',
          title: 'Song',
          channel: 'Chan',
          index: 0,
        });
        return { files: [{ filePath: '/tmp/dl.mp3', originalUrl: url, trackUrl: url }] };
      })
    );

    const res = await call('ytdlp-download-url', {
      url: 'https://youtu.be/x',
      newPlaylistName: 'YouTube set',
    });

    expect(res).toMatchObject({ ok: true, trackIds: [imported] });
    expect(res.playlistId).toBeGreaterThan(0);
    const statuses = sent(win, 'ytdlp-track-update').map((u) => u.status);
    expect(statuses).toContain('importing');
    expect(statuses).toContain('done');
    expect(importManager.importAudioFile).toHaveBeenCalledWith(
      '/tmp/dl.mp3',
      expect.objectContaining({ source_url: 'https://youtu.be/x', source_platform: 'youtube' })
    );
  });

  it('imports files the downloader reported but never handed over', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    const importManager = await import('../audio/importManager.js');
    attachRenderer();
    const imported = seedTrack();
    importManager.importAudioFile.mockResolvedValueOnce(imported);
    yt.downloadUrl.mockResolvedValueOnce({
      files: [{ filePath: '/tmp/fallback.mp3', originalUrl: 'u', trackUrl: 'u' }],
    });

    const res = await call('ytdlp-download-url', { url: 'u', existingPlaylistId: 7 });

    expect(res).toMatchObject({ ok: true, trackIds: [imported], playlistId: 7 });
  });

  it('creates a playlist after the fact when several tracks came back', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    const first = seedTrack();
    const second = seedTrack();
    importManager.importAudioFile.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    yt.downloadUrl.mockResolvedValueOnce({
      files: [
        { filePath: '/tmp/1.mp3', originalUrl: 'u1', trackUrl: 'u1' },
        { filePath: '/tmp/2.mp3', originalUrl: 'u2', trackUrl: 'u2' },
      ],
      playlistName: 'Detected',
    });

    const res = await call('ytdlp-download-url', { url: 'u' });

    expect(res.trackIds).toEqual([first, second]);
    expect(res.playlistId).toBeGreaterThan(0);
    expect(playlistTrackIds(res.playlistId)).toEqual([first, second]);
    expect(sentChannels(win)).toContain('playlists-updated');
  });

  it('reports a download failure and clears the progress bar', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    const win = attachRenderer();
    yt.downloadUrl.mockRejectedValueOnce(new Error('signature error'));

    expect(await call('ytdlp-download-url', { url: 'u' })).toEqual({
      ok: false,
      error: 'signature error',
    });
    expect(sent(win, 'ytdlp-progress').at(-1)).toBe(null);
  });

  it('answers duplicate-url and playlist-source queries from the library', async () => {
    const trackId = seedTrack({ source_url: 'https://youtu.be/dup' });
    const { id: playlistId } = await call('create-playlist', { name: 'Src' });
    await call('add-tracks-to-playlist', { playlistId, trackIds: [trackId] });

    expect(await call('check-duplicate-urls', [{ url: 'https://youtu.be/dup' }])).toEqual([
      expect.objectContaining({ url: 'https://youtu.be/dup', trackId }),
    ]);
    expect(await call('get-playlist-source-urls', playlistId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ trackId })])
    );
  });
});

describe('cloud search', () => {
  it('rejects an empty query', async () => {
    expect(await call('cloud-search', { source: 'youtube', query: '  ' })).toEqual({
      ok: false,
      error: 'Empty query',
    });
  });

  it('searches YouTube', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    yt.searchYouTube.mockResolvedValueOnce([{ id: 'v1' }]);

    expect(await call('cloud-search', { source: 'youtube', query: 'x', limit: 5 })).toEqual({
      ok: true,
      results: [{ id: 'v1' }],
    });
  });

  it('normalises TIDAL results onto the shared result shape', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    tidal.searchTidal.mockResolvedValueOnce({
      ok: true,
      results: [
        {
          type: 'track',
          id: 9,
          title: 'T',
          artist: 'A',
          album: 'Al',
          duration: 200,
          numTracks: 1,
          quality: 'LOSSLESS',
          url: 'https://tidal.com/track/9',
        },
      ],
    });

    const res = await call('cloud-search', { source: 'tidal', query: 'y', types: ['track'] });

    expect(res.ok).toBe(true);
    expect(res.results[0]).toEqual({
      source: 'tidal',
      type: 'track',
      id: 9,
      title: 'T',
      artist: 'A',
      album: 'Al',
      durationSec: 200,
      numTracks: 1,
      quality: 'LOSSLESS',
      url: 'https://tidal.com/track/9',
    });
  });

  it('passes a failed TIDAL search through untouched', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    tidal.searchTidal.mockResolvedValueOnce({ ok: false, error: 'not logged in' });

    expect(await call('cloud-search', { source: 'tidal', query: 'y' })).toEqual({
      ok: false,
      error: 'not logged in',
    });
  });

  it('rejects an unknown source', async () => {
    expect(await call('cloud-search', { source: 'napster', query: 'z' })).toEqual({
      ok: false,
      error: 'Unknown source: napster',
    });
  });

  it('reports a provider crash instead of throwing', async () => {
    const yt = await import('../audio/ytDlpManager.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    yt.searchYouTube.mockRejectedValueOnce(new Error('rate limited'));

    expect(await call('cloud-search', { source: 'youtube', query: 'x' })).toEqual({
      ok: false,
      error: 'rate limited',
    });
    errorSpy.mockRestore();
  });
});

describe('cloud search preview', () => {
  it('needs a result URL', async () => {
    expect(await call('cloud-search-preview', { source: 'tidal' })).toEqual({
      ok: false,
      error: 'Missing result URL',
    });
  });

  it('registers a YouTube preview stream and returns its local URL', async () => {
    const url = 'https://www.youtube.com/watch?v=abc';

    const res = await call('cloud-search-preview', { source: 'youtube', url });

    expect(res.ok).toBe(true);
    expect(res.url).toMatch(/^http:\/\/127\.0\.0\.1:.*\/djman-yt-preview\/[\w-]+$/);
  });

  it('only previews TIDAL track results inline', async () => {
    expect(
      await call('cloud-search-preview', { source: 'tidal', type: 'album', url: 'u' })
    ).toEqual({
      ok: false,
      error: 'Inline preview is only available for TIDAL track results',
    });
  });

  it('returns the TIDAL preview URL for a track', async () => {
    const res = await call('cloud-search-preview', {
      source: 'tidal',
      type: 'track',
      url: 'https://tidal.com/track/1',
    });

    expect(res).toEqual({ ok: true, url: 'http://127.0.0.1/tidal.mp3' });
  });

  it('rejects an unknown source', async () => {
    expect(await call('cloud-search-preview', { source: 'x', url: 'u' })).toEqual({
      ok: false,
      error: 'Unknown source: x',
    });
  });

  it('reports a preview failure', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tidal.getTidalPreviewUrl.mockRejectedValueOnce(new Error('no stream'));

    expect(
      await call('cloud-search-preview', { source: 'tidal', type: 'track', url: 'u' })
    ).toEqual({ ok: false, error: 'no stream' });
    errorSpy.mockRestore();
  });
});

describe('TIDAL', () => {
  it('reports setup state', async () => {
    const tidal = await import('../audio/tidalDlManager.js');

    expect(await call('tidal-check')).toEqual(await tidal.checkTidalSetup());
  });

  it('streams install progress and reports failure', async () => {
    const deps = await import('../deps.js');
    const win = attachRenderer();
    deps.ensureTidalDlNg
      .mockImplementationOnce(async (onLine) => onLine('fetching release'))
      .mockRejectedValueOnce(new Error('no network'));

    expect(await call('tidal-install')).toEqual({ ok: true });
    expect(sent(win, 'tidal-install-progress')).toEqual([{ msg: 'fetching release' }]);

    expect(await call('tidal-install')).toEqual({ ok: false, error: 'no network' });
  });

  it('returns fetched info and reports errors', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tidal.fetchTidalInfo
      .mockResolvedValueOnce({ type: 'track', entries: [{}] })
      .mockRejectedValueOnce(new Error('bad url'));

    expect(await call('tidal-fetch-info', 'https://tidal.com/track/1')).toMatchObject({
      type: 'track',
    });
    expect(await call('tidal-fetch-info', 'nope')).toEqual({ ok: false, error: 'bad url' });
    errorSpy.mockRestore();
  });

  it('forwards the login URL to the renderer', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    const win = attachRenderer();
    tidal.startLogin.mockImplementationOnce(async (onUrl) => onUrl('https://login.tidal'));

    expect(await call('tidal-login')).toEqual({ ok: true });
    expect(sent(win, 'tidal-login-url')).toEqual(['https://login.tidal']);
  });

  it('reports a failed login', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    tidal.startLogin.mockRejectedValueOnce(new Error('timeout'));

    expect(await call('tidal-login')).toEqual({ ok: false, error: 'timeout' });
  });

  it('lists account collections and survives a crash', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tidal.fetchTidalCollections
      .mockResolvedValueOnce({ ok: true, collections: [{ id: 1 }] })
      .mockRejectedValueOnce(new Error('not logged in'));

    expect(await call('tidal-list-collections')).toEqual({ ok: true, collections: [{ id: 1 }] });
    expect(await call('tidal-list-collections')).toEqual({
      ok: false,
      error: 'not logged in',
      collections: [],
      warnings: [],
    });
    errorSpy.mockRestore();
  });

  it('resolves collection entries without downloading', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await call('tidal-collection-tracks', {})).toEqual({
      ok: false,
      error: 'Missing collection type or id',
      entries: [],
    });

    tidal.fetchTidalCollectionTracks.mockResolvedValueOnce({
      ok: true,
      title: 'Mix',
      type: 'playlist',
      total: 2,
      entries: [{ mediaType: 'track' }, { mediaType: 'video' }],
    });

    expect(await call('tidal-collection-tracks', { type: 'playlist', id: 5 })).toMatchObject({
      ok: true,
      title: 'Mix',
      videoCount: 1,
      truncated: false,
    });

    tidal.fetchTidalCollectionTracks.mockResolvedValueOnce({ ok: false, error: 'gone' });
    expect(await call('tidal-collection-tracks', { type: 'playlist', id: 6 })).toMatchObject({
      ok: false,
      entries: [],
    });

    tidal.fetchTidalCollectionTracks.mockRejectedValueOnce(new Error('crash'));
    expect(await call('tidal-collection-tracks', { type: 'playlist', id: 7 })).toEqual({
      ok: false,
      error: 'crash',
      entries: [],
    });
    errorSpy.mockRestore();
  });

  it('downloads a single URL, importing each reported file', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    const imported = seedTrack();
    importManager.importAudioFile.mockResolvedValueOnce(imported);
    tidal.downloadTidal.mockImplementationOnce(async (urls, dir, progress, { onFileReady }) => {
      progress('downloading');
      await onFileReady('/tmp/a.flac');
      return ['/tmp/a.flac'];
    });

    const res = await call('tidal-download-url', { url: 'https://tidal.com/track/1' });

    expect(res).toMatchObject({ ok: true, trackIds: [imported] });
    expect(sent(win, 'tidal-track-update').at(-1)).toMatchObject({ status: 'done' });
  });

  it('reports a download that produced no audio', async () => {
    const win = attachRenderer();

    const res = await call('tidal-download-url', { url: 'https://tidal.com/mix/1' });

    expect(res).toEqual({ ok: false, error: 'Download finished but no audio files were found.' });
    expect(sent(win, 'tidal-progress').at(-1)).toBe(null);
  });

  it('rejects a collection download without type or id', async () => {
    expect(await call('tidal-download-collection', {})).toEqual({
      ok: false,
      error: 'Missing collection type or id',
    });
  });

  it('explains that a collection holds only videos', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    tidal.fetchTidalCollectionTracks.mockResolvedValueOnce({
      ok: true,
      title: 'Clips',
      entries: [{ mediaType: 'video' }],
    });

    const res = await call('tidal-download-collection', { type: 'playlist', id: 3 });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only video items/);
    expect(res.videoCount).toBe(1);
  });

  it('downloads the selected entries of a collection', async () => {
    const tidal = await import('../audio/tidalDlManager.js');
    const importManager = await import('../audio/importManager.js');
    attachRenderer();
    const imported = seedTrack();
    importManager.importAudioFile.mockResolvedValueOnce(imported);
    tidal.downloadTidal.mockImplementationOnce(async (urls, dir, progress, { onFileReady }) => {
      await onFileReady('/tmp/c.flac');
      return ['/tmp/c.flac'];
    });

    const res = await call('tidal-download-collection', {
      type: 'playlist',
      id: 4,
      title: 'Set',
      selectedEntries: [
        { id: 11, title: 'One', artist: 'A', mediaType: 'track' },
        { id: 12, title: 'Clip', mediaType: 'video' },
      ],
    });

    expect(res).toMatchObject({ ok: true, trackIds: [imported], videoCount: 1 });
  });
});

describe('file explorer', () => {
  it('lists audio files and folders, skipping dot directories', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-browse-'));
    fs.mkdirSync(path.join(dir, 'Sub'));
    fs.mkdirSync(path.join(dir, '.hidden'));
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');

    const res = await call('browse-directory', dir);

    expect(res.dirs.map((d) => d.name)).toEqual(['Sub']);
    expect(res.files).toEqual([{ name: 'a.mp3', path: path.join(dir, 'a.mp3'), size: 1 }]);
  });

  it('reports a directory it cannot read', async () => {
    const res = await call('browse-directory', '/definitely/not/here');

    expect(res.dirs).toEqual([]);
    expect(res.files).toEqual([]);
    expect(res.error).toEqual(expect.any(String));
  });

  it('reads metadata for an explorer file through ffprobe', async () => {
    const ffmpeg = await import('../audio/ffmpeg.js');
    ffmpeg.ffprobe.mockResolvedValueOnce({
      format: {
        duration: '180.5',
        bit_rate: '320000',
        tags: {
          title: 'Probed',
          artist: 'A',
          album: 'Al',
          date: '1999-05-01',
          label: 'L',
          genre: 'House, Techno',
          bpm: '128',
          key: '8A',
        },
      },
      streams: [{ codec_type: 'audio', bit_rate: '320000' }],
    });

    const res = await call('get-explorer-track-metadata', '/music/x.mp3');

    expect(res).toMatchObject({
      title: 'Probed',
      year: 1999,
      genre: ['House', 'Techno'],
      bpm: 128,
      key_raw: '8A',
      duration: 180.5,
      bitrate: 320000,
    });
  });

  it('falls back to the filename when probing fails', async () => {
    const ffmpeg = await import('../audio/ffmpeg.js');
    ffmpeg.ffprobe.mockRejectedValueOnce(new Error('not audio'));

    const res = await call('get-explorer-track-metadata', '/music/broken.mp3');

    expect(res).toMatchObject({ title: 'broken', bpm: null, error: 'not audio' });
  });

  it('reports the filesystem root, home and drives', async () => {
    const res = await call('get-computer-root');

    expect(res.root).toBe(process.platform === 'win32' ? expect.any(String) : '/');
    expect(res.home).toEqual(expect.any(String));
    expect(Array.isArray(res.drives)).toBe(true);
  });

  it('resolves library rows for explorer paths', async () => {
    const id = seedTrack();
    const res = await call('get-tracks-by-paths', [trackRow(id).file_path]);

    expect(res.map((t) => t.id)).toEqual([id]);
  });

  it('walks a directory recursively and reports batches', async () => {
    const win = attachRenderer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-walk-'));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'one.mp3'), 'x');
    fs.writeFileSync(path.join(dir, 'nested', 'two.flac'), 'x');

    expect(await call('explorer-start-recursive', dir)).toEqual({ ok: true });

    await vi.waitFor(() => expect(sentChannels(win)).toContain('explorer-recursive-done'));
    const found = sent(win, 'explorer-recursive-batch')
      .flat()
      .map((f) => f.name);
    expect(found.sort()).toEqual(['one.mp3', 'two.flac']);
  });

  it('cancels an in-flight recursive walk without throwing', async () => {
    attachRenderer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-walk-cancel-'));
    fs.writeFileSync(path.join(dir, 'one.mp3'), 'x');

    await call('explorer-start-recursive', dir);

    await expect(call('explorer-cancel-recursive')).resolves.toEqual({ ok: true });
  });

  it('links individual files, optionally into a playlist', async () => {
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    const { id: playlistId } = await call('create-playlist', { name: 'Linked' });
    const trackId = seedTrack();
    importManager.linkAudioFile
      .mockResolvedValueOnce({ id: trackId, duplicate: false })
      .mockRejectedValueOnce(new Error('unreadable'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-link-'));

    const res = await call('link-audio-files', {
      filePaths: [path.join(dir, 'a.mp3'), path.join(dir, 'b.mp3')],
      playlistId,
    });

    expect(res[0]).toEqual({ id: trackId, duplicate: false });
    expect(res[1]).toMatchObject({ id: null, error: 'unreadable' });
    expect(playlistTrackIds(playlistId)).toEqual([trackId]);
    expect(sentChannels(win)).toContain('library-updated');
  });

  it('links a whole directory, honouring recursion', async () => {
    const importManager = await import('../audio/importManager.js');
    attachRenderer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-linkdir-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'b.mp3'), 'x');
    importManager.linkAudioFile.mockResolvedValue({ id: 1, duplicate: false });

    const flat = await call('link-directory', { dirPath: dir, recursive: false });
    expect(flat).toMatchObject({ ok: true, total: 1, linked: 1 });

    const deep = await call('link-directory', { dirPath: dir, recursive: true });
    expect(deep).toMatchObject({ ok: true, total: 2 });
  });

  it('remaps a single track path through the file dialog', async () => {
    const id = seedTrack();
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await call('remap-track', { trackId: id })).toMatchObject({ ok: false });

    const newPath = audioFile('remapped.mp3');
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [newPath] });
    expect(await call('remap-track', { trackId: id })).toEqual({ ok: true, newPath });
    expect(trackRow(id).file_path).toBe(newPath);
  });

  it('remaps a whole folder prefix', async () => {
    const oldDir = path.join(os.tmpdir(), 'djman-old-root');
    const id = seedTrack({ file_path: path.join(oldDir, 'a.mp3') });
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await call('remap-folder', { oldDir })).toMatchObject({ ok: false });

    const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-new-root-'));
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [newDir] });
    const res = await call('remap-folder', { oldDir });

    expect(res).toMatchObject({ ok: true, newDir });
    expect(trackRow(id).file_path).toBe(path.join(newDir, 'a.mp3'));
  });

  it('moves a track to another library and reports the result', async () => {
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    importManager.moveTrackToLibrary.mockResolvedValueOnce({ newPath: '/x/a.mp3' });

    expect(await call('move-track-to-library', { trackId: 1, targetLibraryId: 2 })).toEqual({
      newPath: '/x/a.mp3',
    });
    expect(sentChannels(win)).toContain('library-updated');
  });

  it('moves a batch, reporting progress and failures', async () => {
    const importManager = await import('../audio/importManager.js');
    const win = attachRenderer();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    importManager.moveTrackToLibrary
      .mockResolvedValueOnce({ newPath: '/x/a.mp3' })
      .mockRejectedValueOnce(new Error('disk full'));

    const res = await call('move-tracks-to-library', { trackIds: [1, 2], targetLibraryId: 3 });

    expect(res).toEqual({ moved: [{ trackId: 1, newPath: '/x/a.mp3' }], failed: [2] });
    expect(sent(win, 'move-tracks-to-library-progress').at(-1)).toEqual({
      completed: 2,
      total: 2,
      done: true,
    });
    errorSpy.mockRestore();
  });

  it('reports whether linked tracks are still reachable', async () => {
    const present = seedTrack({ is_linked: 1 });
    const missing = seedTrack({ is_linked: 1, file_path: '/nope/x.mp3' });
    const imported = seedTrack({ is_linked: 0, file_path: '/nope/y.mp3' });

    expect(await call('check-linked-track-status', [present, missing, imported, 999])).toEqual([
      { id: present, exists: true },
      { id: missing, exists: false },
      { id: imported, exists: true },
      { id: 999, exists: false },
    ]);
  });

  it('lists linked tracks', async () => {
    seedTrack({ is_linked: 1 });

    expect(await call('get-linked-tracks-basic')).toHaveLength(1);
  });
});

describe('USB formatting', () => {
  it('describes the stick filesystem', async () => {
    const res = await call('check-usb-format', '/media/stick');

    expect(res).toMatchObject({ fs: 'vfat' });
    expect(typeof res.fsLabel).toBe('string');
  });

  it('streams format progress and reports success', async () => {
    const usb = await import('../usb/generic/fs.js');
    const win = attachRenderer();
    usb.formatDrive.mockImplementationOnce(async (device, mountPoint, onProgress) => {
      onProgress('mkfs.vfat');
    });

    expect(
      await call('format-usb', { device: '/dev/sdb1', mountPoint: '/media/stick', confirm: true })
    ).toEqual({
      ok: true,
    });
    expect(sent(win, 'format-usb-progress')).toEqual([{ msg: 'mkfs.vfat' }, null]);
  });

  it('reports a failed format', async () => {
    const usb = await import('../usb/generic/fs.js');
    const win = attachRenderer();
    usb.formatDrive.mockRejectedValueOnce(new Error('device busy'));

    expect(
      await call('format-usb', { device: '/dev/sdb1', mountPoint: '/m', confirm: true })
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: 'device busy',
    });
    expect(sent(win, 'format-usb-progress').at(-1)).toBe(null);
  });
});

describe('USB export', () => {
  function usbRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'djman-usb-'));
  }

  function seedPlaylistWithTracks(count) {
    const playlist = call('create-playlist', { name: 'Export set' });
    return playlist.then(async ({ id }) => {
      const ids = [];
      for (let i = 0; i < count; i += 1) {
        const trackId = seedTrack();
        const row = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId);
        fs.writeFileSync(row.file_path, 'dummy audio');
        ids.push(trackId);
      }
      await call('add-tracks-to-playlist', { playlistId: id, trackIds: ids });
      return { playlistId: id, trackIds: ids };
    });
  }

  it('explorer export copies files and writes a PDB', async () => {
    const ffmpeg = await import('../audio/ffmpeg.js');
    const pdb = await import('../usb/pioneer/formats/pdb.js');
    const win = attachRenderer();
    const root = usbRoot();
    const source = audioFile('explorer.mp3');
    ffmpeg.ffprobe.mockResolvedValue({
      format: { duration: '120', tags: { title: 'Song', artist: 'Artist', bpm: '124' } },
      streams: [{ codec_type: 'audio', bit_rate: '320000' }],
    });

    const res = await call('export-explorer-to-usb', {
      filePaths: [source],
      usbRoot: root,
      playlistName: 'Explorer',
    });

    expect(res).toEqual({ ok: true, trackCount: 1, usbRoot: root });
    expect(fs.readdirSync(path.join(root, 'Contents'))).toEqual(['Artist - Song.mp3']);
    expect(pdb.writePdb).toHaveBeenCalledWith(
      expect.objectContaining({
        tracks: [expect.objectContaining({ title: 'Song', bpm: 124 })],
        playlists: [expect.objectContaining({ name: 'Explorer' })],
      }),
      expect.stringContaining('export.pdb')
    );
    expect(sent(win, 'export-explorer-progress').at(-1)).toBe(null);
  });

  it('explorer export reports a fatal error', async () => {
    const win = attachRenderer();

    const res = await call('export-explorer-to-usb', { filePaths: [], usbRoot: undefined });

    expect(res.ok).toBe(false);
    expect(sent(win, 'export-explorer-progress').at(-1)).toBe(null);
  });

  it('exports a playlist to the stick and records a manifest', async () => {
    const pdb = await import('../usb/pioneer/formats/pdb.js');
    const win = attachRenderer();
    const root = usbRoot();
    const { playlistId } = await seedPlaylistWithTracks(2);

    const res = await call('export-all', { usbRoot: root, playlistId });

    expect(res).toMatchObject({ ok: true, trackCount: 2, newTrackCount: 2, usbRoot: root });
    expect(fs.readdirSync(path.join(root, 'Contents'))).toHaveLength(2);
    expect(fs.existsSync(path.join(root, 'playlists', 'Export set.m3u'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'PIONEER', 'rekordbox', 'export-manifest.json'))).toBe(
      true
    );
    expect(pdb.writePdb).toHaveBeenCalled();
    expect(sent(win, 'export-all-progress').at(-1)).toBe(null);
  });

  it('exports every playlist when none is named', async () => {
    attachRenderer();
    const root = usbRoot();
    await seedPlaylistWithTracks(1);

    const res = await call('export-all', { usbRoot: root });

    expect(res.ok).toBe(true);
    expect(res.playlistCount).toBe(1);
  });

  it('reuses files already on the stick on a second export', async () => {
    attachRenderer();
    const root = usbRoot();
    const { playlistId } = await seedPlaylistWithTracks(1);
    await call('export-all', { usbRoot: root, playlistId });
    const copied = fs.readdirSync(path.join(root, 'Contents'));

    const again = await call('export-all', { usbRoot: root, playlistId });

    expect(again.ok).toBe(true);
    expect(fs.readdirSync(path.join(root, 'Contents'))).toEqual(copied);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'PIONEER', 'rekordbox', 'export-manifest.json'), 'utf8')
    );
    expect(manifest.tracks).toHaveLength(1);
  });

  it('re-encodes when normalization or a target format asks for it', async () => {
    const ffmpeg = await import('../audio/ffmpeg.js');
    const trim = await import('../audio/trackTrim.js');
    attachRenderer();
    const root = usbRoot();
    const { playlistId } = await seedPlaylistWithTracks(1);
    db.prepare('UPDATE tracks SET loudness = -14, trim_start_ms = 1000, trim_end_ms = 31000').run();
    trim.exportTrimRange.mockReturnValueOnce({ startMs: 1000, endMs: 31000 });
    ffmpeg.convertAudio.mockImplementationOnce(async (_src, dest) => {
      fs.writeFileSync(dest, 'converted');
    });

    const res = await call('export-all', { usbRoot: root, playlistId, useNormalized: true });

    expect(res.ok).toBe(true);
    expect(ffmpeg.convertAudio).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Contents'),
      expect.objectContaining({ gainDb: 5, trimStartSec: 1, trimEndSec: 31 })
    );
  });

  it('reports an export failure', async () => {
    const win = attachRenderer();

    const res = await call('export-all', { usbRoot: undefined });

    expect(res.ok).toBe(false);
    expect(sent(win, 'export-all-progress').at(-1)).toBe(null);
  });
});

describe('USB cue import', () => {
  function stickWithManifest(trackId) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-cueusb-'));
    const dir = path.join(root, 'PIONEER', 'rekordbox');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'export-manifest.json'),
      JSON.stringify({
        version: 1,
        tracks: [{ id: trackId, file_path: 'Contents/a.mp3' }],
        playlists: [],
      })
    );
    return root;
  }

  it('scans cues written by hardware', async () => {
    const reader = await import('../usb/pioneer/formats/cues.js');
    const trackId = seedTrack();
    reader.readTrackCues.mockReturnValue([
      { positionMs: 1000, label: 'A', color: '#ffffff', hotCueIndex: 0 },
    ]);

    const res = await call('scan-usb-cues', { usbRoot: stickWithManifest(trackId) });

    expect(res.ok).toBe(true);
    expect(res.summary).toMatchObject({ tracks: 1, cues: 1, add: 1 });
  });

  it('returns an empty summary for a stick without cues', async () => {
    const res = await call('scan-usb-cues', {
      usbRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')),
    });

    expect(res.summary).toEqual({ tracks: 0, cues: 0, add: 0, update: 0, skip: 0, remove: 0 });
  });

  it('imports the scanned cues into the library', async () => {
    const reader = await import('../usb/pioneer/formats/cues.js');
    const win = attachRenderer();
    const trackId = seedTrack();
    reader.readTrackCues.mockReturnValue([
      { positionMs: 1500, label: 'Drop', color: '#ff0000', hotCueIndex: 1 },
    ]);

    const res = await call('import-usb-cues', { usbRoot: stickWithManifest(trackId) });

    expect(res).toMatchObject({ ok: true, added: 1, updated: 0, removed: 0 });
    expect((await call('get-cue-points', trackId))[0]).toMatchObject({ label: 'Drop' });
    expect(sentChannels(win)).toContain('cue-points-updated');
  });

  it('reports a scan failure instead of throwing', async () => {
    const reader = await import('../usb/pioneer/formats/cues.js');
    reader.readTrackCues.mockImplementationOnce(() => {
      throw new Error('corrupt ANLZ');
    });
    const trackId = seedTrack();

    expect(await call('scan-usb-cues', { usbRoot: stickWithManifest(trackId) })).toMatchObject({
      ok: false,
      code: 'failed',
      error: 'corrupt ANLZ',
    });
  });

  it('reports an import failure instead of throwing', async () => {
    const reader = await import('../usb/pioneer/formats/cues.js');
    reader.readTrackCues.mockImplementationOnce(() => {
      throw new Error('corrupt ANLZ');
    });
    const trackId = seedTrack();

    expect(await call('import-usb-cues', { usbRoot: stickWithManifest(trackId) })).toMatchObject({
      ok: false,
      code: 'failed',
      error: 'corrupt ANLZ',
    });
  });
});

describe('application lifecycle', () => {
  function fireAppEvent(name, ...args) {
    const listeners = h.appEvents.get(name) ?? [];
    for (const listener of listeners) listener(...args);
  }

  function seedDefaultLibrary() {
    return createLibraryId('Default');
  }

  it('boots the app: database, media server, window and menu', async () => {
    seedDefaultLibrary();

    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBe(1));

    const window = h.windowInstances[0];
    expect(window.options.title).toBe('DjManager - RWTechWorks.pl');
    expect(window.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(bridge.getRuntime().mainWindow).toBe(window);
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(h.appEvents.get('activate')).toHaveLength(1);
  });

  it('skips dependency downloads when --no-deps-bootstrap is passed', async () => {
    const deps = await import('../deps.js');
    seedDefaultLibrary();
    process.argv.push('--no-deps-bootstrap');

    try {
      fireAppEvent('ready');
      await vi.waitFor(() => expect(h.windowInstances.length).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(deps.ensureDeps).not.toHaveBeenCalled();
    } finally {
      process.argv.splice(process.argv.indexOf('--no-deps-bootstrap'), 1);
    }
  });

  it('sets the normalization target once, when it is missing', async () => {
    seedDefaultLibrary();

    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBeGreaterThan(0));

    expect(await call('get-setting', 'normalize_target_lufs')).toBe('-9');
  });

  it('downloads missing deps in the background and then wires the watchers', async () => {
    const deps = await import('../deps.js');
    const watcher = await import('../library/libraryWatcher.js');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-boot-'));
    createdDirs.push(folder);
    seedDefaultLibrary();
    await call('set-setting', 'watch_folders', JSON.stringify([folder]));
    await call('set-setting', 'watch_enabled', 'true');

    fireAppEvent('ready');
    await vi.waitFor(() => expect(deps.ensureDeps).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(
        watcher.createLibraryWatcher.mock.calls.some(([options]) =>
          options.folders.includes(folder)
        )
      ).toBe(true)
    );
  });

  it('logs a deps failure instead of crashing the boot', async () => {
    const deps = await import('../deps.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedDefaultLibrary();
    deps.ensureDeps.mockRejectedValueOnce(new Error('no network'));

    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBe(1));
    const win = h.windowInstances[0];

    await vi.waitFor(() =>
      expect(sent(win, 'deps-progress').at(-1)).toMatchObject({ error: 'no network' })
    );
    expect(errorSpy).toHaveBeenCalledWith('[deps] Failed to download FFmpeg:', 'no network');
    errorSpy.mockRestore();
  });

  it('quits when the last window closes outside macOS', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    fireAppEvent('window-all-closed');

    expect(app.quit).toHaveBeenCalled();
    log.mockRestore();
  });

  it('closes the folder watcher on quit', async () => {
    const watcher = await import('../library/libraryWatcher.js');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-quit-'));
    const close = vi.fn();
    watcher.createLibraryWatcher.mockReturnValueOnce({ close });
    await call('set-setting', 'watch_enabled', 'true');
    await call('set-setting', 'watch_folders', JSON.stringify([folder]));

    fireAppEvent('will-quit');

    expect(close).toHaveBeenCalled();
  });

  it('records GPU crashes in graphics.json and writes a report', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const statePath = path.join(userDataDir, 'graphics.json');
    const reportPath = path.join(userDataDir, 'graphics-crash-report.json');

    fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });

    await vi.waitFor(() => expect(fs.existsSync(statePath)).toBe(true));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.crashes).toHaveLength(1);
    expect(state.crashes[0]).toMatchObject({ type: 'GPU', reason: 'crashed', exitCode: 139 });

    await vi.waitFor(() => expect(fs.existsSync(reportPath)).toBe(true));
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.summary.count).toBe(1);
    expect(report.stackTraceAvailable).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('records a renderer crash, which never reaches child-process-gone', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const statePath = path.join(userDataDir, 'graphics.json');

    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBeGreaterThan(0));
    const window = h.windowInstances.at(-1);

    window.webContents.events['render-process-gone']({}, { reason: 'crashed', exitCode: 139 });

    await vi.waitFor(() => expect(fs.existsSync(statePath)).toBe(true));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.crashes).toHaveLength(1);
    expect(state.crashes[0]).toMatchObject({
      type: 'Renderer',
      reason: 'crashed',
      exitCode: 139,
    });
    errorSpy.mockRestore();
  });

  it('does not record a renderer clean-exit as a crash', async () => {
    const statePath = path.join(userDataDir, 'graphics.json');

    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBeGreaterThan(0));
    const window = h.windowInstances.at(-1);

    window.webContents.events['render-process-gone']({}, { reason: 'clean-exit', exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('does not record an external SIGTERM as a renderer crash', async () => {
    const statePath = path.join(userDataDir, 'graphics.json');

    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBeGreaterThan(0));
    const window = h.windowInstances.at(-1);

    window.webContents.events['render-process-gone']({}, { reason: 'killed', exitCode: 15 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('counts renderer crashes toward the fallback threshold', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const statePath = path.join(userDataDir, 'graphics.json');

    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBeGreaterThan(0));
    const window = h.windowInstances.at(-1);

    const crash = { reason: 'crashed', exitCode: 139 };
    window.webContents.events['render-process-gone']({}, crash);
    await vi.waitFor(() => expect(fs.existsSync(statePath)).toBe(true));

    window.webContents.events['render-process-gone']({}, crash);
    await vi.waitFor(() => {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(state.crashes).toHaveLength(2);
      expect(state.fallback?.active).toBe(true);
    });
    errorSpy.mockRestore();
  });

  describe('graphics IPC', () => {
    it('reports the default state before anything happened', async () => {
      const state = await call('get-graphics-state');
      expect(state).toEqual({
        mode: 'auto',
        activeProfile: 'auto',
        notice: null,
        crashCount: 0,
        lastCrashAt: null,
      });
    });

    it('reports the recorded fallback as the profile the next start will use', async () => {
      fs.writeFileSync(
        path.join(userDataDir, 'graphics.json'),
        JSON.stringify({
          mode: 'auto',
          fallback: {
            active: true,
            since: 1730000000000,
            reason: 'gpu-crash-loop',
            relaunchedAt: 1,
          },
          crashes: [{ at: 1730000000000, type: 'GPU', reason: 'crashed', exitCode: 139 }],
        }),
        'utf8'
      );

      const state = await call('get-graphics-state');
      expect(state).toMatchObject({
        activeProfile: 'fallback',
        notice: 'gpu-crash',
        crashCount: 1,
        lastCrashAt: 1730000000000,
      });
    });

    it('rejects an unknown graphics mode', async () => {
      const result = await call('set-graphics-mode', { mode: 'warp-speed' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Unknown graphics mode/);
    });

    it('requires confirmation to re-enable acceleration after a fallback', async () => {
      fs.writeFileSync(
        path.join(userDataDir, 'graphics.json'),
        JSON.stringify({
          mode: 'auto',
          fallback: { active: true, since: 1, reason: 'gpu-crash-loop', relaunchedAt: 1 },
          crashes: [],
        }),
        'utf8'
      );

      const result = await call('set-graphics-mode', { mode: 'enabled' });
      expect(result).toEqual({
        ok: false,
        requiresConfirmation: true,
        error: expect.stringMatching(/may crash the app again/),
      });
      const persisted = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'graphics.json'), 'utf8')
      );
      expect(persisted.mode).toBe('auto');
    });

    it('accepts the confirmed risk and persists it', async () => {
      fs.writeFileSync(
        path.join(userDataDir, 'graphics.json'),
        JSON.stringify({
          mode: 'auto',
          fallback: { active: true, since: 1, reason: 'gpu-crash-loop', relaunchedAt: 1 },
          crashes: [],
        }),
        'utf8'
      );

      const result = await call('set-graphics-mode', { mode: 'enabled', confirmRisk: true });
      expect(result).toEqual({ ok: true });
      const persisted = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'graphics.json'), 'utf8')
      );
      expect(persisted.mode).toBe('enabled');
    });

    it('clears the fallback when the user goes back to automatic', async () => {
      fs.writeFileSync(
        path.join(userDataDir, 'graphics.json'),
        JSON.stringify({
          mode: 'disabled',
          fallback: { active: true, since: 1, reason: 'gpu-crash-loop', relaunchedAt: 1 },
          crashes: [],
        }),
        'utf8'
      );

      expect(await call('set-graphics-mode', { mode: 'auto' })).toEqual({ ok: true });
      const persisted = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'graphics.json'), 'utf8')
      );
      expect(persisted.fallback).toBeNull();
      expect(persisted.mode).toBe('auto');
    });

    it('restarts the app through the single relaunch path', async () => {
      await call('relaunch-app');
      expect(app.relaunch).toHaveBeenCalledTimes(1);
      expect(app.exit).toHaveBeenCalledWith(0);
    });
  });

  it('falls back once after two GPU crashes and never restarts again', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const statePath = path.join(userDataDir, 'graphics.json');

    fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });
    await vi.waitFor(() => expect(app.relaunch).not.toHaveBeenCalled());
    fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });

    await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledTimes(1));
    expect(app.exit).toHaveBeenCalledWith(0);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.fallback).toMatchObject({ active: true, reason: 'gpu-crash-loop' });
    expect(state.fallback.relaunchedAt).toBe(state.fallback.since);

    fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });
    await vi.waitFor(() => {
      const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(after.crashes).toHaveLength(3);
    });
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('does not restart the app when --no-fallback-relaunch is passed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.argv.push('--no-fallback-relaunch');

    try {
      fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });
      fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });

      await vi.waitFor(() => {
        const state = JSON.parse(fs.readFileSync(path.join(userDataDir, 'graphics.json'), 'utf8'));
        expect(state.crashes).toHaveLength(2);
      });
      expect(app.relaunch).not.toHaveBeenCalled();
    } finally {
      process.argv.splice(process.argv.indexOf('--no-fallback-relaunch'), 1);
      errorSpy.mockRestore();
    }
  });

  it('never overrides an explicit "force enabled" choice', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(userDataDir, 'graphics.json'),
      JSON.stringify({ mode: 'enabled', crashes: [] }),
      'utf8'
    );

    fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });
    fireAppEvent('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });

    await vi.waitFor(() => {
      const state = JSON.parse(fs.readFileSync(path.join(userDataDir, 'graphics.json'), 'utf8'));
      expect(state.crashes).toHaveLength(2);
    });
    expect(app.relaunch).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('leaves unrelated child-process crashes out of the graphics history', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const statePath = path.join(userDataDir, 'graphics.json');
    fs.rmSync(statePath, { force: true });

    fireAppEvent('child-process-gone', {}, { type: 'Tab', reason: 'crashed', exitCode: 1 });

    expect(errorSpy).toHaveBeenCalledWith(
      '[crash] child-process-gone type=Tab reason=crashed exitCode=1 name=?'
    );
    expect(fs.existsSync(statePath)).toBe(false);
    errorSpy.mockRestore();
  });

  it('opens devtools on the current window', async () => {
    seedDefaultLibrary();
    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBe(1));

    // Dev mode opens devtools on its own while loading the renderer, so the
    // mock has to be cleared or this test passes without the IPC path working.
    const win = h.windowInstances[0];
    win.webContents.openDevTools.mockClear();

    await call('open-devtools');

    expect(win.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });

  it('refuses to open devtools once the build is packaged', async () => {
    seedDefaultLibrary();
    fireAppEvent('ready');
    await vi.waitFor(() => expect(h.windowInstances.length).toBe(1));

    app.isPackaged = true;
    try {
      const win = h.windowInstances[0];
      win.webContents.openDevTools.mockClear();
      const res = await call('open-devtools');

      expect(res).toMatchObject({ ok: false });
      expect(win.webContents.openDevTools).not.toHaveBeenCalled();
    } finally {
      app.isPackaged = false;
    }
  });

  it('opens external links in the system browser', async () => {
    await call('open-external', 'https://rwtechworks.pl');

    expect(shell.openExternal).toHaveBeenCalledWith('https://rwtechworks.pl');
  });

  it('refuses URL schemes that reach local files or run script', async () => {
    const refused = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'smb://host/share',
      'not a url',
      '',
    ];

    for (const url of refused) {
      const res = await call('open-external', url);
      expect(res, url).toMatchObject({ ok: false });
    }

    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('allows the mail client scheme', async () => {
    const res = await call('open-external', 'mailto:kontakt@rwtechworks.pl');

    expect(res).toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith('mailto:kontakt@rwtechworks.pl');
  });
});

describe('window chrome', () => {
  async function bootWindow() {
    createLibraryId('Chrome');
    process.argv.push('--load-built-renderer');
    try {
      const listeners = h.appEvents.get('ready') ?? [];
      for (const listener of listeners) listener();
      await vi.waitFor(() => expect(h.windowInstances.length).toBeGreaterThan(0));
      return h.windowInstances.at(-1);
    } finally {
      process.argv.splice(process.argv.indexOf('--load-built-renderer'), 1);
    }
  }

  it('offers a context menu on editable fields', async () => {
    const window = await bootWindow();
    const before = h.menuInstances.length;

    window.webContents.events['context-menu'](
      {},
      {
        isEditable: true,
        editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true },
      }
    );

    const menu = h.menuInstances[before];
    expect(menu.items.length).toBeGreaterThan(3);
    expect(menu.popup).toHaveBeenCalled();
    expect(menu.items.map((i) => i.role)).toContain('paste');
  });

  it('offers copy for selected text and nothing for an empty selection', async () => {
    const window = await bootWindow();
    const before = h.menuInstances.length;

    window.webContents.events['context-menu']({}, { isEditable: false, selectionText: 'hi' });
    const copyMenu = h.menuInstances[before];
    expect(copyMenu.items.map((i) => i.role)).toEqual(['copy']);
    expect(copyMenu.popup).toHaveBeenCalled();

    const afterSelection = h.menuInstances.length;
    window.webContents.events['context-menu']({}, { isEditable: false, selectionText: '' });
    expect(h.menuInstances[afterSelection].popup).not.toHaveBeenCalled();
  });

  it('forwards renderer console output to the log file', async () => {
    const window = await bootWindow();

    expect(() =>
      window.webContents.events['console-message']({ level: 'error', message: 'boom' })
    ).not.toThrow();
  });

  it('logs only failed resource loads', async () => {
    const window = await bootWindow();
    const onErrorOccurred = window.onErrorOccurred;
    const onCompleted = window.onCompleted;

    expect(() => onErrorOccurred({ error: 'ERR_ABORTED', url: '/skip' })).not.toThrow();
    expect(() => onErrorOccurred({ error: 'ERR_FAILED', url: '/fail' })).not.toThrow();
    expect(() => onCompleted({ statusCode: 200, url: '/ok' })).not.toThrow();
    expect(() => onCompleted({ statusCode: 404, url: '/missing' })).not.toThrow();
  });
});

describe('factory reset', () => {
  it('schedules a detached cleanup of the user data and quits', async () => {
    const resetCleanup = await import('../resetCleanup.js');
    const database = await import('../db/database.js');

    await call('clear-user-data');

    expect(database.closeDB).toHaveBeenCalled();
    expect(resetCleanup.startResetCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPid: process.pid,
        targets: expect.any(Array),
      })
    );
    expect(app.quit).toHaveBeenCalled();
  });
});

/**
 * Guards the module doubles registered above.
 *
 * A mock is bound to a path, so moving a file silently turns the double into
 * dead code: the real module gets imported and the test still passes, only now
 * it exercises something else. Each entry below is compared against the real
 * module, which fails loudly when the specifier stops resolving, when nothing
 * is actually overridden, or when a double patches an export that does not
 * exist any more.
 */
describe('module doubles', () => {
  const STUBBED = [
    '../deps.js',
    '../audio/ytDlpManager.js',
    '../audio/tidalDlManager.js',
    '../audio/ffmpeg.js',
    '../audio/waveformGenerator.js',
    '../audio/mediaServer.js',
    '../audio/autoTagger.js',
    '../audio/importManager.js',
    '../audio/id3Writer.js',
    '../audio/sampleInfo.js',
    '../audio/trackTrim.js',
    '../usb/pioneer/formats/anlz.js',
    '../usb/pioneer/formats/pdb.js',
    '../usb/pioneer/formats/settings.js',
    '../usb/generic/fs.js',
    '../usb/pioneer/formats/cues.js',
    '../library/libraryWatcher.js',
    '../db/database.js',
    '../resetCleanup.js',
  ];

  it.each(STUBBED)('%s is stubbed over the real module', async (spec) => {
    const actual = await vi.importActual(spec);
    const mocked = await import(spec);
    const overridden = Object.keys(mocked).filter((key) => mocked[key] !== actual[key]);

    expect(overridden.length, `nothing is stubbed in ${spec}`).toBeGreaterThan(0);
    for (const key of overridden) {
      expect(actual, `${spec} no longer exports ${key}`).toHaveProperty(key);
      expect(vi.isMockFunction(mocked[key]), `${spec}.${key} is not a mock`).toBe(true);
    }
  });
});
