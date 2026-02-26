// src/db/playlistRepository.js
import db from './database.js';

export function createPlaylist(name, color = null) {
  const info = db
    .prepare(`INSERT INTO playlists (name, color, created_at) VALUES (?, ?, ?)`)
    .run(name, color, Date.now());
  return info.lastInsertRowid;
}

export function getPlaylists() {
  return db
    .prepare(
      `
    SELECT
      p.id,
      p.name,
      p.color,
      p.created_at,
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

export function getPlaylist(id) {
  return db
    .prepare(
      `
    SELECT
      p.id, p.name, p.color, p.created_at,
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

export function renamePlaylist(id, name) {
  db.prepare(`UPDATE playlists SET name = ? WHERE id = ?`).run(name, id);
}

export function updatePlaylistColor(id, color) {
  db.prepare(`UPDATE playlists SET color = ? WHERE id = ?`).run(color, id);
}

export function deletePlaylist(id) {
  // playlist_tracks rows cascade via FK
  db.prepare(`DELETE FROM playlists WHERE id = ?`).run(id);
}

// Returns the next available position in a playlist
function nextPosition(playlistId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM playlist_tracks WHERE playlist_id = ?`
    )
    .get(playlistId);
  return row.pos;
}

export function addTrackToPlaylist(playlistId, trackId) {
  const pos = nextPosition(playlistId);
  db.prepare(
    `
    INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, date_added)
    VALUES (?, ?, ?, ?)
  `
  ).run(playlistId, trackId, pos, Date.now());
}

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
    // Compact positions above the removed one
    db.prepare(
      `
      UPDATE playlist_tracks SET position = position - 1
      WHERE playlist_id = ? AND position > ?
    `
    ).run(playlistId, row.position);
  })();
}

// Rewrite all positions from an ordered array of track IDs
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

export function isTrackInPlaylist(playlistId, trackId) {
  return !!db
    .prepare(`SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`)
    .get(playlistId, trackId);
}

// Returns [{id, name, color, isMember}] for all playlists, for a given track
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
