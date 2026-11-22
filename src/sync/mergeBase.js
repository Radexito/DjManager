import {
  saveDeviceSyncState,
  savePlaylistStates,
  saveTrackStates,
} from '../db/deviceStateRepository.js';
import { manifestToJson } from '../usb/pioneer/manifest.js';

/**
 * Rebuild what this application knows about a device from the manifest on the
 * medium, for a database that has no record of it.
 *
 * A stick can come back from another machine, or the application database can
 * be restored from a backup without the device rows. The manifest carries the
 * mapping the device had: which library track became which file, and at which
 * revision. What it cannot answer is a track the library no longer has; that
 * loss is reported instead of being hidden.
 *
 * @param {object} options
 * @param {string} options.deviceKey identity of the medium
 * @param {object} options.manifest loaded manifest
 * @param {function(number): object|null} options.resolveTrack library lookup
 * @param {string|null} [options.libraryRevision] revision to record, if known
 * @param {function(): number} [options.now]
 * @returns {{restored: number, lost: object[]}}
 */
export function rebuildMergeBase({
  deviceKey,
  manifest,
  resolveTrack,
  libraryRevision = null,
  now = Date.now,
}) {
  if (!deviceKey) throw new Error('rebuildMergeBase: deviceKey is required');
  const tracks = [];
  const lost = [];

  for (const [id, row] of manifest.tracks ?? new Map()) {
    const track = resolveTrack?.(id) ?? null;
    if (!track) {
      lost.push({ trackId: id, filePath: row?.file_path ?? null });
      continue;
    }
    tracks.push({
      trackId: id,
      deviceTrackId: row?.id ?? id,
      filePath: row?.file_path ?? track.file_path ?? null,
      rev: row?.rev ?? track.rev ?? null,
      hash: row?.hash ?? track.file_hash ?? null,
      fileFingerprint: row?.file_fingerprint ?? track.file_fingerprint ?? null,
    });
  }

  saveTrackStates(deviceKey, tracks, { now: now() });
  savePlaylistStates(
    deviceKey,
    [...(manifest.playlists ?? new Map()).values()].map((playlist) => ({
      playlistId: playlist.id,
      rev: playlist.rev ?? null,
      signature: (playlist.track_ids ?? []).join(','),
    })),
    { now: now() }
  );
  saveDeviceSyncState({
    deviceKey,
    exportId: manifest.exportId ?? null,
    lastSync: manifest.lastSync ?? null,
    // The manifest does not carry the library revision it was built from, so
    // leave it unset: the next sync compares revisions and finds no actions.
    libraryRevision,
    manifestJson: JSON.stringify(manifestToJson(manifest)),
    now: now(),
  });

  return { restored: tracks.length, lost };
}
