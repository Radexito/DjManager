import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerImportIpc } from '../main/ipc/importIpc.js';

let root;

/**
 * Wires the import handlers against stub repositories and reset hooks.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} Registered handlers, sent messages, the stub deps and a `call` helper.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const sent = [];
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  const deps = {
    ipcMain,
    send: (channel, data) => sent.push([channel, data]),
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/a.mp3', '/b.mp3'] })),
    log: vi.fn(),
    error: vi.fn(),

    addTrack: vi.fn((t) => ({ id: 1, ...t })),
    importAudioFile: vi.fn(async (p) => parseInt(path.basename(p), 10)),
    addTracksToPlaylist: vi.fn(),

    getCurrentLibraryId: vi.fn(() => 'lib1'),
    getLibraryBase: vi.fn((id) => path.join(root, 'libs', String(id))),
    clearTracksForLibrary: vi.fn(),

    getResetPaths: vi.fn(() => ({
      userDataPath: path.join(root, 'userdata'),
      cachePath: path.join(root, 'cache'),
      logsPath: path.join(root, 'logs'),
    })),
    getResetCleanupTargets: vi.fn(() => ['/a', '/b']),
    closeDB: vi.fn(),
    startResetCleanup: vi.fn(),
    quitApp: vi.fn(),
    parentPid: 4242,
    ...overrides,
  };

  registerImportIpc(deps);
  return { handlers, sent, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'importipc-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerImportIpc', () => {
  it('registers the six import channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'add-track',
        'select-audio-files',
        'open-dir-dialog',
        'import-audio-files',
        'clear-library',
        'clear-user-data',
      ].sort()
    );
  });

  it('returns an empty selection when the file dialog is cancelled', async () => {
    const { call } = setup({ showOpenDialog: vi.fn(async () => ({ canceled: true })) });
    expect(await call('select-audio-files')).toEqual([]);
  });

  it('returns the chosen paths when the dialog is accepted', async () => {
    const { call } = setup();
    expect(await call('select-audio-files')).toEqual(['/a.mp3', '/b.mp3']);
  });

  it('returns null when the directory dialog is cancelled', async () => {
    const { call } = setup({ showOpenDialog: vi.fn(async () => ({ canceled: true })) });
    expect(await call('open-dir-dialog')).toBeNull();
  });

  it('returns the single chosen directory', async () => {
    const { call } = setup({
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/music'] })),
    });
    expect(await call('open-dir-dialog')).toBe('/music');
  });

  it('imports every file and reports progress for each one', async () => {
    const { call, sent, deps } = setup();

    const res = await call('import-audio-files', ['/1.mp3', '/2.mp3'], null, 'lib1');

    expect(res).toEqual([1, 2]);
    expect(deps.importAudioFile).toHaveBeenCalledWith('/1.mp3', {}, 'lib1');
    const progress = sent.filter(([ch]) => ch === 'import-progress').map(([, d]) => d);
    expect(progress).toEqual([
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
    expect(sent.some(([ch]) => ch === 'library-updated')).toBe(true);
  });

  it('keeps importing after one file fails and never aborts the run', async () => {
    const { call, sent, deps } = setup({
      importAudioFile: vi.fn().mockRejectedValueOnce(new Error('corrupt')).mockResolvedValueOnce(2),
    });

    const res = await call('import-audio-files', ['/bad.mp3', '/good.mp3'], null, 'lib1');

    expect(res).toEqual([2]);
    const progress = sent.filter(([ch]) => ch === 'import-progress').map(([, d]) => d);
    expect(progress.at(-1)).toEqual({ completed: 2, total: 2 });
    expect(deps.error).toHaveBeenCalled();
  });

  it('adds the imported tracks to the target playlist and says so', async () => {
    const { call, sent, deps } = setup();

    await call('import-audio-files', ['/1.mp3'], 9, 'lib1');

    expect(deps.addTracksToPlaylist).toHaveBeenCalledWith(9, [1]);
    expect(sent.map(([ch]) => ch)).toEqual([
      'import-progress',
      'playlists-updated',
      'library-updated',
    ]);
  });

  it('broadcasts nothing when every file failed', async () => {
    const { call, sent } = setup({
      importAudioFile: vi.fn(async () => {
        throw new Error('corrupt');
      }),
    });

    const res = await call('import-audio-files', ['/bad.mp3'], null, 'lib1');

    expect(res).toEqual([]);
    expect(sent.some(([ch]) => ch === 'library-updated')).toBe(false);
  });

  it('clears the current library folder and broadcasts both updates', async () => {
    const base = path.join(root, 'libs', 'lib1');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'x.mp3'), 'audio');

    const { call, sent, deps } = setup();

    await call('clear-library', undefined);

    expect(deps.getCurrentLibraryId).toHaveBeenCalled();
    expect(deps.clearTracksForLibrary).toHaveBeenCalledWith('lib1');
    expect(fs.existsSync(base)).toBe(false);
    expect(sent.map(([ch]) => ch)).toEqual(['library-updated', 'playlists-updated']);
  });

  it('clears the requested library rather than the current one', async () => {
    const { call, deps } = setup();

    await call('clear-library', 'lib7');

    expect(deps.clearTracksForLibrary).toHaveBeenCalledWith('lib7');
  });

  it('closes the database, schedules cleanup and quits on reset', async () => {
    const { call, deps } = setup();

    await call('clear-user-data');

    expect(deps.getResetCleanupTargets).toHaveBeenCalledWith({
      userDataPath: path.join(root, 'userdata'),
      cachePath: path.join(root, 'cache'),
      logsPath: path.join(root, 'logs'),
    });
    expect(deps.startResetCleanup).toHaveBeenCalledWith({ parentPid: 4242, targets: ['/a', '/b'] });
    expect(deps.closeDB).toHaveBeenCalled();
    expect(deps.quitApp).toHaveBeenCalled();
  });
});
