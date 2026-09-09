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
      beatgrid TEXT,
      beatgrid_offset INTEGER DEFAULT 0,

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
    'ALTER TABLE tracks ADD COLUMN beatgrid TEXT',
    'ALTER TABLE tracks ADD COLUMN source_url TEXT',
    'ALTER TABLE tracks ADD COLUMN source_platform TEXT',
    'ALTER TABLE tracks ADD COLUMN source_quality TEXT',
    'ALTER TABLE tracks ADD COLUMN source_link TEXT',
    'ALTER TABLE tracks ADD COLUMN user_tags TEXT',
    'ALTER TABLE tracks ADD COLUMN has_artwork INTEGER DEFAULT 0',
    'ALTER TABLE tracks ADD COLUMN artwork_path TEXT',
    'ALTER TABLE tracks ADD COLUMN normalized_file_path TEXT',
    'ALTER TABLE tracks ADD COLUMN source_loudness REAL',
    'ALTER TABLE tracks ADD COLUMN beatgrid_offset INTEGER DEFAULT 0',
    'ALTER TABLE tracks ADD COLUMN waveform_overview BLOB',
    'ALTER TABLE tracks ADD COLUMN is_linked INTEGER DEFAULT 0',
    'ALTER TABLE tracks ADD COLUMN waveform_detail_hires BLOB',
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
    'ALTER TABLE playlists ADD COLUMN source_url TEXT',
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

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS cue_points (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id      INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position_ms   REAL    NOT NULL,
      label         TEXT    NOT NULL DEFAULT '',
      color         TEXT    NOT NULL DEFAULT '#00b4d8',
      hot_cue_index INTEGER NOT NULL DEFAULT -1,
      created_at    INTEGER NOT NULL
    )
  `
  ).run();

  db.prepare(
    `
    CREATE INDEX IF NOT EXISTS idx_cue_points_track_id
    ON cue_points(track_id)
  `
  ).run();

  // #209: per-cue export enable/disable toggle
  try {
    db.prepare('ALTER TABLE cue_points ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1').run();
  } catch {}

  // ── Multiple libraries (#390) ────────────────────────────────────────────
  // All libraries live in this one database — a "library" is just a row plus
  // a tag on tracks, so everything is queryable together at once (unified
  // view, not a switchable profile). Playlists intentionally have no
  // library_id: a playlist is just a list of track references and may mix
  // tracks from different libraries.
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS libraries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      root_path      TEXT,
      storage_format TEXT NOT NULL DEFAULT 'hashed',
      created_at     INTEGER NOT NULL
    )
  `
  ).run();

  try {
    db.prepare('ALTER TABLE tracks ADD COLUMN library_id INTEGER REFERENCES libraries(id)').run();
  } catch {
    /* column already exists */
  }

  // First run after upgrading from a single-library install: seed one
  // "Default" library from the old global library_path/storage_format
  // settings (if set) and backfill every existing track onto it, so nothing
  // becomes orphaned. Safe to run every startup — only acts once.
  const libraryCount = db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n;
  if (libraryCount === 0) {
    const getOldSetting = (key) =>
      db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    const rootPath = getOldSetting('library_path');
    const storageFormat = getOldSetting('storage_format') === 'readable' ? 'readable' : 'hashed';
    const info = db
      .prepare(
        'INSERT INTO libraries (name, root_path, storage_format, created_at) VALUES (?, ?, ?, ?)'
      )
      .run('Default', rootPath, storageFormat, Date.now());
    db.prepare('UPDATE tracks SET library_id = ? WHERE library_id IS NULL').run(
      info.lastInsertRowid
    );
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('current_library_id', ?)`).run(
      String(info.lastInsertRowid)
    );
  }

  db.prepare(
    `
    CREATE INDEX IF NOT EXISTS idx_tracks_library_id
    ON tracks(library_id)
  `
  ).run();
}
