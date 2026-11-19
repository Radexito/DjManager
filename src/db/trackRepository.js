import path from 'path';
import db from './database.js';

const ALLOWED_TRACK_COLUMNS = new Set([
  'title',
  'artist',
  'album',
  'year',
  'label',
  'genres',
  'bpm',
  'bpm_override',
  'key_raw',
  'key_camelot',
  'loudness',
  'replay_gain',
  'intro_secs',
  'outro_secs',
  'beatgrid',
  'beatgrid_offset',
  'rating',
  'comments',
  'user_tags',
  'has_artwork',
  'artwork_path',
  'normalized_file_path',
  'source_loudness',
  'file_path',
  'file_hash',
  'format',
  'bitrate',
  'duration',
  'source_url',
  'source_platform',
  'source_quality',
  'source_link',
  'library_id',
  'is_linked',
  'trim_start_ms',
  'trim_end_ms',
]);

/**
 * Split a Camelot key ("8A", "12b") into its number and letter.
 * @param {string} key
 * @returns {{ n: number, letter: string }|null} null when the key is not Camelot notation
 */
function parseCamelot(key) {
  const m = String(key)
    .trim()
    .match(/^(\d+)([aAbB])$/);
  if (!m) return null;
  return { n: parseInt(m[1], 10), letter: m[2].toUpperCase() };
}

/**
 * Keys that count as a harmonic match for a Camelot key, lowercased as stored in
 * key_camelot. `is` is the key itself, `mode switch` the same number on the other
 * letter, `adjacent` the neighbouring numbers on the same letter (the wheel wraps
 * at 12/1), and any other op returns all four. A non-Camelot key only ever
 * matches itself.
 * @param {string} key
 * @param {string} op
 * @returns {string[]}
 */
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
  return [
    `${n}${letter}`.toLowerCase(),
    `${n}${other}`.toLowerCase(),
    `${prev}${letter}`.toLowerCase(),
    `${next}${letter}`.toLowerCase(),
  ];
}

/**
 * Convert an array of structured filters (from the renderer's parseQuery)
 * into a { clauses: string[], params: object } pair for better-sqlite3.
 */
