import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('os', () => ({
  default: { homedir: () => '/home/test', tmpdir: () => '/tmp' },
  homedir: () => '/home/test',
  tmpdir: () => '/tmp',
}));

const mockExistsSync = vi.fn();
const mockWriteFileSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    existsSync: (...args) => mockExistsSync(...args),
    writeFileSync: (...args) => mockWriteFileSync(...args),
  },
  existsSync: (...args) => mockExistsSync(...args),
  writeFileSync: (...args) => mockWriteFileSync(...args),
}));

// The Python CLI is never really spawned: every test queues the fake process
// the next spawn call must return, so an extra spawn fails loudly.
let pendingProcs = [];
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = pendingProcs.shift();
    if (!proc) throw new Error('unexpected spawn: no fake process queued');
    return proc;
  }),
  execSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

import { spawn } from 'child_process';
import {
  listTidalCollections,
  resetTidalCollectionsCache,
  TIDAL_COLLECTIONS_TTL_MS,
} from '../audio/tidalDlCollectionsCache.js';

const COLLECTIONS_PAYLOAD = {
  ok: true,
  collections: [
    {
      id: 'pl-1',
      type: 'playlist',
      title: 'Uptempo',
      group: 'playlists',
      parentId: null,
      subtitle: '',
      count: 12,
    },
  ],
  warnings: [],
};

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

/**
 * Queue one fake tdn process, start a listing and let the fake process answer.
 * The fake is consumed synchronously by the spawn call inside the fetch.
 */
function runListing(payload, start) {
  const proc = makeFakeProc();
  pendingProcs.push(proc);
  const promise = start();
  if (payload !== undefined) {
    proc.stdout.emit('data', JSON.stringify(payload));
    proc.emit('close', 0);
  }
  return promise;
}

let clock;
const now = () => clock;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true); // python interpreter + token.json found
  mockWriteFileSync.mockReset();
  resetTidalCollectionsCache();
  pendingProcs = [];
  clock = 1_000_000;
});

describe('tidalDlCollectionsCache', () => {
  it('spawns python on the first call and serves the next one from cache', async () => {
    const first = await runListing(COLLECTIONS_PAYLOAD, () => listTidalCollections({ now }));
    expect(first.ok).toBe(true);
    expect(first.collections).toHaveLength(1);
    expect(first.cached).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);

    clock += 1000;
    const second = await runListing(COLLECTIONS_PAYLOAD, () => listTidalCollections({ now }));

    expect(second.cached).toBe(true);
    expect(second.collections).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cached listing is older than the TTL', async () => {
    await runListing(COLLECTIONS_PAYLOAD, () => listTidalCollections({ now }));

    clock += TIDAL_COLLECTIONS_TTL_MS;
    const expired = await runListing(COLLECTIONS_PAYLOAD, () => listTidalCollections({ now }));

    expect(expired.cached).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('refetches when the renderer forces a refresh', async () => {
    await runListing(COLLECTIONS_PAYLOAD, () => listTidalCollections({ now }));

    const forced = await runListing(COLLECTIONS_PAYLOAD, () =>
      listTidalCollections({ force: true, now })
    );

    expect(forced.cached).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent calls into a single python process', async () => {
    const proc = makeFakeProc();
    pendingProcs.push(proc);

    const first = listTidalCollections({ now });
    const second = listTidalCollections({ now });

    expect(spawn).toHaveBeenCalledTimes(1);

    proc.stdout.emit('data', JSON.stringify(COLLECTIONS_PAYLOAD));
    proc.emit('close', 0);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.collections).toHaveLength(1);

    // ... and the shared result lands in the cache for later callers.
    clock += 1000;
    const third = await listTidalCollections({ now });
    expect(third.cached).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed listing, so the next call retries', async () => {
    const failed = await runListing({ ok: false, error: 'Not logged in to TIDAL.' }, () =>
      listTidalCollections({ now })
    );

    expect(failed.ok).toBe(false);
    expect(failed.cached).toBe(false);

    clock += 1000;
    const retried = await runListing(COLLECTIONS_PAYLOAD, () => listTidalCollections({ now }));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(retried.ok).toBe(true);
    expect(retried.cached).toBe(false);
    expect(retried.collections).toHaveLength(1);
  });

  it('reports a missing Python interpreter without spawning', async () => {
    mockExistsSync.mockReturnValue(false);

    const res = await listTidalCollections({ now });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Python interpreter not found/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
