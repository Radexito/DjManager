// src/db/libraryRepository.js
import db from './database.js';
import { getSetting, setSetting } from './settingsRepository.js';

export function listLibraries() {
  return db.prepare('SELECT * FROM libraries ORDER BY id').all();
}

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

export function setCurrentLibraryId(id) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  setSetting('current_library_id', String(id));
}

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

export function renameLibrary(id, name) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(name?.trim() || 'Library', id);
  return getLibrary(id);
}

export function setLibraryRootPath(id, rootPath) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  db.prepare('UPDATE libraries SET root_path = ? WHERE id = ?').run(rootPath, id);
}

export function setLibraryStorageFormat(id, format) {
  if (!getLibrary(id)) throw new Error('Library not found.');
  db.prepare('UPDATE libraries SET storage_format = ? WHERE id = ?').run(
    format === 'readable' ? 'readable' : 'hashed',
    id
  );
}
