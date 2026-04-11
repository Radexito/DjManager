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

export function updateCuePoint(id, { label, color }) {
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
