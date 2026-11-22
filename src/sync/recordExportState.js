import {
  saveDeviceSyncState,
  savePlaylistStates,
  saveTrackStates,
} from '../db/deviceStateRepository.js';
import { readDeviceIdentity } from '../usb/generic/identity.js';
import { manifestToJson } from '../usb/pioneer/manifest.js';

/**
 * Record what an export published, so the next sync can compare revisions
 * instead of rebuilding the library.
 *
 * Called after the journal commits. The revision is the one captured before the
 * first write, not the one after publishing: a change that lands while the
 * export runs must stay visible to the next comparison instead of being
 * swallowed by a timestamp read at the end.
 *
 * @param {object} options
 * @param {string} options.usbRoot
 * @param {object} options.manifest manifest that was published
 * @param {Map|object[]} options.tracks rows written to the device
 * @param {Map|object[]} options.playlists playlists written to the device
 * @param {{key: string}} [options.revision] library revision captured before the export
 * @param {function(string): Promise<object>} [options.readIdentity]
 * @param {function(): number} [options.now]
 * @returns {Promise<string|null>} the device key, or null when no identity
 */
export async function recordExportState({
  usbRoot,
  manifest,
  tracks,
  playlists,
  revision = null,
  readIdentity = readDeviceIdentity,
  now = Date.now,
}) {
  if (!manifest) return null;
  const identity = await readIdentity(usbRoot).catch(() => null);
  if (!identity?.key) return null;

  const trackRows = [...(tracks instanceof Map ? tracks.values() : (tracks ?? []))];
  const playlistRows = [...(playlists instanceof Map ? playlists.values() : (playlists ?? []))];

  saveDeviceSyncState({
    deviceKey: identity.key,
    exportId: manifest.exportId ?? null,
    label: identity.label,
    serial: identity.serial,
    filesystem: identity.filesystem,
    mountPath: usbRoot,
    lastSync: manifest.lastSync ?? now(),
    libraryRevision: revision?.key ?? null,
    manifestJson: JSON.stringify(manifestToJson(manifest)),
    now: now(),
  });

  saveTrackStates(
    identity.key,
    trackRows.map((row) => ({
      trackId: row.id,
      deviceTrackId: row.id,
      filePath: row.file_path,
      rev: row.rev ?? null,
      hash: row.hash ?? row.file_hash ?? null,
      fileFingerprint: row.file_fingerprint ?? null,
    })),
    { now: now() }
  );

  savePlaylistStates(
    identity.key,
    playlistRows.map((playlist) => ({
      playlistId: playlist.id,
      rev: playlist.rev ?? null,
      signature: (playlist.track_ids ?? []).join(','),
    })),
    { now: now() }
  );

  return identity.key;
}
