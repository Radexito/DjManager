import { useState } from 'react';
import './FolderSyncModal.css';

/**
 * #267 — a folder-tracked playlist lost some files. Moving a track within the
 * collection is far more common than deleting it, so nothing is ticked by
 * default and the buttons say plainly what happens to the playlist.
 */
function FolderSyncModal({ playlistName, missing = [], onKeepAll, onRemove }) {
  const [selected, setSelected] = useState([]);

  const toggle = (id) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="fsm-overlay" onClick={onKeepAll}>
      <div className="fsm-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="fsm-title">Files missing from “{playlistName}”</h3>
        <p className="fsm-desc">
          {missing.length} track{missing.length === 1 ? ' is' : 's are'} in the playlist but their
          files are no longer in the tracked folder. A moved file usually reappears on the next
          refresh, so nothing is removed unless you tick it here. Removing only takes the track out
          of the playlist, it stays in your library.
        </p>

        <div className="fsm-list">
          {missing.map((m) => (
            <label key={m.id} className="fsm-row">
              <input
                type="checkbox"
                checked={selected.includes(m.id)}
                onChange={() => toggle(m.id)}
              />
              <span className="fsm-row-text">
                <span className="fsm-row-title">
                  {[m.artist, m.title].filter(Boolean).join(' - ') || `Track ${m.id}`}
                </span>
                <span className="fsm-row-path" title={m.file_path}>
                  {m.file_path}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="fsm-actions">
          <button className="fsm-btn fsm-btn--secondary" onClick={onKeepAll}>
            Keep all
          </button>
          <button
            className="fsm-btn fsm-btn--primary"
            disabled={selected.length === 0}
            onClick={() => onRemove(selected)}
          >
            Remove {selected.length > 0 ? `${selected.length} ` : ''}from playlist
          </button>
        </div>
      </div>
    </div>
  );
}

export default FolderSyncModal;
