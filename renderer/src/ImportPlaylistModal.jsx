import { useState, useEffect } from 'react';
import './ImportPlaylistModal.css';

export default function ImportPlaylistModal({ fileCount, onConfirm, onCancel }) {
  const [playlists, setPlaylists] = useState([]);
  const [targetPlaylistId, setTargetPlaylistId] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');

  useEffect(() => {
    window.api.getPlaylists().then((list) => setPlaylists(list || []));
  }, []);

  const handleConfirm = () => {
    if (targetPlaylistId === '') {
      // New playlist — name required
      onConfirm({ mode: 'new', name: newPlaylistName.trim() || null });
    } else if (targetPlaylistId === '__none__') {
      onConfirm({ mode: 'none' });
    } else {
      onConfirm({ mode: 'existing', id: targetPlaylistId });
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="imp-modal">
        <h3 className="imp-modal-title">
          Import {fileCount} file{fileCount !== 1 ? 's' : ''}
        </h3>

        <div className="imp-modal-body">
          <label className="imp-modal-label">Save to playlist</label>

          <select
            className="imp-modal-select"
            value={targetPlaylistId}
            onChange={(e) => setTargetPlaylistId(e.target.value)}
            autoFocus
          >
            <option value="">New playlist…</option>
            <option value="__none__">No playlist</option>
            {playlists.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.name}
              </option>
            ))}
          </select>

          {targetPlaylistId === '' && (
            <input
              className="imp-modal-name-input"
              type="text"
              placeholder="Playlist name (optional)"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
            />
          )}
        </div>

        <div className="imp-modal-footer">
          <button className="imp-modal-btn imp-modal-btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="imp-modal-btn imp-modal-btn--primary" onClick={handleConfirm}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
