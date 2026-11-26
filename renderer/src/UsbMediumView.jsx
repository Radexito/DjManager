import { useEffect, useMemo, useRef, useState } from 'react';

import { COL_BY_KEY, cellClass, renderCell } from './trackTable.jsx';
import SearchBar from './SearchBar.jsx';
import { usePlayer } from './PlayerContext.jsx';

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

/** Every term has to appear somewhere in the row, the way a plain search reads. */
function matches(track, terms) {
  if (terms.length === 0) return true;
  const haystack = `${track.title ?? ''} ${track.artist ?? ''} ${track.album ?? ''}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Read-only view of what one medium carries, drawn with the same table the
 * library and playlist tabs use: same columns, same cell rendering, same row
 * styles. The tracks belong to the medium, so the rows are not edited here; they
 * can be played, because a medium is a mounted directory of ordinary files.
 */
export default function UsbMediumView({ selection, onClose }) {
  const [result, setResult] = useState({ mount: null, contents: undefined });
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState(null);
  const { play } = usePlayer() ?? {};

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

  // A new selection starts from a clean search, otherwise a previous filter
  // would silently hide the rows of the medium just opened.
  useEffect(() => {
    setSearch('');
  }, [selection.mount, selection.playlistId, selection.tagId]);

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
  const tag =
    contents && selection.tagId != null
      ? (contents.tags
          .flatMap((category) => category.tags)
          .find((entry) => entry.id === selection.tagId) ?? null)
      : null;

  const allRows = playlist ? playlist.tracks : tag ? tag.tracks : (contents?.tracks ?? []);
  const title = playlist ? playlist.name : tag ? tag.name : 'Library';

  const terms = useMemo(() => search.toLowerCase().split(/\s+/).filter(Boolean), [search]);
  const rows = useMemo(() => allRows.filter((track) => matches(track, terms)), [allRows, terms]);

  const gridTemplate = useMemo(() => MEDIUM_COLUMNS.map((c) => c.width).join(' '), []);
  const minWidth = useMemo(() => minWidthOf(MEDIUM_COLUMNS), []);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const playRow = (track, index) => {
    if (typeof play !== 'function' || !track?.file_path) return;
    play(track, rows, index, null, null);
  };

  const openMenu = (event, track, index) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, track, index });
  };

  return (
    <div className="usb-medium-view" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid var(--border, #333)',
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ fontSize: '1.05rem' }}>{title}</strong>
        <span style={{ opacity: 0.7 }}>{selection.mount}</span>
        <span style={{ opacity: 0.7 }}>
          {rows.length === allRows.length
            ? `${allRows.length} track(s)`
            : `${rows.length} of ${allRows.length} track(s)`}
        </span>
        <span style={{ opacity: 0.55, fontSize: '0.85rem' }}>from the medium</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <SearchBar value={search} onChange={setSearch} />
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {contents === undefined && (
        <div style={{ padding: '1rem', opacity: 0.8 }}>Reading the medium…</div>
      )}
      {contents === null && (
        <div style={{ padding: '1rem', opacity: 0.8 }}>
          This medium carries no playlist database that can be read.
        </div>
      )}
      {contents && allRows.length === 0 && (
        <div style={{ padding: '1rem', opacity: 0.8 }}>
          {tag ? 'No track on this medium carries that tag.' : 'Nothing to show here.'}
        </div>
      )}
      {contents && allRows.length > 0 && rows.length === 0 && (
        <div style={{ padding: '1rem', opacity: 0.8 }}>Nothing matches that search.</div>
      )}

      {contents && rows.length > 0 && (
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
            {rows.map((track, index) => (
              <div
                key={track.id}
                className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}`}
                style={{ gridTemplateColumns: gridTemplate, minWidth: minWidth }}
                title={`${track.title}\ndouble click to play`}
                onDoubleClick={() => playRow(track, index)}
                onContextMenu={(event) => openMenu(event, track, index)}
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
                        <span>
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

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000 }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => playRow(menu.track, menu.index)}>
            Play
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(menu.track.file_path ?? '');
              setMenu(null);
            }}
          >
            Copy file path
          </div>
        </div>
      )}
    </div>
  );
}
