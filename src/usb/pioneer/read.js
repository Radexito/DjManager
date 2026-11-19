import path from 'node:path';

import { loadManifest } from './manifest.js';
import { readTrackCues, buildCueImportPlan } from './formats/cues.js';

/**
 * Reading side of a Pioneer medium.
 *
 * The library lookup and the existing cue rows are handed in rather than
 * imported, so this module never reaches into the application database: it
 * answers what the stick carries, and the caller decides what to do with it.
 */

export function scanUsbCues({
  root: usbRoot,
  mode = 'extend',
  resolveTrack,
  getExistingCues = () => [],
}) {
  const manifest = loadManifest(usbRoot);
  const tracks = [];
  for (const [id, row] of manifest.tracks) {
    const trackId = Number(id);
    const track = resolveTrack(trackId);
    if (!track || !row?.file_path) continue;
    const usbCues = readTrackCues(usbRoot, row.file_path);
    const existingCues = getExistingCues(trackId);
    if (usbCues.length === 0 && !(mode === 'replace' && existingCues.length > 0)) continue;
    const plan = buildCueImportPlan({ usbCues, existingCues, mode });
    tracks.push({
      trackId,
      title: track.title || path.basename(track.file_path || ''),
      usbFilePath: row.file_path,
      cues: usbCues,
      add: plan.add,
      update: plan.update,
      skip: plan.skip,
      remove: plan.remove,
    });
  }
  const summary = tracks.reduce(
    (acc, t) => ({
      tracks: acc.tracks + 1,
      cues: acc.cues + t.cues.length,
      add: acc.add + t.add.length,
      update: acc.update + t.update.length,
      skip: acc.skip + t.skip.length,
      remove: acc.remove + t.remove.length,
    }),
    { tracks: 0, cues: 0, add: 0, update: 0, skip: 0, remove: 0 }
  );
  return { ok: true, usbRoot, mode: mode === 'replace' ? 'replace' : 'extend', tracks, summary };
}
