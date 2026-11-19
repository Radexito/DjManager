import db from './database.js';

/** Every cue point of a track, ordered by position from the start of the track. */
export function getCuePoints(trackId) {
  return db
    .prepare('SELECT * FROM cue_points WHERE track_id = ? ORDER BY position_ms ASC')
    .all(trackId);
}

/**
 * Insert a cue point for a track.
 * @param {object} cue
 * @param {number} cue.trackId owning track
 * @param {number} cue.positionMs offset from the start of the track, in milliseconds
 * @param {string} [cue.label] display label, empty when not given
 * @param {string} [cue.color] hex colour, defaults to #00b4d8
 * @param {number} [cue.hotCueIndex] hot cue slot, -1 when the cue is not bound to one
 * @returns {number} rowid of the inserted cue point
 */
export function addCuePoint({
  trackId,
  positionMs,
  label = '',
  color = '#00b4d8',
  hotCueIndex = -1,
}) {
  const info = db
    .prepare(
      `INSERT INTO cue_points (track_id, position_ms, label, color, hot_cue_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(trackId, positionMs, label, color, hotCueIndex, Date.now());
  return info.lastInsertRowid;
}

/**
 * Patch a cue point: only the fields that are not `undefined` are written, so a
 * rename does not touch the position and vice versa. Does nothing when no field
 * is given.
 * @param {number} id cue point id
 * @param {object} fields
 * @param {string} [fields.label]
 * @param {string} [fields.color]
 * @param {number} [fields.hotCueIndex]
 * @param {boolean} [fields.enabled] stored as 1/0
 * @param {number} [fields.positionMs]
 */
export function updateCuePoint(id, { label, color, hotCueIndex, enabled, positionMs }) {
  const fields = [];
  const vals = [];
  if (label !== undefined) {
    fields.push('label = ?');
    vals.push(label);
  }
  if (color !== undefined) {
    fields.push('color = ?');
    vals.push(color);
  }
  if (hotCueIndex !== undefined) {
    fields.push('hot_cue_index = ?');
    vals.push(hotCueIndex);
  }
  if (enabled !== undefined) {
    fields.push('enabled = ?');
    vals.push(enabled ? 1 : 0);
  }
  if (positionMs !== undefined) {
    fields.push('position_ms = ?');
    vals.push(positionMs);
  }
  if (fields.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE cue_points SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

/** Delete one cue point. */
export function deleteCuePoint(id) {
  db.prepare('DELETE FROM cue_points WHERE id = ?').run(id);
}

/** Drop every cue point of a single track. */
export function deleteAllCuePoints(trackId) {
  db.prepare('DELETE FROM cue_points WHERE track_id = ?').run(trackId);
}

/**
 * Wipe the cue_points table, e.g. before a full library reset.
 * @returns {number[]} ids of the tracks that had cue points
 */
export function deleteAllCuePointsLibrary() {
  const affected = db
    .prepare('SELECT DISTINCT track_id FROM cue_points')
    .all()
    .map((r) => r.track_id);
  db.prepare('DELETE FROM cue_points').run();
  return affected;
}

/** Matches the auto-generated `Cue N` labels and captures N. */
const SEQUENTIAL_CUE_LABEL = /^Cue (\d+)$/;

/**
 * After a cue is added or renamed to a sequential name (`Cue N`), renumber
 * every following cue (sorted by position) that still uses the same
 * auto-naming scheme, so names stay unique and ordered (#253). Cues with
 * custom labels are left alone. Returns how many labels were rewritten.
 */
export function renumberSequentialCuesAfter(trackId, cueId) {
  const cues = db
    .prepare(`SELECT * FROM cue_points WHERE track_id = ? ORDER BY position_ms ASC, id ASC`)
    .all(trackId);
  const idx = cues.findIndex((c) => c.id === cueId);
  if (idx === -1) return 0;
  const match = SEQUENTIAL_CUE_LABEL.exec(cues[idx].label ?? '');
  if (!match) return 0;
  let nextNum = parseInt(match[1], 10) + 1;
  let updated = 0;
  const update = db.prepare('UPDATE cue_points SET label = ? WHERE id = ?');
  for (let j = idx + 1; j < cues.length; j++) {
    if (!SEQUENTIAL_CUE_LABEL.test(cues[j].label ?? '')) continue;
    const newLabel = `Cue ${nextNum++}`;
    if (cues[j].label !== newLabel) {
      update.run(newLabel, cues[j].id);
      updated++;
    }
  }
  return updated;
}

/**
 * Fetch a single cue point by id (used to resolve the track before a
 * rename-triggered renumber).
 */
export function getCuePointById(id) {
  return db.prepare('SELECT * FROM cue_points WHERE id = ?').get(id);
}
