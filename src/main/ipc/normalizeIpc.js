/**
 * Loudness normalisation (tor B, slice 16).
 *
 * Four channels moved out of `src/main.js`. Two of them change gain for a
 * batch of tracks, and both must tell the renderer the new `replay_gain` per
 * track afterwards, otherwise the list keeps showing the old value until the
 * next full reload.
 *
 * The progress line finishes with `done: true` in every case, including a batch
 * where nothing was normalised: a spinner left running is worse than the
 * outcome it hides.
 */

import { handle } from './response.js';
/**
 * Register the loudness normalisation channels: normalise the library or a
 * selection, reset it, and report the normalized count. The target loudness
 * comes from the `normalize_target_lufs` setting and the new per-track gain is
 * sent back for every batch, including batches where nothing changed.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @throws {Error} when ipcMain is missing
 */
export function registerNormalizeIpc({
  ipcMain,
  send = () => {},

  getSetting,
  getTrackById,
  getTrackIdsNeedingNormalization,
  getNormalizedTrackCount,
  normalizeLibrary,
  normalizeTracksByIds,
  resetNormalization,
}) {
  if (!ipcMain) throw new Error('registerNormalizeIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  const targetLufs = () => Number(getSetting('normalize_target_lufs', '-9'));

  register('normalize-library', () => {
    const normalized = normalizeLibrary(targetLufs());
    const trackIds = getTrackIdsNeedingNormalization();

    for (const trackId of trackIds) {
      const track = getTrackById(trackId);
      if (track?.replay_gain != null) {
        send('track-updated', { trackId, analysis: { replay_gain: track.replay_gain } });
      }
    }
    send('normalize-progress', { completed: normalized, total: normalized, done: true });
    return { normalized, skipped: 0, total: normalized };
  });

  register('reset-normalization', (_, { trackIds } = {}) => {
    const ids = trackIds?.length ? trackIds : null;
    const updated = resetNormalization(ids);

    const affectedIds = ids ?? getTrackIdsNeedingNormalization();
    for (const id of affectedIds) {
      send('track-updated', { trackId: id, analysis: { replay_gain: null } });
    }
    return { updated };
  });

  register('get-normalized-count', () => getNormalizedTrackCount());

  register('normalize-tracks-audio', (_, { trackIds }) => {
    const gains = normalizeTracksByIds(trackIds, targetLufs());
    const normalized = Object.keys(gains).length;
    const skipped = trackIds.length - normalized;

    for (const [id, replay_gain] of Object.entries(gains)) {
      send('track-updated', { trackId: Number(id), analysis: { replay_gain } });
    }
    send('normalize-progress', {
      completed: trackIds.length,
      total: trackIds.length,
      done: true,
    });
    return { normalized, skipped };
  });
}
