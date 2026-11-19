import { describe, expect, it, vi } from 'vitest';
import { registerNormalizeIpc } from '../main/ipc/normalizeIpc.js';

/**
 * Wires the normalisation handlers against stub repositories.
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

    getSetting: vi.fn(() => '-9'),
    getTrackById: vi.fn((id) => ({ id, replay_gain: -8.5 })),
    getTrackIdsNeedingNormalization: vi.fn(() => [1, 2]),
    getNormalizedTrackCount: vi.fn(() => 12),
    normalizeLibrary: vi.fn(() => 2),
    normalizeTracksByIds: vi.fn(() => ({ 3: -7.1, 4: -6.4 })),
    resetNormalization: vi.fn(() => 5),
    ...overrides,
  };

  registerNormalizeIpc(deps);
  return { handlers, sent, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

describe('registerNormalizeIpc', () => {
  it('registers the four normalisation channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'normalize-library',
        'reset-normalization',
        'get-normalized-count',
        'normalize-tracks-audio',
      ].sort()
    );
  });

  it('reads the target loudness from settings and passes it on', async () => {
    const { call, deps } = setup();

    await call('normalize-library');

    expect(deps.getSetting).toHaveBeenCalledWith('normalize_target_lufs', '-9');
    expect(deps.normalizeLibrary).toHaveBeenCalledWith(-9);
  });

  it('pushes the new gain for every affected track and finishes the bar', async () => {
    const { call, sent } = setup();

    const res = await call('normalize-library');

    expect(res).toEqual({ normalized: 2, skipped: 0, total: 2 });
    const updates = sent.filter(([ch]) => ch === 'track-updated');
    expect(updates).toEqual([
      ['track-updated', { trackId: 1, analysis: { replay_gain: -8.5 } }],
      ['track-updated', { trackId: 2, analysis: { replay_gain: -8.5 } }],
    ]);
    expect(sent.at(-1)).toEqual(['normalize-progress', { completed: 2, total: 2, done: true }]);
  });

  it('skips the broadcast for a track with no gain recorded', async () => {
    const { call, sent } = setup({
      getTrackById: vi.fn((id) => ({ id, replay_gain: id === 1 ? -8.5 : null })),
    });

    await call('normalize-library');

    const updates = sent.filter(([ch]) => ch === 'track-updated');
    expect(updates).toHaveLength(1);
  });

  it('treats an empty id list on reset as "every track"', async () => {
    const { call, deps } = setup();

    await call('reset-normalization', { trackIds: [] });

    expect(deps.resetNormalization).toHaveBeenCalledWith(null);
  });

  it('resets only the requested tracks and clears their gain in the renderer', async () => {
    const { call, sent, deps } = setup();

    const res = await call('reset-normalization', { trackIds: [7] });

    expect(res).toEqual({ updated: 5 });
    expect(deps.resetNormalization).toHaveBeenCalledWith([7]);
    expect(sent).toEqual([['track-updated', { trackId: 7, analysis: { replay_gain: null } }]]);
  });

  it('reports the normalised count straight through', async () => {
    const { call } = setup();
    expect(await call('get-normalized-count')).toBe(12);
  });

  it('normalises a selection and sends numeric track ids, not string keys', async () => {
    const { call, sent } = setup();

    const res = await call('normalize-tracks-audio', { trackIds: [3, 4, 5] });

    expect(res).toEqual({ normalized: 2, skipped: 1 });
    const updates = sent.filter(([ch]) => ch === 'track-updated').map(([, d]) => d);
    expect(updates).toEqual([
      { trackId: 3, analysis: { replay_gain: -7.1 } },
      { trackId: 4, analysis: { replay_gain: -6.4 } },
    ]);
  });

  it('still finishes the progress line when nothing could be normalised', async () => {
    const { call, sent } = setup({ normalizeTracksByIds: vi.fn(() => ({})) });

    const res = await call('normalize-tracks-audio', { trackIds: [1, 2] });

    expect(res).toEqual({ normalized: 0, skipped: 2 });
    expect(sent.at(-1)).toEqual(['normalize-progress', { completed: 2, total: 2, done: true }]);
  });
});
