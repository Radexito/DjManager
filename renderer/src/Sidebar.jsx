import { useState, useEffect, useRef, useCallback } from 'react';
import { useDownload } from './DownloadContext.jsx';
import { useTidalDownload } from './TidalDownloadContext.jsx';
import './Sidebar.css';
import ImportPlaylistDialog from './ImportPlaylistDialog';
import FolderSyncModal from './FolderSyncModal';

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

/**
 * Left navigation: the fixed views (music, explorer, cloud search, YT-DLP, TIDAL),
 * the playlist list with create/rename/delete and per-playlist export, plus
 * progress bars for running import, analysis, normalization and download jobs.
 *
 * @param {string} selectedMenuItemId Id of the active view or playlist.
 * @param {(id: string) => void} onMenuSelect Switches to a view or playlist.
 * @param {(playlistId: string) => void} onExportPlaylistAll Exports a whole playlist
 *   to a USB drive.
 */
function Sidebar({
  selectedMenuItemId,
  onMenuSelect,
  onExportPlaylistAll,
  usbSelection = null,
  onUsbSelect = () => {},
}) {
  const { sidebarProgress: ytDlpSidebarProgress } = useDownload();
  const { sidebarProgress: tidalSidebarProgress } = useTidalDownload();
  const [playlists, setPlaylists] = useState([]);
  const [usbDevices, setUsbDevices] = useState([]);
  const [usbOpen, setUsbOpen] = useState({});
  const [usbContents, setUsbContents] = useState({});
  const [importProgress, setImportProgress] = useState({ total: 0, completed: 0 });
  const [normalizeProgress, setNormalizeProgress] = useState(null);
  const [analysisProgress, setAnalysisProgress] = useState(null);
  const [waveformGenProgress, setWaveformGenProgress] = useState(null);
  const [moveTracksProgress, setMoveTracksProgress] = useState(null);
  const [removeTracksProgress, setRemoveTracksProgress] = useState(null);
  const [ytDlpCheckProgress, setYtDlpCheckProgress] = useState(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [createError, setCreateError] = useState('');
  const [renameError, setRenameError] = useState('');
  const [playlistMenu, setPlaylistMenu] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragOverPlaylistId, setDragOverPlaylistId] = useState(null);
  const [importDialogFiles, setImportDialogFiles] = useState(null);
  const [linkDialogFiles, setLinkDialogFiles] = useState(null);
  const [linking, setLinking] = useState(false);
  const newInputRef = useRef(null);
  const renameInputRef = useRef(null);

  const [folderMissing, setFolderMissing] = useState(null);
  const [folderNotice, setFolderNotice] = useState('');

  useEffect(() => {
    if (!folderNotice) return undefined;
    const id = setTimeout(() => setFolderNotice(''), 6000);
    return () => clearTimeout(id);
  }, [folderNotice]);

  const loadPlaylists = useCallback(async () => {
    const list = await window.api.getPlaylists();
    setPlaylists(list);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPlaylists();
    const unsub = window.api.onPlaylistsUpdated(loadPlaylists);
    const unsubFolder = window.api.onFolderPlaylistUpdated(loadPlaylists);
    return () => {
      unsub?.();
      unsubFolder?.();
    };
  }, [loadPlaylists]);

  // The sidebar follows the sticks: the list arrives from the main process and is
  // replaced whenever a medium is plugged in or removed.
  useEffect(() => {
    let alive = true;
    // A renderer without the channel (an older preload, or a test double) simply
    // has no USB section; it must not take the sidebar down with it.
    const requestDevices = window.api?.getUsbDevices;
    if (typeof requestDevices === 'function') {
      requestDevices()
        .then((list) => {
          if (alive) setUsbDevices(Array.isArray(list) ? list : []);
        })
        .catch(() => {});
    }
    const unsub = window.api?.onUsbDevicesChanged?.((list) =>
      setUsbDevices(Array.isArray(list) ? list : [])
    );
    return () => {
      alive = false;
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  const loadUsbContents = useCallback(async (mount) => {
    const request = window.api?.getUsbContents;
    if (typeof request !== 'function') return null;
    const contents = await request(mount).catch(() => null);
    setUsbContents((current) => ({ ...current, [mount]: contents }));
    return contents;
  }, []);

  const toggleUsbDevice = async (mount) => {
    const opening = !usbOpen[mount];
    setUsbOpen((current) => ({ ...current, [mount]: opening }));
    if (opening && usbContents[mount] === undefined) await loadUsbContents(mount);
  };

  const refreshUsbDevices = async () => {
    setUsbContents({});
    const refresh = window.api?.refreshUsbDevices;
    if (typeof refresh !== 'function') return;
    const list = await refresh().catch(() => null);
    if (Array.isArray(list)) setUsbDevices(list);
  };

  /** True when this row is what the main area is showing right now. */
  const isSelectedUsb = (mount, playlistId = null) =>
    Boolean(usbSelection) &&
    usbSelection.mount === mount &&
    (usbSelection.playlistId ?? null) === (playlistId ?? null);

  const runFolderRefresh = useCallback(
    async (result) => {
      if (!result) return;
      if (!result.ok) {
        setFolderNotice(
          result.error === 'folder-missing'
            ? `The tracked folder is not reachable: ${result.folder ?? ''}`
            : 'Could not refresh that playlist.'
        );
        return;
      }
      const pl = playlists.find((p) => p.id === result.playlistId);
      if (result.missing?.length) {
        setFolderMissing({
          playlistId: result.playlistId,
          name: pl?.name ?? 'tracked folder',
          missing: result.missing,
        });
      } else {
        setFolderNotice(
          `Refreshed “${pl?.name ?? 'playlist'}”: +${result.added ?? 0} added, ` +
            `${result.linked ?? 0} linked, ${result.found ?? 0} in the folder.`
        );
      }
      loadPlaylists();
    },
    [playlists, loadPlaylists]
  );

  const handleRefreshFolderPlaylist = async (playlistId) => {
    setPlaylistMenu(null);
    setFolderNotice('Refreshing…');
    const res = await window.api.refreshFolderPlaylist(playlistId);
    setFolderNotice('');
    await runFolderRefresh(res);
  };

  const handleToggleFolderRecursive = async (playlistId, recursive) => {
    setPlaylistMenu(null);
    const res = await window.api.setFolderPlaylistRecursive({ playlistId, recursive });
    await runFolderRefresh(res);
  };

  const handleStopFolderPlaylist = async (playlistId) => {
    setPlaylistMenu(null);
    await window.api.stopFolderPlaylist(playlistId);
    setFolderNotice('Folder tracking stopped. The playlist and its tracks stay.');
    loadPlaylists();
  };

  const handlePointPlaylistAtFolder = async (playlistId) => {
    setPlaylistMenu(null);
    const pl = playlists.find((p) => p.id === playlistId);
    const dir = await window.api.openDirDialog();
    if (!dir) return;
    const res = await window.api.setPlaylistFolder({
      playlistId,
      folderPath: dir,
      recursive: pl?.folder_recursive === 1,
    });
    if (!res?.ok) {
      const why =
        res?.error === 'missing-folder'
          ? 'that folder is not reachable right now'
          : (res?.error ?? 'failed');
      setFolderNotice(`Could not track the folder: ${why}`);
      return;
    }
    loadPlaylists();
    if (res.missing?.length) {
      setFolderMissing({ playlistId, name: pl?.name ?? '', missing: res.missing });
    } else {
      setFolderNotice(
        `Now tracking ${dir}: +${res.added ?? 0} added, ${res.linked ?? 0} linked, ` +
          `${res.found ?? 0} file(s) in the folder.`
      );
    }
  };

  const handleRemoveMissing = async (trackIds) => {
    const pending = folderMissing;
    setFolderMissing(null);
    if (!pending) return;
    await window.api.removeFolderPlaylistTracks({ playlistId: pending.playlistId, trackIds });
    setFolderNotice(
      `Removed ${trackIds.length} track${trackIds.length === 1 ? '' : 's'} from “${pending.name}”.`
    );
    loadPlaylists();
  };

  useEffect(() => {
    if (creatingPlaylist) newInputRef.current?.focus();
  }, [creatingPlaylist]);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);

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
      setYtDlpCheckProgress(data);
    });
    return unsub;
  }, []);

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
                {pl.folder_path && (
                  <span
                    className="playlist-folder-icon"
                    title={`Tracked folder: ${pl.folder_path}`}
                  >
                    📁
                  </span>
                )}
                <span className="menu-text playlist-name">{pl.name}</span>
                <span className="playlist-count">{pl.track_count}</span>
              </div>
            )}
          </div>
        ))}

        {usbDevices.length > 0 && (
          <div className="menu-section" style={{ marginTop: '0.75rem' }}>
            <div className="playlists-header">
              <span className="section-title" style={{ padding: 0 }}>
                USB
              </span>
              <button
                className="new-playlist-btn"
                title="Look for media again"
                onClick={refreshUsbDevices}
              >
                ⟳
              </button>
            </div>
            {usbDevices.map((device) => {
              const contents = usbContents[device.mount];
              const open = Boolean(usbOpen[device.mount]);
              return (
                <div key={device.mount}>
                  <div
                    className={`menu-item ${open ? 'active' : ''}`}
                    onClick={() => toggleUsbDevice(device.mount)}
                    title={device.mount}
                  >
                    <span className="menu-icon">{open ? '▾' : '▸'}</span>
                    <span className="menu-text">{device.name}</span>
                    <span className="playlist-count">{contents ? contents.trackCount : ''}</span>
                  </div>
                  {open && (
                    <div style={{ paddingLeft: '0.9rem' }}>
                      {contents === undefined && (
                        <div className="menu-item" style={{ cursor: 'default' }}>
                          <span className="menu-text">Reading the medium…</span>
                        </div>
                      )}
                      {contents === null && (
                        <div className="menu-item" style={{ cursor: 'default' }}>
                          <span className="menu-text">No playlist database on this medium</span>
                        </div>
                      )}
                      {contents && (
                        <>
                          <div
                            className={`menu-item ${isSelectedUsb(device.mount) ? 'active' : ''}`}
                            title="Every track the medium carries"
                            onClick={() =>
                              onUsbSelect({
                                mount: device.mount,
                                playlistId: null,
                                name: 'Library',
                              })
                            }
                          >
                            <span className="menu-text">Library</span>
                            <span className="playlist-count">{contents.trackCount}</span>
                          </div>
                          {contents.playlists.map((playlist) => (
                            <div
                              key={`${device.mount}:${playlist.id}`}
                              className={`menu-item ${
                                isSelectedUsb(device.mount, playlist.id) ? 'active' : ''
                              }`}
                              title={`${playlist.trackCount} track(s) on the medium`}
                              onClick={() =>
                                onUsbSelect({
                                  mount: device.mount,
                                  playlistId: playlist.id,
                                  name: playlist.name,
                                })
                              }
                            >
                              <span className="menu-text">{playlist.name}</span>
                              <span className="playlist-count">{playlist.trackCount}</span>
                            </div>
                          ))}
                          {contents.tags.map((category) => (
                            <div key={`${device.mount}:tagcat:${category.name}`}>
                              <div
                                className="menu-item"
                                style={{ cursor: 'default', opacity: 0.65 }}
                                title={`${category.tags.length} tag(s)`}
                              >
                                <span className="menu-text">{category.name}</span>
                                <span className="playlist-count">{category.tags.length}</span>
                              </div>
                              {category.tags.map((tag) => {
                                const usable = tag.trackCount > 0;
                                const unknown = (tag.unknownTrackCount ?? 0) > 0;
                                const active =
                                  usbSelection?.mount === device.mount &&
                                  usbSelection?.tagId === tag.id;
                                return (
                                  <div
                                    key={`${device.mount}:tag:${tag.id}`}
                                    className={`menu-item ${active ? 'active' : ''}`}
                                    style={{
                                      cursor: usable ? 'pointer' : 'default',
                                      paddingLeft: '1.6rem',
                                      opacity: usable ? 1 : 0.55,
                                    }}
                                    title={
                                      usable
                                        ? `${tag.trackCount} track(s) on the medium carry this tag`
                                        : unknown
                                          ? `${tag.unknownTrackCount} assignment(s) name tracks that are not on this medium`
                                          : 'No track on this medium carries this tag'
                                    }
                                    onClick={
                                      usable
                                        ? () =>
                                            onUsbSelect({
                                              mount: device.mount,
                                              playlistId: null,
                                              tagId: tag.id,
                                              name: tag.name,
                                            })
                                        : undefined
                                    }
                                  >
                                    <span className="menu-text">{tag.name}</span>
                                    {usable && (
                                      <span className="playlist-count">{tag.trackCount}</span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="fixed-bottom-section">
        {folderNotice && (
          <div
            className="folder-sync-notice"
            onClick={() => setFolderNotice('')}
            title="Click to dismiss"
          >
            {folderNotice}
          </div>
        )}
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

      {}
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
          <div
            className="context-menu-item"
            onClick={() => handleExportPlaylistAll(playlistMenu.id)}
          >
            📦 Export All to USB…
          </div>
          <div className="context-menu-separator" />
          {playlists.find((p) => p.id === playlistMenu.id)?.folder_path ? (
            <>
              <div
                className="context-menu-item"
                onClick={() => handleRefreshFolderPlaylist(playlistMenu.id)}
              >
                🔄 Refresh from folder
              </div>
              <div
                className="context-menu-item"
                onClick={() =>
                  handleToggleFolderRecursive(
                    playlistMenu.id,
                    !playlists.find((p) => p.id === playlistMenu.id)?.folder_recursive
                  )
                }
              >
                📁 Sub-folders:{' '}
                {playlists.find((p) => p.id === playlistMenu.id)?.folder_recursive ? 'on' : 'off'}
              </div>
              <div
                className="context-menu-item"
                onClick={() => handlePointPlaylistAtFolder(playlistMenu.id)}
              >
                📁 Change tracked folder…
              </div>
              <div
                className="context-menu-item"
                onClick={() => handleStopFolderPlaylist(playlistMenu.id)}
              >
                ⏹ Stop tracking folder
              </div>
              <div className="context-menu-separator" />
            </>
          ) : (
            <div
              className="context-menu-item"
              onClick={() => handlePointPlaylistAtFolder(playlistMenu.id)}
            >
              📁 Track a folder…
            </div>
          )}
          <div
            className="context-menu-item context-menu-item--danger"
            onClick={() => handleDeletePlaylist(playlistMenu.id)}
          >
            🗑️ Delete playlist
          </div>
        </div>
      )}

      {folderMissing && (
        <FolderSyncModal
          playlistName={folderMissing.name}
          missing={folderMissing.missing}
          onKeepAll={() => setFolderMissing(null)}
          onRemove={handleRemoveMissing}
        />
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
