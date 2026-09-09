import db from './database.js';

export function getCuePoints(trackId) {
  return db
    .prepare('SELECT * FROM cue_points WHERE track_id = ? ORDER BY position_ms ASC')
    .all(trackId);
}

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

export function updateCuePoint(id, { label, color, hotCueIndex, enabled }) {
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
  if (fields.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE cue_points SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteCuePoint(id) {
  db.prepare('DELETE FROM cue_points WHERE id = ?').run(id);
}

export function deleteAllCuePoints(trackId) {
  db.prepare('DELETE FROM cue_points WHERE track_id = ?').run(trackId);
}

export function deleteAllCuePointsLibrary() {
  // Returns the list of affected track IDs before wiping
  const affected = db
    .prepare('SELECT DISTINCT track_id FROM cue_points')
    .all()
    .map((r) => r.track_id);
  db.prepare('DELETE FROM cue_points').run();
  return affected;
}

// Auto-naming scheme for sequential cues ("Cue 1", "Cue 2", ...). Cues with
// custom labels (e.g. "Mix In", "Drop") must never be touched by renumbering.
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
