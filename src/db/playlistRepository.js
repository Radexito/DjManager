import db from './database.js';

/** Look a playlist up by its (unique) name; returns the id row or null. */
export function getPlaylistByName(name) {
  return db.prepare(`SELECT id FROM playlists WHERE name = ?`).get(name) ?? null;
}

/**
 * Create a playlist.
 * @param {string} name must be unique
 * @param {string|null} [color] hex colour shown in the sidebar
 * @param {string|null} [sourceUrl] origin of an imported playlist, if any
 * @returns {number} id of the new playlist
 * @throws {Error} code DUPLICATE_PLAYLIST_NAME when the name is taken
 */
export function createPlaylist(name, color = null, sourceUrl = null) {
  if (getPlaylistByName(name)) {
    const err = new Error(`A playlist named "${name}" already exists.`);
    err.code = 'DUPLICATE_PLAYLIST_NAME';
    throw err;
  }
  const info = db
    .prepare(`INSERT INTO playlists (name, color, source_url, created_at) VALUES (?, ?, ?, ?)`)
    .run(name, color, sourceUrl, Date.now());
  return info.lastInsertRowid;
}

/** Find existing playlist by name or create a new one. Returns { id, created }. */
export function findOrCreatePlaylist(name, color = null, sourceUrl = null) {
  const existing = getPlaylistByName(name);
  if (existing) return { id: existing.id, created: false };
  const id = db
    .prepare(`INSERT INTO playlists (name, color, source_url, created_at) VALUES (?, ?, ?, ?)`)
    .run(name, color, sourceUrl, Date.now()).lastInsertRowid;
  return { id, created: true };
}

/**
 * All playlists with their track count and summed duration, oldest first.
 * @returns {object[]}
 */
export function getPlaylists() {
  return db
    .prepare(
      `
    SELECT
      p.id,
      p.name,
      p.color,
      p.created_at,
      p.folder_path,
      p.folder_recursive,
      p.folder_synced_at,
      COUNT(pt.track_id)                          AS track_count,
      COALESCE(SUM(t.duration), 0)                AS total_duration
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    LEFT JOIN tracks t ON t.id = pt.track_id
    GROUP BY p.id
    ORDER BY p.created_at ASC
  `
    )
    .all();
}

/**
 * One playlist with its track count and summed duration.
 * @param {number} id
 * @returns {object|undefined}
 */
export function getPlaylist(id) {
  return db
    .prepare(
      `
    SELECT
      p.id, p.name, p.color, p.created_at,
      p.folder_path, p.folder_recursive, p.folder_synced_at,
      COUNT(pt.track_id)           AS track_count,
      COALESCE(SUM(t.duration), 0) AS total_duration
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    LEFT JOIN tracks t ON t.id = pt.track_id
    WHERE p.id = ?
    GROUP BY p.id
  `
    )
    .get(id);
}

/** Every playlist that mirrors a folder, oldest first. */
export function getFolderPlaylists() {
  return db
    .prepare(`SELECT * FROM playlists WHERE folder_path IS NOT NULL ORDER BY created_at ASC`)
    .all();
}

/** Point a playlist at a folder (or change the folder / recursion). */
export function setPlaylistFolder(playlistId, folderPath, recursive = false) {
  db.prepare(`UPDATE playlists SET folder_path = ?, folder_recursive = ? WHERE id = ?`).run(
    folderPath || null,
    recursive ? 1 : 0,
    playlistId
  );
}

/** Forget the tracked folder — the playlist itself and its tracks stay. */
export function clearPlaylistFolder(playlistId) {
  db.prepare(`UPDATE playlists SET folder_path = NULL, folder_recursive = 0 WHERE id = ?`).run(
    playlistId
  );
}

/** Record when the folder was last mirrored (shown in the UI). */
export function markPlaylistFolderSynced(playlistId, at = Date.now()) {
  db.prepare(`UPDATE playlists SET folder_synced_at = ? WHERE id = ?`).run(at, playlistId);
}

/**
 * Rename a playlist; the new name must not belong to another playlist.
 * @param {number} id
 * @param {string} name
 * @throws {Error} code DUPLICATE_PLAYLIST_NAME when the name is taken
 */
