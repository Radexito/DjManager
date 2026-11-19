import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getDbPath } from './dbLocation.js';

let dbPath;

if (process.env.DB_PATH) {
  dbPath = process.env.DB_PATH;
} else {
  try {
    const { app } = await import('electron');
    dbPath = getDbPath(app.getPath('userData'));
  } catch {
    dbPath = path.join(process.cwd(), 'library.db');
  }
}

if (dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Close the shared SQLite handle; silently does nothing if it is already closed. */
export function closeDB() {
  try {
    db.close();
  } catch {}
}

export default db;
