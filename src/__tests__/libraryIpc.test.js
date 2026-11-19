import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLibraryIpc } from '../main/ipc/libraryIpc.js';

let root;
let userData;

/**
 * Wires the library handlers against stub repositories and library bases.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} Registered handlers, sent messages, allowed bases, deps and a `call` helper.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const sent = [];
  const allowed = [];
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  const deps = {
    ipcMain,
    send: (channel, data) => sent.push([channel, data]),
    userDataDir: userData,
    runtime: {},
    allowExplorerBase: (rt, base) => allowed.push(base),

    getLibraryBase: vi.fn((id) => path.join(root, 'libs', String(id ?? 'current'))),
    getArtworkBase: vi.fn((id) => path.join(root, 'art', String(id ?? 'current'))),
    getTracks: vi.fn(() => []),
    updateTrack: vi.fn(),
    setLibraryRootPath: vi.fn(),
    listLibraries: vi.fn(() => [{ id: 'lib1', name: 'Main' }]),
    getLibraryDiskUsage: vi.fn(() => 1024),
    getLibraryFreeSpace: vi.fn(() => 2048),
    getCurrentLibraryId: vi.fn(() => 'lib1'),
    setCurrentLibraryId: vi.fn((id) => id),
    createLibrary: vi.fn((opts) => ({ id: 'lib2', ...opts })),
    renameLibrary: vi.fn((id, name) => ({ id, name })),
    getStorageFormat: vi.fn(() => 'normalized'),
    convertStorageFormat: vi.fn(() => ({ ok: true })),

    getDbPath: vi.fn(() => path.join(userData, 'djmanager.db')),
    closeDB: vi.fn(),
    setDbPath: vi.fn(),
    relaunchApp: vi.fn(),

    moveFileSafe: vi.fn((a, b) => fs.renameSync(a, b)),
    ...overrides,
  };

  registerLibraryIpc(deps);
  return { handlers, sent, allowed, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'libipc-'));
  userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerLibraryIpc', () => {
  it('registers all fourteen channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'get-library-path',
        'move-library',
        'list-libraries',
        'get-library-size',
        'list-libraries-with-free-space',
        'get-current-library-id',
        'set-current-library-id',
        'create-library',
        'rename-library',
        'get-library-storage-format',
        'convert-storage-format',
        'get-db-path',
        'get-db-size',
        'move-database',
      ].sort()
    );
  });

  it('defaults a missing library id to the current one', async () => {
    const { call, deps } = setup();

    call('get-library-path');
    expect(deps.getLibraryBase).toHaveBeenCalledWith('lib1');

    call('get-library-path', 'lib9');
    expect(deps.getLibraryBase).toHaveBeenCalledWith('lib9');
  });

  it('resolves effective_root_path for every listed library', async () => {
    const { call } = setup();
    expect(await call('list-libraries')).toEqual([
      { id: 'lib1', name: 'Main', effective_root_path: path.join(root, 'libs', 'lib1') },
    ]);
  });

  it('adds both folders of a new library to the allowlist', async () => {
    const { call, allowed } = setup();
    call('create-library', { name: 'New' });

    expect(allowed).toEqual([path.join(root, 'libs', 'lib2'), path.join(root, 'art', 'lib2')]);
  });

  it('moves this library tracks and reports progress through send', async () => {
    const base = path.join(root, 'libs', 'lib1');
    fs.mkdirSync(path.join(base, 'a'), { recursive: true });
    const oldFile = path.join(base, 'a', 'track.mp3');
    fs.writeFileSync(oldFile, 'audio');

    const newDir = path.join(root, 'newlib');
    const { call, sent, deps, allowed } = setup({
      getTracks: vi.fn(() => [{ id: 7, file_path: oldFile, analyzed: 1 }]),
    });

    const res = await call('move-library', newDir, 'lib1');

    expect(res).toEqual({ moved: 1, total: 1 });
    expect(fs.existsSync(path.join(newDir, 'a', 'track.mp3'))).toBe(true);
    expect(deps.updateTrack).toHaveBeenCalledWith(7, {
      file_path: path.join(newDir, 'a', 'track.mp3'),
    });
    expect(deps.setLibraryRootPath).toHaveBeenCalledWith('lib1', newDir);
    expect(allowed).toEqual([newDir]);

    expect(sent[0][0]).toBe('move-library-progress');
    expect(sent[0][1]).toMatchObject({ moved: 1, total: 1, pct: 100 });
    expect(sent[1]).toEqual([
      'track-updated',
      { trackId: 7, analysis: { file_path: path.join(newDir, 'a', 'track.mp3'), analyzed: 1 } },
    ]);
  });

  it('counts a track whose file is already gone without failing the move', async () => {
    const { call, deps } = setup({
      getTracks: vi.fn(() => [{ id: 1, file_path: path.join(root, 'missing.mp3') }]),
    });

    const res = await call('move-library', path.join(root, 'newlib'), 'lib1');

    expect(res).toEqual({ moved: 1, total: 1 });
    expect(deps.updateTrack).not.toHaveBeenCalled();
  });

  it('refuses a move onto the same directory', async () => {
    const base = path.join(root, 'libs', 'lib1');
    const { call } = setup();
    expect(await call('move-library', base, 'lib1')).toMatchObject({
      ok: false,
      code: 'same-directory',
      message: 'Same directory selected.',
    });
  });

  it('returns zero db size when the file is missing', async () => {
    const { call } = setup();
    expect(await call('get-db-size')).toBe(0);
  });

  it('returns the real db size once the file exists', async () => {
    const dbPath = path.join(userData, 'djmanager.db');
    fs.writeFileSync(dbPath, 'x'.repeat(42));
    const { call } = setup();

    expect(await call('get-db-path')).toBe(dbPath);
    expect(await call('get-db-size')).toBe(42);
  });

  it('moves the database with its wal and shm sidecars, then relaunches', async () => {
    const dbPath = path.join(userData, 'djmanager.db');
    fs.writeFileSync(dbPath, 'db');
    fs.writeFileSync(`${dbPath}-wal`, 'wal');
    fs.writeFileSync(`${dbPath}-shm`, 'shm');

    const newDir = path.join(root, 'dbnew');
    const { call, deps } = setup();

    await call('move-database', newDir);

    expect(fs.existsSync(path.join(newDir, 'djmanager.db'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'djmanager.db-wal'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'djmanager.db-shm'))).toBe(true);
    expect(deps.closeDB).toHaveBeenCalled();
    expect(deps.setDbPath).toHaveBeenCalledWith(userData, path.join(newDir, 'djmanager.db'));
    expect(deps.relaunchApp).toHaveBeenCalled();
  });

  it('refuses a database move onto the same location without closing it', async () => {
    const { call, deps } = setup();
    expect(await call('move-database', userData)).toMatchObject({
      ok: false,
      code: 'same-location',
      message: 'Same location selected.',
    });
    expect(deps.closeDB).not.toHaveBeenCalled();
    expect(deps.relaunchApp).not.toHaveBeenCalled();
  });
});
