import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

let dbPath;

if (process.env.DB_PATH) {
  // Test mode: caller specifies path (e.g. ':memory:')
  dbPath = process.env.DB_PATH;
} else {
  // Try to use Electron's app.getPath('userData') if available
  try {
    const { app } = await import('electron');
    dbPath = path.join(app.getPath('userData'), 'library.db');
  } catch {
    // Node test mode: put database in project folder
    dbPath = path.join(process.cwd(), 'library.db');
  }
}

// Ensure folder exists (skip for :memory:)
if (dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

// Open database
const db = new Database(dbPath);

// Performance & integrity settings
db.pragma('journal_mode = WAL'); // Write-Ahead Logging
db.pragma('foreign_keys = ON'); // Enforce foreign keys

export default db;
