import { useState, useEffect, useRef, useCallback } from 'react';
import { useDownload } from './DownloadContext.jsx';
import { useTidalDownload } from './TidalDownloadContext.jsx';
import './Sidebar.css';
import ImportPlaylistDialog from './ImportPlaylistDialog';

const MENU_ITEMS = [
  { id: 'music', name: 'Music', icon: '🎵' },
  { id: 'explorer', name: 'Explorer', icon: '📁' },
  { id: 'cloud-search', name: 'Cloud Search', icon: '🔎' },
  { id: 'download', name: 'YT-DLP', icon: '⬇️' },
  { id: 'tidal', name: 'TIDAL', icon: '🌊' },
];

const PRESET_COLORS = [
  '#e63946',
  '#f4a261',
  '#2a9d8f',
  '#457b9d',
  '#9b5de5',
  '#f15bb5',
  '#00bbf9',
  '#adb5bd',
];

function Sidebar({
  selectedMenuItemId,
  onMenuSelect,
  onExportPlaylistRekordboxUsb,
  onExportPlaylistAll,
}) {
  const { sidebarProgress: ytDlpSidebarProgress } = useDownload();
  const { sidebarProgress: tidalSidebarProgress } = useTidalDownload();
  const [playlists, setPlaylists] = useState([]);
  const [importProgress, setImportProgress] = useState({ total: 0, completed: 0 });
  const [normalizeProgress, setNormalizeProgress] = useState(null); // { completed, total } | null
  const [analysisProgress, setAnalysisProgress] = useState(null); // { done, total } | null
  const [waveformGenProgress, setWaveformGenProgress] = useState(null); // { completed, total } | null
  const [moveTracksProgress, setMoveTracksProgress] = useState(null); // { completed, total } | null
  const [removeTracksProgress, setRemoveTracksProgress] = useState(null); // { completed, total } | null
  const [exportProgress, setExportProgress] = useState(null); // { copied, total, pct } | null
  const [ytDlpCheckProgress, setYtDlpCheckProgress] = useState(null); // { checked, total } | null during fetch/check
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [createError, setCreateError] = useState('');
  const [renameError, setRenameError] = useState('');
  const [playlistMenu, setPlaylistMenu] = useState(null); // { id, x, y, flipLeft, flipUp }
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragOverPlaylistId, setDragOverPlaylistId] = useState(null);
  const [importDialogFiles, setImportDialogFiles] = useState(null); // pending files waiting for playlist selection
  const [linkDialogFiles, setLinkDialogFiles] = useState(null); // pending files waiting for playlist selection (link mode)
  const [linking, setLinking] = useState(false);
  const newInputRef = useRef(null);
  const renameInputRef = useRef(null);

  const loadPlaylists = useCallback(async () => {
    const list = await window.api.getPlaylists();
    setPlaylists(list);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    setImportDialogFiles(files);
  };

  const handleImportConfirm = async (choice) => {
    const files = importDialogFiles;
    setImportDialogFiles(null);
    if (!files?.length) return;

    let playlistId = null;

    if (choice.type === 'create') {
      const result = await window.api.createPlaylist(choice.name);
      playlistId = result?.id ?? null;
    } else if (choice.type === 'existing') {
      playlistId = choice.id;
    }

    setImportProgress({ total: files.length, completed: 0 });
    await window.api.importAudioFiles(files, playlistId);
    // Small delay so the user sees 100% before the bar disappears
    setTimeout(() => setImportProgress({ total: 0, completed: 0 }), 800);
  };

  const handleLink = async () => {
    const files = await window.api.selectAudioFiles();
    if (!files.length) return;
    setLinkDialogFiles(files);
  };

  const handleLinkConfirm = async (choice) => {
    const files = linkDialogFiles;
    setLinkDialogFiles(null);
    if (!files?.length) return;

    let playlistId = null;

    if (choice.type === 'create') {
      const result = await window.api.createPlaylist(choice.name);
      playlistId = result?.id ?? null;
    } else if (choice.type === 'existing') {
      playlistId = choice.id;
    }

    setLinking(true);
    await window.api.linkAudioFiles(files, playlistId);
    setLinking(false);
  };

  const handleCreatePlaylist = async (e) => {
    e.preventDefault();
    const name = newPlaylistName.trim();
    if (!name) {
      setCreatingPlaylist(false);
      return;
    }
    const result = await window.api.createPlaylist(name, null);
    if (result?.error === 'duplicate') {
      setCreateError('A playlist with this name already exists.');
      return;
    }
    setNewPlaylistName('');
    setCreateError('');
    setCreatingPlaylist(false);
  };

  const handleRenameSubmit = async (e) => {
    e.preventDefault();
    const name = renameValue.trim();
    if (name) {
      const result = await window.api.renamePlaylist(renamingId, name);
      if (result?.error === 'duplicate') {
        setRenameError('A playlist with this name already exists.');
        return;
      }
    }
    setRenameError('');
    setRenamingId(null);
  };

  useEffect(() => {
    const unsub = window.api.onExportM3UProgress((data) => setExportProgress(data));
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.api.onImportProgress(({ completed, total }) => {
      setImportProgress({ completed, total });
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.api.onNormalizeProgress((data) => {
      if (data.done) {
        setTimeout(() => setNormalizeProgress(null), 1500);
      } else {
        setNormalizeProgress({ completed: data.completed, total: data.total });
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!window.api.onWaveformGenProgress) return;
    const unsub = window.api.onWaveformGenProgress((data) => {
      if (data.done) {
        setTimeout(() => setWaveformGenProgress(null), 1500);
      } else {
        setWaveformGenProgress({ completed: data.completed, total: data.total });
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!window.api.onMoveTracksToLibraryProgress) return;
    const unsub = window.api.onMoveTracksToLibraryProgress((data) => {
      if (data.done) {
        setTimeout(() => setMoveTracksProgress(null), 1500);
      } else {
        setMoveTracksProgress({ completed: data.completed, total: data.total });
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!window.api.onRemoveTracksProgress) return;
    const unsub = window.api.onRemoveTracksProgress((data) => {
      if (data.done) {
        setTimeout(() => setRemoveTracksProgress(null), 1500);
      } else {
        setRemoveTracksProgress({ completed: data.completed, total: data.total });
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.api.onAnalysisProgress((data) => {
      if (data.finished) {
        setTimeout(() => setAnalysisProgress(null), 1500);
      } else {
        setAnalysisProgress({ done: data.done, total: data.total });
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.api.onYtDlpCheckProgress((data) => {
      setYtDlpCheckProgress(data); // null when done
    });
    return unsub;
  }, []);

  const handleExportM3U = async (id) => {
    setPlaylistMenu(null);
    const result = await window.api.exportPlaylistAsM3U(id);
    setExportProgress(null);
    if (result && !result.canceled) {
      alert(
        `Exported ${result.trackCount} track${result.trackCount !== 1 ? 's' : ''} to:\n${result.destDir}`
      );
    }
  };

  const handleExportPlaylistRekordboxUsb = (id) => {
    setPlaylistMenu(null);
    onExportPlaylistRekordboxUsb(id);
  };

  const handleExportPlaylistAll = (id) => {
    setPlaylistMenu(null);
    onExportPlaylistAll(id);
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

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragEnter = (e, playlistId) => {
    if (e.dataTransfer.types.includes('application/dj-tracks')) {
      setDragOverPlaylistId(playlistId);
    }
  };

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverPlaylistId(null);
    }
  };

  const handleDrop = async (e, playlistId) => {
    e.preventDefault();
    setDragOverPlaylistId(null);
    const raw = e.dataTransfer.getData('application/dj-tracks');
    if (!raw) return;
    const trackIds = JSON.parse(raw);
    await window.api.addTracksToPlaylist(playlistId, trackIds);
  };

  return (
    <div className="sidebar">
      <div className="fixed-top-section">
        <div className="menu-section">
          {MENU_ITEMS.map((item) => (
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
          <span className="section-title" style={{ padding: 0 }}>
            PLAYLISTS
          </span>
          <button
            className="new-playlist-btn"
            onClick={() => setCreatingPlaylist(true)}
            title="New playlist"
          >
            ＋
          </button>
        </div>
      </div>

      <div className="scrollable-playlists">
        {creatingPlaylist && (
          <form className="playlist-new-form" onSubmit={handleCreatePlaylist}>
            <input
              ref={newInputRef}
              className={`playlist-rename-input${createError ? ' input-error' : ''}`}
              value={newPlaylistName}
              onChange={(e) => {
                setNewPlaylistName(e.target.value);
                setCreateError('');
              }}
              placeholder="Playlist name"
              onBlur={handleCreatePlaylist}
              onKeyDown={(e) => e.key === 'Escape' && setCreatingPlaylist(false)}
            />
            {createError && <div className="playlist-input-error">{createError}</div>}
          </form>
        )}

        {playlists.length === 0 && !creatingPlaylist && (
          <div className="playlists-empty">No playlists yet</div>
        )}

        {playlists.map((pl) => (
          <div key={pl.id}>
            {renamingId === pl.id ? (
              <form className="playlist-new-form" onSubmit={handleRenameSubmit}>
                <input
                  ref={renameInputRef}
                  className={`playlist-rename-input${renameError ? ' input-error' : ''}`}
                  value={renameValue}
                  onChange={(e) => {
                    setRenameValue(e.target.value);
                    setRenameError('');
                  }}
                  onBlur={handleRenameSubmit}
                  onKeyDown={(e) => e.key === 'Escape' && setRenamingId(null)}
                />
                {renameError && <div className="playlist-input-error">{renameError}</div>}
              </form>
            ) : (
              <div
                className={`menu-item playlist-item ${selectedMenuItemId === String(pl.id) ? 'active' : ''}${dragOverPlaylistId === pl.id ? ' playlist-item--drag-over' : ''}`}
                onClick={() => onMenuSelect(String(pl.id))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Flip the Color submenu to the opposite side/edge when it would
                  // otherwise overflow the viewport (see issue #428).
                  const flipLeft = e.clientX > window.innerWidth / 2;
                  const flipUp = e.clientY > window.innerHeight / 2;
                  setPlaylistMenu({ id: pl.id, x: e.clientX, y: e.clientY, flipLeft, flipUp });
                }}
                onDragOver={handleDragOver}
                onDragEnter={(e) => handleDragEnter(e, pl.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, pl.id)}
              >
                {pl.color && (
                  <span className="playlist-color-dot" style={{ background: pl.color }} />
                )}
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
        {linking && <div className="import-progress">Linking files…</div>}
        {analysisProgress && (
          <div className="normalize-progress-wrap">
            <div className="normalize-progress-label">
              <span>Analyzing</span>
              <span>
                {analysisProgress.done} / {analysisProgress.total}
              </span>
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill"
                style={{
                  width: `${analysisProgress.total > 0 ? Math.round((analysisProgress.done / analysisProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {normalizeProgress && (
          <div className="normalize-progress-wrap">
            <div className="normalize-progress-label">
              <span>Normalizing</span>
              <span>
                {normalizeProgress.completed} / {normalizeProgress.total}
              </span>
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill"
                style={{
                  width: `${Math.round((normalizeProgress.completed / normalizeProgress.total) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
        {waveformGenProgress && (
          <div className="normalize-progress-wrap">
            <div className="normalize-progress-label">
              <span>Waveforms</span>
              <span>
                {waveformGenProgress.completed} / {waveformGenProgress.total}
              </span>
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill"
                style={{
                  width: `${waveformGenProgress.total > 0 ? Math.round((waveformGenProgress.completed / waveformGenProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {moveTracksProgress && (
          <div className="normalize-progress-wrap">
            <div className="normalize-progress-label">
              <span>Moving tracks</span>
              <span>
                {moveTracksProgress.completed} / {moveTracksProgress.total}
              </span>
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill"
                style={{
                  width: `${moveTracksProgress.total > 0 ? Math.round((moveTracksProgress.completed / moveTracksProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {removeTracksProgress && (
          <div className="normalize-progress-wrap">
            <div className="normalize-progress-label">
              <span>Removing tracks</span>
              <span>
                {removeTracksProgress.completed} / {removeTracksProgress.total}
              </span>
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill"
                style={{
                  width: `${removeTracksProgress.total > 0 ? Math.round((removeTracksProgress.completed / removeTracksProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        {ytDlpCheckProgress && !ytDlpSidebarProgress && (
          <button
            className="normalize-progress-wrap ytdlp-progress-clickable"
            onClick={() => onMenuSelect('download')}
            title="Go to YT-DLP"
          >
            <div className="normalize-progress-label">
              <span>Checking tracks…</span>
              {ytDlpCheckProgress.total > 0 && (
                <span>
                  {ytDlpCheckProgress.checked} / {ytDlpCheckProgress.total}
                </span>
              )}
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill ytdlp-progress-fill"
                style={{
                  width: `${ytDlpCheckProgress.total > 0 ? Math.round((ytDlpCheckProgress.checked / ytDlpCheckProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </button>
        )}
        {ytDlpSidebarProgress && (
          <button
            className="normalize-progress-wrap ytdlp-progress-clickable"
            onClick={() => onMenuSelect('download')}
            title="Go to YT-DLP"
          >
            <div className="normalize-progress-label">
              <span>Downloading</span>
              <span>
                {ytDlpSidebarProgress.current} / {ytDlpSidebarProgress.total}
              </span>
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill ytdlp-progress-fill"
                style={{ width: `${Math.round(ytDlpSidebarProgress.pct)}%` }}
              />
            </div>
            {ytDlpSidebarProgress.msg && (
              <div className="normalize-progress-label" style={{ marginTop: 4, opacity: 0.7 }}>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                    fontSize: 11,
                  }}
                >
                  {ytDlpSidebarProgress.msg}
                </span>
              </div>
            )}
          </button>
        )}
        {tidalSidebarProgress && (
          <button
            className="normalize-progress-wrap ytdlp-progress-clickable"
            onClick={() => onMenuSelect('tidal')}
            title="Go to TIDAL"
          >
            <div className="normalize-progress-label">
              <span>TIDAL Downloading</span>
              <span>
                {tidalSidebarProgress.current} / {tidalSidebarProgress.total}
              </span>
            </div>
            <div className="normalize-progress-bar">
              <div
                className="normalize-progress-fill ytdlp-progress-fill"
                style={{ width: `${Math.round(tidalSidebarProgress.pct)}%` }}
              />
            </div>
            {tidalSidebarProgress.msg && (
              <div className="normalize-progress-label" style={{ marginTop: 4, opacity: 0.7 }}>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                    fontSize: 11,
                  }}
                >
                  {tidalSidebarProgress.msg}
                </span>
              </div>
            )}
          </button>
        )}
        {exportProgress && (
          <div className="import-progress">
            Exporting {exportProgress.copied} / {exportProgress.total}… ({exportProgress.pct}%)
          </div>
        )}
        <button
          className="import-button"
          onClick={handleImport}
          title="Copy audio files into the library"
        >
          Import
        </button>
        <button
          className="link-button"
          onClick={handleLink}
          title="Reference files without copying them into the library"
        >
          Link
        </button>
      </div>

      {/* Playlist context menu */}
      {playlistMenu && (
        <div
          className={`context-menu${playlistMenu.flipLeft ? ' context-menu--flip-left' : ''}${playlistMenu.flipUp ? ' context-menu--flip-up' : ''}`}
          style={{ top: playlistMenu.y, left: playlistMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              const pl = playlists.find((p) => p.id === playlistMenu.id);
              setRenameValue(pl?.name ?? '');
              setRenamingId(playlistMenu.id);
              setPlaylistMenu(null);
            }}
          >
            ✏️ Rename
          </div>
          <div className="context-menu-item context-menu-item--has-submenu">
            🎨 Color
            <div className="context-submenu context-submenu--colors">
              {PRESET_COLORS.map((c) => (
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
              >
                ✕
              </div>
            </div>
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => handleExportM3U(playlistMenu.id)}>
            📤 Export as M3U…
          </div>
          <div
            className="context-menu-item"
            onClick={() => handleExportPlaylistRekordboxUsb(playlistMenu.id)}
          >
            💾 Export Rekordbox USB…
          </div>
          <div
            className="context-menu-item"
            onClick={() => handleExportPlaylistAll(playlistMenu.id)}
          >
            📦 Export All to USB…
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

      {importDialogFiles && (
        <ImportPlaylistDialog
          playlists={playlists}
          onConfirm={handleImportConfirm}
          onCancel={() => setImportDialogFiles(null)}
        />
      )}

      {linkDialogFiles && (
        <ImportPlaylistDialog
          playlists={playlists}
          onConfirm={handleLinkConfirm}
          onCancel={() => setLinkDialogFiles(null)}
          title="Link to Playlist"
          confirmLabel="Link"
        />
      )}
    </div>
  );
}

export default Sidebar;
