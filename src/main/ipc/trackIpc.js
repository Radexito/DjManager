/**
 * Track reads and tag writing (tor B, slice 12).
 *
 * Eight channels moved out of `src/main.js`. Seven are thin reads over the
 * repository; `write-bpm-key-tags` is the one that does work, and it is the one
 * whose failure shape matters: it must report per track rather than abort the
 * batch, because the user picked a selection and expects to hear which files
 * were updated and which were left alone.
 */
import fs from 'node:fs';
import { handle } from './response.js';

/**
 * Register the track read channels — paged list, count, rank, ids, single track,
 * unavailable linked tracks and the stored waveform — plus
 * `write-bpm-key-tags`, which reports per track instead of failing the batch.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {object} [deps.fsImpl] filesystem implementation to use instead of node:fs
 * @throws {Error} when ipcMain is missing
 */
export function registerTrackIpc({
  ipcMain,
  getTracks,
  countTracks,
  getTrackRank,
  getTrackIds,
  getTrackById,
  getLinkedTracksBasic,
  getTrackWaveform,
  writeBpmKeyTagsForTrack,
  fsImpl = fs,
}) {
  if (!ipcMain) throw new Error('registerTrackIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('get-tracks', (_, params) => getTracks(params));
  register('count-tracks', (_, params) => countTracks(params));
  register('get-track-rank', (_, params) => getTrackRank(params));
  register('get-track-ids', (_, params) => getTrackIds(params));
  register('get-track-by-id', (_, trackId) => getTrackById(trackId) ?? null);

  register('get-unavailable-linked-tracks', () =>
    getLinkedTracksBasic()
      .filter((t) => !fsImpl.existsSync(t.file_path))
      .map((t) => t.id)
  );

  register('get-track-waveform', (_, trackId) => {
    const buf = getTrackWaveform(trackId);
    return buf ? new Uint8Array(buf) : null;
  });

  register('write-bpm-key-tags', async (_, { trackIds = [] } = {}) => {
    const results = [];
    for (const id of trackIds) {
      try {
        results.push(await writeBpmKeyTagsForTrack(id));
      } catch (err) {
        results.push({ trackId: id, ok: false, reason: 'error', error: err.message });
      }
    }
    const written = results.filter((r) => r.ok && (r.wrote?.length ?? 0) > 0).length;
    return { ok: true, written, skipped: results.length - written, results };
  });
}
