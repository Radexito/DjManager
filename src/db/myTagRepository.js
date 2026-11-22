import db from './database.js';

/**
 * My Tags: the tree a user builds and the assignments that reach a device.
 *
 * The tree is stored flat (parent_id plus sequence_no) because that is what
 * exportLibrary.db and exportExt.pdb need, and the nesting is presentation. A
 * rename bumps the revision of every track assigned to that tag, and an
 * assignment bumps the track itself, so the sync sees a tag change the same way
 * it sees a metadata edit.
 */

const now = () => Date.now();

function nextSequence(parentId) {
  const row = db
    .prepare('SELECT COALESCE(MAX(sequence_no), -1) AS last FROM my_tags WHERE parent_id IS ?')
    .get(parentId);
  return Number(row?.last ?? -1) + 1;
}

/** Every tag, flat, in display order. */
export function listMyTags() {
  return db
    .prepare('SELECT * FROM my_tags ORDER BY parent_id IS NOT NULL, parent_id, sequence_no, name')
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id ?? null,
      sequenceNo: row.sequence_no,
      attribute: row.attribute,
      rev: row.rev,
    }));
}

/** The tree, for a caller that wants to render it. */
export function getMyTagTree() {
  const rows = listMyTags();
  const byId = new Map(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots = [];
  for (const row of byId.values()) {
    if (row.parentId != null && byId.has(row.parentId)) byId.get(row.parentId).children.push(row);
    else roots.push(row);
  }
  return roots;
}

export function getMyTag(id) {
  const row = db.prepare('SELECT * FROM my_tags WHERE id = ?').get(id);
  return row
    ? {
        id: row.id,
        name: row.name,
        parentId: row.parent_id ?? null,
        sequenceNo: row.sequence_no,
        attribute: row.attribute,
        rev: row.rev,
      }
    : null;
}

export function createMyTag({ name, parentId = null, attribute = 0 } = {}) {
  const label = String(name ?? '').trim();
  if (!label) throw new Error('a tag needs a name');
  if (parentId != null && !getMyTag(parentId)) throw new Error('parent tag does not exist');
  const at = now();
  const info = db
    .prepare(
      `INSERT INTO my_tags (name, parent_id, sequence_no, attribute, created_at, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(label, parentId, nextSequence(parentId), Number(attribute) ? 1 : 0, at, at);
  return getMyTag(info.lastInsertRowid);
}

export function renameMyTag(id, name) {
  const label = String(name ?? '').trim();
  if (!label) throw new Error('a tag needs a name');
  const info = db.prepare('UPDATE my_tags SET name = ? WHERE id = ?').run(label, id);
  if (info.changes === 0) throw new Error('tag does not exist');
  return getMyTag(id);
}

/** The tag and everything under it. */
export function myTagSubtree(id) {
  return db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM my_tags WHERE id = ?
         UNION ALL
         SELECT t.id FROM my_tags t JOIN tree ON t.parent_id = tree.id
       )
       SELECT id FROM tree`
    )
    .all(id)
    .map((row) => row.id);
}

export function deleteMyTag(id) {
  const ids = myTagSubtree(id);
  if (ids.length === 0) return false;
  const placeholders = ids.map(() => '?').join(',');
  // Cascades remove the assignment rows, but a cascade does not fire the delete
  // trigger, so the tracks are bumped here before the rows disappear.
  db.prepare(
    `UPDATE tracks SET rev = rev + 1, updated_at = ?
      WHERE id IN (SELECT track_id FROM track_my_tags WHERE tag_id IN (${placeholders}))`
  ).run(now(), ...ids);
  db.prepare(`DELETE FROM my_tags WHERE id IN (${placeholders})`).run(...ids);
  return true;
}

export function assignMyTag(trackId, tagId, assigned = true) {
  if (!getMyTag(tagId)) throw new Error('tag does not exist');
  if (assigned) {
    db.prepare(
      'INSERT OR IGNORE INTO track_my_tags (track_id, tag_id, assigned_at) VALUES (?, ?, ?)'
    ).run(trackId, tagId, now());
  } else {
    db.prepare('DELETE FROM track_my_tags WHERE track_id = ? AND tag_id = ?').run(trackId, tagId);
  }
  return getTagsForTrack(trackId);
}

export function getTagsForTrack(trackId) {
  return db
    .prepare(
      `SELECT t.* FROM my_tags t
        JOIN track_my_tags a ON a.tag_id = t.id
       WHERE a.track_id = ?
       ORDER BY t.parent_id IS NOT NULL, t.parent_id, t.sequence_no, t.name`
    )
    .all(trackId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id ?? null,
      sequenceNo: row.sequence_no,
      attribute: row.attribute,
    }));
}

export function getTrackIdsForTag(tagId) {
  return db
    .prepare('SELECT track_id FROM track_my_tags WHERE tag_id = ? ORDER BY track_id')
    .all(tagId)
    .map((row) => row.track_id);
}

/** Assignments for a set of tracks, as the export needs them. */
export function getAssignmentsForTracks(trackIds = []) {
  if (trackIds.length === 0) return [];
  const placeholders = trackIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT track_id, tag_id FROM track_my_tags
        WHERE track_id IN (${placeholders})
        ORDER BY track_id, tag_id`
    )
    .all(...trackIds);
}

/** The id shared by exportExt.pdb and the library's property row. */
export function getMyTagMasterId() {
  // Existing libraries predate this row, and a test or a settings reset can drop
  // it, so it is created on demand rather than assumed.
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value)
     VALUES ('my_tag_master_id', CAST(abs(random()) % 4294967295 AS TEXT))`
  ).run();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'my_tag_master_id'").get();
  let value = Number(row?.value);
  if (!Number.isFinite(value) || value <= 0) {
    db.prepare(
      `UPDATE settings SET value = CAST(abs(random()) % 4294967295 AS TEXT)
        WHERE key = 'my_tag_master_id'`
    ).run();
    value = Number(
      db.prepare("SELECT value FROM settings WHERE key = 'my_tag_master_id'").get()?.value
    );
  }
  return value >>> 0;
}
