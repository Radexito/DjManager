import { describe, expect, it, vi } from 'vitest';
import { registerPlaylistIpc } from '../main/ipc/playlistIpc.js';

/**
 * Wires the playlist handlers against stub repositories.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} Registered handlers, sent messages, the stub deps, a `call` helper and the
 *   duplicate-name error factory.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const sent = [];
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  const duplicate = () => {
    const err = new Error('Playlist name already used');
    err.code = 'DUPLICATE_PLAYLIST_NAME';
    return err;
  };

  const deps = {
    ipcMain,
    send: (channel, data) => sent.push([channel, data]),

    getPlaylists: vi.fn(() => [{ id: 1, name: 'Set' }]),
    createPlaylist: vi.fn(() => 2),
    renamePlaylist: vi.fn(),
    updatePlaylistColor: vi.fn(),
    deletePlaylist: vi.fn(),
    addTracksToPlaylist: vi.fn(),
    removeTrackFromPlaylist: vi.fn(),
    reorderPlaylistTracks: vi.fn(),
    getPlaylistsForTrack: vi.fn(() => [{ id: 1 }]),
    getPlaylist: vi.fn(() => ({ id: 1, name: 'Set' })),
    getPlaylistSourceUrls: vi.fn(() => [
      { trackId: 3, source_url: 'https://x', source_link: null },
    ]),
    ...overrides,
  };

  registerPlaylistIpc(deps);
  return { handlers, sent, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args), duplicate };
}

describe('registerPlaylistIpc', () => {
  it('registers the eleven curated-playlist channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'get-playlists',
        'create-playlist',
        'rename-playlist',
        'update-playlist-color',
        'delete-playlist',
        'add-tracks-to-playlist',
        'remove-track-from-playlist',
        'reorder-playlist',
        'get-playlists-for-track',
        'get-playlist',
        'get-playlist-source-urls',
      ].sort()
    );
  });

  it('creates a playlist and tells the renderer', async () => {
    const { call, sent } = setup();

    expect(await call('create-playlist', { name: 'Set', color: '#fff' })).toEqual({ id: 2 });
    expect(sent).toEqual([['playlists-updated', undefined]]);
  });

  it('defaults a missing colour to null rather than undefined', async () => {
    const { call, deps } = setup();
    await call('create-playlist', { name: 'Set' });
    expect(deps.createPlaylist).toHaveBeenCalledWith('Set', null);
  });

  it('reports a duplicate name as a result instead of throwing', async () => {
    const { call, sent, duplicate } = setup({
      createPlaylist: vi.fn(() => {
        throw duplicate();
      }),
    });

    expect(await call('create-playlist', { name: 'Set' })).toMatchObject({ error: 'duplicate' });
    expect(sent).toEqual([]);
  });

  it('treats a duplicate rename the same way', async () => {
    const { call, duplicate } = setup({
      renamePlaylist: vi.fn(() => {
        throw duplicate();
      }),
    });

    expect(await call('rename-playlist', { id: 1, name: 'Other' })).toMatchObject({
      error: 'duplicate',
    });
  });

  it('rethrows anything that is not a duplicate name', async () => {
    const { call } = setup({
      createPlaylist: vi.fn(() => {
        throw new Error('disk on fire');
      }),
    });

    expect(await call('create-playlist', { name: 'Set' })).toMatchObject({
      ok: false,
      code: 'internal',
      message: 'disk on fire',
    });
  });

  it('broadcasts after colour change and delete', async () => {
    const { call, sent } = setup();

    await call('update-playlist-color', { id: 1, color: '#123456' });
    await call('delete-playlist', 1);

    expect(sent).toEqual([
      ['playlists-updated', undefined],
      ['playlists-updated', undefined],
    ]);
  });

  it('ignores an empty track selection without broadcasting', async () => {
    const { call, sent, deps } = setup();

    await call('add-tracks-to-playlist', { playlistId: 1, trackIds: [] });
    await call('add-tracks-to-playlist', { playlistId: 1, trackIds: null });

    expect(deps.addTracksToPlaylist).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('adds and removes tracks with a broadcast each', async () => {
    const { call, sent, deps } = setup();

    await call('add-tracks-to-playlist', { playlistId: 1, trackIds: [3, 4] });
    await call('remove-track-from-playlist', { playlistId: 1, trackId: 3 });

    expect(deps.addTracksToPlaylist).toHaveBeenCalledWith(1, [3, 4]);
    expect(deps.removeTrackFromPlaylist).toHaveBeenCalledWith(1, 3);
    expect(sent).toHaveLength(2);
  });

  it('reorders without broadcasting, because the sidebar does not change', async () => {
    const { call, sent, deps } = setup();

    await call('reorder-playlist', { playlistId: 1, orderedTrackIds: [4, 3] });

    expect(deps.reorderPlaylistTracks).toHaveBeenCalledWith(1, [4, 3]);
    expect(sent).toEqual([]);
  });

  it('passes reads straight through', async () => {
    const { call } = setup();

    expect(await call('get-playlists')).toEqual([{ id: 1, name: 'Set' }]);
    expect(await call('get-playlist', 1)).toEqual({ id: 1, name: 'Set' });
    expect(await call('get-playlists-for-track', 3)).toEqual([{ id: 1 }]);
    expect(await call('get-playlist-source-urls', 1)).toEqual([
      { trackId: 3, source_url: 'https://x', source_link: null },
    ]);
  });
});
