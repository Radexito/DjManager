import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ─── MUSICAL_KEY value mapping ─────────────────────────────────────────────────
// Maps key_camelot (e.g. "8B", "5A") → Traktor MUSICAL_KEY VALUE (0-23)
// 0=C, 1=Db, 2=D, 3=Eb, 4=E, 5=F, 6=Gb, 7=G, 8=Ab, 9=A, 10=Bb, 11=B
// 12=Cm, 13=Dbm, 14=Dm, 15=Ebm, 16=Em, 17=Fm, 18=Gbm, 19=Gm, 20=Abm, 21=Am, 22=Bbm, 23=Bm
const CAMELOT_TO_MUSICAL_KEY = {
  '8B': 0, // C  major
  '3B': 1, // Db major
  '10B': 2, // D  major
  '5B': 3, // Eb major
  '12B': 4, // E  major
  '7B': 5, // F  major
  '2B': 6, // Gb major
  '9B': 7, // G  major
  '4B': 8, // Ab major
  '11B': 9, // A  major
  '6B': 10, // Bb major
  '1B': 11, // B  major
  '5A': 12, // Cm minor
  '12A': 13, // Dbm minor
  '7A': 14, // Dm minor
  '2A': 15, // Ebm minor
  '9A': 16, // Em minor
  '4A': 17, // Fm minor
  '11A': 18, // Gbm minor
  '6A': 19, // Gm minor
  '1A': 20, // Abm minor
  '8A': 21, // Am minor
  '3A': 22, // Bbm minor
  '10A': 23, // Bm minor
};

// Traktor INFO KEY attribute uses text key notation (e.g. "Am", "C", "Dm")
const MUSICAL_KEY_TO_TEXT = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
  'Cm',
  'Dbm',
  'Dm',
  'Ebm',
  'Em',
  'Fm',
  'Gbm',
  'Gm',
  'Abm',
  'Am',
  'Bbm',
  'Bm',
];

// ─── XML helpers ───────────────────────────────────────────────────────────────

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join('');
}

function tag(name, attrsObj, children = '', selfClose = false) {
  const a = attrs(attrsObj);
  if (selfClose || children === '') return `<${name}${a}></${name}>`;
  return `<${name}${a}>${children}</${name}>`;
}

// ─── Path encoding ─────────────────────────────────────────────────────────────
// Traktor encodes DIR as /:-separated path segments with trailing /: e.g. "/:Music/:Artist/:"
// FILE is just the filename.

function encodePath(filePath) {
  if (!filePath) return { dir: '/:', file: '' };

  // Normalize separators
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');

  if (lastSlash === -1) {
    return { dir: '/:', file: normalized };
  }

  const dirPart = normalized.slice(0, lastSlash);
  const file = normalized.slice(lastSlash + 1);

  // Convert /path/to/dir → /:path/:to/:dir/:
  const segments = dirPart.split('/').filter(Boolean);
  const dirFinal = '/:' + segments.map((s) => escapeXml(s)).join('/:') + '/:';

  return { dir: dirFinal, file: escapeXml(file) };
}

// Derive VOLUME from file path (first path component on Mac/Linux = volume name or "")
function deriveVolume(filePath) {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/Volumes/')) {
    return normalized.split('/')[2] || '';
  }
  // Linux/Windows: use empty string — Traktor will re-link on import
  return '';
}

// ─── Entry builder ─────────────────────────────────────────────────────────────

