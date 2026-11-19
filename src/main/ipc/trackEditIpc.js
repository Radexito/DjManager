/**
 * Track mutations and analysis control (tor B, slice 13).
 *
 * Eight channels moved out of `src/main.js`: reanalysis and cancellation, the
 * three removal paths, the metadata update, the editor waveform, and the BPM
 * adjustment. It sits beside `trackIpc.js` rather than inside it because these
 * are writes; the read module stays free of side effects.
 *
 * Two rules carried over unchanged, because losing either one destroys data:
 *   - an imported track owns its copy under userData/audio, but two rows can
 *     share one file_path (SHA-1 import dedup is not transactional), so the file
 *     is only deleted when no row references it any more;
 *   - a linked track's file is never deleted by remove-track; that needs the
 *     explicit remove-linked-file channel.
 */
import fs from 'node:fs';
import { AppError, handle } from './response.js';

/**
 * Register the track mutation channels: reanalysis and cancellation, the three
 * removal paths, metadata updates, the editor waveform and BPM adjustment. An
 * imported file is only deleted when no other row points at it; a linked file
 * is never deleted here.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @param {object} [deps.fsImpl] filesystem implementation to use instead of node:fs
 * @throws {Error} when ipcMain is missing
 */
export function registerTrackEditIpc({
  ipcMain,
  send = () => {},

  getTrackById,
  updateTrack,
  removeTrack,
  removeTracks,
  getTrackCountByFilePath,
  spawnAnalysis,
  cancelAnalysis,
  writeId3Tags,
  generateEditorWaveform,
  regenerateHiresWaveform,
  getFfmpegRuntimePath,
  error = () => {},
  fsImpl = fs,
}) {
  if (!ipcMain) throw new Error('registerTrackEditIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('reanalyze-track', (_, trackId) => {
    const track = getTrackById(trackId);
    if (!track) throw new AppError('track-not-found', `Track ${trackId} not found`);
    spawnAnalysis(trackId, track.file_path);
    return { ok: true };
  });

  register('cancel-analysis', (_, trackId) => ({ cancelled: cancelAnalysis(trackId) }));

  register('remove-track', (_, trackId) => {
    const track = getTrackById(trackId);
    removeTrack(trackId);
    if (track && !track.is_linked && track.file_path) {
      if (getTrackCountByFilePath(track.file_path) === 0) {
        try {
          fsImpl.unlinkSync(track.file_path);
        } catch {}
      }
    }
    send('playlists-updated');
    return { ok: true };
  });

  register('remove-tracks', (_, trackIds) => {
    const total = trackIds.length;
    const tracks = trackIds.map((id) => getTrackById(id)).filter(Boolean);

    removeTracks(trackIds);

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (!track.is_linked && track.file_path && getTrackCountByFilePath(track.file_path) === 0) {
        try {
          fsImpl.unlinkSync(track.file_path);
        } catch {}
      }
      send('remove-tracks-progress', { completed: i + 1, total });
    }

    send('playlists-updated');
    send('remove-tracks-progress', { completed: total, total, done: true });
    return { ok: true, total };
  });

  register('remove-linked-file', async (_, trackId) => {
    const track = getTrackById(trackId);
    if (!track) return { ok: false, error: 'not found' };
    const filePath = track.file_path;
    removeTrack(trackId);
    try {
      fsImpl.unlinkSync(filePath);
    } catch {}
    send('library-updated');
    send('playlists-updated');
    return { ok: true };
  });

  register('update-track', (_, { id, data }) => {
    updateTrack(id, data);
    const track = getTrackById(id);
    send('track-updated', { trackId: id, analysis: data });

    if (track?.file_path) {
      writeId3Tags(track.file_path, data).catch((e) =>
        error('[update-track] id3 write failed:', e.message)
      );
    }
    return { ok: true };
  });

  register('get-editor-waveform', async (_, trackId) => {
    const track = getTrackById(trackId);
    if (!track?.file_path) return null;

    if (track.waveform_detail_hires != null) {
      return {
        detail: track.waveform_detail_hires,
        overview: track.waveform_overview ?? null,
        numCols: Math.floor(track.waveform_detail_hires.length / 3),
      };
    }

    try {
      const result = await generateEditorWaveform(track.file_path, getFfmpegRuntimePath());
      regenerateHiresWaveform(trackId, track.file_path);
      return { detail: result.detail, overview: result.overview, numCols: result.numCols };
    } catch (e) {
      error('[get-editor-waveform]', e.message);
      return null;
    }
  });

  register('adjust-bpm', (_, { trackIds, factor }) => {
    if (factor !== 2 && factor !== 0.5)
      throw new AppError('invalid-factor', 'Invalid factor: must be 2 or 0.5');
    if (!Array.isArray(trackIds) || trackIds.length === 0 || trackIds.length > 500) {
      throw new AppError(
        'invalid-selection',
        'Invalid trackIds: must be a non-empty array of up to 500 IDs'
      );
    }

    const results = [];
    for (const id of trackIds) {
      const track = getTrackById(id);
      if (!track) continue;
      const base = track.bpm_override ?? track.bpm;
      if (base == null) continue;
      const newBpm = Math.round(base * factor * 10) / 10;
      updateTrack(id, { bpm_override: newBpm });
      results.push({ id, bpm_override: newBpm });
    }
    return results;
  });
}
