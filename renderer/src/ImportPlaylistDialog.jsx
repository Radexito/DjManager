import { useState, useEffect, useRef } from 'react';
import './ImportPlaylistDialog.css';

export default function ImportPlaylistDialog({ playlists, onConfirm, onCancel }) {
  const [selected, setSelected] = useState('library');
  const [createName, setCreateName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const createInputRef = useRef(null);

  useEffect(() => {
    if (showCreate) createInputRef.current?.focus();
  }, [showCreate]);

  const handleConfirm = () => {
    if (showCreate) {
      const name = createName.trim();
      if (!name) return;
      onConfirm({ type: 'create', name });
    } else {
      onConfirm({ type: selected === 'library' ? 'library' : 'existing', id: selected });
    }
  };

  return (
    <div className="ipd-backdrop" onClick={onCancel}>
      <div className="ipd-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="ipd-title">Import to Playlist</h3>
        <p className="ipd-desc">Choose where to add the imported tracks:</p>

        <div className="ipd-list">
          <label
            className={`ipd-option${selected === 'library' && !showCreate ? ' ipd-option--active' : ''}`}
          >
            <input
              type="radio"
              name="ipd-dest"
              value="library"
              checked={selected === 'library' && !showCreate}
              onChange={() => {
                setSelected('library');
                setShowCreate(false);
              }}
            />
            <span className="ipd-option-label">🎵 Library only (no playlist)</span>
          </label>

          {playlists.map((pl) => (
            <label
              key={pl.id}
              className={`ipd-option${selected === pl.id && !showCreate ? ' ipd-option--active' : ''}`}
            >
              <input
                type="radio"
                name="ipd-dest"
                value={pl.id}
                checked={selected === pl.id && !showCreate}
                onChange={() => {
                  setSelected(pl.id);
                  setShowCreate(false);
                }}
              />
              <span className="ipd-color-dot" style={{ background: pl.color || '#adb5bd' }} />
              <span className="ipd-option-label">{pl.name}</span>
            </label>
          ))}

          <label className={`ipd-option${showCreate ? ' ipd-option--active' : ''}`}>
            <input
              type="radio"
              name="ipd-dest"
              checked={showCreate}
              onChange={() => setShowCreate(true)}
            />
            <span className="ipd-option-label">➕ Create new playlist…</span>
          </label>
        </div>

        {showCreate && (
          <input
            ref={createInputRef}
            className="ipd-create-input"
            placeholder="New playlist name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConfirm();
              if (e.key === 'Escape') onCancel();
            }}
          />
        )}

        <div className="ipd-actions">
          <button className="ipd-btn ipd-btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="ipd-btn ipd-btn--primary"
            onClick={handleConfirm}
            disabled={showCreate && !createName.trim()}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
