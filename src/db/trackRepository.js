// src/db/trackRepository.js
import db from './database.js';

export function addTrack(track) {
  console.log('Adding track:', track);
  const stmt = db.prepare(`
    INSERT INTO tracks (
      title, artist, album, duration,
      file_path, file_hash, format, bitrate,
      created_at
    ) VALUES (
      @title, @artist, @album, @duration,
      @file_path, @file_hash, @format, @bitrate,
      @created_at
    )
  `);

  const info = stmt.run({
    title: track.title,
    artist: track.artist ?? '',
    album: track.album ?? '',
    duration: track.duration ?? 0,
    file_path: track.file_path,
    file_hash: track.file_hash,
    format: track.format,
    bitrate: track.bitrate,
    created_at: Date.now(),
  });

  return info.lastInsertRowid;
}

export function updateTrack(id, data) {
  console.log(`Updating track ${id} with data:`, data);
  const fields = Object.keys(data);
  if (!fields.length) return;

  const set = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(
    `
    UPDATE tracks
    SET ${set}, analyzed = 1
    WHERE id = @id
  `
  ).run({ id, ...data });
}

export function getTracks({ limit = 50, offset = 0, search = '', playlistId } = {}) {
  if (playlistId) {
    const q = search ? `%${search}%` : null;
    const where = search ? `AND (t.title LIKE @q OR t.artist LIKE @q OR t.album LIKE @q)` : '';
    return db
      .prepare(
        `
      SELECT t.*
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = @playlistId ${where}
      ORDER BY pt.position ASC
      LIMIT @limit OFFSET @offset
    `
      )
      .all({ playlistId, q, limit, offset });
  }

  if (search) {
    return db
      .prepare(
        `
      SELECT *
      FROM tracks
      WHERE title LIKE @q
         OR artist LIKE @q
         OR album LIKE @q
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `
      )
      .all({ q: `%${search}%`, limit, offset });
  }

  return db
    .prepare(
      `
    SELECT *
    FROM tracks
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(limit, offset);
}

export function getTrackIds({ search = '', playlistId } = {}) {
  if (playlistId) {
    const q = search ? `%${search}%` : null;
    const where = search ? `AND (t.title LIKE @q OR t.artist LIKE @q OR t.album LIKE @q)` : '';
    return db
      .prepare(
        `
      SELECT t.id
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = @playlistId ${where}
      ORDER BY pt.position ASC
    `
      )
      .all({ playlistId, q })
      .map((r) => r.id);
  }
  if (search) {
    return db
      .prepare(
        `
      SELECT id FROM tracks
      WHERE title LIKE @q OR artist LIKE @q OR album LIKE @q
      ORDER BY created_at DESC
    `
      )
      .all({ q: `%${search}%` })
      .map((r) => r.id);
  }
  return db
    .prepare('SELECT id FROM tracks ORDER BY created_at DESC')
    .all()
    .map((r) => r.id);
}

export function getTrackByHash(hash) {
  return db.prepare('SELECT * FROM tracks WHERE file_hash = ?').get(hash);
}

export function getTrackById(id) {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
}

export function removeTrack(id) {
  db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
}

export function normalizeLibrary(targetLufs) {
  const info = db
    .prepare(
      `
    UPDATE tracks
    SET replay_gain = ROUND((? - loudness) * 10) / 10
    WHERE loudness IS NOT NULL
  `
    )
    .run(targetLufs);
  return info.changes ?? 0;
}

export function clearTracks() {
  console.log('Clearing all tracks from database');
  db.prepare(`DELETE FROM tracks`).run();
  db.prepare(`VACUUM`).run();
}
