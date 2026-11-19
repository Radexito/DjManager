import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTrackIpc } from '../main/ipc/trackIpc.js';

let root;

/**
 * Wires the track handlers against stub repositories.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} Registered handlers, the stub deps and a `call` helper.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  const deps = {
    ipcMain,
    getTracks: vi.fn(() => [{ id: 1 }]),
    countTracks: vi.fn(() => 7),
    getTrackRank: vi.fn(() => 3),
    getTrackIds: vi.fn(() => [1, 2]),
    getTrackById: vi.fn((id) => (id === 1 ? { id: 1, title: 'Track' } : undefined)),
    getLinkedTracksBasic: vi.fn(() => []),
    getTrackWaveform: vi.fn(() => null),
    writeBpmKeyTagsForTrack: vi.fn(async (id) => ({ trackId: id, ok: true, wrote: ['bpm'] })),
    ...overrides,
  };

  registerTrackIpc(deps);
  return { handlers, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackipc-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerTrackIpc', () => {
  it('registers the eight track channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'get-tracks',
        'count-tracks',
        'get-track-rank',
        'get-track-ids',
        'get-track-by-id',
        'get-unavailable-linked-tracks',
        'get-track-waveform',
        'write-bpm-key-tags',
      ].sort()
    );
  });

  it('passes read parameters straight through', async () => {
    const { call, deps } = setup();
    const params = { limit: 10, offset: 0 };

    expect(await call('get-tracks', params)).toEqual([{ id: 1 }]);
    expect(await call('count-tracks', params)).toBe(7);
    expect(await call('get-track-rank', params)).toBe(3);
    expect(await call('get-track-ids', params)).toEqual([1, 2]);
    expect(deps.getTracks).toHaveBeenCalledWith(params);
  });

  it('returns null for a track that does not exist rather than undefined', async () => {
    const { call } = setup();

    expect(await call('get-track-by-id', 1)).toEqual({ id: 1, title: 'Track' });
    expect(await call('get-track-by-id', 404)).toBeNull();
  });

  it('lists only linked tracks whose file has vanished', async () => {
    const present = path.join(root, 'here.mp3');
    fs.writeFileSync(present, 'x');
    const gone = path.join(root, 'gone.mp3');

    const { call } = setup({
      getLinkedTracksBasic: vi.fn(() => [
        { id: 1, file_path: present },
        { id: 2, file_path: gone },
      ]),
    });

    expect(await call('get-unavailable-linked-tracks')).toEqual([2]);
  });

  it('returns the waveform as a typed array, and null when there is none', async () => {
    const withWave = setup({ getTrackWaveform: vi.fn(() => Buffer.from([1, 2, 3])) });
    const wave = await withWave.call('get-track-waveform', 1);
    expect(wave).toBeInstanceOf(Uint8Array);
    expect([...wave]).toEqual([1, 2, 3]);

    const without = setup();
    expect(await without.call('get-track-waveform', 1)).toBeNull();
  });

  it('counts a tag write as done only when something was actually written', async () => {
    const { call } = setup({
      writeBpmKeyTagsForTrack: vi
        .fn()
        .mockResolvedValueOnce({ trackId: 1, ok: true, wrote: ['bpm'] })
        .mockResolvedValueOnce({ trackId: 2, ok: true, wrote: [] }),
    });

    const res = await call('write-bpm-key-tags', { trackIds: [1, 2] });

    expect(res.ok).toBe(true);
    expect(res.written).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('keeps going when one track throws and reports it per track', async () => {
    const { call } = setup({
      writeBpmKeyTagsForTrack: vi
        .fn()
        .mockResolvedValueOnce({ trackId: 1, ok: true, wrote: ['bpm'] })
        .mockRejectedValueOnce(new Error('read-only file')),
    });

    const res = await call('write-bpm-key-tags', { trackIds: [1, 2] });

    expect(res.written).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.results[1]).toMatchObject({
      trackId: 2,
      ok: false,
      reason: 'error',
      error: 'read-only file',
    });
  });

  it('handles an empty selection without calling the writer', async () => {
    const { call, deps } = setup();

    const res = await call('write-bpm-key-tags', {});

    expect(res).toEqual({ ok: true, written: 0, skipped: 0, results: [] });
    expect(deps.writeBpmKeyTagsForTrack).not.toHaveBeenCalled();
  });
});
