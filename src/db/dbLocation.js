import path from 'path';
import fs from 'fs';

// A tiny pointer file, separate from the database itself, since we need to
// know where library.db lives before any database connection exists — same
// reason the old per-library registry lived outside any per-library DB.
// Defaults to userData/library.db (the original, pre-#390 location) so
// upgrading users see zero change unless they explicitly move it.

function pointerPath(userDataDir) {
  return path.join(userDataDir, 'db-location.json');
}

export function getDbPath(userDataDir) {
  const p = pointerPath(userDataDir);
  if (fs.existsSync(p)) {
    try {
      const stored = JSON.parse(fs.readFileSync(p, 'utf8'))?.path;
      if (stored) return stored;
    } catch {
      /* corrupt pointer file — fall back to the default location below */
    }
  }
  return path.join(userDataDir, 'library.db');
}

export function setDbPath(userDataDir, newPath) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(pointerPath(userDataDir), JSON.stringify({ path: newPath }, null, 2));
}
