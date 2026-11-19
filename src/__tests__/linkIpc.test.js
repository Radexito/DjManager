import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLinkIpc } from '../main/ipc/linkIpc.js';

let root;

/**
 * Wires the link handlers against stub repositories and USB helpers.
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
    getMainWindow: () => ({ id: 'win' }),

    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/new/file.mp3'] })),
    detectWindowsDrives: vi.fn(() => ['C:\\', 'D:\\']),
    platform: 'linux',

    getTracksByPaths: vi.fn(() => [{ id: 1 }]),
    linkAudioFile: vi.fn(async (p) => ({ id: 1, duplicate: false, path: p })),
    addTrackToPlaylist: vi.fn(),
    allowExplorerBase: (rt, base) => allowed.push(base),
    runtime: {},
    audioExtensions: new Set(['.mp3', '.flac']),
    updateTrack: vi.fn(),
    remapTracksByPrefix: vi.fn(() => 3),
    moveTrackToLibrary: vi.fn(async (id) => ({ newPath: `/libs/${id}.mp3` })),
    error: vi.fn(),
    ...overrides,
  };

  registerLinkIpc(deps);
  return { handlers, sent, allowed, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkipc-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerLinkIpc', () => {
  it('registers the eight link and remap channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'get-computer-root',
        'get-tracks-by-paths',
        'link-audio-files',
        'link-directory',
        'remap-track',
        'remap-folder',
        'move-track-to-library',
        'move-tracks-to-library',
      ].sort()
    );
  });

  it('reports the filesystem root and home on Linux, with no drive list', async () => {
    const { call } = setup();

    await expect(call('get-computer-root')).resolves.toEqual({
      root: '/',
      home: os.homedir(),
      drives: [],
    });
  });

  it('enumerates drives on Windows and keeps the home drive first', async () => {
    const { call } = setup({
      platform: 'win32',
      detectWindowsDrives: vi.fn(() => ['D:\\']),
    });

    const res = await call('get-computer-root');

    expect(res.drives[0]).toBe(path.parse(os.homedir()).root || 'C:\\');
    expect(res.drives).toContain('D:\\');
  });

  it('passes path lookups straight through', async () => {
    const { call, deps } = setup();
    await expect(call('get-tracks-by-paths', ['/a.mp3'])).resolves.toEqual([{ id: 1 }]);
    expect(deps.getTracksByPaths).toHaveBeenCalledWith(['/a.mp3']);
  });

  it('links each file, serves its folder and broadcasts once', async () => {
    const { call, sent, allowed } = setup();

    const res = await call('link-audio-files', { filePaths: ['/music/a.mp3'], playlistId: 7 });

    expect(res).toEqual([{ id: 1, duplicate: false, path: '/music/a.mp3' }]);
    expect(allowed).toEqual(['/music']);
    expect(sent.map(([ch]) => ch)).toEqual(['library-updated', 'playlists-updated']);
  });

  it('reports a failing file per file instead of failing the batch', async () => {
    const { call } = setup({
      linkAudioFile: vi
        .fn()
        .mockRejectedValueOnce(new Error('no such file'))
        .mockResolvedValueOnce({ id: 2, duplicate: false }),
    });

    const res = await call('link-audio-files', { filePaths: ['/a.mp3', '/b.mp3'] });

    expect(res[0]).toMatchObject({ id: null, error: 'no such file', path: '/a.mp3' });
    expect(res[1]).toMatchObject({ id: 2 });
  });

  it('walks a directory recursively, skipping hidden folders, and reports failures', async () => {
    const top = path.join(root, 'music');
    const nested = path.join(top, 'nested');
    const hidden = path.join(top, '.hidden');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(top, 'a.mp3'), 'x');
    fs.writeFileSync(path.join(top, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(nested, 'b.flac'), 'x');
    fs.writeFileSync(path.join(hidden, 'c.mp3'), 'x');

    const { call } = setup();

    const res = await call('link-directory', { dirPath: top, recursive: true });

    expect(res.total).toBe(2);
    expect(res.filePaths.sort()).toEqual(
      [path.join(top, 'a.mp3'), path.join(nested, 'b.flac')].sort()
    );
    expect(res.failed).toEqual([]);
  });

  it('does not descend into subfolders when recursive is off', async () => {
    const top = path.join(root, 'flat');
    fs.mkdirSync(path.join(top, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(top, 'a.mp3'), 'x');
    fs.writeFileSync(path.join(top, 'sub', 'b.mp3'), 'x');

    const { call } = setup();
    const res = await call('link-directory', { dirPath: top, recursive: false });

    expect(res.total).toBe(1);
    expect(res.filePaths).toEqual([path.join(top, 'a.mp3')]);
  });

  it('counts a directory whose files all failed as failed, not as linked', async () => {
    const top = path.join(root, 'bad');
    fs.mkdirSync(top, { recursive: true });
    fs.writeFileSync(path.join(top, 'a.mp3'), 'x');

    const { call } = setup({
      linkAudioFile: vi.fn(async () => {
        throw new Error('unreadable');
      }),
    });

    const res = await call('link-directory', { dirPath: top, recursive: false });

    expect(res.linked).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ error: 'unreadable' });
  });

  it('remaps a single track to the file chosen in the dialog', async () => {
    const { call, deps, allowed } = setup({
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/new/place.mp3'] })),
    });

    const res = await call('remap-track', { trackId: 4, newPath: '/old/place.mp3' });

    expect(res).toEqual({ ok: true, newPath: '/new/place.mp3' });
    expect(deps.updateTrack).toHaveBeenCalledWith(4, { file_path: '/new/place.mp3' });
    expect(allowed).toEqual(['/new']);
  });

  it('returns ok:false when the remap dialog is cancelled', async () => {
    const { call, deps } = setup({
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });

    await expect(call('remap-track', { trackId: 4 })).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    });
    expect(deps.updateTrack).not.toHaveBeenCalled();
  });

  it('resolves the old folder before building the remap prefix', async () => {
    const { call, deps } = setup({
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/new/place'] })),
    });

    await call('remap-folder', { oldDir: '/music/../etc' });

    expect(deps.remapTracksByPrefix).toHaveBeenCalledWith(
      path.resolve('/music/../etc') + path.sep,
      path.resolve('/new/place') + path.sep
    );
    expect(deps.remapTracksByPrefix.mock.calls[0][0]).toBe(path.join('/', 'etc') + path.sep);
  });

  it('does nothing when the folder remap dialog is cancelled', async () => {
    const { call, deps } = setup({
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });

    await expect(call('remap-folder', { oldDir: '/music' })).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    });
    expect(deps.remapTracksByPrefix).not.toHaveBeenCalled();
  });

  it('moves one track between libraries and broadcasts', async () => {
    const { call, sent } = setup();

    const res = await call('move-track-to-library', { trackId: 1, targetLibraryId: 'lib2' });

    expect(res).toEqual({ newPath: '/libs/1.mp3' });
    expect(sent).toContainEqual(['library-updated', undefined]);
  });

  it('reports per-track failures for a batch move and finishes the bar', async () => {
    const { call, sent, deps } = setup({
      moveTrackToLibrary: vi
        .fn()
        .mockResolvedValueOnce({ newPath: '/libs/1.mp3' })
        .mockRejectedValueOnce(new Error('disk full')),
    });

    const res = await call('move-tracks-to-library', { trackIds: [1, 2], targetLibraryId: 'lib2' });

    expect(res.moved).toEqual([{ trackId: 1, newPath: '/libs/1.mp3' }]);
    expect(res.failed).toEqual([2]);
    expect(deps.error).toHaveBeenCalled();
    const progress = sent
      .filter(([ch]) => ch === 'move-tracks-to-library-progress')
      .map(([, d]) => d);
    expect(progress.at(-1)).toEqual({ completed: 2, total: 2, done: true });
  });
});
