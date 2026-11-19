import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTrackEditIpc } from '../main/ipc/trackEditIpc.js';

let root;

/**
 * Wires the track-edit handlers against stub repositories.
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

    getTrackById: vi.fn((id) => ({ id, file_path: path.join(root, `${id}.mp3`), is_linked: 0 })),
    updateTrack: vi.fn(),
    removeTrack: vi.fn(),
    removeTracks: vi.fn(),
    getTrackCountByFilePath: vi.fn(() => 0),
    spawnAnalysis: vi.fn(),
    cancelAnalysis: vi.fn(() => true),
    writeId3Tags: vi.fn(async () => {}),
    generateEditorWaveform: vi.fn(async () => ({
      detail: new Uint8Array([1, 2, 3, 4, 5, 6]),
      overview: new Uint8Array([9]),
      numCols: 2,
    })),
    regenerateHiresWaveform: vi.fn(),
    getFfmpegRuntimePath: vi.fn(() => '/usr/bin/ffmpeg'),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };

  registerTrackEditIpc(deps);
  return { handlers, sent, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackedit-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerTrackEditIpc', () => {
  it('registers the eight mutation channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'reanalyze-track',
        'cancel-analysis',
        'remove-track',
        'remove-tracks',
        'remove-linked-file',
        'update-track',
        'get-editor-waveform',
        'adjust-bpm',
      ].sort()
    );
  });

  it('refuses to reanalyse a track that does not exist', async () => {
    const { call } = setup({ getTrackById: vi.fn(() => undefined) });
    expect(await call('reanalyze-track', 42)).toMatchObject({ ok: false, code: 'track-not-found' });
  });

  it('spawns analysis for an existing track', async () => {
    const { call, deps } = setup();

    expect(await call('reanalyze-track', 5)).toEqual({ ok: true });
    expect(deps.spawnAnalysis).toHaveBeenCalledWith(5, path.join(root, '5.mp3'));
  });

  it('reports whether a cancellation was actually applied', async () => {
    const { call } = setup({ cancelAnalysis: vi.fn(() => false) });
    expect(await call('cancel-analysis', 1)).toEqual({ cancelled: false });
  });

  it('deletes the owned file of the last row pointing at it', async () => {
    const file = path.join(root, 'owned.mp3');
    fs.writeFileSync(file, 'audio');
    const { call, sent } = setup({
      getTrackById: vi.fn(() => ({ id: 1, file_path: file, is_linked: 0 })),
      getTrackCountByFilePath: vi.fn(() => 0),
    });

    await call('remove-track', 1);

    expect(fs.existsSync(file)).toBe(false);
    expect(sent).toContainEqual(['playlists-updated', undefined]);
  });

  it('keeps the file while another row still references it', async () => {
    const file = path.join(root, 'shared.mp3');
    fs.writeFileSync(file, 'audio');
    const { call } = setup({
      getTrackById: vi.fn(() => ({ id: 1, file_path: file, is_linked: 0 })),
      getTrackCountByFilePath: vi.fn(() => 1),
    });

    await call('remove-track', 1);

    expect(fs.existsSync(file)).toBe(true);
  });

  it('never deletes a linked file through remove-track', async () => {
    const file = path.join(root, 'linked.mp3');
    fs.writeFileSync(file, 'audio');
    const { call, deps } = setup({
      getTrackById: vi.fn(() => ({ id: 1, file_path: file, is_linked: 1 })),
    });

    await call('remove-track', 1);

    expect(fs.existsSync(file)).toBe(true);
    expect(deps.getTrackCountByFilePath).not.toHaveBeenCalled();
  });

  it('reports batch removal progress and finishes with done', async () => {
    const one = path.join(root, '1.mp3');
    const two = path.join(root, '2.mp3');
    fs.writeFileSync(one, 'a');
    fs.writeFileSync(two, 'b');

    const { call, sent } = setup({
      getTrackById: vi.fn((id) => ({ id, file_path: id === 1 ? one : two, is_linked: 0 })),
    });

    expect(await call('remove-tracks', [1, 2])).toEqual({ ok: true, total: 2 });

    expect(fs.existsSync(one)).toBe(false);
    expect(fs.existsSync(two)).toBe(false);
    const progress = sent.filter(([ch]) => ch === 'remove-tracks-progress').map(([, d]) => d);
    expect(progress.at(-1)).toMatchObject({ completed: 2, total: 2, done: true });
  });

  it('returns not found for a missing linked-file removal', async () => {
    const { call } = setup({ getTrackById: vi.fn(() => undefined) });
    await expect(call('remove-linked-file', 9)).resolves.toEqual({ ok: false, error: 'not found' });
  });

  it('removes the linked file from disk and broadcasts both updates', async () => {
    const file = path.join(root, 'gone.mp3');
    fs.writeFileSync(file, 'audio');
    const { call, sent } = setup({
      getTrackById: vi.fn(() => ({ id: 1, file_path: file, is_linked: 1 })),
    });

    await call('remove-linked-file', 1);

    expect(fs.existsSync(file)).toBe(false);
    expect(sent.map(([ch]) => ch)).toEqual(['library-updated', 'playlists-updated']);
  });

  it('updates a track, broadcasts it, and writes tags without awaiting them', async () => {
    const { call, sent, deps } = setup({
      writeId3Tags: vi.fn(() => Promise.reject(new Error('read-only'))),
    });

    const res = await call('update-track', { id: 3, data: { bpm: 128 } });

    expect(res).toEqual({ ok: true });
    expect(deps.updateTrack).toHaveBeenCalledWith(3, { bpm: 128 });
    expect(sent).toContainEqual(['track-updated', { trackId: 3, analysis: { bpm: 128 } }]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.error).toHaveBeenCalled();
  });

  it('serves the cached hires waveform without decoding', async () => {
    const { call, deps } = setup({
      getTrackById: vi.fn(() => ({
        id: 1,
        file_path: path.join(root, '1.mp3'),
        waveform_detail_hires: new Uint8Array([1, 2, 3, 4, 5, 6]),
        waveform_overview: new Uint8Array([7]),
      })),
    });

    const res = await call('get-editor-waveform', 1);

    expect(res.numCols).toBe(2);
    expect(deps.generateEditorWaveform).not.toHaveBeenCalled();
  });

  it('generates a legacy waveform and queues the hires rebuild in the background', async () => {
    const { call, deps } = setup({
      getTrackById: vi.fn(() => ({
        id: 1,
        file_path: path.join(root, '1.mp3'),
        waveform_detail_hires: null,
      })),
    });

    const res = await call('get-editor-waveform', 1);

    expect(res.numCols).toBe(2);
    expect(deps.regenerateHiresWaveform).toHaveBeenCalledWith(1, path.join(root, '1.mp3'));
  });

  it('returns null when waveform generation fails', async () => {
    const { call, deps } = setup({
      getTrackById: vi.fn(() => ({ id: 1, file_path: path.join(root, '1.mp3') })),
      generateEditorWaveform: vi.fn(async () => {
        throw new Error('ffmpeg missing');
      }),
    });

    await expect(call('get-editor-waveform', 1)).resolves.toBeNull();
    expect(deps.error).toHaveBeenCalled();
  });

  it('doubles and halves bpm from the override when one exists', async () => {
    const { call, deps } = setup({
      getTrackById: vi.fn((id) => ({ id, bpm: 120, bpm_override: id === 1 ? 100 : null })),
    });

    const res = await call('adjust-bpm', { trackIds: [1, 2], factor: 0.5 });

    expect(res).toEqual([
      { id: 1, bpm_override: 50 },
      { id: 2, bpm_override: 60 },
    ]);
    expect(deps.updateTrack).toHaveBeenCalledTimes(2);
  });

  it('skips tracks with no bpm at all', async () => {
    const { call } = setup({ getTrackById: vi.fn(() => ({ id: 1, bpm: null })) });
    expect(await call('adjust-bpm', { trackIds: [1], factor: 2 })).toEqual([]);
  });

  it('answers with a code for a factor other than double or half', async () => {
    const { call } = setup();
    expect(await call('adjust-bpm', { trackIds: [1], factor: 1.5 })).toMatchObject({
      ok: false,
      code: 'invalid-factor',
    });
  });

  it('answers with a code for an empty or oversized selection', async () => {
    const { call } = setup();
    expect(await call('adjust-bpm', { trackIds: [], factor: 2 })).toMatchObject({
      ok: false,
      code: 'invalid-selection',
    });
    expect(
      await call('adjust-bpm', { trackIds: Array.from({ length: 501 }, (_, i) => i), factor: 2 })
    ).toMatchObject({ ok: false, code: 'invalid-selection' });
  });
});
