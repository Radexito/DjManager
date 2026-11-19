import db from './database.js';
import { getSetting, setSetting } from './settingsRepository.js';

/** All libraries, oldest first. */
export function listLibraries() {
  return db.prepare('SELECT * FROM libraries ORDER BY id').all();
}

/** One library row by id, or null when it does not exist. */
export function getLibrary(id) {
  if (id == null) return null;
  return db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
}

/** The oldest library — fallback target when nothing else is specified. */
export function getDefaultLibraryId() {
  return db.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get()?.id ?? null;
}

/** Which library new imports go into unless told otherwise. */
export function getCurrentLibraryId() {
  const stored = Number(getSetting('current_library_id'));
  if (stored && getLibrary(stored)) return stored;
  return getDefaultLibraryId();
}

/** Make a library the import target; throws when the id is unknown. */
export function setCurrentLibraryId(id) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  setSetting('current_library_id', String(id));
}

/**
 * Create a library and return its row.
 * @param {object} [library]
 * @param {string} [library.name] trimmed, falls back to "New Library" when blank
 * @param {string|null} [library.rootPath] filesystem root of the library, may be unset
 * @param {string} [library.storageFormat] "readable" for a plain folder layout,
 *   anything else means the hashed layout
 * @returns {object} the inserted library row
 */
export function createLibrary({ name, rootPath = null, storageFormat = 'hashed' } = {}) {
  const info = db
    .prepare(
      'INSERT INTO libraries (name, root_path, storage_format, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(
      name?.trim() || 'New Library',
      rootPath,
      storageFormat === 'readable' ? 'readable' : 'hashed',
      Date.now()
    );
  return getLibrary(info.lastInsertRowid);
}

/**
 * Rename a library and return the updated row; a blank name becomes "Library".
 * @param {number} id
 * @param {string} name
 * @returns {object}
 */
export function renameLibrary(id, name) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(name?.trim() || 'Library', id);
  return getLibrary(id);
}

/** Point a library at a new filesystem root; throws when the id is unknown. */
export function setLibraryRootPath(id, rootPath) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  db.prepare('UPDATE libraries SET root_path = ? WHERE id = ?').run(rootPath, id);
}

/** Set the on-disk layout, where only "readable" is accepted and anything else means hashed. */
export function setLibraryStorageFormat(id, format) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  db.prepare('UPDATE libraries SET storage_format = ? WHERE id = ?').run(
    format === 'readable' ? 'readable' : 'hashed',
    id
  );
}
