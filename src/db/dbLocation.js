import path from 'path';
import fs from 'fs';

/** JSON file in the Electron user-data dir that records the chosen database path. */
function pointerPath(userDataDir) {
  return path.join(userDataDir, 'db-location.json');
}

/**
 * Resolve the library database path: the one recorded in the pointer file when it
 * exists and parses, otherwise the default `library.db` in the user-data dir.
 * @param {string} userDataDir Electron user-data directory
 * @returns {string}
 */
export function getDbPath(userDataDir) {
  const p = pointerPath(userDataDir);
  if (fs.existsSync(p)) {
    try {
      const stored = JSON.parse(fs.readFileSync(p, 'utf8'))?.path;
      if (stored) return stored;
    } catch {}
  }
  return path.join(userDataDir, 'library.db');
}

/**
 * Remember a new database path, creating the user-data dir if needed. The move
 * itself is not performed here.
 * @param {string} userDataDir Electron user-data directory
 * @param {string} newPath absolute path of the database file
 */
export function setDbPath(userDataDir, newPath) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(pointerPath(userDataDir), JSON.stringify({ path: newPath }, null, 2));
}
