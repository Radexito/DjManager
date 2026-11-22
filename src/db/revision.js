import db from './database.js';

/**
 * One value that answers "has anything in the library changed".
 *
 * The maximum `updated_at` over the four synced tables is an indexed read. Row
 * counts ride along because a delete does not leave a newer timestamp behind:
 * removing the newest track can lower the maximum, and a count catches it.
 * Together they form a key a device can remember, so the next sync recognises
 * an unchanged library without scanning rows or opening a single audio file.
 */

/** Revision state of one table: its newest timestamp and its row count. */
export function tableRevision(table) {
  const row = db
    .prepare(`SELECT COALESCE(MAX(updated_at), 0) AS at, COUNT(*) AS n FROM ${table}`)
    .get();
  return { maxUpdatedAt: Number(row?.at ?? 0), count: Number(row?.n ?? 0) };
}

/**
 * @returns {{key: string, maxUpdatedAt: number, tracks: number, playlists: number,
 *   playlistTracks: number, cues: number}}
 */
export function revisionSummary() {
  const tracks = tableRevision('tracks');
  const playlists = tableRevision('playlists');
  const playlistTracks = tableRevision('playlist_tracks');
  const cues = tableRevision('cue_points');
  const maxUpdatedAt = Math.max(
    tracks.maxUpdatedAt,
    playlists.maxUpdatedAt,
    playlistTracks.maxUpdatedAt,
    cues.maxUpdatedAt
  );
  return {
    key: `${maxUpdatedAt}:${tracks.count}:${playlists.count}:${playlistTracks.count}:${cues.count}`,
    maxUpdatedAt,
    tracks: tracks.count,
    playlists: playlists.count,
    playlistTracks: playlistTracks.count,
    cues: cues.count,
  };
}
