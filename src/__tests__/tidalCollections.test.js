import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('os', () => ({
  default: { homedir: () => '/home/test', tmpdir: () => '/tmp' },
  homedir: () => '/home/test',
  tmpdir: () => '/tmp',
}));

const mockExistsSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    existsSync: (...args) => mockExistsSync(...args),
    writeFileSync: (...args) => mockWriteFileSync(...args),
    readFileSync: (...args) => mockReadFileSync(...args),
  },
  existsSync: (...args) => mockExistsSync(...args),
  writeFileSync: (...args) => mockWriteFileSync(...args),
  readFileSync: (...args) => mockReadFileSync(...args),
}));

let lastSpawnBin = null;
let lastSpawnArgs = null;
let fakeProc;
vi.mock('child_process', () => ({
  spawn: vi.fn((bin, args) => {
    lastSpawnBin = bin;
    lastSpawnArgs = args;
    return fakeProc;
  }),
  execSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

import {
  buildCollectionsArgs,
  buildCollectionTracksArgs,
  parseTidalScriptOutput,
  normalizeTidalCollections,
  normalizeTidalCollectionTracks,
  splitTidalCollectionEntries,
  reindexTidalEntries,
  fetchTidalCollections,
  fetchTidalCollectionTracks,
} from '../audio/tidalDlManager.js';

beforeEach(() => {
  vi.clearAllMocks();
  fakeProc = makeFakeProc();
  lastSpawnBin = null;
  lastSpawnArgs = null;
});

describe('TIDAL collection script builders', () => {
  it('builds the collections-list argument vector', () => {
    expect(buildCollectionsArgs('/tmp/collections.py', '/home/u/token.json')).toEqual([
      '/tmp/collections.py',
      '/home/u/token.json',
    ]);
  });

  it('builds the collection-tracks argument vector with type, id and limit', () => {
    expect(
      buildCollectionTracksArgs('/tmp/tracks.py', 'favorites', 'tracks', '/home/u/token.json', 250)
    ).toEqual(['/tmp/tracks.py', 'favorites', 'tracks', '/home/u/token.json', '250']);
  });

  it('defaults the collection-tracks limit to 500', () => {
    const args = buildCollectionTracksArgs('/tmp/tracks.py', 'mix', 'mix-1', '/home/u/token.json');
    expect(args[4]).toBe('500');
  });
});

describe('parseTidalScriptOutput', () => {
  it('parses the JSON payload printed by the script', () => {
    expect(parseTidalScriptOutput('{"ok": true, "collections": []}', '')).toEqual({
      ok: true,
      collections: [],
    });
  });

  it('falls back to stderr when stdout is not JSON', () => {
    const res = parseTidalScriptOutput('Traceback: boom', 'Session error: expired');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Session error: expired');
  });

  it('falls back to stdout when stderr is empty', () => {
    const res = parseTidalScriptOutput('not json', '');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not json');
  });
});

describe('normalizeTidalCollections', () => {
  it('keeps id/type/title/group metadata and drops malformed rows', () => {
    const res = normalizeTidalCollections({
      ok: true,
      collections: [
        { id: 'pl-1', type: 'playlist', title: 'Uptempo', group: 'playlists', count: 12 },
        { id: '', type: 'playlist', title: 'no id' },
        { id: '   ', type: 'playlist', title: 'blank id' },
        { id: 'x', type: '', title: 'no type' },
        null,
        { id: 'mix-1', type: 'mix', title: 'My Daily Discovery', group: 'mixes' },
        { id: '521', type: 'artist', title: 'Doja Cat', group: 'favorites', parentId: 'artists' },
      ],
      warnings: ['mixes: unavailable'],
    });

    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual(['mixes: unavailable']);
    expect(res.collections.map((c) => c.id)).toEqual(['pl-1', 'mix-1', '521']);
    expect(res.collections[0].count).toBe(12);
    expect(res.collections[1].group).toBe('mixes');
    expect(res.collections[1].count).toBe(0); // missing count defaults to 0
    expect(res.collections[2].parentId).toBe('artists');
  });

  it('stringifies numeric ids and falls back to the id as title', () => {
    const res = normalizeTidalCollections({
      ok: true,
      collections: [{ id: 987, type: 'playlist' }],
    });
    expect(res.collections).toEqual([
      {
        id: '987',
        type: 'playlist',
        title: '987',
        group: 'other',
        parentId: null,
        subtitle: '',
        mixType: '',
        count: 0,
      },
    ]);
  });

  it('returns an error result when the payload reports failure', () => {
    const res = normalizeTidalCollections({ ok: false, error: 'Not logged in to TIDAL' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Not logged in to TIDAL');
    expect(res.collections).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('tolerates a null payload', () => {
    const res = normalizeTidalCollections(null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to list TIDAL collections/);
  });
});

describe('normalizeTidalCollectionTracks', () => {
  it('normalizes entries, defaults mediaType to track and drops rows without an id', () => {
    const res = normalizeTidalCollectionTracks({
      ok: true,
      type: 'playlist',
      title: 'Uptempo',
      total: 3,
      truncated: true,
      entries: [
        { index: 0, id: 111, title: 'One', artist: 'A', duration: 200, url: 'u1' },
        { index: 1, title: 'no id' },
        { index: 2, id: '222', title: 'Two', artist: 'B', mediaType: 'video' },
      ],
    });

    expect(res.ok).toBe(true);
    expect(res.title).toBe('Uptempo');
    expect(res.type).toBe('playlist');
    expect(res.truncated).toBe(true);
    expect(res.entries).toEqual([
      {
        index: 0,
        id: '111',
        title: 'One',
        artist: 'A',
        duration: 200,
        url: 'u1',
        mediaType: 'track',
      },
      { index: 2, id: '222', title: 'Two', artist: 'B', duration: 0, url: '', mediaType: 'video' },
    ]);
    expect(res.videoCount).toBe(1);
  });

  it('trusts an explicit videoCount from the script', () => {
    const res = normalizeTidalCollectionTracks({
      ok: true,
      entries: [{ id: '1', mediaType: 'video' }],
      videoCount: 7,
    });
    expect(res.videoCount).toBe(7);
  });

  it('returns an error result when the payload reports failure', () => {
    const res = normalizeTidalCollectionTracks({ ok: false, error: 'Mix not found' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Mix not found');
    expect(res.entries).toEqual([]);
    expect(res.videoCount).toBe(0);
  });
});

describe('reindexTidalEntries', () => {
  it('rewrites sparse indices into a contiguous 0-based order', () => {
    const out = reindexTidalEntries([
      { index: 0, id: 'a' },
      { index: 4, id: 'b' },
      { index: 7, id: 'c' },
    ]);
    expect(out).toEqual([
      { index: 0, id: 'a' },
      { index: 1, id: 'b' },
      { index: 2, id: 'c' },
    ]);
  });

  it('does not mutate the input entries', () => {
    const input = [{ index: 9, id: 'a' }];
    reindexTidalEntries(input);
    expect(input[0].index).toBe(9);
  });

  it('handles a missing list', () => {
    expect(reindexTidalEntries(undefined)).toEqual([]);
  });
});

describe('splitTidalCollectionEntries', () => {
  it('keeps audio entries, re-indexes them from 0 and counts the videos', () => {
    const { tracks, videoCount } = splitTidalCollectionEntries([
      { index: 0, id: 'a', mediaType: 'track' },
      { index: 1, id: 'v', mediaType: 'video' },
      { index: 2, id: 'b', mediaType: 'track' },
      { index: 3, id: 'v2', mediaType: 'video' },
    ]);

    expect(videoCount).toBe(2);
    expect(tracks.map((t) => [t.id, t.index])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('treats entries without a mediaType as audio tracks', () => {
    const { tracks, videoCount } = splitTidalCollectionEntries([{ index: 4, id: 'x' }]);
    expect(videoCount).toBe(0);
    expect(tracks).toEqual([{ index: 0, id: 'x' }]);
  });

  it('handles an empty or missing list', () => {
    expect(splitTidalCollectionEntries([])).toEqual({ tracks: [], videoCount: 0 });
    expect(splitTidalCollectionEntries(undefined)).toEqual({ tracks: [], videoCount: 0 });
  });
});

describe('fetchTidalCollections', () => {
  it('errors when no Python interpreter can be found', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await fetchTidalCollections();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Python interpreter not found/);
  });

  it('errors when not logged in to TIDAL', async () => {
    mockExistsSync.mockImplementation((p) => p.includes('python'));
    const res = await fetchTidalCollections();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Not logged in/);
  });

  it('spawns the collections script with the token path and parses its output', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = fetchTidalCollections();

    fakeProc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        collections: [
          { id: 'pl-1', type: 'playlist', title: 'Uptempo', group: 'playlists', count: 12 },
          { id: 'tracks', type: 'favorites', title: 'Favorite tracks', group: 'favorites' },
        ],
      })
    );
    fakeProc.emit('close', 0);

    const res = await resultPromise;

    expect(lastSpawnBin).toMatch(/python/);
    expect(lastSpawnArgs[0]).toMatch(/dj_manager_tidal_collections\.py$/);
    expect(lastSpawnArgs[1]).toMatch(/token\.json$/);
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.collections).toHaveLength(2);
    expect(res.collections[0].title).toBe('Uptempo');
  });

  it('resolves with an error when the script prints unparseable output', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = fetchTidalCollections();
    fakeProc.stderr.emit('data', 'Traceback: something went wrong');
    fakeProc.emit('close', 1);

    const res = await resultPromise;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/something went wrong/);
    expect(res.collections).toEqual([]);
  });

  it('resolves with an error when spawning the interpreter fails', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = fetchTidalCollections();
    fakeProc.emit('error', new Error('ENOENT'));

    const res = await resultPromise;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ENOENT');
  });
});

describe('fetchTidalCollectionTracks', () => {
  it('rejects a missing type or id without spawning python', async () => {
    const noType = await fetchTidalCollectionTracks('', 'pl-1');
    expect(noType.ok).toBe(false);
    expect(noType.error).toMatch(/Missing collection type or id/);

    const noId = await fetchTidalCollectionTracks('playlist', '');
    expect(noId.ok).toBe(false);
    expect(noId.error).toMatch(/Missing collection type or id/);
    expect(lastSpawnBin).toBeNull();
  });

  it('errors when no Python interpreter can be found', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await fetchTidalCollectionTracks('playlist', 'pl-1');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Python interpreter not found/);
  });

  it('errors when not logged in to TIDAL', async () => {
    mockExistsSync.mockImplementation((p) => p.includes('python'));
    const res = await fetchTidalCollectionTracks('favorites', 'tracks');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Not logged in/);
  });

  it('spawns the resolver with type, id and limit and parses the entries', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = fetchTidalCollectionTracks('favorites', 'videos', { limit: 25 });

    fakeProc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        type: 'favorites',
        id: 'videos',
        title: 'Favorite videos',
        total: 1,
        truncated: false,
        entries: [
          {
            index: 0,
            id: '77',
            title: 'Video One',
            artist: 'Somebody',
            duration: 180,
            url: 'https://tidal.com/browse/video/77',
            mediaType: 'video',
          },
        ],
      })
    );
    fakeProc.emit('close', 0);

    const res = await resultPromise;

    expect(lastSpawnArgs[0]).toMatch(/dj_manager_tidal_collection_tracks\.py$/);
    expect(lastSpawnArgs[1]).toBe('favorites');
    expect(lastSpawnArgs[2]).toBe('videos');
    expect(lastSpawnArgs[3]).toMatch(/token\.json$/);
    expect(lastSpawnArgs[4]).toBe('25');
    expect(res.ok).toBe(true);
    expect(res.title).toBe('Favorite videos');
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].mediaType).toBe('video');
    expect(res.entries[0].url).toBe('https://tidal.com/browse/video/77');
    expect(res.videoCount).toBe(1);
  });

  it('propagates a script-level error payload', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = fetchTidalCollectionTracks('mix', 'mix-404');

    fakeProc.stdout.emit('data', JSON.stringify({ ok: false, error: 'Mix not found' }));
    fakeProc.emit('close', 0);

    const res = await resultPromise;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Mix not found');
    expect(res.entries).toEqual([]);
  });

  it('resolves with an error when spawning the interpreter fails', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = fetchTidalCollectionTracks('playlist', 'pl-1');
    fakeProc.emit('error', new Error('ENOENT'));

    const res = await resultPromise;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ENOENT');
    expect(res.entries).toEqual([]);
  });
});
