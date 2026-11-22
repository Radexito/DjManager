import { describe, expect, it, vi } from 'vitest';

import { hasPendingWork } from '../sync/pendingWork.js';

const REVISION = '100:1:1:1:1';

function baseDeps(overrides = {}) {
  return {
    usbRoot: '/media/stick',
    readIdentity: async () => ({ key: 'serial:TEST' }),
    revision: () => ({ key: REVISION }),
    getState: () => ({ library_revision: REVISION }),
    getTracksState: () => new Map(),
    getPlaylistsState: () => new Map(),
    manifestLoader: () => ({ playlists: new Map([[10, { id: 10 }]]) }),
    getPlaylist: () => ({ id: 10, name: 'Set', rev: 1 }),
    getPlaylistTracks: () => [],
    ...overrides,
  };
}

describe('pending work', () => {
  it('answers false from the revision alone, without touching the selection', async () => {
    const getPlaylist = vi.fn(() => {
      throw new Error('must not be called for an unchanged library');
    });
    const result = await hasPendingWork(baseDeps({ getPlaylist }));
    expect(result).toBe(false);
    expect(getPlaylist).not.toHaveBeenCalled();
  });

  it('asks for a job on a medium this database never wrote to', async () => {
    expect(await hasPendingWork(baseDeps({ getState: () => null }))).toBe(true);
  });

  it('asks for a job when the medium has no usable identity', async () => {
    expect(await hasPendingWork(baseDeps({ readIdentity: async () => ({ key: null }) }))).toBe(
      true
    );
  });

  it('compares the selection when the library revision moved', async () => {
    const unchanged = await hasPendingWork(
      baseDeps({
        getState: () => ({ library_revision: '99:1:1:1:1' }),
        getPlaylistTracks: () => [
          { id: 1, rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' },
        ],
        getTracksState: () =>
          new Map([[1, { rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' }]]),
        getPlaylistsState: () => new Map([[10, { rev: 1, signature: '1' }]]),
      })
    );
    expect(unchanged).toBe(false);

    const changed = await hasPendingWork(
      baseDeps({
        getState: () => ({ library_revision: '99:1:1:1:1' }),
        getPlaylistTracks: () => [
          { id: 1, rev: 3, file_path: '/lib/a.mp3', file_fingerprint: '1:1' },
        ],
        getTracksState: () =>
          new Map([[1, { rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' }]]),
        getPlaylistsState: () => new Map([[10, { rev: 1, signature: '1' }]]),
      })
    );
    expect(changed).toBe(true);
  });

  it('does nothing for a medium whose playlists are all gone', async () => {
    const result = await hasPendingWork(
      baseDeps({
        getState: () => ({ library_revision: '99:1:1:1:1' }),
        getPlaylist: () => null,
      })
    );
    expect(result).toBe(false);
  });
});
