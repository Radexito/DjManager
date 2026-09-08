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

import { searchTidal } from '../audio/tidalDlManager.js';

beforeEach(() => {
  vi.clearAllMocks();
  fakeProc = makeFakeProc();
});

describe('searchTidal', () => {
  it('errors when no Python interpreter can be found', async () => {
    mockExistsSync.mockReturnValue(false); // no uv env, no token
    const result = await searchTidal('daft punk');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Python interpreter not found/);
  });

  it('errors when not logged in to TIDAL', async () => {
    // Python interpreter found, but no token.json
    mockExistsSync.mockImplementation((p) => p.includes('python') || p.includes('bin'));
    const result = await searchTidal('daft punk');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Not logged in/);
  });

  it('spawns the search script with query, token path, types, and limit', async () => {
    mockExistsSync.mockReturnValue(true); // python found, token found
    const resultPromise = searchTidal('daft punk', { types: ['track', 'album'], limit: 10 });

    fakeProc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        results: [
          {
            type: 'track',
            id: '123',
            title: 'One More Time',
            artist: 'Daft Punk',
            album: 'Discovery',
            duration: 320,
            quality: 'HiRes_Lossless',
            url: 'https://tidal.com/browse/track/123',
          },
        ],
      })
    );
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    expect(lastSpawnBin).toMatch(/python/);
    expect(lastSpawnArgs).toContain('daft punk');
    expect(lastSpawnArgs).toContain('track,album');
    expect(lastSpawnArgs).toContain('10');
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('One More Time');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('defaults to type "track" and limit 20 when not specified', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = searchTidal('some query');
    fakeProc.stdout.emit('data', JSON.stringify({ ok: true, results: [] }));
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(lastSpawnArgs).toContain('track');
    expect(lastSpawnArgs).toContain('20');
  });

  it('resolves with an error when the script prints unparseable output', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = searchTidal('daft punk');
    fakeProc.stderr.emit('data', 'Traceback: something went wrong');
    fakeProc.emit('close', 1);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/something went wrong/);
  });

  it('resolves with an error when spawning the interpreter fails', async () => {
    mockExistsSync.mockReturnValue(true);
    const resultPromise = searchTidal('daft punk');
    fakeProc.emit('error', new Error('ENOENT'));

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ENOENT');
  });
});
