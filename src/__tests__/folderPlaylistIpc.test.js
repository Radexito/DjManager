import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFolderPlaylistIpc } from '../main/ipc/folderPlaylistIpc.js';

let root;

/**
 * Wires the folder-playlist handlers against stub repositories.
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

    getPlaylist: vi.fn(() => ({ id: 1, folder_path: '/music', folder_recursive: 1 })),
    createPlaylist: vi.fn(() => 42),
    setPlaylistFolder: vi.fn(),
    clearPlaylistFolder: vi.fn(),
    removeTrackFromPlaylist: vi.fn(),
    syncFolderPlaylist: vi.fn(async () => ({ added: 2, removed: 0 })),
    refreshFolderPlaylists: vi.fn(() => ({ synced: 3 })),
    restartLibraryWatcher: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };

  registerFolderPlaylistIpc(deps);
  return { handlers, sent, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'folderpl-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerFolderPlaylistIpc', () => {
  it('registers the seven folder-playlist channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'create-folder-playlist',
        'refresh-folder-playlist',
        'refresh-folder-playlists',
        'remove-folder-playlist-tracks',
        'stop-folder-playlist',
        'set-playlist-folder',
        'set-folder-playlist-recursive',
      ].sort()
    );
  });

  it('refuses to watch a folder that does not exist', async () => {
    const { call, deps } = setup();

    const res = await call('create-folder-playlist', { folderPath: path.join(root, 'nope') });

    expect(res).toMatchObject({
      ok: false,
      code: 'folder-missing',
      error: 'folder-missing',
      folder: path.join(root, 'nope'),
    });
    expect(deps.createPlaylist).not.toHaveBeenCalled();
  });

  it('names the playlist after the folder when no name is given', async () => {
    const folder = path.join(root, 'Tuesday Set');
    fs.mkdirSync(folder);

    const { call, deps } = setup();
    const res = await call('create-folder-playlist', { folderPath: folder });

    expect(deps.createPlaylist).toHaveBeenCalledWith('Tuesday Set', null, null);
    expect(res).toMatchObject({ ok: true, playlistId: 42, name: 'Tuesday Set' });
  });

  it('falls back to a placeholder name for a nameless root folder', async () => {
    const { call, deps } = setup();
    await call('create-folder-playlist', { folderPath: '/', name: '   ' });

    expect(deps.createPlaylist).toHaveBeenCalledWith('Watched folder', null, null);
  });

  it('reports a duplicate name distinctly from a general failure', async () => {
    const folder = path.join(root, 'dup');
    fs.mkdirSync(folder);

    const dupErr = new Error('taken');
    dupErr.code = 'DUPLICATE_PLAYLIST_NAME';
    const dup = setup({
      createPlaylist: vi.fn(() => {
        throw dupErr;
      }),
    });
    await expect(dup.call('create-folder-playlist', { folderPath: folder })).resolves.toMatchObject(
      { ok: false, error: 'duplicate-name' }
    );

    const other = setup({
      createPlaylist: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    await expect(
      other.call('create-folder-playlist', { folderPath: folder })
    ).resolves.toMatchObject({ ok: false, error: 'failed' });
  });

  it('registers the folder, restarts the watcher and syncs before answering', async () => {
    const folder = path.join(root, 'watched');
    fs.mkdirSync(folder);

    const { call, sent, deps } = setup();
    const res = await call('create-folder-playlist', { folderPath: folder, recursive: true });

    expect(deps.setPlaylistFolder).toHaveBeenCalledWith(42, folder, true);
    expect(deps.restartLibraryWatcher).toHaveBeenCalled();
    expect(deps.syncFolderPlaylist).toHaveBeenCalledWith(42);
    expect(res).toMatchObject({ ok: true, added: 2, removed: 0 });
    expect(sent).toContainEqual(['playlists-updated', undefined]);
  });

  it('forwards the two refresh channels', async () => {
    const { call, deps } = setup();

    await expect(call('refresh-folder-playlist', 5)).resolves.toEqual({ added: 2, removed: 0 });
    await expect(call('refresh-folder-playlists')).resolves.toEqual({ synced: 3 });
    expect(deps.refreshFolderPlaylists).toHaveBeenCalled();
  });

  it('removes the requested tracks and broadcasts once', async () => {
    const { call, sent, deps } = setup();

    const res = await call('remove-folder-playlist-tracks', { playlistId: 1, trackIds: [3, 4] });

    expect(res).toEqual({ ok: true, playlistId: 1, removed: 2 });
    expect(deps.removeTrackFromPlaylist).toHaveBeenCalledTimes(2);
    expect(sent.map(([ch]) => ch)).toEqual(['library-updated', 'playlists-updated']);
  });

  it('stays silent when asked to remove nothing', async () => {
    const { call, sent, deps } = setup();

    const res = await call('remove-folder-playlist-tracks', { playlistId: 1, trackIds: [] });

    expect(res).toMatchObject({ removed: 0 });
    expect(deps.removeTrackFromPlaylist).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('stops tracking a folder and restarts the watcher', async () => {
    const { call, sent, deps } = setup();

    await expect(call('stop-folder-playlist', 1)).resolves.toEqual({ ok: true, playlistId: 1 });
    expect(deps.clearPlaylistFolder).toHaveBeenCalledWith(1);
    expect(deps.restartLibraryWatcher).toHaveBeenCalled();
    expect(sent).toContainEqual(['playlists-updated', undefined]);
  });

  it('rejects setting a folder on an unknown playlist or a missing folder', async () => {
    const unknown = setup({ getPlaylist: vi.fn(() => null) });
    await expect(
      unknown.call('set-playlist-folder', { playlistId: 9, folderPath: '/music' })
    ).resolves.toMatchObject({ ok: false, code: 'unknown-playlist', error: 'unknown-playlist' });

    const noFolder = setup();
    await expect(noFolder.call('set-playlist-folder', { playlistId: 1 })).resolves.toMatchObject({
      ok: false,
      code: 'no-folder',
      error: 'no-folder',
    });

    const missing = setup();
    await expect(
      missing.call('set-playlist-folder', { playlistId: 1, folderPath: path.join(root, 'nope') })
    ).resolves.toMatchObject({
      ok: false,
      code: 'missing-folder',
      error: 'missing-folder',
      folder: path.join(root, 'nope'),
    });
  });

  it('keeps the current recursive setting when the caller omits it', async () => {
    const folder = path.join(root, 'rec');
    fs.mkdirSync(folder);

    const { call, deps } = setup({
      getPlaylist: vi.fn(() => ({ id: 1, folder_recursive: 1 })),
    });

    await call('set-playlist-folder', { playlistId: 1, folderPath: folder });

    expect(deps.setPlaylistFolder).toHaveBeenCalledWith(1, folder, true);
  });

  it('flips the recursion flag on an existing folder playlist', async () => {
    const { call, deps } = setup();

    await call('set-folder-playlist-recursive', { playlistId: 1, recursive: false });

    expect(deps.setPlaylistFolder).toHaveBeenCalledWith(1, '/music', false);
    expect(deps.restartLibraryWatcher).toHaveBeenCalled();
  });

  it('refuses to change recursion on a playlist that is not folder-backed', async () => {
    const { call, deps } = setup({
      getPlaylist: vi.fn(() => ({ id: 2, folder_path: null })),
    });

    await expect(
      call('set-folder-playlist-recursive', { playlistId: 2, recursive: true })
    ).resolves.toMatchObject({
      ok: false,
      code: 'not-a-folder-playlist',
      playlistId: 2,
      error: 'not-a-folder-playlist',
    });
    expect(deps.setPlaylistFolder).not.toHaveBeenCalled();
  });

  it('answers with a failure body when the work throws, instead of rejecting', async () => {
    const folder = path.join(root, 'explodes');
    fs.mkdirSync(folder);

    const { call, deps } = setup({
      syncFolderPlaylist: vi.fn(async () => {
        throw new Error('disk on fire');
      }),
    });

    const res = await call('create-folder-playlist', { folderPath: folder });

    expect(res).toMatchObject({ ok: false, code: 'internal', message: 'disk on fire' });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('create-folder-playlist'));
  });
});
