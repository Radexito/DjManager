import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';

import { detectFileType } from '../formats/pdb.js';
import { STATIC_TABLES } from './static.js';
import { LIBRARY_TABLES } from './schema.js';

/**
 * rekordbox's device library, `PIONEER/rekordbox/exportLibrary.db`.
 *
 * The file is SQLCipher 4 with default parameters, despite what the protocol
 * note says: page 4096, HMAC-SHA512, PBKDF2-HMAC-SHA512, 256000 iterations.
 * `better-sqlite3-multiple-ciphers` speaks that mode through `cipher=sqlcipher`
 * plus `legacy=4`, and ships N-API prebuilds, so no compiler is needed.
 *
 * The key is a constant of the format, not of a machine: the same 64 characters
 * open an export from April and one from November. It is NOT in this repository.
 * Callers pass it from the environment or from settings.
 */
export const ONELIBRARY_FILE = 'PIONEER/rekordbox/exportLibrary.db';

/** Where the key comes from: env first, then the settings table. */
export function resolveLibraryKey({ env = process.env, getSetting } = {}) {
  const fromEnv = typeof env?.REKORDBOX_LIBRARY_KEY === 'string' ? env.REKORDBOX_LIBRARY_KEY : '';
  if (fromEnv.trim()) return fromEnv.trim();
  try {
    const stored = getSetting?.('rekordbox_library_key');
    return typeof stored === 'string' && stored.trim() ? stored.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Open a device library. The key is applied before the first read; a wrong key
 * surfaces as SQLITE_NOTADB on that read, not at open time.
 */
export function openLibrary(file, { key, readonly = false } = {}) {
  if (!key) throw new Error('onelibrary: a library key is required');
  const db = new Database(file, { readonly, fileMustExist: readonly });
  db.pragma("cipher='sqlcipher'");
  db.pragma('legacy=4');
  db.pragma(`key='${String(key).replace(/'/g, "''")}'`);
  db.prepare('select count(*) as n from sqlite_master').get();
  return db;
}

/** The rows the application reads back: content, playlists, membership, tags. */
export function readLibrary(file, { key } = {}) {
  const db = openLibrary(file, { key, readonly: true });
  try {
    return {
      content: db.prepare('select * from content order by content_id').all(),
      playlists: db.prepare('select * from playlist order by sequenceNo, playlist_id').all(),
      membership: db
        .prepare(
          'select playlist_id, content_id, sequenceNo from playlist_content order by playlist_id, sequenceNo'
        )
        .all(),
      myTags: db.prepare('select * from myTag order by sequenceNo, myTag_id').all(),
    };
  } finally {
    db.close();
  }
}

const asRows = (value) => (value instanceof Map ? [...value.values()] : (value ?? []));

/** 0..5 as the library stores it, 0..255 as the PDB stores it. */
function libraryRating(value) {
  const rating = Number(value ?? 0);
  if (!Number.isFinite(rating) || rating <= 0) return 0;
  const normalised = rating > 5 ? Math.round(rating / 51) : Math.round(rating);
  return Math.max(0, Math.min(5, normalised));
}

function putUnique(map, key, name) {
  const text = String(name ?? '').trim();
  if (!text) return null;
  if (!map.has(text)) map.set(text, map.size + 1);
  return map.get(text);
}

/**
 * Write a device library from what the export just put on the medium.
 *
 * My Tags come from the caller: the application has no tag model yet, so an
 * export without one writes an empty tree instead of inventing the user's.
 *
 * `tracks` and `playlists` are the rows the manifest carries: `file_path` is the
 * path on the medium (`/Contents/x.mp3`), and playlist membership is `track_ids`
 * because that is what the player has. Fields rekordbox fills from its own
 * master library (`masterDbId`, `masterContentId`, `contentLink`) are written as
 * zero: this is a device library, not a copy of the source library.
 */
export function writeLibrary(file, { key, tracks, playlists, myTags = [], now = new Date() } = {}) {
  if (!key) throw new Error('onelibrary: a library key is required');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const trackRows = asRows(tracks).filter((track) => track && track.file_path);
  const playlistRows = asRows(playlists);
  const date = now.toISOString().slice(0, 10);
  const db = openLibrary(file, { key });

  try {
    db.exec('BEGIN');
    for (const ddl of LIBRARY_TABLES) db.exec(ddl);

    const insertCategory = db.prepare(
      'insert into category (category_id, menuItem_id, sequenceNo, isVisible) values (@category_id, @menuItem_id, @sequenceNo, @isVisible)'
    );
    const insertColor = db.prepare('insert into color (color_id, name) values (@color_id, @name)');
    const insertMenuItem = db.prepare(
      'insert into menuItem (menuItem_id, kind, name) values (@menuItem_id, @kind, @name)'
    );
    const insertSort = db.prepare(
      'insert into sort (sort_id, menuItem_id, sequenceNo, isVisible, isSelectedAsSubColumn) values (@sort_id, @menuItem_id, @sequenceNo, @isVisible, @isSelectedAsSubColumn)'
    );
    for (const row of STATIC_TABLES.category) insertCategory.run(row);
    for (const row of STATIC_TABLES.color) insertColor.run(row);
    for (const row of STATIC_TABLES.menuItem) insertMenuItem.run(row);
    for (const row of STATIC_TABLES.sort) insertSort.run(row);

    if (myTags.length > 0) {
      const insertMyTag = db.prepare(
        'insert into myTag (myTag_id, sequenceNo, name, attribute, myTag_id_parent) values (@myTag_id, @sequenceNo, @name, @attribute, @myTag_id_parent)'
      );
      for (const row of myTags) insertMyTag.run(row);
    }

    const artists = new Map();
    const keys = new Map();
    for (const track of trackRows) {
      putUnique(artists, 'artist', track.artist);
      putUnique(keys, 'key', track.key_raw || track.key_camelot);
    }
    const insertArtist = db.prepare(
      'insert into artist (artist_id, name, nameForSearch) values (?, ?, null)'
    );
    for (const [name, id] of artists) insertArtist.run(id, name);
    const insertKey = db.prepare('insert into key (key_id, name) values (?, ?)');
    for (const [name, id] of keys) insertKey.run(id, name);

    const insertContent = db.prepare(`
      insert into content (
        content_id, title, titleForSearch, subtitle, bpmx100, length, trackNo, discNo,
        artist_id_artist, artist_id_remixer, artist_id_originalArtist, artist_id_composer,
        artist_id_lyricist, album_id, genre_id, label_id, key_id, color_id, image_id,
        djComment, rating, releaseYear, releaseDate, dateCreated, dateAdded, path, fileName,
        fileSize, fileType, bitrate, bitDepth, samplingRate, isrc, djPlayCount,
        isHotCueAutoLoadOn, isKuvoDeliverStatusOn, kuvoDeliveryComment, masterDbId,
        masterContentId, analysisDataFilePath, analysedBits, contentLink, hasModified,
        cueUpdateCount, analysisDataUpdateCount, informationUpdateCount
      ) values (
        @content_id, @title, null, null, @bpmx100, @length, 0, 0,
        @artist_id, null, null, null,
        null, null, null, null, @key_id, 0, null,
        null, @rating, @releaseYear, null, @date, @date, @path, @fileName,
        0, @fileType, @bitrate, @bitDepth, @samplingRate, null, 0,
        1, 0, null, 0,
        0, @analysisDataFilePath, 105, 0, 0,
        0, 0, 0
      )
    `);

    const contentIdByTrack = new Map();
    trackRows.forEach((track, index) => {
      const contentId = index + 1;
      contentIdByTrack.set(track.id, contentId);
      insertContent.run({
        content_id: contentId,
        title: track.title ?? '',
        bpmx100: Math.round(Number(track.bpm ?? 0) * 100),
        length: Math.round(Number(track.duration ?? 0)),
        artist_id: artists.get(String(track.artist ?? '').trim()) ?? null,
        key_id: keys.get(String(track.key_raw || track.key_camelot || '').trim()) ?? null,
        rating: libraryRating(track.rating),
        releaseYear: Number(track.year) || 0,
        date,
        path: track.file_path,
        fileName: path.posix.basename(track.file_path),
        fileType: detectFileType(track.file_path),
        bitrate: Math.round(Number(track.bitrate ?? 0) / 1000),
        bitDepth: track.bit_depth ?? null,
        samplingRate: track.sample_rate ?? null,
        analysisDataFilePath: track.analyzePath || null,
      });
    });

    const insertPlaylist = db.prepare(
      'insert into playlist (playlist_id, sequenceNo, name, image_id, attribute, playlist_id_parent) values (?, ?, ?, null, 0, 0)'
    );
    const insertMembership = db.prepare(
      'insert into playlist_content (playlist_id, content_id, sequenceNo) values (?, ?, ?)'
    );
    playlistRows.forEach((playlist, index) => {
      const playlistId = index + 1;
      insertPlaylist.run(playlistId, index, playlist.name ?? '');
      const ids = playlist.track_ids ?? playlist.trackIds ?? [];
      let sequence = 0;
      for (const trackId of ids) {
        const contentId = contentIdByTrack.get(trackId);
        if (!contentId) continue;
        sequence += 1;
        insertMembership.run(playlistId, contentId, sequence);
      }
    });

    db.exec('COMMIT');
    return {
      path: file,
      trackCount: trackRows.length,
      playlistCount: playlistRows.length,
      artistCount: artists.size,
      keyCount: keys.size,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    throw err;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * The check #10 asks for: the two databases say the same thing about the medium.
 * Counts come from the PDB the export published, so a mismatch is a real defect
 * rather than a formatting difference.
 */
export function checkConsistency({ library, pdbTrackCount, pdbPlaylistCount }) {
  const problems = [];
  if (!library) return { ok: false, problems: ['no library was written'] };
  if (library.content.length !== pdbTrackCount) {
    problems.push(`library has ${library.content.length} tracks, pdb has ${pdbTrackCount}`);
  }
  if (library.playlists.length !== pdbPlaylistCount) {
    problems.push(`library has ${library.playlists.length} playlists, pdb has ${pdbPlaylistCount}`);
  }
  return { ok: problems.length === 0, problems };
}
