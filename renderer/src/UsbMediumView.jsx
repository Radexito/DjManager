import { useEffect, useMemo, useState } from 'react';

import { COL_BY_KEY, cellClass, renderCell } from './trackTable.jsx';

/**
 * Columns a medium can answer. The library table also knows key, loudness,
 * genres and cues, but those live in the analysis files and in the library
 * database, not in the playlist database a stick carries.
 */
const MEDIUM_COLUMN_KEYS = ['index', 'title', 'artist', 'album', 'bpm', 'rating', 'duration'];

const MEDIUM_COLUMNS = MEDIUM_COLUMN_KEYS.map((key) => COL_BY_KEY[key]).filter(Boolean);

const RIGHT_ALIGNED = new Set(['bpm', 'duration', 'rating', 'index']);

/** Smallest width the row may shrink to, the same way the library table does it. */
function minWidthOf(columns) {
  return columns.reduce((total, column) => {
    const range = column.width.match(/minmax\((\d+)px/);
    if (range) return total + Number(range[1]);
    const fixed = column.width.match(/^(\d+)px$/);
    if (fixed) return total + Number(fixed[1]);
    return total;
  }, 0);
}

/**
 * Read-only view of what one medium carries, drawn with the same table the
 * library and playlist tabs use: same columns, same cell rendering, same row
 * styles. It cannot reuse their data path, because that reads this
 * application's library database while a medium answers from its own
 * `export.pdb`, so rows arrive here already mapped.
 */
export default function UsbMediumView({ selection, onClose }) {
  // Keyed by mount so switching devices never shows the previous one's rows,
  // and the effect only ever sets state from a callback.
  const [result, setResult] = useState({ mount: null, contents: undefined });

  useEffect(() => {
    let alive = true;
    const request = window.api?.getUsbContents;
    if (typeof request !== 'function') return undefined;
    request(selection.mount)
      .then((contents) => {
        if (alive) setResult({ mount: selection.mount, contents: contents ?? null });
      })
      .catch(() => {
        if (alive) setResult({ mount: selection.mount, contents: null });
      });
    return () => {
      alive = false;
    };
  }, [selection.mount]);

  const readable = typeof window.api?.getUsbContents === 'function';
  const contents = readable
    ? result.mount === selection.mount
      ? result.contents
      : undefined
    : null;

  const playlist =
    contents && selection.playlistId != null
      ? (contents.playlists.find((entry) => entry.id === selection.playlistId) ?? null)
      : null;
  const tracks = playlist ? playlist.tracks : (contents?.tracks ?? []);
  const title = playlist ? playlist.name : 'Library';

  const gridTemplate = useMemo(() => MEDIUM_COLUMNS.map((c) => c.width).join(' '), []);
  const minWidth = useMemo(() => minWidthOf(MEDIUM_COLUMNS), []);

  return (
    <div className="usb-medium-view" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.75rem',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid var(--border, #333)',
        }}
      >
        <strong style={{ fontSize: '1.05rem' }}>{title}</strong>
        <span style={{ opacity: 0.7 }}>{selection.mount}</span>
        <span style={{ opacity: 0.7 }}>{tracks.length} track(s)</span>
        <span style={{ opacity: 0.55, fontSize: '0.85rem' }}>read only, from the medium</span>
        <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Close
        </button>
      </div>

      {contents === undefined && (
        <div style={{ padding: '1rem', opacity: 0.8 }}>Reading the medium…</div>
      )}
      {contents === null && (
        <div style={{ padding: '1rem', opacity: 0.8 }}>
          This medium carries no playlist database that can be read.
        </div>
      )}
      {contents && tracks.length === 0 && (
        <div style={{ padding: '1rem', opacity: 0.8 }}>Nothing to show here.</div>
      )}
      {contents && tracks.length > 0 && (
        <>
          <div style={{ overflow: 'hidden' }}>
            <div
              className="header"
              style={{ gridTemplateColumns: gridTemplate, minWidth: minWidth }}
            >
              {MEDIUM_COLUMNS.map((column) => (
                <div
                  key={column.key}
                  className={`header-cell ${RIGHT_ALIGNED.has(column.key) ? 'right' : ''}`}
                  title={column.label}
                >
                  {column.label}
                </div>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {tracks.map((track, index) => (
              <div
                key={track.id}
                className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}`}
                style={{ gridTemplateColumns: gridTemplate, minWidth: minWidth }}
                title={track.title}
              >
                {MEDIUM_COLUMNS.map((column) => {
                  if (column.key === 'rating') {
                    const value = track.rating ?? 0;
                    return (
                      <div
                        key="rating"
                        className="cell rating"
                        title={`${value} of 5, as the medium records it`}
                      >
                        <span className="rating-stars-static">
                          {'★'.repeat(value)}
                          {'☆'.repeat(Math.max(0, 5 - value))}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div key={column.key} className={cellClass(column.key, track)}>
                      {renderCell(track, column.key)}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
