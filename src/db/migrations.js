import db from './database.js';

/**
 * Create the schema and bring an existing database up to date. Tables use
 * `IF NOT EXISTS` and later columns are added with `ALTER TABLE` inside try/catch,
 * so running this on every start is safe; the two structural rewrites (the
 * playlist_tracks `track_order` rename and the first library row) only happen when
 * the old shape is detected. Idempotent.
 */
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
    'ALTER TABLE tracks ADD COLUMN trim_start_ms REAL',
    'ALTER TABLE tracks ADD COLUMN trim_end_ms REAL',
    'ALTER TABLE tracks ADD COLUMN sample_rate INTEGER',
    'ALTER TABLE tracks ADD COLUMN bit_depth INTEGER',
  ]) {
    try {
      db.prepare(col).run();
    } catch {}
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

  for (const col of [
    'ALTER TABLE playlists ADD COLUMN color TEXT',
    'ALTER TABLE playlists ADD COLUMN created_at INTEGER',
    'ALTER TABLE playlists ADD COLUMN source_url TEXT',
    'ALTER TABLE playlists ADD COLUMN folder_path TEXT',
    'ALTER TABLE playlists ADD COLUMN folder_recursive INTEGER DEFAULT 0',
    'ALTER TABLE playlists ADD COLUMN folder_synced_at INTEGER',
    'ALTER TABLE playlist_tracks ADD COLUMN position INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE playlist_tracks ADD COLUMN date_added INTEGER',
  ]) {
    try {
      db.prepare(col).run();
    } catch {}
  }

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

  try {
    db.prepare('ALTER TABLE cue_points ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1').run();
  } catch {}

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
  } catch {}

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

  installRevisionTracking();
  installSelectiveSync();
}

/**
 * Revision tracking, file fingerprints and the per-device merge base (#12).
 *
 * Every row that can reach a device carries `rev` and `updated_at`. Triggers
 * maintain them, so no write path has to remember to bump anything: an import,
 * a metadata edit, a cue edit, a playlist reorder, a trim change and a
 * normalisation all move the revision by exactly the trigger rule. A caller
 * that sets `rev` itself (the sync apply) is left alone, because the update
 * trigger only fires when the revision is unchanged.
 *
 * `updated_at` doubles as the cheap "did anything change" query: the maximum
 * over the four tables is one indexed read, so an unchanged library can be
 * recognised without scanning rows or touching audio.
 */