export function renamePlaylist(id, name) {
  const existing = getPlaylistByName(name);
  if (existing && existing.id !== id) {
    const err = new Error(`A playlist named "${name}" already exists.`);
    err.code = 'DUPLICATE_PLAYLIST_NAME';
    throw err;
  }
  db.prepare(`UPDATE playlists SET name = ? WHERE id = ?`).run(name, id);
}

/** Set the sidebar colour of a playlist. */
export function updatePlaylistColor(id, color) {
  db.prepare(`UPDATE playlists SET color = ? WHERE id = ?`).run(color, id);
}

/** Delete a playlist; its playlist_tracks rows go with it through the cascade. */
export function deletePlaylist(id) {
  db.prepare(`DELETE FROM playlists WHERE id = ?`).run(id);
}

/** One past the highest position in a playlist, i.e. where an appended track goes. */
function nextPosition(playlistId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM playlist_tracks WHERE playlist_id = ?`
    )
    .get(playlistId);
  return row.pos;
}

/**
 * Append a track to the end of a playlist. A track that is already a member is
 * ignored (the membership is keyed on playlist and track).
 */
export function addTrackToPlaylist(playlistId, trackId) {
  const pos = nextPosition(playlistId);
  db.prepare(
    `
    INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, date_added)
    VALUES (?, ?, ?, ?)
  `
  ).run(playlistId, trackId, pos, Date.now());
}

/**
 * Append many tracks in order, in one transaction. Tracks already in the
 * playlist are skipped.
 * @param {number} playlistId
 * @param {number[]} trackIds
 */
export function addTracksToPlaylist(playlistId, trackIds) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, date_added)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction(() => {
    let pos = nextPosition(playlistId);
    for (const trackId of trackIds) {
      insert.run(playlistId, trackId, pos++, Date.now());
    }
  })();
}

/**
 * Remove a track and close the gap: every later track moves up one position, so
 * positions stay dense.
 */
export function removeTrackFromPlaylist(playlistId, trackId) {
  db.transaction(() => {
    const row = db
      .prepare(`SELECT position FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`)
      .get(playlistId, trackId);
    if (!row) return;
    db.prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`).run(
      playlistId,
      trackId
    );
    db.prepare(
      `
      UPDATE playlist_tracks SET position = position - 1
      WHERE playlist_id = ? AND position > ?
    `
    ).run(playlistId, row.position);
  })();
}

/**
 * Rewrite positions from a complete ordered list of track ids, index 0 first.
 * @param {number} playlistId
 * @param {number[]} orderedTrackIds
 */
export function reorderPlaylistTracks(playlistId, orderedTrackIds) {
  const stmt = db.prepare(
    `UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?`
  );
  db.transaction(() => {
    orderedTrackIds.forEach((trackId, index) => {
      stmt.run(index, playlistId, trackId);
    });
  })();
}

/** Whether the track is a member of the playlist. */
export function isTrackInPlaylist(playlistId, trackId) {
  return !!db
    .prepare(`SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`)
    .get(playlistId, trackId);
}

/**
 * Every playlist, oldest first, each with an `is_member` flag for this track —
 * used to render the "add to playlist" menu.
 * @param {number} trackId
 * @returns {object[]}
 */
export function getPlaylistsForTrack(trackId) {
  return db
    .prepare(
      `
    SELECT
      p.id, p.name, p.color,
      EXISTS (
        SELECT 1 FROM playlist_tracks pt2
        WHERE pt2.playlist_id = p.id AND pt2.track_id = ?
      ) AS is_member
    FROM playlists p
    ORDER BY p.created_at ASC
  `
    )
    .all(trackId);
}

/** Full track rows of a playlist, in playlist order. */
export function getPlaylistTracks(playlistId) {
  return db
    .prepare(
      `
    SELECT t.*
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC
  `
    )
    .all(playlistId);
}

/** Delete every playlist; used by the library reset. */
export function clearPlaylists() {
  db.prepare(`DELETE FROM playlists`).run();
}
