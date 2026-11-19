/**
 * Cue points and bulk waveform generation (tor B, slice 11).
 *
 * Eight channels moved out of `src/main.js`. Two of them walk the whole
 * library, so they are the longest-running handlers the app has: progress and
 * completion go through the injected `send`, which is also what removes the
 * last `global.mainWindow` reach-through from this domain.
 *
 * The renumbering rule is the subtle part and is preserved deliberately: adding
 * or renaming a sequentially-named cue shifts the positional order, so the
 * following auto-named cues are renumbered to keep names unique (#253).
 */

import { handle } from './response.js';
/**
 * Register the cue point channels (list, add, rename, delete, bulk waveform
 * generation) on ipcMain. Every collaborator is injected; progress and
 * completion are pushed through `send`.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @throws {Error} when ipcMain is missing
 */
export function registerCuePointIpc({
  ipcMain,
  send = () => {},

  getCuePoints,
  addCuePoint,
  getCuePointById,
  updateCuePoint,
  deleteCuePoint,
  deleteAllCuePoints,
  deleteAllCuePointsLibrary,
  generateCuePoints,
  renumberSequentialCuesAfter,
  getTrackById,
  getTracks,
  generateWaveformOverview,
  updateTrackWaveform,
  getFfmpegRuntimePath,
  warn = () => {},
}) {
  if (!ipcMain) throw new Error('registerCuePointIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('get-cue-points', (_, trackId) => getCuePoints(trackId));

  register('add-cue-point', (_, { trackId, positionMs, label, color, hotCueIndex }) => {
    const id = addCuePoint({ trackId, positionMs, label, color, hotCueIndex });
    renumberSequentialCuesAfter(trackId, id);
    return { id };
  });

  register('update-cue-point', (_, { id, label, color, hotCueIndex, enabled }) => {
    const before = getCuePointById(id);
    updateCuePoint(id, { label, color, hotCueIndex, enabled });
    if (before && typeof label === 'string') {
      renumberSequentialCuesAfter(before.track_id, id);
    }
    return { ok: true };
  });

  register('delete-cue-point', (_, id) => {
    deleteCuePoint(id);
    return { ok: true };
  });

  register('generate-cue-points', (_, trackId) => {
    const track = getTrackById(trackId);
    if (!track) throw new Error(`Track ${trackId} not found`);
    deleteAllCuePoints(trackId);
    const generated = generateCuePoints(track);
    generated.forEach((cue) => addCuePoint({ trackId, ...cue }));
    return getCuePoints(trackId);
  });

  register('generate-cue-points-library', (_, { overwrite = false } = {}) => {
    const analyzed = getTracks({ limit: 999999 }).filter((t) => t.analyzed === 1);
    const total = analyzed.length;
    let generated = 0;
    let skipped = 0;

    const reportProgress = (done = false) => {
      send('cue-gen-progress', { completed: generated + skipped, total, done });
    };

    for (const track of analyzed) {
      const existing = getCuePoints(track.id);
      if (!overwrite && existing.length > 0) {
        skipped++;
        reportProgress();
        continue;
      }
      deleteAllCuePoints(track.id);
      const cues = generateCuePoints(track);
      cues.forEach((cue) => addCuePoint({ trackId: track.id, ...cue }));
      generated++;
      send('cue-points-updated', { trackId: track.id, cueCount: cues.length });
      reportProgress();
    }

    reportProgress(true);
    return { generated, skipped, total };
  });

  register('delete-all-cue-points-library', () => {
    const affected = deleteAllCuePointsLibrary();
    for (const trackId of affected) {
      send('cue-points-updated', { trackId, cueCount: 0 });
    }
    return { deleted: affected.length };
  });

  register('generate-waveforms-library', async (_, { overwrite = false } = {}) => {
    const analyzed = getTracks({ limit: 999999 }).filter((t) => t.analyzed === 1);
    const total = analyzed.length;
    let generated = 0;
    let skipped = 0;

    const reportProgress = (done = false) => {
      send('waveform-gen-progress', { completed: generated + skipped, total, done });
    };

    for (const track of analyzed) {
      if (!overwrite && track.waveform_overview != null) {
        skipped++;
        reportProgress();
        continue;
      }
      try {
        const buf = await generateWaveformOverview(track.file_path, getFfmpegRuntimePath());
        updateTrackWaveform(track.id, buf);
        generated++;
      } catch (err) {
        warn(`[waveform-gen] failed for track ${track.id}:`, err.message);
        skipped++;
      }
      reportProgress();
    }

    reportProgress(true);
    return { generated, skipped, total };
  });
}
