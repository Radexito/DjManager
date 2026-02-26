// src/db/migrations.js
import db from './database.js';

export function initDB() {
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- File
      file_path TEXT,
      file_hash TEXT,
      format TEXT,
      bitrate INTEGER,
      duration REAL,

      -- Tags
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      year INTEGER,
      label TEXT,
      genres TEXT,

      -- Analysis
      bpm REAL,
      bpm_override REAL,
      key_raw TEXT,
      key_camelot TEXT,
      loudness REAL,
      replay_gain REAL,
      intro_secs REAL,
      outro_secs REAL,

      -- User
      rating INTEGER,
      comments TEXT,

      analyzed INTEGER DEFAULT 0,
      created_at INTEGER
    )
  `
  ).run();

  db.prepare(
    `
    CREATE INDEX IF NOT EXISTS idx_tracks_created_at
    ON tracks(created_at)
  `
  ).run();

  // Migrate existing databases — safe to run on fresh installs too
  for (const col of [
    'ALTER TABLE tracks ADD COLUMN bpm_override REAL',
    'ALTER TABLE tracks ADD COLUMN replay_gain REAL',
    'ALTER TABLE tracks ADD COLUMN intro_secs REAL',
    'ALTER TABLE tracks ADD COLUMN outro_secs REAL',
  ]) {
    try {
      db.prepare(col).run();
    } catch {
      /* column already exists */
    }
  }

  db.prepare(
    `
    CREATE INDEX IF NOT EXISTS idx_tracks_title
    ON tracks(title)
  `
  ).run();

  db.prepare(
    `
    CREATE INDEX IF NOT EXISTS idx_tracks_artist
    ON tracks(artist)
  `
  ).run();

  // Legacy tables (safe to keep, unused for now)
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT,
      created_at INTEGER
    )
  `
  ).run();

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      date_added INTEGER,
      PRIMARY KEY (playlist_id, track_id)
    )
  `
  ).run();

  // Migrate existing playlist tables
  for (const col of [
    'ALTER TABLE playlists ADD COLUMN color TEXT',
    'ALTER TABLE playlists ADD COLUMN created_at INTEGER',
    'ALTER TABLE playlist_tracks ADD COLUMN position INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE playlist_tracks ADD COLUMN date_added INTEGER',
  ]) {
    try {
      db.prepare(col).run();
    } catch {
      /* column already exists */
    }
  }

  // Drop legacy track_order column by recreating playlist_tracks without it.
  // track_order existed in old schema as NOT NULL with no default, breaking inserts.
  const hasTrackOrder = db
    .prepare(`SELECT 1 FROM pragma_table_info('playlist_tracks') WHERE name = 'track_order'`)
    .get();
  if (hasTrackOrder) {
    db.transaction(() => {
      db.prepare(`ALTER TABLE playlist_tracks RENAME TO playlist_tracks_old`).run();
      db.prepare(
        `
        CREATE TABLE playlist_tracks (
          playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
          track_id    INTEGER NOT NULL REFERENCES tracks(id)   ON DELETE CASCADE,
          position    INTEGER NOT NULL DEFAULT 0,
          date_added  INTEGER,
          PRIMARY KEY (playlist_id, track_id)
        )
      `
      ).run();
      db.prepare(
        `
        INSERT INTO playlist_tracks (playlist_id, track_id, position, date_added)
        SELECT playlist_id, track_id, position, date_added FROM playlist_tracks_old
      `
      ).run();
      db.prepare(`DROP TABLE playlist_tracks_old`).run();
    })();
  }

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `
  ).run();
}
