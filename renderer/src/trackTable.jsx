/**
 * How a track table looks and what each cell shows.
 *
 * The library, the playlist tabs and the view of a medium all draw the same
 * columns from here, so a row looks the same wherever it comes from.
 */
import { Fragment } from 'react';

import { splitArtists } from './searchParser.js';

const RIGHT_ALIGNED_COLUMNS = new Set([
  'bpm',
  'key_camelot',
  'loudness',
  'year',
  'duration',
  'bitrate',
]);

const ALL_COLUMNS = [
  { key: 'index', label: '#', width: '40px' },
  { key: 'title', label: 'Title', width: 'minmax(120px, 2fr)' },
  { key: 'artist', label: 'Artist', width: 'minmax(90px, 1.5fr)' },
  { key: 'rating', label: 'Rating', width: '88px' },
  { key: 'bpm', label: 'BPM', width: '62px' },
  { key: 'key_camelot', label: 'Key', width: '52px' },
  { key: 'loudness', label: 'Loudness (LUFS)', width: '115px' },
  { key: 'cue', label: '◆', width: '28px' },
  { key: 'album', label: 'Album', width: 'minmax(80px, 1fr)' },
  { key: 'year', label: 'Year', width: '50px' },
  { key: 'label', label: 'Label', width: '100px' },
  { key: 'genres', label: 'Genres', width: '120px' },
  { key: 'user_tags', label: 'Tags', width: '120px' },
  { key: 'bitrate', label: 'Bitrate', width: '92px' },
  { key: 'duration', label: 'Duration', width: '65px' },
];

const ALL_COLUMN_KEYS = ALL_COLUMNS.map((c) => c.key);
const COL_BY_KEY = Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c]));

/** Format a duration in seconds as m:ss, or an em dash when unknown. */
function fmtDuration(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Render the contents of one track table cell.
 *
 * Artist cells become clickable (or split into several links) for multi-artist
 * tracks, the rating and cue cells render widgets, everything else is plain text.
 *
 * @param {object} t Track row from the database.
 * @param {string} colKey Column to render.
 * @param {(artist: string) => void} [onArtistClick] Enables the artist links.
 * @returns {React.ReactNode} Cell content.
 */
function renderCell(t, colKey, onArtistClick) {
  const bpmValue = t.bpm_override ?? t.bpm;
  switch (colKey) {
    case 'title':
      return t.title;
    case 'artist': {
      const name = t.artist || 'Unknown';
      if (!t.artist || !onArtistClick) return name;
      const names = splitArtists(t.artist);
      if (names.length < 2) {
        return (
          <span
            className="cell-artist--clickable"
            title={`Search: ARTIST is ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              onArtistClick(name);
            }}
          >
            {name}
          </span>
        );
      }
      return names.map((one, i) => (
        <Fragment key={one}>
          {i > 0 ? ', ' : null}
          <span
            className="cell-artist--clickable"
            title={`Search: ARTIST contains ${one}`}
            onClick={(e) => {
              e.stopPropagation();
              onArtistClick(one, true);
            }}
          >
            {one}
          </span>
        </Fragment>
      ));
    }
    case 'bpm': {
      const display = bpmValue ?? '...';
      const hasGridShift = (t.beatgrid_offset ?? 0) !== 0;
      if (!hasGridShift) return display;
      return (
        <span title={`Grid shifted ${t.beatgrid_offset > 0 ? '+' : ''}${t.beatgrid_offset} ms`}>
          {display}
          <span className="bpm-grid-shift-dot" />
        </span>
      );
    }
    case 'key_camelot':
      return t.key_camelot ?? '...';
    case 'loudness':
      return t.loudness != null ? t.loudness : '...';
    case 'album':
      return t.album || '—';
    case 'year':
      return t.year ?? '—';
    case 'label':
      return t.label || '—';
    case 'genres': {
      try {
        return JSON.parse(t.genres ?? '[]').join(', ') || '—';
      } catch {
        return '—';
      }
    }
    case 'cue':
      return null;
    case 'rating':
      return null;
    case 'user_tags':
      return t.user_tags || '—';
    case 'duration':
      return fmtDuration(t.duration);
    case 'bitrate':
      return t.bitrate != null ? `${Math.round(t.bitrate / 1000)} kbps` : '—';
    default:
      return t[colKey] ?? '—';
  }
}

/**
 * CSS classes for a cell: numeric alignment, plus markers for a BPM override and
 * for a non-zero beat grid offset.
 *
 * @param {string} colKey Column key.
 * @param {object} t Track row.
 * @returns {string} Space separated class list.
 */
function cellClass(colKey, t) {
  const numeric = ['bpm', 'key_camelot', 'loudness', 'year', 'duration', 'bitrate'].includes(
    colKey
  );
  const over = colKey === 'bpm' && t.bpm_override != null;
  const gridShifted = colKey === 'bpm' && (t.beatgrid_offset ?? 0) !== 0;
  return `cell ${colKey}${numeric ? ' numeric' : ''}${over ? ' bpm--overridden' : ''}${gridShifted ? ' bpm--grid-shifted' : ''}`;
}

export {
  ALL_COLUMNS,
  ALL_COLUMN_KEYS,
  COL_BY_KEY,
  RIGHT_ALIGNED_COLUMNS,
  cellClass,
  fmtDuration,
  renderCell,
};
