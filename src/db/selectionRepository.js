import db from './database.js';

/**
 * What a device is meant to carry, and what the last apply did.
 *
 * The selection is stored per device key, so it survives a new drive letter and
 * a re-plug. It holds playlists today; the `kind` column leaves room for the
 * collection or a folder once those exist as sync roots.
 */

/** Replace the stored selection of a device. */
export function saveSelection(deviceKey, playlistIds = [], { now = Date.now } = {}) {
  if (!deviceKey) throw new Error('saveSelection: deviceKey is required');
  const ids = [...new Set(playlistIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  db.transaction(() => {
    db.prepare('DELETE FROM device_selection WHERE device_key = ?').run(deviceKey);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO device_selection (device_key, kind, ref_id, created_at)
       VALUES (?, 'playlist', ?, ?)`
    );
    for (const id of ids) insert.run(deviceKey, id, now());
  })();
  return ids;
}

/** The stored selection of a device: playlist ids, oldest first. */
export function getSelection(deviceKey) {
  if (!deviceKey) return { playlists: [], kinds: [] };
  const rows = db
    .prepare(
      'SELECT kind, ref_id FROM device_selection WHERE device_key = ? ORDER BY created_at, ref_id'
    )
    .all(deviceKey);
  return {
    playlists: rows.filter((row) => row.kind === 'playlist').map((row) => Number(row.ref_id)),
    kinds: [...new Set(rows.map((row) => row.kind))],
  };
}

/** Remember the action list the last apply executed. */
export function saveLastPlan({
  deviceKey,
  hash = null,
  actions = [],
  summary = null,
  now = Date.now,
}) {
  db.prepare(
    `
    INSERT INTO device_last_plan (device_key, plan_hash, plan_json, summary, applied_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_key) DO UPDATE SET
      plan_hash = excluded.plan_hash,
      plan_json = excluded.plan_json,
      summary = excluded.summary,
      applied_at = excluded.applied_at
  `
  ).run(deviceKey, hash, JSON.stringify(actions), summary ? JSON.stringify(summary) : null, now());
}

/** The action list of the last apply, or null. */
export function getLastPlan(deviceKey) {
  const row = db.prepare('SELECT * FROM device_last_plan WHERE device_key = ?').get(deviceKey);
  if (!row) return null;
  try {
    return {
      hash: row.plan_hash,
      actions: JSON.parse(row.plan_json),
      summary: row.summary ? JSON.parse(row.summary) : null,
      appliedAt: row.applied_at,
    };
  } catch {
    return null;
  }
}
