// src/db/trackRepository.js
import db from './database.js';

// ─── Camelot helpers (mirrors renderer/src/searchParser.js) ─────────────────

function parseCamelot(key) {
  const m = String(key)
    .trim()
    .match(/^(\d+)([aAbB])$/);
  if (!m) return null;
  return { n: parseInt(m[1], 10), letter: m[2].toUpperCase() };
}

function camelotKeys(key, op) {
  const c = parseCamelot(key);
  if (!c) return [key.toLowerCase()];
  const { n, letter } = c;
  const other = letter === 'A' ? 'B' : 'A';
  const prev = n === 1 ? 12 : n - 1;
  const next = n === 12 ? 1 : n + 1;

  if (op === 'is') return [`${n}${letter}`.toLowerCase()];
  if (op === 'mode switch') return [`${n}${other}`.toLowerCase()];
  if (op === 'adjacent')
    return [`${prev}${letter}`.toLowerCase(), `${next}${letter}`.toLowerCase()];
  // 'matches' — all four
  return [
    `${n}${letter}`.toLowerCase(),
    `${n}${other}`.toLowerCase(),
    `${prev}${letter}`.toLowerCase(),
    `${next}${letter}`.toLowerCase(),
  ];
}

// ─── Filter → SQL ────────────────────────────────────────────────────────────

/**
 * Convert an array of structured filters (from the renderer's parseQuery)
 * into a { clauses: string[], params: object } pair for better-sqlite3.
 */
function buildFiltersSQL(filters = []) {
  const clauses = [];
  const params = {};

  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const pk = (name) => `${name}_f${i}`; // unique param name per filter index

    switch (f.field) {
      case 'genre': {
        const val = (f.value ?? '').toLowerCase();
        if (f.op === 'is') {
          params[pk('v')] = `%"${val}"%`;
          clauses.push(`LOWER(genres) LIKE @${pk('v')}`);
        } else if (f.op === 'contains') {
          params[pk('v')] = `%${val}%`;
          clauses.push(`LOWER(genres) LIKE @${pk('v')}`);
        } else if (f.op === 'is not') {
          params[pk('v')] = `%${val}%`;
          clauses.push(`LOWER(genres) NOT LIKE @${pk('v')}`);
        }
        break;
      }

      case 'bpm': {
        const col = 'COALESCE(bpm_override, bpm)';
        if (f.op === 'range') {
          params[pk('lo')] = f.from;
          params[pk('hi')] = f.to;
          clauses.push(`${col} BETWEEN @${pk('lo')} AND @${pk('hi')}`);
        } else if (f.op === 'is') {
          params[pk('v')] = Number(f.value);
          clauses.push(`ABS(${col} - @${pk('v')}) < 0.5`);
        } else if (['>', '<', '>=', '<='].includes(f.op)) {
          params[pk('v')] = Number(f.value);
          clauses.push(`${col} ${f.op} @${pk('v')}`);
        }
        break;
      }

      case 'key': {
        const keys = camelotKeys(f.value ?? '', f.op);
        const placeholders = keys.map((k, j) => {
          const name = `key_f${i}_${j}`;
          params[name] = k;
          return `@${name}`;
        });
        clauses.push(`LOWER(key_camelot) IN (${placeholders.join(',')})`);
        break;
      }

      case 'loudness': {
        if (f.op === 'range') {
          params[pk('lo')] = f.from;
          params[pk('hi')] = f.to;
          clauses.push(`loudness BETWEEN @${pk('lo')} AND @${pk('hi')}`);
        } else if (f.op === 'is') {
          params[pk('v')] = Number(f.value);
          clauses.push(`loudness = @${pk('v')}`);
        } else if (['>', '<', '>=', '<='].includes(f.op)) {
          params[pk('v')] = Number(f.value);
          clauses.push(`loudness ${f.op} @${pk('v')}`);
        }
        break;
      }

      case 'title':
      case 'artist':
      case 'album':
      case 'label': {
        const col = f.field;
        const val = (f.value ?? '').toLowerCase();
        if (f.op === 'is') {
          params[pk('v')] = val;
          clauses.push(`LOWER(${col}) = @${pk('v')}`);
        } else if (f.op === 'contains') {
          params[pk('v')] = `%${val}%`;
          clauses.push(`LOWER(${col}) LIKE @${pk('v')}`);
        } else if (f.op === 'is not') {
          params[pk('v')] = val;
          clauses.push(`LOWER(${col}) != @${pk('v')}`);
        }
        break;
      }

      case 'year':
      case 'rating':
      case 'duration':
      case 'bitrate': {
        const col = f.field;
        if (f.op === 'range') {
          params[pk('lo')] = f.from;
          params[pk('hi')] = f.to;
          clauses.push(`${col} BETWEEN @${pk('lo')} AND @${pk('hi')}`);
        } else if (f.op === 'is') {
          params[pk('v')] = Number(f.value);
          clauses.push(`${col} = @${pk('v')}`);
        } else if (['>', '<', '>=', '<='].includes(f.op)) {
          params[pk('v')] = Number(f.value);
          clauses.push(`${col} ${f.op} @${pk('v')}`);
        }
        break;
      }

      default:
        break;
    }
  }

  return { clauses, params };
}

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

export function getTracks({ limit = 50, offset = 0, search = '', filters = [], playlistId } = {}) {
  const { clauses: filterClauses, params: filterParams } = buildFiltersSQL(filters);

  // Plain-text search (title / artist / album)
  const textClause = search ? '(title LIKE @_q OR artist LIKE @_q OR album LIKE @_q)' : null;
  const textParams = search ? { _q: `%${search}%` } : {};

  const allClauses = [...filterClauses, ...(textClause ? [textClause] : [])];
  const allParams = { ...filterParams, ...textParams, limit, offset };

  if (playlistId) {
    const extra = allClauses.length ? `AND ${allClauses.join(' AND ')}` : '';
    return db
      .prepare(
        `
        SELECT t.*
        FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = @playlistId ${extra}
        ORDER BY pt.position ASC
        LIMIT @limit OFFSET @offset
      `
      )
      .all({ playlistId, ...allParams });
  }

  const where = allClauses.length ? `WHERE ${allClauses.join(' AND ')}` : '';
  return db
    .prepare(
      `
      SELECT * FROM tracks
      ${where}
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `
    )
    .all(allParams);
}

export function getTrackIds({ search = '', filters = [], playlistId } = {}) {
  const { clauses: filterClauses, params: filterParams } = buildFiltersSQL(filters);

  const textClause = search ? '(title LIKE @_q OR artist LIKE @_q OR album LIKE @_q)' : null;
  const textParams = search ? { _q: `%${search}%` } : {};

  const allClauses = [...filterClauses, ...(textClause ? [textClause] : [])];
  const allParams = { ...filterParams, ...textParams };

  if (playlistId) {
    const extra = allClauses.length ? `AND ${allClauses.join(' AND ')}` : '';
    return db
      .prepare(
        `
        SELECT t.id
        FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = @playlistId ${extra}
        ORDER BY pt.position ASC
      `
      )
      .all({ playlistId, ...allParams })
      .map((r) => r.id);
  }

  const where = allClauses.length ? `WHERE ${allClauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT id FROM tracks ${where} ORDER BY created_at DESC`)
    .all(allParams)
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
