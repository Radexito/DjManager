import { decodeDeviceSQLString, readPdb } from './pdbRead.js';

/**
 * Reading side of `exportExt.pdb`, which is the only place the My Tags tree
 * lives on a medium.
 *
 * The row layout is the one the writer emits and the one measured on a stick
 * rekordbox tagged: a 31-byte header, the name right behind it, and the tag's
 * own index stored at offset 2 (owned by the page, not by the row). rekordbox
 * stores the name body with a trailing 0x03, so it is stripped here.
 */

/** Table type that carries the tag rows. */
export const EXT_TAG_TABLE = 3;

const EXT_TAG_HEADER_BYTES = 31;

/**
 * One tag row.
 * @param {Buffer} row
 * @returns {{id: number, name: string, categoryId: number, position: number, isCategory: boolean}}
 */
export function decodeExtTagRow(row) {
  const nameAt = row[29] || EXT_TAG_HEADER_BYTES;
  let name = '';
  try {
    name = decodeDeviceSQLString(row, nameAt).value;
  } catch {
    name = '';
  }
  if (name.endsWith('\u0003')) name = name.slice(0, -1);
  return {
    id: row.readUInt32LE(20),
    name,
    categoryId: row.readUInt32LE(12),
    position: row.readUInt32LE(16),
    isCategory: row.readUInt32LE(24) === 0x01000000,
  };
}

/**
 * Keep the first row for every id. An export that ran more than once can leave
 * the same tag row in the file several times; the id is the identity, so the
 * first copy wins and the tree stays the size of the tag set, not of the file.
 * @param {Array<object>} rows decoded rows
 * @returns {Array<object>} rows with unique ids and a name
 */
function uniqueById(rows) {
  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    if (!row.name) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    kept.push(row);
  }
  return kept;
}

/**
 * The tag tree of a medium, categories first with their own tags underneath.
 * @param {Buffer} buffer whole `exportExt.pdb`
 * @returns {Array<{id: number|null, name: string, tags: Array<{id: number, name: string}>}>}
 */
export function readTagTree(buffer) {
  const { tables } = readPdb(buffer);
  const rows = uniqueById((tables.get(EXT_TAG_TABLE) ?? []).map(decodeExtTagRow));
  const categories = rows.filter((row) => row.isCategory);
  const tree = categories.map((category) => ({
    id: category.id,
    name: category.name,
    tags: rows
      .filter((row) => !row.isCategory && row.categoryId === category.id)
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ id: row.id, name: row.name })),
  }));
  // A tag whose category is missing would otherwise disappear from the view.
  const orphaned = rows
    .filter(
      (row) => !row.isCategory && !categories.some((category) => category.id === row.categoryId)
    )
    .sort((a, b) => a.position - b.position)
    .map((row) => ({ id: row.id, name: row.name }));
  if (orphaned.length > 0) tree.push({ id: null, name: 'Uncategorised', tags: orphaned });
  return tree;
}

/** Table type that carries "this tag belongs to this track" rows. */
export const EXT_ASSIGNMENT_TABLE = 4;

/**
 * Which tracks carry which tag: one row is `0, track id, tag id, 3`.
 * @param {Buffer} buffer whole `exportExt.pdb`
 * @returns {Map<number, number[]>} tag id to the ids of the tracks carrying it
 */
export function readTagAssignments(buffer) {
  const { tables } = readPdb(buffer);
  const byTag = new Map();
  for (const row of tables.get(EXT_ASSIGNMENT_TABLE) ?? []) {
    if (row.length < 16) continue;
    const trackId = row.readUInt32LE(4);
    const tagId = row.readUInt32LE(8);
    if (!trackId || !tagId) continue;
    const list = byTag.get(tagId);
    if (!list) {
      byTag.set(tagId, [trackId]);
    } else if (!list.includes(trackId)) {
      list.push(trackId);
    }
  }
  return byTag;
}