function installRevisionTracking() {
  for (const col of [
    'ALTER TABLE tracks ADD COLUMN updated_at INTEGER',
    'ALTER TABLE tracks ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE tracks ADD COLUMN file_fingerprint TEXT',
    'ALTER TABLE playlists ADD COLUMN updated_at INTEGER',
    'ALTER TABLE playlists ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE playlist_tracks ADD COLUMN updated_at INTEGER',
    'ALTER TABLE playlist_tracks ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE cue_points ADD COLUMN updated_at INTEGER',
    'ALTER TABLE cue_points ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
  ]) {
    try {
      db.prepare(col).run();
    } catch {}
  }

  const nowMs = `CAST(strftime('%s','now') AS INTEGER) * 1000`;
  db.prepare(
    `UPDATE tracks SET updated_at = COALESCE(created_at, ${nowMs}) WHERE updated_at IS NULL`
  ).run();
  db.prepare('UPDATE tracks SET rev = 1 WHERE rev IS NULL').run();
  db.prepare(
    `UPDATE playlists SET updated_at = COALESCE(created_at, ${nowMs}) WHERE updated_at IS NULL`
  ).run();
  db.prepare('UPDATE playlists SET rev = 1 WHERE rev IS NULL').run();
  db.prepare(
    `UPDATE playlist_tracks SET updated_at = COALESCE(date_added, ${nowMs}) WHERE updated_at IS NULL`
  ).run();
  db.prepare('UPDATE playlist_tracks SET rev = 1 WHERE rev IS NULL').run();
  db.prepare(
    `UPDATE cue_points SET updated_at = COALESCE(created_at, ${nowMs}) WHERE updated_at IS NULL`
  ).run();
  db.prepare('UPDATE cue_points SET rev = 1 WHERE rev IS NULL').run();

  const triggers = [
    // A new row gets its timestamp once; the revision keeps its default.
    `CREATE TRIGGER IF NOT EXISTS tracks_revision_insert AFTER INSERT ON tracks
     WHEN NEW.updated_at IS NULL
     BEGIN
       UPDATE tracks SET updated_at = ${nowMs} WHERE id = NEW.id;
     END`,
    // Any edit that does not bring its own revision bumps it. The guard on
    // updated_at is what stops the insert trigger's own timestamp write from
    // counting as an edit.
    `CREATE TRIGGER IF NOT EXISTS tracks_revision_update AFTER UPDATE ON tracks
     WHEN NEW.rev = OLD.rev AND NEW.updated_at IS OLD.updated_at
     BEGIN
       UPDATE tracks SET rev = OLD.rev + 1, updated_at = ${nowMs} WHERE id = NEW.id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS playlists_revision_insert AFTER INSERT ON playlists
     WHEN NEW.updated_at IS NULL
     BEGIN
       UPDATE playlists SET updated_at = ${nowMs} WHERE id = NEW.id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS playlists_revision_update AFTER UPDATE ON playlists
     WHEN NEW.rev = OLD.rev AND NEW.updated_at IS OLD.updated_at
     BEGIN
       UPDATE playlists SET rev = OLD.rev + 1, updated_at = ${nowMs} WHERE id = NEW.id;
     END`,
    // Membership and order live in playlist_tracks, so any change there moves
    // the playlist revision as well as the row's own.
    `CREATE TRIGGER IF NOT EXISTS playlist_tracks_revision_insert AFTER INSERT ON playlist_tracks
     BEGIN
       UPDATE playlist_tracks SET updated_at = ${nowMs}
        WHERE playlist_id = NEW.playlist_id AND track_id = NEW.track_id
          AND updated_at IS NULL;
       UPDATE playlists SET rev = rev + 1, updated_at = ${nowMs} WHERE id = NEW.playlist_id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS playlist_tracks_revision_update AFTER UPDATE ON playlist_tracks
     WHEN NEW.rev = OLD.rev AND NEW.updated_at IS OLD.updated_at
     BEGIN
       UPDATE playlist_tracks SET rev = OLD.rev + 1, updated_at = ${nowMs}
        WHERE playlist_id = NEW.playlist_id AND track_id = NEW.track_id;
       UPDATE playlists SET rev = rev + 1, updated_at = ${nowMs} WHERE id = NEW.playlist_id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS playlist_tracks_revision_delete AFTER DELETE ON playlist_tracks
     BEGIN
       UPDATE playlists SET rev = rev + 1, updated_at = ${nowMs} WHERE id = OLD.playlist_id;
     END`,
    // Cues are exported inside the analysis bundle, so a cue edit moves the
    // track revision too.
    `CREATE TRIGGER IF NOT EXISTS cue_points_revision_insert AFTER INSERT ON cue_points
     WHEN NEW.updated_at IS NULL
     BEGIN
       UPDATE cue_points SET updated_at = ${nowMs} WHERE id = NEW.id;
       UPDATE tracks SET rev = rev + 1, updated_at = ${nowMs} WHERE id = NEW.track_id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS cue_points_revision_update AFTER UPDATE ON cue_points
     WHEN NEW.rev = OLD.rev AND NEW.updated_at IS OLD.updated_at
     BEGIN
       UPDATE cue_points SET rev = OLD.rev + 1, updated_at = ${nowMs} WHERE id = NEW.id;
       UPDATE tracks SET rev = rev + 1, updated_at = ${nowMs} WHERE id = NEW.track_id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS cue_points_revision_delete AFTER DELETE ON cue_points
     BEGIN
       UPDATE tracks SET rev = rev + 1, updated_at = ${nowMs} WHERE id = OLD.track_id;
     END`,
  ];
  for (const sql of triggers) db.prepare(sql).run();

  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_tracks_updated_at ON tracks(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_playlists_updated_at ON playlists(updated_at)',
  ]) {
    db.prepare(sql).run();
  }

  // The merge base is per device and per track. The library keeps the revisions
  // it exported and the cue set that was the base for a merge; the device only
  // carries hashes. `manifest_json` keeps the last manifest, so a database that
  // never saw a device can rebuild the base from the stick (criterion 6).
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS device_sync_state (
      device_key       TEXT PRIMARY KEY,
      export_id        TEXT,
      label            TEXT,
      serial           TEXT,
      filesystem       TEXT,
      last_mount_path  TEXT,
      last_sync        INTEGER,
      library_revision TEXT,
      manifest_json    TEXT,
      updated_at       INTEGER
    )
  `
  ).run();

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS device_track_state (
      device_key         TEXT    NOT NULL,
      track_id           INTEGER NOT NULL,
      device_track_id    INTEGER,
      file_path          TEXT,
      rev                INTEGER,
      hash               TEXT,
      file_fingerprint   TEXT,
      exported_at        INTEGER,
      PRIMARY KEY (device_key, track_id)
    )
  `
  ).run();

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS device_playlist_state (
      device_key     TEXT    NOT NULL,
      playlist_id    INTEGER NOT NULL,
      rev            INTEGER,
      signature      TEXT,
      exported_at    INTEGER,
      PRIMARY KEY (device_key, playlist_id)
    )
  `
  ).run();

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS device_cue_base (
      device_key  TEXT    NOT NULL,
      track_id    INTEGER NOT NULL,
      hash        TEXT,
      cue_json    TEXT,
      updated_at  INTEGER,
      PRIMARY KEY (device_key, track_id)
    )
  `
  ).run();
}

/**
 * What a device is meant to carry, and what its last apply did (#14).
 *
 * The selection is the device side of "keep these playlists in step". It is
 * stored per device key, so it survives a new drive letter. `device_last_plan`
 * keeps the action list the last apply executed, which is what lets the next
 * preview explain itself ("this is what the device was told last time").
 */
function installSelectiveSync() {
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS device_selection (
      device_key TEXT    NOT NULL,
      kind       TEXT    NOT NULL DEFAULT 'playlist',
      ref_id     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      PRIMARY KEY (device_key, kind, ref_id)
    )
  `
  ).run();

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS device_last_plan (
      device_key TEXT PRIMARY KEY,
      plan_hash  TEXT,
      plan_json  TEXT NOT NULL,
      summary    TEXT,
      applied_at INTEGER NOT NULL
    )
  `
  ).run();
}