function buildEntry(track) {
  const { dir, file } = encodePath(track.file_path);
  const volume = deriveVolume(track.file_path);

  // MUSICAL_KEY numeric value
  const musicalKeyValue = CAMELOT_TO_MUSICAL_KEY[track.key_camelot] ?? '';
  const textKey = musicalKeyValue !== '' ? MUSICAL_KEY_TO_TEXT[musicalKeyValue] : '';

  // Genres: stored as JSON array in DB
  let genre = '';
  try {
    const genres = typeof track.genres === 'string' ? JSON.parse(track.genres) : track.genres;
    if (Array.isArray(genres) && genres.length > 0) genre = genres[0];
  } catch {
    genre = track.genres || '';
  }

  // Date fields
  const today = new Date();
  const modifiedDate = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  const modifiedTime = Math.floor(
    today.getHours() * 3600 + today.getMinutes() * 60 + today.getSeconds()
  );

  const entryAttrs = {
    MODIFIED_DATE: modifiedDate,
    MODIFIED_TIME: String(modifiedTime),
    TITLE: track.title || '',
    ARTIST: track.artist || '',
  };

  const location = tag('LOCATION', {
    DIR: dir,
    FILE: file,
    VOLUME: volume,
    VOLUMEID: volume,
  });

  const album = track.album
    ? tag('ALBUM', { TITLE: track.album, TRACK: track.track_number || '' })
    : '<ALBUM></ALBUM>';

  const modInfo = tag('MODIFICATION_INFO', { AUTHOR_TYPE: 'user' });

  const infoAttrs = {
    BITRATE: track.bitrate ? String(track.bitrate * 1000) : '',
    GENRE: genre,
    LABEL: track.label || '',
    COMMENT: track.comments || '',
    KEY: textKey,
    PLAYCOUNT: '0',
    PLAYTIME: track.duration ? String(Math.round(track.duration)) : '',
    PLAYTIME_FLOAT: track.duration ? track.duration.toFixed(6) : '',
    RANKING: track.rating ? String(track.rating * 51) : '0', // 0-5 stars → 0-255
    IMPORT_DATE: modifiedDate,
    FLAGS: '8',
  };
  const info = tag('INFO', infoAttrs);

  const bpm = track.bpm_override ?? track.bpm;
  const tempo = tag('TEMPO', {
    BPM: bpm ? bpm.toFixed(6) : '',
    BPM_QUALITY: '100.000000',
  });

  const loudness = tag('LOUDNESS', {
    PEAK_DB: track.loudness != null ? String(track.loudness) : '0.0',
    PERCEIVED_DB: track.loudness != null ? String(track.loudness) : '0.0',
    ANALYZED_DB: track.loudness != null ? String(track.loudness) : '0.0',
  });

  const musicalKey =
    musicalKeyValue !== '' ? tag('MUSICAL_KEY', { VALUE: String(musicalKeyValue) }) : '';

  // AutoGrid CUE_V2 from intro_secs (ms) or beat 0
  const gridStartMs = track.intro_secs != null ? (track.intro_secs * 1000).toFixed(6) : '0.000000';
  const autoGrid = tag('CUE_V2', {
    NAME: 'AutoGrid',
    DISPL_ORDER: '0',
    TYPE: '4',
    START: gridStartMs,
    LEN: '0.000000',
    REPEATS: '-1',
    HOTCUE: '-1',
  });

  const children = [location, album, modInfo, info, tempo, loudness, musicalKey, autoGrid]
    .filter(Boolean)
    .join('\n');

  return tag('ENTRY', entryAttrs, '\n' + children + '\n');
}

// ─── Playlist tree builder ─────────────────────────────────────────────────────

function buildPlaylistEntries(trackKeys) {
  return trackKeys
    .map((key) => `<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="${escapeXml(key)}"></PRIMARYKEY></ENTRY>`)
    .join('\n');
}

function buildPlaylistNode(playlist, trackKeyMap) {
  const keys = (playlist.track_ids || []).map((id) => trackKeyMap[id]).filter(Boolean);

  const playlistEl = tag(
    'PLAYLIST',
    { ENTRIES: String(keys.length), TYPE: 'LIST' },
    '\n' + buildPlaylistEntries(keys) + '\n'
  );

  return tag('NODE', { TYPE: 'PLAYLIST', NAME: playlist.name }, '\n' + playlistEl + '\n');
}

function buildPlaylistsSection(playlists, trackKeyMap) {
  const playlistNodes = playlists.map((pl) => buildPlaylistNode(pl, trackKeyMap)).join('\n');

  const subNodes = tag(
    'SUBNODES',
    { COUNT: String(playlists.length) },
    '\n' + playlistNodes + '\n'
  );

  const rootNode = tag('NODE', { TYPE: 'FOLDER', NAME: '$ROOT' }, '\n' + subNodes + '\n');

  return tag('PLAYLISTS', {}, '\n' + rootNode + '\n');
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Build and write a Traktor NML collection file.
 *
 * @param {{ tracks: object[], playlists: object[] }} payload
 * @param {string} outputPath - Full path to the output .nml file
 */
export function writeNml(payload, outputPath) {
  const { tracks, playlists } = payload;

  // Build a map from track ID → Traktor PRIMARYKEY (volume path string)
  const trackKeyMap = {};
  for (const track of tracks) {
    const { dir, file } = encodePath(track.file_path);
    const volume = deriveVolume(track.file_path);
    // Traktor PRIMARYKEY format: "{VOLUME}{DIR}{FILE}"
    trackKeyMap[track.id] = `${volume}${dir}${file}`;
  }

  const entryElements = tracks.map(buildEntry).join('\n');
  const collection = tag(
    'COLLECTION',
    { ENTRIES: String(tracks.length) },
    '\n' + entryElements + '\n'
  );

  const playlistsSection = buildPlaylistsSection(playlists, trackKeyMap);

  const nml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    `<NML VERSION="19">`,
    tag('HEAD', { COMPANY: 'www.native-instruments.com', PROGRAM: 'Traktor' }),
    '<MUSICFOLDERS></MUSICFOLDERS>',
    collection,
    '<SETS ENTRIES="0"></SETS>',
    playlistsSection,
    '</NML>',
  ].join('\n');

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, nml, 'utf8');
}
