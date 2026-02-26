import { useState, useEffect, useRef, useCallback } from 'react';
import './Sidebar.css';

const MUSIC_ITEMS = [
  { id: 'music', name: 'Music', icon: '🎵' },
];

const PRESET_COLORS = ['#e63946','#f4a261','#2a9d8f','#457b9d','#9b5de5','#f15bb5','#00bbf9','#adb5bd'];

function Sidebar({ selectedMenuItemId, onMenuSelect }) {
  const [playlists, setPlaylists] = useState([]);
  const [importProgress, setImportProgress] = useState({ total: 0, completed: 0 });
  const [exportProgress, setExportProgress] = useState(null); // { copied, total, pct } | null
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [playlistMenu, setPlaylistMenu] = useState(null); // { id, x, y }
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const newInputRef = useRef(null);
  const renameInputRef = useRef(null);

  const loadPlaylists = useCallback(async () => {
    const list = await window.api.getPlaylists();
    setPlaylists(list);
  }, []);

  useEffect(() => {
    loadPlaylists();
    const unsub = window.api.onPlaylistsUpdated(loadPlaylists);
    return unsub;
  }, [loadPlaylists]);

  // Focus new playlist input when it appears
  useEffect(() => {
    if (creatingPlaylist) newInputRef.current?.focus();
  }, [creatingPlaylist]);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);

  // Close playlist context menu on outside click
  useEffect(() => {
    if (!playlistMenu) return;
    const close = () => setPlaylistMenu(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [playlistMenu]);

  const handleImport = async () => {
    const files = await window.api.selectAudioFiles();
    if (!files.length) return;
    setImportProgress({ total: files.length, completed: 0 });
    await window.api.importAudioFiles(files);
    setImportProgress({ total: 0, completed: 0 });
  };

  const handleCreatePlaylist = async (e) => {
    e.preventDefault();
    const name = newPlaylistName.trim();
    if (!name) { setCreatingPlaylist(false); return; }
    await window.api.createPlaylist(name, null);
    setNewPlaylistName('');
    setCreatingPlaylist(false);
  };

  const handleRenameSubmit = async (e) => {
    e.preventDefault();
    const name = renameValue.trim();
    if (name) await window.api.renamePlaylist(renamingId, name);
    setRenamingId(null);
  };

  useEffect(() => {
    const unsub = window.api.onExportM3UProgress((data) => setExportProgress(data));
    return unsub;
  }, []);

  const handleExportM3U = async (id) => {
    setPlaylistMenu(null);
    const result = await window.api.exportPlaylistAsM3U(id);
    setExportProgress(null);
    if (result && !result.canceled) {
      alert(`Exported ${result.trackCount} track${result.trackCount !== 1 ? 's' : ''} to:\n${result.destDir}`);
    }
  };

  const handleDeletePlaylist = async (id) => {
    setPlaylistMenu(null);
    if (!window.confirm('Delete this playlist? Tracks will stay in your library.')) return;
    if (selectedMenuItemId === String(id)) onMenuSelect('music');
    await window.api.deletePlaylist(id);
  };

  const handleColorPick = async (id, color) => {
    setPlaylistMenu(null);
    await window.api.updatePlaylistColor(id, color);
  };

  const formatDuration = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  return (
    <div className="sidebar">
      <div className="fixed-top-section">
        <div className="menu-section">
          {MUSIC_ITEMS.map(item => (
            <div
              key={item.id}
              className={`menu-item ${selectedMenuItemId === item.id ? 'active' : ''}`}
              onClick={() => onMenuSelect(item.id)}
            >
              <span className="menu-icon">{item.icon}</span>
              <span className="menu-text">{item.name}</span>
            </div>
          ))}
        </div>
        <div className="menu-separator" />
        <div className="playlists-header">
          <span className="section-title" style={{ padding: 0 }}>PLAYLISTS</span>
          <button className="new-playlist-btn" onClick={() => setCreatingPlaylist(true)} title="New playlist">＋</button>
        </div>
      </div>

      <div className="scrollable-playlists">
        {creatingPlaylist && (
          <form className="playlist-new-form" onSubmit={handleCreatePlaylist}>
            <input
              ref={newInputRef}
              className="playlist-rename-input"
              value={newPlaylistName}
              onChange={e => setNewPlaylistName(e.target.value)}
              placeholder="Playlist name"
              onBlur={handleCreatePlaylist}
              onKeyDown={e => e.key === 'Escape' && setCreatingPlaylist(false)}
            />
          </form>
        )}

        {playlists.length === 0 && !creatingPlaylist && (
          <div className="playlists-empty">No playlists yet</div>
        )}

        {playlists.map(pl => (
          <div key={pl.id}>
            {renamingId === pl.id ? (
              <form className="playlist-new-form" onSubmit={handleRenameSubmit}>
                <input
                  ref={renameInputRef}
                  className="playlist-rename-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={e => e.key === 'Escape' && setRenamingId(null)}
                />
              </form>
            ) : (
              <div
                className={`menu-item playlist-item ${selectedMenuItemId === String(pl.id) ? 'active' : ''}`}
                onClick={() => onMenuSelect(String(pl.id))}
                onContextMenu={e => {
                  e.preventDefault();
                  setPlaylistMenu({ id: pl.id, x: e.clientX, y: e.clientY });
                }}
              >
                {pl.color && <span className="playlist-color-dot" style={{ background: pl.color }} />}
                <span className="menu-text playlist-name">{pl.name}</span>
                <span className="playlist-count">{pl.track_count}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="fixed-bottom-section">
        {importProgress.total > 0 && (
          <div className="import-progress">
            Importing {importProgress.completed} / {importProgress.total}…
          </div>
        )}
        {exportProgress && (
          <div className="import-progress">
            Exporting {exportProgress.copied} / {exportProgress.total}… ({exportProgress.pct}%)
          </div>
        )}
        <button className="import-button" onClick={handleImport}>
          Import Audio Files
        </button>
      </div>

      {/* Playlist context menu */}
      {playlistMenu && (
        <div
          className="context-menu"
          style={{ top: playlistMenu.y, left: playlistMenu.x }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => {
            const pl = playlists.find(p => p.id === playlistMenu.id);
            setRenameValue(pl?.name ?? '');
            setRenamingId(playlistMenu.id);
            setPlaylistMenu(null);
          }}>
            ✏️ Rename
          </div>
          <div className="context-menu-item context-menu-item--has-submenu">
            🎨 Color
            <div className="context-submenu">
              {PRESET_COLORS.map(c => (
                <div
                  key={c}
                  className="color-swatch"
                  style={{ background: c }}
                  onClick={() => handleColorPick(playlistMenu.id, c)}
                />
              ))}
              <div
                className="color-swatch color-swatch--none"
                onClick={() => handleColorPick(playlistMenu.id, null)}
              >✕</div>
            </div>
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => handleExportM3U(playlistMenu.id)}>
            📤 Export as M3U…
          </div>
          <div className="context-menu-separator" />
          <div
            className="context-menu-item context-menu-item--danger"
            onClick={() => handleDeletePlaylist(playlistMenu.id)}
          >
            🗑️ Delete playlist
          </div>
        </div>
      )}
    </div>
  );
}

export default Sidebar;

