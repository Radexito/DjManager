import db from './database.js';

/**
 * The application side of the merge base: what this library last wrote to a
 * device, addressed by the device's own key rather than by a mount point.
 *
 * Three tables. `device_sync_state` keeps one row per device: its identity, the
 * export id, the library revision it saw, and the last manifest it wrote.
 * `device_track_state` keeps one row per track this device carries, with the
 * revision and file fingerprint that were published. `device_playlist_state`
 * does the same for playlists and their ordered membership. `device_cue_base`
 * keeps the cue set that was the base for a merge, so a later comparison can
 * tell which side changed.
 */

const SYNC_COLUMNS = [
  'export_id',
  'label',
  'serial',
  'filesystem',
  'last_mount_path',
  'last_sync',
  'library_revision',
  'manifest_json',
];

/** Insert or update the one row for a device. */
export function saveDeviceSyncState({
  deviceKey,
  exportId = null,
  label = null,
  serial = null,
  filesystem = null,
  mountPath = null,
  lastSync = null,
  libraryRevision = null,
  manifestJson = null,
  now = Date.now(),
} = {}) {
  if (!deviceKey) throw new Error('saveDeviceSyncState: deviceKey is required');
  db.prepare(
    `
    INSERT INTO device_sync_state (
      device_key, export_id, label, serial, filesystem, last_mount_path,
      last_sync, library_revision, manifest_json, updated_at
    ) VALUES (
      @device_key, @export_id, @label, @serial, @filesystem, @last_mount_path,
      @last_sync, @library_revision, @manifest_json, @updated_at
    )
    ON CONFLICT(device_key) DO UPDATE SET
      ${SYNC_COLUMNS.map((column) => `${column} = excluded.${column}`).join(',\n      ')},
      updated_at = excluded.updated_at
  `
  ).run({
    device_key: deviceKey,
    export_id: exportId,
    label,
    serial,
    filesystem,
    last_mount_path: mountPath,
    last_sync: lastSync,
    library_revision: libraryRevision,
    manifest_json: manifestJson,
    updated_at: now,
  });
}

/** The device row, or null when this database never wrote to it. */
export function getDeviceSyncState(deviceKey) {
  return db.prepare('SELECT * FROM device_sync_state WHERE device_key = ?').get(deviceKey) ?? null;
}

/** One row per track the device carries. */
export function saveTrackStates(
  deviceKey,
  entries = [],
  { now = Date.now(), keepMissing = false } = {}
) {
  if (!deviceKey) throw new Error('saveTrackStates: deviceKey is required');
  const upsert = db.prepare(
    `
    INSERT INTO device_track_state (
      device_key, track_id, device_track_id, file_path, rev, hash, file_fingerprint, exported_at
    ) VALUES (
      @device_key, @track_id, @device_track_id, @file_path, @rev, @hash, @file_fingerprint, @exported_at
    )
    ON CONFLICT(device_key, track_id) DO UPDATE SET
      device_track_id = excluded.device_track_id,
      file_path = excluded.file_path,
      rev = excluded.rev,
      hash = excluded.hash,
      file_fingerprint = excluded.file_fingerprint,
      exported_at = excluded.exported_at
  `
  );
  db.transaction(() => {
    for (const entry of entries) {
      upsert.run({
        device_key: deviceKey,
        track_id: entry.trackId ?? entry.track_id,
        device_track_id: entry.deviceTrackId ?? entry.device_track_id ?? null,
        file_path: entry.filePath ?? entry.file_path ?? null,
        rev: entry.rev ?? null,
        hash: entry.hash ?? null,
        file_fingerprint: entry.fileFingerprint ?? entry.file_fingerprint ?? null,
        exported_at: now,
      });
    }
    if (!keepMissing) {
      const keep = new Set(entries.map((entry) => entry.trackId ?? entry.track_id));
      for (const row of db
        .prepare('SELECT track_id FROM device_track_state WHERE device_key = ?')
        .all(deviceKey)) {
        if (!keep.has(row.track_id)) {
          db.prepare('DELETE FROM device_track_state WHERE device_key = ? AND track_id = ?').run(
            deviceKey,
            row.track_id
          );
        }
      }
    }
  })();
}

/** Track states of one device, keyed by library track id. */
export function getTrackStates(deviceKey) {
  const rows = db.prepare('SELECT * FROM device_track_state WHERE device_key = ?').all(deviceKey);
  return new Map(rows.map((row) => [row.track_id, row]));
}

/** One row per playlist the device carries, with its ordered membership. */
export function savePlaylistStates(deviceKey, entries = [], { now = Date.now() } = {}) {
  if (!deviceKey) throw new Error('savePlaylistStates: deviceKey is required');
  const upsert = db.prepare(
    `
    INSERT INTO device_playlist_state (device_key, playlist_id, rev, signature, exported_at)
    VALUES (@device_key, @playlist_id, @rev, @signature, @exported_at)
    ON CONFLICT(device_key, playlist_id) DO UPDATE SET
      rev = excluded.rev,
      signature = excluded.signature,
      exported_at = excluded.exported_at
  `
  );
  db.transaction(() => {
    for (const entry of entries) {
      upsert.run({
        device_key: deviceKey,
        playlist_id: entry.playlistId ?? entry.playlist_id,
        rev: entry.rev ?? null,
        signature: entry.signature ?? '',
        exported_at: now,
      });
    }
  })();
}

/** Playlist states of one device, keyed by library playlist id. */
export function getPlaylistStates(deviceKey) {
  const rows = db
    .prepare('SELECT * FROM device_playlist_state WHERE device_key = ?')
    .all(deviceKey);
  return new Map(rows.map((row) => [row.playlist_id, row]));
}

/** Remember the cue set a track had when it was exported. */
export function saveCueBase({ deviceKey, trackId, hash = null, cues = [], now = Date.now() }) {
  db.prepare(
    `
    INSERT INTO device_cue_base (device_key, track_id, hash, cue_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_key, track_id) DO UPDATE SET
      hash = excluded.hash,
      cue_json = excluded.cue_json,
      updated_at = excluded.updated_at
  `
  ).run(deviceKey, trackId, hash, JSON.stringify(cues), now);
}

/** The cue set a track had when it was exported, or null. */
export function getCueBase(deviceKey, trackId) {
  const row = db
    .prepare('SELECT * FROM device_cue_base WHERE device_key = ? AND track_id = ?')
    .get(deviceKey, trackId);
  if (!row) return null;
  try {
    return { ...row, cues: JSON.parse(row.cue_json) };
  } catch {
    return { ...row, cues: [] };
  }
}

/** Forget everything about a device. Test and repair helper. */
export function deleteDeviceState(deviceKey) {
  db.prepare('DELETE FROM device_track_state WHERE device_key = ?').run(deviceKey);
  db.prepare('DELETE FROM device_playlist_state WHERE device_key = ?').run(deviceKey);
  db.prepare('DELETE FROM device_cue_base WHERE device_key = ?').run(deviceKey);
  db.prepare('DELETE FROM device_sync_state WHERE device_key = ?').run(deviceKey);
}
