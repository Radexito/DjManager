import db from './database.js';

/**
 * Read a setting.
 * @param {string} key
 * @param {*} [defaultValue] returned when the key is absent
 * @returns {string|*} the stored text, or defaultValue
 */
export function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

/** Upsert a setting; the value is stored as text. */
export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}
