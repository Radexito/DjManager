import { describe, expect, it, vi } from 'vitest';
import { registerCuePointIpc } from '../main/ipc/cuePointIpc.js';

/**
 * Wires the cue point handlers against stub repositories.
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

    getCuePoints: vi.fn(() => []),
    addCuePoint: vi.fn(() => 11),
    getCuePointById: vi.fn(() => ({ id: 5, track_id: 7 })),
    updateCuePoint: vi.fn(),
    deleteCuePoint: vi.fn(),
    deleteAllCuePoints: vi.fn(),
    deleteAllCuePointsLibrary: vi.fn(() => [1, 2]),
    generateCuePoints: vi.fn(() => [{ positionMs: 1000 }, { positionMs: 2000 }]),
    renumberSequentialCuesAfter: vi.fn(),
    getTrackById: vi.fn(() => ({ id: 7, analyzed: 1 })),
    getTracks: vi.fn(() => []),
    generateWaveformOverview: vi.fn(async () => Buffer.from('wf')),
    updateTrackWaveform: vi.fn(),
    getFfmpegRuntimePath: vi.fn(() => '/usr/bin/ffmpeg'),
    warn: vi.fn(),
    ...overrides,
  };

  registerCuePointIpc(deps);
  return { handlers, sent, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

describe('registerCuePointIpc', () => {
  it('registers the eight cue and waveform channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'get-cue-points',
        'add-cue-point',
        'update-cue-point',
        'delete-cue-point',
        'generate-cue-points',
        'generate-cue-points-library',
        'delete-all-cue-points-library',
        'generate-waveforms-library',
      ].sort()
    );
  });

  it('renumbers sequential cues after a new one is added', async () => {
    const { call, deps } = setup();

    expect(await call('add-cue-point', { trackId: 7, positionMs: 500 })).toEqual({ id: 11 });
    expect(deps.renumberSequentialCuesAfter).toHaveBeenCalledWith(7, 11);
  });

  it('cascades the renumber only when a label was supplied', async () => {
    const { call, deps } = setup();

    await call('update-cue-point', { id: 5, label: 'Cue 2' });
    expect(deps.renumberSequentialCuesAfter).toHaveBeenCalledWith(7, 5);

    deps.renumberSequentialCuesAfter.mockClear();
    await call('update-cue-point', { id: 5, color: '#fff' });
    expect(deps.renumberSequentialCuesAfter).not.toHaveBeenCalled();
  });

  it('does not renumber when the cue is already gone', async () => {
    const { call, deps } = setup({ getCuePointById: vi.fn(() => undefined) });

    await call('update-cue-point', { id: 99, label: 'Cue 2' });

    expect(deps.updateCuePoint).toHaveBeenCalled();
    expect(deps.renumberSequentialCuesAfter).not.toHaveBeenCalled();
  });

  it('refuses to generate cues for a track that does not exist', async () => {
    const { call } = setup({ getTrackById: vi.fn(() => undefined) });

    expect(await call('generate-cue-points', 42)).toMatchObject({
      ok: false,
      code: 'internal',
      message: 'Track 42 not found',
    });
  });

  it('replaces the cues of one track and returns the new list', async () => {
    const { call, deps } = setup();

    await call('generate-cue-points', 7);

    expect(deps.deleteAllCuePoints).toHaveBeenCalledWith(7);
    expect(deps.addCuePoint).toHaveBeenCalledTimes(2);
    expect(deps.addCuePoint).toHaveBeenCalledWith({ trackId: 7, positionMs: 1000 });
  });

  it('skips tracks that already have cues unless overwrite is set', async () => {
    const skip = setup({
      getTracks: vi.fn(() => [
        { id: 1, analyzed: 1 },
        { id: 2, analyzed: 0 },
      ]),
      getCuePoints: vi.fn(() => [{ id: 1 }]),
    });

    const res = await skip.call('generate-cue-points-library', {});

    expect(res).toEqual({ generated: 0, skipped: 1, total: 1 });
    expect(skip.deps.deleteAllCuePoints).not.toHaveBeenCalled();
  });

  it('regenerates everything with overwrite and reports progress to the end', async () => {
    const over = setup({
      getTracks: vi.fn(() => [{ id: 3, analyzed: 1 }]),
      getCuePoints: vi.fn(() => [{ id: 9 }]),
    });

    const res = await over.call('generate-cue-points-library', { overwrite: true });

    expect(res).toEqual({ generated: 1, skipped: 0, total: 1 });
    const progress = over.sent.filter(([ch]) => ch === 'cue-gen-progress').map(([, d]) => d);
    expect(progress.at(-1)).toMatchObject({ done: true, completed: 1, total: 1 });
    expect(over.sent.some(([ch]) => ch === 'cue-points-updated')).toBe(true);
  });

  it('broadcasts a zero cue count for every track it cleared', async () => {
    const { call, sent } = setup();

    expect(await call('delete-all-cue-points-library')).toEqual({ deleted: 2 });
    expect(sent).toEqual([
      ['cue-points-updated', { trackId: 1, cueCount: 0 }],
      ['cue-points-updated', { trackId: 2, cueCount: 0 }],
    ]);
  });

  it('skips tracks that already have a waveform', async () => {
    const { call, deps } = setup({
      getTracks: vi.fn(() => [{ id: 1, analyzed: 1, waveform_overview: 'blob' }]),
    });

    const res = await call('generate-waveforms-library', {});

    expect(res).toEqual({ generated: 0, skipped: 1, total: 1 });
    expect(deps.generateWaveformOverview).not.toHaveBeenCalled();
  });

  it('counts one unreadable file as skipped instead of aborting the batch', async () => {
    const { call, sent, deps } = setup({
      getTracks: vi.fn(() => [
        { id: 1, analyzed: 1, waveform_overview: null },
        { id: 2, analyzed: 1, waveform_overview: null },
      ]),
      generateWaveformOverview: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('ok'))
        .mockRejectedValueOnce(new Error('ffmpeg exploded')),
    });

    const res = await call('generate-waveforms-library', {});

    expect(res).toEqual({ generated: 1, skipped: 1, total: 2 });
    expect(deps.updateTrackWaveform).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalled();
    const progress = sent.filter(([ch]) => ch === 'waveform-gen-progress').map(([, d]) => d);
    expect(progress.at(-1)).toMatchObject({ done: true, completed: 2 });
  });
});