function buildFiltersSQL(filters = []) {
  const clauses = [];
  const params = {};

  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const pk = (name) => `${name}_f${i}`;

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
        } else if (f.op === 'starts with') {
          const flat = val.replace(/\s+/g, '');
          const norm = `LOWER(REPLACE(${col}, ' ', ''))`;
          params[pk('v')] = `${flat}%`;
          params[pk('e')] = `%,${flat}%`;
          clauses.push(`(${norm} LIKE @${pk('v')} OR ${norm} LIKE @${pk('e')})`);
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
        const scale = f.field === 'bitrate' ? 1000 : 1;
        if (f.op === 'range') {
          params[pk('lo')] = f.from * scale;
          params[pk('hi')] = f.to * scale;
          clauses.push(`${col} BETWEEN @${pk('lo')} AND @${pk('hi')}`);
        } else if (f.op === 'is') {
          params[pk('v')] = Number(f.value) * scale;
          clauses.push(`${col} = @${pk('v')}`);
        } else if (['>', '<', '>=', '<='].includes(f.op)) {
          params[pk('v')] = Number(f.value) * scale;
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

/** IN-clause for an optional library_id filter — omitted entirely (all libraries) when unset. */
function buildLibraryIdsSQL(libraryIds) {
  if (!libraryIds || !libraryIds.length) return { clause: null, params: {} };
  const params = {};
  const placeholders = libraryIds.map((id, i) => {
    params[`_lib${i}`] = id;
    return `@_lib${i}`;
  });
  return { clause: `library_id IN (${placeholders.join(',')})`, params };
}

/**
 * Insert a track row. Only title, file_path, file_hash, format and bitrate are
 * expected to be set; everything else falls back to an empty value.
 * @param {object} track
 * @returns {number} id of the inserted track
 */
export function addTrack(track) {
  console.log('Adding track:', track);
  const stmt = db.prepare(`
    INSERT INTO tracks (
      title, artist, album, duration,
      file_path, file_hash, format, bitrate,
      year, label, genres, bpm,
      source_url, source_platform, source_quality, source_link,
      user_tags, has_artwork, artwork_path, is_linked, library_id,
      trim_start_ms, trim_end_ms, sample_rate, bit_depth,
      created_at
    ) VALUES (
      @title, @artist, @album, @duration,
      @file_path, @file_hash, @format, @bitrate,
      @year, @label, @genres, @bpm,
      @source_url, @source_platform, @source_quality, @source_link,
      @user_tags, @has_artwork, @artwork_path, @is_linked, @library_id,
      @trim_start_ms, @trim_end_ms, @sample_rate, @bit_depth,
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
    year: track.year ?? null,
    label: track.label ?? null,
    genres: track.genres ?? null,
    bpm: track.bpm ?? null,
    source_url: track.source_url ?? null,
    source_platform: track.source_platform ?? null,
    source_quality: track.source_quality ?? null,
    source_link: track.source_link ?? null,
    user_tags: track.user_tags ?? null,
    has_artwork: track.has_artwork ?? 0,
    artwork_path: track.artwork_path ?? null,
    is_linked: track.is_linked ?? 0,
    library_id: track.library_id ?? null,
    trim_start_ms: track.trim_start_ms ?? null,
    trim_end_ms: track.trim_end_ms ?? null,
    sample_rate: track.sample_rate ?? null,
    bit_depth: track.bit_depth ?? null,
    created_at: Date.now(),
  });

  return info.lastInsertRowid;
}

/**
 * Update the given columns of a track, ignoring names that are not in
 * ALLOWED_TRACK_COLUMNS (with a warning). Also flags the track as analyzed, so
 * it is not meant for file-level fields like sample rate — see
 * setTrackSampleInfo. Does nothing when no known field is passed.
 * @param {number} id
 * @param {object} data column name → value
 */
export function updateTrack(id, data) {
  console.log(`Updating track ${id} with data:`, data);
  const fields = Object.keys(data).filter((f) => {
    if (!ALLOWED_TRACK_COLUMNS.has(f)) {
      console.warn(`[updateTrack] Ignoring unknown column: ${f}`);
      return false;
    }
    return true;
  });
  if (!fields.length) return;

  const set = fields.map((f) => `${f} = @${f}`).join(', ');
  const safeData = Object.fromEntries(fields.map((f) => [f, data[f]]));
  db.prepare(
    `
    UPDATE tracks
    SET ${set}, analyzed = 1
    WHERE id = @id
  `
  ).run({ id, ...safeData });
}

/**
 * #561 — store the real sample rate / bit depth of a track's *file*.
 *
 * Separate from updateTrack() on purpose: updateTrack() always flags the track
 * as analyzed, and these two columns describe the file, not an analysis result.
 * A null value leaves the stored one alone (COALESCE), so the export-time
 * backfill can fill in whichever of the two is still missing.
 *
 * @param {number} id
 * @param {{ sampleRate?: number|null, bitDepth?: number|null }} info
 * @returns {boolean} true when at least one value was written
 */
export function setTrackSampleInfo(id, { sampleRate = null, bitDepth = null } = {}) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null;
  const depth = Number.isFinite(bitDepth) && bitDepth > 0 ? bitDepth : null;
  if (rate === null && depth === null) return false;

  const info = db
    .prepare(
      `
    UPDATE tracks
    SET sample_rate = COALESCE(@sampleRate, sample_rate),
        bit_depth   = COALESCE(@bitDepth, bit_depth)
    WHERE id = @id
  `
    )
    .run({ id, sampleRate: rate, bitDepth: depth });
  return info.changes > 0;
}

/**
 * Shared FROM/WHERE scope for one track-listing view (whole library or a
 * playlist) plus its natural (unsorted) order. getTracks / countTracks /
 * getTrackRank all build on this so page queries, the total count and the
 * rank of a row always describe the SAME row set.
 */
function buildViewScope({ search = '', filters = [], libraryIds, playlistId } = {}) {
  const { clauses: filterClauses, params: filterParams } = buildFiltersSQL(filters);

  const textClause = search ? '(title LIKE @_q OR artist LIKE @_q OR album LIKE @_q)' : null;
  const textParams = search ? { _q: `%${search}%` } : {};

  const { clause: libClause, params: libParams } = buildLibraryIdsSQL(libraryIds);

  const clauses = [
    ...filterClauses,
    ...(textClause ? [textClause] : []),
    ...(libClause ? [libClause] : []),
  ];
  const params = { ...filterParams, ...textParams, ...libParams };

  if (playlistId) {
    return {
      from: 'playlist_tracks pt\n      JOIN tracks t ON t.id = pt.track_id',
      where: clauses.length
        ? `pt.playlist_id = @playlistId AND ${clauses.join(' AND ')}`
        : 'pt.playlist_id = @playlistId',
      params: { playlistId, ...params },
      defaultOrder: 'pt.position ASC',
    };
  }
  return {
    from: 'tracks t',
    where: clauses.length ? clauses.join(' AND ') : null,
    params,
    defaultOrder: 't.created_at DESC',
  };
}

/**
 * One page of the track list, with `cue_count` per row.
 * @param {object} [query]
 * @param {number} [query.limit] page size, 50 by default
 * @param {number} [query.offset] rows to skip
 * @param {string} [query.search] substring matched against title, artist and album
 * @param {object[]} [query.filters] structured filters, see buildFiltersSQL
 * @param {number} [query.playlistId] restrict to one playlist instead of the library
 * @param {number[]} [query.libraryIds] restrict to these libraries, all when unset
 * @param {{ key: string, asc: boolean }} [query.sort] falls back to the view order
 * @returns {object[]}
 */
export function getTracks({
  limit = 50,
  offset = 0,
  search = '',
  filters = [],
  playlistId,
  libraryIds,
  sort,
} = {}) {
  const scope = buildViewScope({ search, filters, libraryIds, playlistId });
  const whereSql = scope.where ? `WHERE ${scope.where}` : '';

  const orderBy = buildTrackOrderSQL(sort);

  return db
    .prepare(
      `
      SELECT t.*, COALESCE(cp.cnt, 0) AS cue_count
      FROM ${scope.from}
      LEFT JOIN (SELECT track_id, COUNT(*) AS cnt FROM cue_points GROUP BY track_id) cp
        ON cp.track_id = t.id
      ${whereSql}
      ${orderBy || `ORDER BY ${scope.defaultOrder}`}
      LIMIT @limit OFFSET @offset
    `
    )
    .all({ ...scope.params, limit, offset });
}

/**
 * How many rows the current view (search / filters / playlist) matches —
 * identical row set to getTracks. Feeds the windowed list's spacer height so
 * the scroller spans the FULL result set even while only a window is loaded.
 */
export function countTracks({ search = '', filters = [], playlistId, libraryIds } = {}) {
  const scope = buildViewScope({ search, filters, libraryIds, playlistId });
  const whereSql = scope.where ? `WHERE ${scope.where}` : '';
  return db.prepare(`SELECT COUNT(*) AS c FROM ${scope.from} ${whereSql}`).get(scope.params).c;
}

/** ORDER BY column list (no prefix) for a sort, or the view's natural order. */
function buildTrackOrderColumns(sort, defaultOrder) {
  const orderBy = buildTrackOrderSQL(sort);
  if (orderBy) return orderBy.replace(/^ORDER BY\s+/i, '');
  return defaultOrder;
}

/**
 * 0-based position of one track inside the SORTED view (same row set and the
 * same ORDER BY as getTracks). Used by the library's "keep selection + scroll
 * to it after re-sort" path so the renderer can jump straight to the row
 * without materializing the whole result set over IPC (the old full-set
 * refetch scaled with library size and stalled the main thread).
 * Returns null when the track is not part of the view.
 */
export function getTrackRank({
  trackId,
  search = '',
  filters = [],
  playlistId,
  libraryIds,
  sort,
} = {}) {
  const scope = buildViewScope({ search, filters, libraryIds, playlistId });
  const orderCols = buildTrackOrderColumns(sort, scope.defaultOrder);
  const whereSql = scope.where ? `WHERE ${scope.where}` : '';
  const row = db
    .prepare(
      `
      SELECT rn FROM (
        SELECT t.id, ROW_NUMBER() OVER (ORDER BY ${orderCols}) AS rn
        FROM ${scope.from}
        ${whereSql}
      ) WHERE id = @trackId
    `
    )
    .get({ trackId, ...scope.params });
  return row ? row.rn - 1 : null;
}

const SORT_TEXT_COLS = new Set([
  'title',
  'artist',
  'album',
  'label',
  'genres',
  'format',
  'key_camelot',
  'key_raw',
]);
const SORT_NUM_COLS = new Set(['rating', 'year', 'duration', 'bitrate', 'loudness']);

/**
 * Build the ORDER BY clause for a sort. Empty values sort last regardless of
 * direction, text columns compare case-insensitively and the id breaks ties so
 * paging stays stable. bpm sorts on the override when one is set.
 * @param {{ key: string, asc: boolean }} [sort]
 * @returns {string} the clause, or an empty string for the natural order
 */
export function buildTrackOrderSQL(sort) {
  if (!sort || !sort.key || sort.key === 'index') return '';
  const dir = sort.asc ? 'ASC' : 'DESC';
  let expr;
  if (sort.key === 'bpm') {
    expr = 'COALESCE(t.bpm_override, t.bpm)';
  } else if (SORT_NUM_COLS.has(sort.key)) {
    expr = `t.${sort.key}`;
  } else if (SORT_TEXT_COLS.has(sort.key)) {
    expr = `t.${sort.key}`;
  } else {
    return '';
  }
  const isText = SORT_TEXT_COLS.has(sort.key);
  const nullsLast = `(${expr} IS NULL OR (${isText ? ` ${expr} = ''` : '0'})) ASC`;
  const collate = isText ? ' COLLATE NOCASE' : '';
  return `ORDER BY ${nullsLast}, ${expr}${collate} ${dir}, t.id ASC`;
}

/**
 * Ids of every track matching the view, in playlist or newest-first library
 * order — the unpaged counterpart of getTracks.
 * @param {object} [query] search, filters, playlistId and libraryIds as in getTracks
 * @returns {number[]}
 */
export function getTrackIds({ search = '', filters = [], playlistId, libraryIds } = {}) {
  const { clauses: filterClauses, params: filterParams } = buildFiltersSQL(filters);

  const textClause = search ? '(title LIKE @_q OR artist LIKE @_q OR album LIKE @_q)' : null;
  const textParams = search ? { _q: `%${search}%` } : {};
  const { clause: libClause, params: libParams } = buildLibraryIdsSQL(libraryIds);

  const allClauses = [
    ...filterClauses,
    ...(textClause ? [textClause] : []),
    ...(libClause ? [libClause] : []),
  ];
  const allParams = { ...filterParams, ...textParams, ...libParams };

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

/** The track whose file hash matches, or undefined. */
export function getTrackByHash(hash) {
  return db.prepare('SELECT * FROM tracks WHERE file_hash = ?').get(hash);
}

/** The track row for an id, or undefined. */
export function getTrackById(id) {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
}

/** Returns IDs of all analyzed tracks that can have gain computed. */
export function getTrackIdsNeedingNormalization() {
  return db
    .prepare(`SELECT id FROM tracks WHERE loudness IS NOT NULL`)
    .all()
    .map((r) => r.id);
}

/** How many tracks still point at a normalized file, i.e. are counted as normalized. */
export function getNormalizedTrackCount() {
  return db
    .prepare(`SELECT COUNT(*) as cnt FROM tracks WHERE normalized_file_path IS NOT NULL`)
    .get().cnt;
}

/** Returns tracks that still have a legacy normalized_file_path set (pre-#260 exports). */
export function getLegacyNormalizedTracks() {
  return db
    .prepare(`SELECT id, normalized_file_path FROM tracks WHERE normalized_file_path IS NOT NULL`)
    .all();
}

/** Clears normalized_file_path and source_loudness for all tracks (legacy cleanup). */
export function clearLegacyNormalizedPaths() {
  db.prepare(
    `UPDATE tracks SET normalized_file_path = NULL, source_loudness = NULL WHERE normalized_file_path IS NOT NULL`
  ).run();
}

/** Delete one track row. */
export function removeTrack(id) {
  db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
}

/** Deletes many track rows in a single transaction (bulk remove — DB write only, no filesystem I/O). */
export function removeTracks(trackIds) {
  const del = db.prepare('DELETE FROM tracks WHERE id = ?');
  db.transaction(() => {
    for (const id of trackIds) del.run(id);
  })();
}

/** Counts tracks still referencing this file_path — used to avoid deleting a file that another track row still points at. */
export function getTrackCountByFilePath(filePath) {
  return db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE file_path = ?').get(filePath).n;
}

/**
 * Recompute the ReplayGain of every analyzed track against a target loudness.
 * @param {number} targetLufs target loudness in LUFS
 * @returns {number} rows updated
 */
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

/**
 * Recompute the ReplayGain of selected tracks, in one transaction.
 * @param {number[]} trackIds
 * @param {number} targetLufs target loudness in LUFS
 * @returns {Object<number, number>} track id → new gain, entries only for tracks that changed
 */
export function normalizeTracksByIds(trackIds, targetLufs) {
  const update = db.prepare(
    `UPDATE tracks SET replay_gain = ROUND((? - loudness) * 10) / 10 WHERE id = ? AND loudness IS NOT NULL`
  );
  const read = db.prepare(`SELECT replay_gain FROM tracks WHERE id = ?`);
  const gains = {};
  db.transaction(() => {
    for (const id of trackIds) {
      const info = update.run(targetLufs, id);
      if (info.changes) {
        const row = read.get(id);
        if (row) gains[id] = row.replay_gain;
      }
    }
  })();
  return gains;
}

/**
 * Clear the gain and normalized-file bookkeeping, for the given tracks or for
 * the whole library when no ids are passed.
 * @param {number[]|null} [trackIds]
 * @returns {number} rows cleared
 */
export function resetNormalization(trackIds = null) {
  if (trackIds && trackIds.length > 0) {
    const stmt = db.prepare(
      `UPDATE tracks SET replay_gain = NULL, normalized_file_path = NULL, source_loudness = NULL WHERE id = ?`
    );
    db.transaction(() => {
      for (const id of trackIds) stmt.run(id);
    })();
    return trackIds.length;
  }
  const info = db
    .prepare(
      `UPDATE tracks SET replay_gain = NULL, normalized_file_path = NULL, source_loudness = NULL`
    )
    .run();
  return info.changes ?? 0;
}

/** Delete every track row and VACUUM the database. */
export function clearTracks() {
  console.log('Clearing all tracks from database');
  db.prepare(`DELETE FROM tracks`).run();
  db.prepare(`VACUUM`).run();
}

/** Clears only one library's tracks — other libraries are untouched. */
export function clearTracksForLibrary(libraryId) {
  console.log(`Clearing all tracks for library ${libraryId}`);
  db.prepare(`DELETE FROM tracks WHERE library_id = ?`).run(libraryId);
  db.prepare(`VACUUM`).run();
}

/**
 * Given an array of { url, id } entry objects, returns a Set of URLs whose
 * video ID already exists in the library.
 * Checks source_link, source_url, AND title (yt-dlp stores the video ID in
 * brackets at the end of the title when source_link is not captured).
 */
/**
 * For each entry check whether a track already exists in the library.
 * Returns an array of { url, trackId } for every entry that matches.
 */
export function getExistingSourceUrls(entries) {
  if (!entries || entries.length === 0) return [];
  const results = [];
  const stmt = db.prepare(
    `SELECT id FROM tracks
     WHERE source_link LIKE ? OR source_url LIKE ? OR title LIKE ?
     LIMIT 1`
  );
  for (const { url, id } of entries) {
    if (!id && !url) continue;
    const pattern = `%${id || url}%`;
    const row = stmt.get(pattern, pattern, pattern);
    if (row) results.push({ url, trackId: row.id });
  }
  return results;
}

/** Store the overview waveform of a track (the small 400-column buffer). */
export function updateTrackWaveform(trackId, buf) {
  db.prepare('UPDATE tracks SET waveform_overview = ? WHERE id = ?').run(buf, trackId);
}

/** The stored overview waveform buffer, or null when the track has none. */
export function getTrackWaveform(trackId) {
  const row = db.prepare('SELECT waveform_overview FROM tracks WHERE id = ?').get(trackId);
  return row?.waveform_overview ?? null;
}

/**
 * High-resolution (600 cols/sec) detail waveform for the Beat Grid Editor
 * zoom view (#262). Separate from `detail` (150 cols/sec), which stays at
 * the Pioneer CDJ export resolution and is generated on demand rather than
 * stored.
 */
export function updateTrackDetailHires(trackId, buf) {
  db.prepare('UPDATE tracks SET waveform_detail_hires = ? WHERE id = ?').run(buf, trackId);
}

/** The stored high-resolution detail waveform buffer, or null when there is none. */
export function getTrackDetailHires(trackId) {
  const row = db.prepare('SELECT waveform_detail_hires FROM tracks WHERE id = ?').get(trackId);
  return row?.waveform_detail_hires ?? null;
}

/**
 * Returns all tracks in a playlist with their source URL fields,
 * used to determine "already in playlist" status on the selection screen.
 */
export function getPlaylistSourceUrls(playlistId) {
  return db
    .prepare(
      `SELECT t.id AS trackId, t.source_url, t.source_link
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       WHERE pt.playlist_id = ?`
    )
    .all(playlistId);
}

/**
 * Track rows for a set of file paths, used to resync the list after a move.
 * @param {string[]} filePaths
 * @returns {object[]}
 */
export function getTracksByPaths(filePaths) {
  if (!filePaths || filePaths.length === 0) return [];
  const placeholders = filePaths.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM tracks WHERE file_path IN (${placeholders})`).all(filePaths);
}

/** Id, path, title and artist of every linked track — enough to resolve links without loading full rows. */
export function getLinkedTracksBasic() {
  return db.prepare(`SELECT id, file_path, title, artist FROM tracks WHERE is_linked = 1`).all();
}

/** Distinct directories that contain linked tracks. */
export function getLinkedTrackDirs() {
  const rows = db.prepare(`SELECT DISTINCT file_path FROM tracks WHERE is_linked = 1`).all();
  return [...new Set(rows.map((r) => path.dirname(r.file_path)))];
}

/**
 * Rewrite file paths after a folder was moved: every path starting with
 * oldPrefix gets the prefix swapped for newPrefix.
 * @param {string} oldPrefix
 * @param {string} newPrefix
 * @returns {number} rows rewritten
 */
export function remapTracksByPrefix(oldPrefix, newPrefix) {
  const rows = db
    .prepare(`SELECT id, file_path FROM tracks WHERE file_path LIKE ?`)
    .all(oldPrefix + '%');
  let count = 0;
  for (const row of rows) {
    const newPath = newPrefix + row.file_path.slice(oldPrefix.length);
    db.prepare(`UPDATE tracks SET file_path = ? WHERE id = ?`).run(newPath, row.id);
    count++;
  }
  return count;
}
