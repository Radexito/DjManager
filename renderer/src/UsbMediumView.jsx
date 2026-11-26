import { useEffect, useState } from 'react';

/**
 * Read-only view of what one medium carries.
 *
 * The main table reads the library database in this application; a stick's
 * contents live in its own `export.pdb` and are not part of that, so they get a
 * view of their own rather than a filter on the library. Nothing here writes to
 * the medium, and the header says so.
 */
export default function UsbMediumView({ selection, onClose }) {
  const [contents, setContents] = useState(undefined);

  useEffect(() => {
    let alive = true;
    setContents(undefined);
    const request = window.api?.getUsbContents;
    if (typeof request !== 'function') {
      setContents(null);
      return () => {
        alive = false;
      };
    }
    request(selection.mount)
      .then((result) => {
        if (alive) setContents(result ?? null);
      })
      .catch(() => {
        if (alive) setContents(null);
      });
    return () => {
      alive = false;
    };
  }, [selection.mount]);

  const playlist =
    contents && selection.playlistId != null
      ? (contents.playlists.find((entry) => entry.id === selection.playlistId) ?? null)
      : null;
  const tracks = playlist ? playlist.tracks : (contents?.tracks ?? []);
  const title = playlist ? playlist.name : 'Library';

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
        <button
          className="btn-secondary"
          style={{ marginLeft: 'auto' }}
          onClick={onClose}
          title="Close the medium"
        >
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
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tracks.map((track, index) => (
            <div
              key={track.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '3rem minmax(8rem, 1fr) minmax(10rem, 2fr) minmax(8rem, 1fr)',
                gap: '0.75rem',
                padding: '0.35rem 1rem',
                borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
                fontSize: '0.9rem',
              }}
            >
              <span style={{ opacity: 0.55 }}>{index + 1}</span>
              <span>{track.artist || '—'}</span>
              <span>{track.title || '—'}</span>
              <span style={{ opacity: 0.75 }}>{track.album || ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
