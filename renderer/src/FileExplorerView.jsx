import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { List } from 'react-window';
import { usePlayer } from './PlayerContext.jsx';
import { artworkUrl } from './artworkUrl.js';
import TrackDetails from './TrackDetails.jsx';
import BeatGridEditor from './BeatGridEditor.jsx';
import './MusicLibrary.css';
import './FileExplorerView.css';

// ── Column definitions (matches MusicLibrary) ────────────────────────────────

const COLUMNS = [
  { key: 'index', label: '#', width: '40px' },
  { key: 'status', label: '', width: '24px' },
  { key: 'title', label: 'Title', width: 'minmax(120px,2fr)' },
  { key: 'artist', label: 'Artist', width: 'minmax(90px,1.5fr)' },
  { key: 'bpm', label: 'BPM', width: '62px' },
  { key: 'key_camelot', label: 'Key', width: '52px' },
  { key: 'loudness', label: 'Loudness', width: '90px' },
  { key: 'duration', label: 'Duration', width: '65px' },
];

const GRID = COLUMNS.map((c) => c.width).join(' ');
const MIN_WIDTH = 680;
const ROW_HEIGHT = 50;

function fmtDuration(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function basename(p) {
  return p.replace(/.*[\\/]/, '');
}

function fileToSyntheticTrack(f) {
  const name = basename(f.path);
  const dot = name.lastIndexOf('.');
  return {
    id: `explorer:${f.path}`,
    file_path: f.path,
    normalized_file_path: null,
    title: dot > 0 ? name.slice(0, dot) : name,
    artist: null,
    album: null,
    bpm: null,
    bpm_override: null,
    key_camelot: null,
    loudness: null,
    duration: null,
    bitrate: null,
    has_artwork: 0,
    artwork_path: null,
    analyzed: 0,
    is_linked: 0,
    replay_gain: null,
    beatgrid_offset: 0,
    cue_count: 0,
    rating: 0,
    genres: '[]',
    user_tags: null,
  };
}

// ── Row component (outside to prevent remounts) ──────────────────────────────

function ExplorerRow({
  index,
  style,
  items,
  tracksMap,
  selectedPaths,
  playingFilePath,
  onRowClick,
  onDoubleClick,
  onContextMenu,
  mediaPort,
}) {
  const item = items[index];
  if (!item) return <div style={style} />;

  const track =
    tracksMap.get(item.path) ?? (item.type === 'file' ? fileToSyntheticTrack(item) : null);
  const isSelected = selectedPaths.has(item.path);
  const isPlaying = item.type === 'file' && item.path === playingFilePath;
  const isLinked = track?.is_linked === 1;
  const isAnalyzing = isLinked && track?.analyzed === 0;

  if (item.type === 'dir') {
    return (
      <div
        style={{ ...style, gridTemplateColumns: GRID, minWidth: MIN_WIDTH }}
        className={`row row-even explorer-dir-row${isSelected ? ' row--selected' : ''}`}
        onClick={(e) => onRowClick(e, item)}
        onDoubleClick={() => onDoubleClick(item)}
        onContextMenu={(e) => onContextMenu(e, item)}
      >
        <div className="cell index">
          <span className="index-num">📁</span>
        </div>
        <div className="cell" />
        <div className="cell title">
          <span className="cell-artwork cell-artwork--placeholder">📁</span>
          <span className="cell-title-text">{item.name}</span>
        </div>
        <div className="cell artist" />
        <div className="cell bpm numeric" />
        <div className="cell key_camelot numeric" />
        <div className="cell loudness numeric" />
        <div className="cell duration numeric" />
      </div>
    );
  }

  const bpmVal = track?.bpm_override ?? track?.bpm;
  const artSrc = artworkUrl(track?.has_artwork ? track.artwork_path : null, mediaPort);

  return (
    <div
      style={{ ...style, gridTemplateColumns: GRID, minWidth: MIN_WIDTH }}
      className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}${isSelected ? ' row--selected' : ''}${isPlaying ? ' row--playing' : ''}${isAnalyzing ? ' row--analyzing' : ''}`}
      onClick={(e) => onRowClick(e, item)}
      onDoubleClick={() => onDoubleClick(item)}
      onContextMenu={(e) => onContextMenu(e, item)}
    >
      <div className="cell index">
        <span className="index-num">{index + 1}</span>
        <button
          className="index-play"
          title="Play"
          onClick={(e) => {
            e.stopPropagation();
            onDoubleClick(item);
          }}
        >
          ▶
        </button>
      </div>
      <div className="cell explorer-status-cell" title={isLinked ? 'In library' : 'Not in library'}>
        {isLinked ? '🔗' : ''}
      </div>
      <div className="cell title">
        {artSrc ? (
          <img className="cell-artwork" src={artSrc} alt="" draggable={false} />
        ) : (
          <span className="cell-artwork cell-artwork--placeholder">♪</span>
        )}
        <span className="cell-title-text">{track?.title ?? item.name}</span>
      </div>
      <div className="cell artist">{track?.artist || '—'}</div>
      <div className="cell bpm numeric">{bpmVal != null ? bpmVal : '—'}</div>
      <div className="cell key_camelot numeric">{track?.key_camelot ?? '—'}</div>
      <div className="cell loudness numeric">{track?.loudness != null ? track.loudness : '—'}</div>
      <div className="cell duration numeric">{fmtDuration(track?.duration)}</div>
    </div>
  );
}

// ── Breadcrumbs ──────────────────────────────────────────────────────────────

function getBreadcrumbs(p) {
  if (!p) return [];
  if (/^[A-Za-z]:/.test(p)) {
    let acc = '';
    return p
      .split('\\')
      .filter(Boolean)
      .map((part) => {
        acc = acc ? `${acc}\\${part}` : `${part}\\`;
        return { label: part, path: acc };
      });
  }
  const parts = p.split('/').filter(Boolean);
  const crumbs = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

// ── Generic confirm dialog ────────────────────────────────────────────────────

function ConfirmDialog({ title, body, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  return (
    <div className="explorer-dialog-backdrop" onMouseDown={onCancel}>
      <div className="explorer-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="explorer-dialog__title">{title}</div>
        <p className="explorer-dialog__body">{body}</p>
        <div className="explorer-dialog__actions">
          <button className="explorer-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="explorer-btn accent" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Link-to-library dialog ────────────────────────────────────────────────────

function LinkFolderDialog({ description, defaultName, playlists, onConfirm, onCancel }) {
  const [mode, setMode] = useState('music');
  const [newName, setNewName] = useState(defaultName);
  const [existingId, setExistingId] = useState(playlists[0]?.id ?? '');

  return (
    <div className="explorer-dialog-backdrop" onMouseDown={onCancel}>
      <div className="explorer-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="explorer-dialog__title">Add to Library</div>
        {description && <p className="explorer-dialog__body">{description}</p>}
        <p className="explorer-dialog__warn">
          Metadata and analysis will run for every new file — on large folders this can take a
          while.
        </p>

        <label className="explorer-dialog__option">
          <input
            type="radio"
            name="lfd-mode"
            checked={mode === 'music'}
            onChange={() => setMode('music')}
          />
          Music only (no playlist)
        </label>

        <label className="explorer-dialog__option">
          <input
            type="radio"
            name="lfd-mode"
            checked={mode === 'new'}
            onChange={() => setMode('new')}
          />
          Create new playlist
        </label>
        {mode === 'new' && (
          <input
            className="explorer-dialog__input"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Playlist name"
            autoFocus
          />
        )}

        {playlists.length > 0 && (
          <label className="explorer-dialog__option">
            <input
              type="radio"
              name="lfd-mode"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
            />
            Add to existing playlist
          </label>
        )}
        {mode === 'existing' && playlists.length > 0 && (
          <select
            className="explorer-dialog__select"
            value={existingId}
            onChange={(e) => setExistingId(e.target.value)}
          >
            {playlists.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.name}
              </option>
            ))}
          </select>
        )}

        <div className="explorer-dialog__actions">
          <button className="explorer-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="explorer-btn accent"
            onClick={() => onConfirm({ mode, newName, existingId: existingId || null })}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FileExplorerView({ style }) {
  const { play, currentTrack, mediaPort, patchCurrentTrack } = usePlayer();

  const [fsRoot, setFsRoot] = useState(null);
  const [homeDir, setHomeDir] = useState(null);
  const [currentPath, setCurrentPath] = useState(null);
  const [dirEntries, setDirEntries] = useState({ dirs: [], files: [] });
  const [loading, setLoading] = useState(false);
  // null = idle; string = path currently being analyzed (persists across navigation)
  const [analyzingPath, setAnalyzingPath] = useState(null);
  const pendingAnalysisIds = useRef(new Set());
  const [tracksMap, setTracksMap] = useState(new Map());
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [playlists, setPlaylists] = useState([]);
  const [contextMenu, setContextMenu] = useState(null);
  const [detailsTrack, setDetailsTrack] = useState(null);
  const [beatGridTrack, setBeatGridTrack] = useState(null);
  const [toast, setToast] = useState(null);
  const [linkDialog, setLinkDialog] = useState(null); // { defaultName, paths|null, description }
  const [confirmDialog, setConfirmDialog] = useState(null); // { title, body, confirmLabel, onConfirm }

  // Broken links — populated by slow background scan
  const [brokenTracks, setBrokenTracks] = useState([]);
  const brokenScanRunning = useRef(false);

  // Recursive scan
  const [recursiveFiles, setRecursiveFiles] = useState(null);
  const [recursiveScanning, setRecursiveScanning] = useState(false);

  const listRef = useRef();
  const containerRef = useRef();
  const [listHeight, setListHeight] = useState(500);
  const lastClickIndex = useRef(null);

  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    window.api.getComputerRoot().then(({ root, home }) => {
      setFsRoot(root);
      setHomeDir(home);
      setCurrentPath(root);
    });
    window.api.getPlaylists().then(setPlaylists);
    const unsub = window.api.onPlaylistsUpdated(() => window.api.getPlaylists().then(setPlaylists));
    return unsub;
  }, []);

  // ── Background broken-link scan ──────────────────────────────────────────

  const runBrokenScan = useCallback(async () => {
    if (brokenScanRunning.current) return;
    brokenScanRunning.current = true;
    try {
      const linked = await window.api.getLinkedTracksBasic();
      if (!linked.length) return;
      const BATCH = 20;
      const broken = [];
      for (let i = 0; i < linked.length; i += BATCH) {
        const batch = linked.slice(i, i + BATCH);
        const results = await window.api.checkLinkedTrackStatus(batch.map((t) => t.id));
        for (const r of results) {
          if (!r.exists) {
            const t = batch.find((b) => b.id === r.id);
            if (t) broken.push(t);
          }
        }
        // Yield between batches — keep CPU low
        await new Promise((res) => setTimeout(res, 150));
      }
      setBrokenTracks(broken);
    } finally {
      brokenScanRunning.current = false;
    }
  }, []);

  useEffect(() => {
    runBrokenScan();
  }, [runBrokenScan]);

  useEffect(() => {
    const unsub = window.api.onLibraryUpdated(() => {
      brokenScanRunning.current = false;
      setBrokenTracks([]);
      runBrokenScan();
    });
    return unsub;
  }, [runBrokenScan]);

  // ── Resize observer ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([e]) => setListHeight(e.contentRect.height));
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Load directory ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!currentPath || !fsRoot) return;
    setLoading(true);
    setSelectedPaths(new Set());
    setRecursiveFiles(null);
    setRecursiveScanning(false);
    window.api.explorerCancelRecursive();
    window.api.browseDirectory(currentPath).then(({ dirs, files }) => {
      setDirEntries({ dirs: dirs ?? [], files: files ?? [] });
      const paths = (files ?? []).map((f) => f.path);
      if (paths.length) {
        window.api.getTracksByPaths(paths).then((tracks) => {
          setTracksMap(new Map(tracks.map((t) => [t.file_path, t])));
        });
      } else {
        setTracksMap(new Map());
      }
      setLoading(false);
    });
  }, [currentPath, fsRoot]);

  // Update rows and player bar as analysis results arrive.
  // Scan tracksMap inside the state setter (always latest state, no ref race).
  useEffect(() => {
    const unsub = window.api.onTrackUpdated(({ trackId, analysis }) => {
      const merged = { ...analysis, analyzed: analysis.analyzed !== 0 ? 1 : 0 };
      setTracksMap((prev) => {
        let filePath = null;
        for (const [fp, t] of prev) {
          if (t.id === trackId) {
            filePath = fp;
            break;
          }
        }
        if (!filePath) return prev;
        const next = new Map(prev);
        next.set(filePath, { ...prev.get(filePath), ...merged });
        return next;
      });
      patchCurrentTrack(trackId, merged);
      // Decrement pending set; clear analyzingPath when all workers finish
      if (pendingAnalysisIds.current.has(trackId)) {
        pendingAnalysisIds.current.delete(trackId);
        if (pendingAnalysisIds.current.size === 0) {
          setAnalyzingPath(null);
        }
      }
    });
    return unsub;
  }, [patchCurrentTrack]);

  // ── Recursive scan events ────────────────────────────────────────────────

  useEffect(() => {
    const u1 = window.api.onExplorerRecursiveBatch((batch) =>
      setRecursiveFiles((p) => [...(p ?? []), ...batch])
    );
    const u2 = window.api.onExplorerRecursiveDone(() => setRecursiveScanning(false));
    return () => {
      u1();
      u2();
    };
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────

  const displayItems = useMemo(() => {
    if (recursiveFiles !== null) return recursiveFiles.map((f) => ({ ...f, type: 'file' }));
    return [
      ...dirEntries.dirs.map((d) => ({ ...d, type: 'dir' })),
      ...dirEntries.files.map((f) => ({ ...f, type: 'file' })),
    ];
  }, [dirEntries, recursiveFiles]);

  const brokenByFilename = useMemo(() => {
    const m = new Map();
    for (const t of brokenTracks) {
      const name = basename(t.file_path);
      if (!m.has(name)) m.set(name, t);
    }
    return m;
  }, [brokenTracks]);

  const playingFilePath = currentTrack?.file_path ?? null;

  // ── Navigation ────────────────────────────────────────────────────────────

  const navigateTo = useCallback((p) => {
    setCurrentPath(p);
    lastClickIndex.current = null;
  }, []);

  // ── Selection ────────────────────────────────────────────────────────────

  const handleRowClick = useCallback(
    (e, item) => {
      const idx = displayItems.findIndex((x) => x.path === item.path);
      if (e.shiftKey && lastClickIndex.current != null) {
        const lo = Math.min(lastClickIndex.current, idx);
        const hi = Math.max(lastClickIndex.current, idx);
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          displayItems.slice(lo, hi + 1).forEach((x) => next.add(x.path));
          return next;
        });
      } else if (e.ctrlKey || e.metaKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          next.has(item.path) ? next.delete(item.path) : next.add(item.path);
          return next;
        });
        lastClickIndex.current = idx;
      } else {
        setSelectedPaths(new Set([item.path]));
        lastClickIndex.current = idx;
      }
    },
    [displayItems]
  );

  // ── Playback ─────────────────────────────────────────────────────────────

  const handleDoubleClick = useCallback(
    (item) => {
      if (item.type === 'dir') {
        navigateTo(item.path);
        return;
      }
      const fileItems = displayItems.filter((x) => x.type === 'file');
      const idx = fileItems.findIndex((x) => x.path === item.path);
      const trackForItem = tracksMap.get(item.path) ?? fileToSyntheticTrack(item);
      const queue = fileItems.map((f) => tracksMap.get(f.path) ?? fileToSyntheticTrack(f));

      // Play immediately — no waiting regardless of link status
      play(trackForItem, queue, idx);

      // If unlinked, auto-link in background so analysis starts and player bar updates
      if (typeof trackForItem.id === 'string') {
        const syntheticId = trackForItem.id;
        window.api.linkAudioFiles([item.path], null).then(async (results) => {
          if (!results[0]?.id || typeof results[0].id !== 'number') return;
          const linked = await window.api.getTracksByPaths([item.path]);
          if (!linked[0]) return;
          setTracksMap((prev) => {
            const next = new Map(prev);
            next.set(item.path, linked[0]);
            return next;
          });
          // Upgrade the synthetic player entry to the real track so analysis
          // results (patchCurrentTrack by numeric id) land correctly
          patchCurrentTrack(syntheticId, linked[0]);
        });
      }
    },
    [displayItems, tracksMap, play, navigateTo, patchCurrentTrack]
  );

  // ── Link helpers ──────────────────────────────────────────────────────────

  const linkFiles = useCallback(
    async (filePaths, playlistId = null) => {
      const results = await window.api.linkAudioFiles(filePaths, playlistId);
      const linked = results.filter((r) => !r.duplicate && r.id).length;
      showToast(`Linked ${linked} track(s)`);
      const tracks = await window.api.getTracksByPaths(filePaths);
      setTracksMap((prev) => {
        const next = new Map(prev);
        tracks.forEach((t) => next.set(t.file_path, t));
        return next;
      });
      return results;
    },
    [showToast]
  );

  // Refresh tracksMap for all files currently visible — called after any link op
  // so onTrackUpdated can find newly linked tracks by their numeric DB id.
  const refreshVisibleTracks = useCallback(async (items) => {
    const filePaths = items.filter((x) => x.type === 'file').map((x) => x.path);
    if (!filePaths.length) return;
    const tracks = await window.api.getTracksByPaths(filePaths);
    setTracksMap((prev) => {
      const next = new Map(prev);
      tracks.forEach((t) => next.set(t.file_path, t));
      return next;
    });
  }, []);

  const linkDir = useCallback(
    async (dirPath, recursive, playlistId = null) => {
      const res = await window.api.linkDirectory(dirPath, recursive, playlistId);
      showToast(`Linked ${res.linked}/${res.total} tracks`);
    },
    [showToast]
  );

  const analyzeFolder = useCallback(
    async (recursive = false) => {
      if (!currentPath || analyzingPath === currentPath) return;
      setAnalyzingPath(currentPath);
      pendingAnalysisIds.current = new Set();
      try {
        await window.api.linkDirectory(currentPath, recursive, null);
        // Refresh map so onTrackUpdated can match track IDs to file paths
        const filePaths = displayItems.filter((x) => x.type === 'file').map((x) => x.path);
        if (!filePaths.length) {
          setAnalyzingPath(null);
          return;
        }
        const tracks = await window.api.getTracksByPaths(filePaths);
        setTracksMap((prev) => {
          const next = new Map(prev);
          tracks.forEach((t) => next.set(t.file_path, t));
          return next;
        });
        const unanalyzed = tracks.filter((t) => t.analyzed === 0);
        if (unanalyzed.length === 0) {
          setAnalyzingPath(null);
        } else {
          pendingAnalysisIds.current = new Set(unanalyzed.map((t) => t.id));
          showToast(`Analyzing ${unanalyzed.length} track(s)…`);
        }
      } catch {
        setAnalyzingPath(null);
        pendingAnalysisIds.current = new Set();
      }
    },
    [currentPath, analyzingPath, displayItems, showToast]
  );

  const cancelAnalyzeFolder = useCallback(() => {
    pendingAnalysisIds.current = new Set();
    setAnalyzingPath(null);
  }, []);

  // ── Context menu ──────────────────────────────────────────────────────────

  const handleContextMenu = useCallback(
    (e, item) => {
      e.preventDefault();
      if (!selectedPaths.has(item.path)) {
        setSelectedPaths(new Set([item.path]));
        lastClickIndex.current = displayItems.findIndex((x) => x.path === item.path);
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setContextMenu({
        x: Math.min(e.clientX, vw - 220),
        y: Math.min(e.clientY, vh - 16),
        item,
        flipLeft: e.clientX > vw / 2,
        flipUp: e.clientY > vh * 0.5,
      });
    },
    [selectedPaths, displayItems]
  );

  const closeMenu = useCallback(() => setContextMenu(null), []);

  // ── Details save ──────────────────────────────────────────────────────────

  const handleDetailsSave = useCallback(async (updatedTrack) => {
    await window.api.updateTrack(updatedTrack.id, updatedTrack);
    setTracksMap((prev) => {
      const next = new Map(prev);
      for (const [k, v] of next) {
        if (v.id === updatedTrack.id) {
          next.set(k, { ...v, ...updatedTrack });
          break;
        }
      }
      return next;
    });
    setDetailsTrack(null);
  }, []);

  // ── Render helpers ────────────────────────────────────────────────────────

  const breadcrumbs = useMemo(() => getBreadcrumbs(currentPath), [currentPath]);

  const selectedFileItems = useMemo(
    () => displayItems.filter((x) => x.type === 'file' && selectedPaths.has(x.path)),
    [displayItems, selectedPaths]
  );

  const rowProps = useMemo(
    () => ({
      items: displayItems,
      tracksMap,
      selectedPaths,
      playingFilePath,
      onRowClick: handleRowClick,
      onDoubleClick: handleDoubleClick,
      onContextMenu: handleContextMenu,
      mediaPort,
    }),
    [
      displayItems,
      tracksMap,
      selectedPaths,
      playingFilePath,
      handleRowClick,
      handleDoubleClick,
      handleContextMenu,
      mediaPort,
    ]
  );

  // Context menu computed values
  const menuItem = contextMenu?.item ?? null;
  const menuTrack = menuItem ? (tracksMap.get(menuItem.path) ?? null) : null;
  const menuIsLinked = menuTrack?.is_linked === 1;
  const menuIsDir = menuItem?.type === 'dir';
  const menuFilename = menuItem ? basename(menuItem.path) : '';
  const menuBrokenMatch =
    menuItem && !menuIsLinked && !menuIsDir ? (brokenByFilename.get(menuFilename) ?? null) : null;
  const menuLinkedBroken = menuIsLinked
    ? (brokenTracks.find((b) => b.id === menuTrack?.id) ?? null)
    : null;

  return (
    <div className="explorer-view" style={style}>
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="explorer-toolbar">
        <button
          className="explorer-btn"
          title="Root /"
          onClick={() => fsRoot && navigateTo(fsRoot)}
        >
          /
        </button>
        <button
          className="explorer-btn"
          title="Home"
          onClick={() => homeDir && navigateTo(homeDir)}
        >
          🏠
        </button>
        <div className="explorer-breadcrumbs">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path}>
              {i > 0 && <span className="explorer-sep">/</span>}
              <button className="explorer-crumb" onClick={() => navigateTo(crumb.path)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <button
          className={`explorer-btn${recursiveFiles !== null ? ' active' : ''}`}
          title={
            recursiveScanning
              ? 'Cancel scan'
              : recursiveFiles !== null
                ? 'Exit recursive view'
                : 'Scan folder recursively'
          }
          onClick={() => {
            if (recursiveScanning) {
              window.api.explorerCancelRecursive();
              setRecursiveScanning(false);
              return;
            }
            if (recursiveFiles !== null) {
              setRecursiveFiles(null);
              return;
            }
            const folderName = basename(currentPath) || currentPath;
            setConfirmDialog({
              title: '🌲 Recursive scan',
              body: `Scan "${folderName}" and all its subdirectories for audio files?\n\nOn large directories or slow drives this can take a long time and list thousands of files.`,
              confirmLabel: 'Scan',
              onConfirm: () => {
                setConfirmDialog(null);
                setRecursiveFiles([]);
                setRecursiveScanning(true);
                window.api.explorerStartRecursive(currentPath);
              },
            });
          }}
        >
          {recursiveScanning ? '⏳' : '🌲'}
        </button>
        <button
          className={`explorer-btn${analyzingPath === currentPath ? ' active' : ''}`}
          title={
            analyzingPath === currentPath
              ? 'Analysis in progress — click to cancel'
              : 'Analyze all audio files in current folder'
          }
          onClick={() => {
            if (analyzingPath === currentPath) {
              cancelAnalyzeFolder();
              return;
            }
            const folderName = basename(currentPath) || currentPath;
            const fileCount = displayItems.filter((x) => x.type === 'file').length;
            setConfirmDialog({
              title: '⚡ Analyze folder',
              body: `Run BPM, key, and loudness analysis on ${fileCount} audio file(s) in "${folderName}"?\n\nAnalysis workers run in the background and may use significant CPU — especially on large folders.`,
              confirmLabel: 'Analyze',
              onConfirm: () => {
                setConfirmDialog(null);
                analyzeFolder(false);
              },
            });
          }}
        >
          {analyzingPath === currentPath ? '⏹ Cancel' : '⚡ Analyze'}
        </button>
        {brokenTracks.length > 0 && (
          <span
            className="explorer-broken-badge"
            title={`${brokenTracks.length} broken link(s) detected`}
          >
            ⚠️ {brokenTracks.length}
          </span>
        )}
        <button
          className="explorer-btn accent"
          title={
            selectedFileItems.length > 0
              ? `Add ${selectedFileItems.length} selected file(s) to library`
              : 'Add folder to library'
          }
          onClick={() => {
            const folderName = currentPath ? basename(currentPath) : 'Folder';
            const paths =
              selectedFileItems.length > 0 ? selectedFileItems.map((f) => f.path) : null;
            const folderFileCount = displayItems.filter((x) => x.type === 'file').length;
            const description = paths
              ? `${paths.length} selected file(s) from "${folderName}"`
              : `${folderFileCount} audio file(s) in "${folderName}"`;
            setLinkDialog({ defaultName: folderName, paths, description });
          }}
        >
          {selectedFileItems.length > 0 ? `+ Library (${selectedFileItems.length})` : '+ Library'}
        </button>
      </div>

      {recursiveFiles !== null && (
        <div className="explorer-recursive-banner">
          Recursive view of <strong>{currentPath}</strong>
          {recursiveScanning ? ' — scanning…' : ` — ${recursiveFiles.length} file(s)`}
        </div>
      )}

      {/* ── Header row ────────────────────────────────────────────────────── */}
      <div className="header" style={{ gridTemplateColumns: GRID, minWidth: MIN_WIDTH }}>
        {COLUMNS.map((col) => (
          <div key={col.key} className="header-cell">
            {col.label}
          </div>
        ))}
      </div>

      {/* ── File list ─────────────────────────────────────────────────────── */}
      <div className="explorer-list-container" ref={containerRef}>
        {loading && <div className="explorer-empty">Loading…</div>}
        {!loading && displayItems.length === 0 && (
          <div className="explorer-empty">No audio files here</div>
        )}
        {!loading && displayItems.length > 0 && (
          <List
            listRef={listRef}
            defaultHeight={listHeight}
            rowCount={displayItems.length}
            rowHeight={ROW_HEIGHT}
            width="100%"
            overscanCount={8}
            rowComponent={ExplorerRow}
            rowProps={rowProps}
          />
        )}
      </div>

      {/* ── Context menu ──────────────────────────────────────────────────── */}
      {contextMenu && (
        <>
          <div className="context-backdrop-invisible" onClick={closeMenu} />
          <div
            className={`context-menu${contextMenu.flipLeft ? ' context-menu--flip-left' : ''}${contextMenu.flipUp ? ' context-menu--flip-up' : ''}`}
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {menuIsDir ? (
              <>
                <div
                  className="context-menu-item"
                  onClick={() => {
                    closeMenu();
                    linkDir(menuItem.path, false);
                  }}
                >
                  📁 Import folder (flat)
                </div>
                <div
                  className="context-menu-item"
                  onClick={() => {
                    closeMenu();
                    linkDir(menuItem.path, true);
                  }}
                >
                  📁 Import folder (recursive)
                </div>
                <div className="context-menu-separator" />
                <div
                  className="context-menu-item"
                  onClick={async () => {
                    closeMenu();
                    const pl = await window.api.createPlaylist(menuItem.name);
                    linkDir(menuItem.path, false, pl.id);
                  }}
                >
                  ➕ Create playlist (flat)
                </div>
                <div
                  className="context-menu-item"
                  onClick={async () => {
                    closeMenu();
                    const pl = await window.api.createPlaylist(menuItem.name);
                    linkDir(menuItem.path, true, pl.id);
                  }}
                >
                  ➕ Create playlist (recursive)
                </div>
                {brokenTracks.some((b) => b.file_path.startsWith(menuItem.path)) && (
                  <>
                    <div className="context-menu-separator" />
                    <div
                      className="context-menu-item"
                      onClick={async () => {
                        closeMenu();
                        const r = await window.api.remapFolder(menuItem.path);
                        showToast(r.ok ? `Remapped ${r.count} track(s)` : 'Remap failed', r.ok);
                      }}
                    >
                      🔗 Remap broken folder…
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* Add to library — unlinked files only */}
                {!menuIsLinked && (
                  <>
                    <div
                      className="context-menu-item"
                      onClick={() => {
                        closeMenu();
                        linkFiles([menuItem.path]);
                      }}
                    >
                      ➕ Add to library
                    </div>
                    <div className="context-menu-separator" />
                  </>
                )}

                {/* Add to playlist submenu */}
                <div className="context-menu-item context-menu-item--has-submenu">
                  ➕ Add to playlist
                  <div className="context-submenu context-submenu--scrollable">
                    <div
                      className="context-menu-item"
                      onClick={async () => {
                        closeMenu();
                        const pl = await window.api.createPlaylist(menuFilename);
                        await linkFiles([menuItem.path], pl.id);
                      }}
                    >
                      ✚ New playlist…
                    </div>
                    {playlists.length > 0 && <div className="context-menu-separator" />}
                    {playlists.map((pl) => (
                      <div
                        key={pl.id}
                        className="context-menu-item"
                        onClick={async () => {
                          closeMenu();
                          let trackId = menuTrack?.id;
                          if (!menuIsLinked || typeof trackId === 'string') {
                            const results = await linkFiles([menuItem.path]);
                            trackId = results[0]?.id ?? null;
                          }
                          if (trackId && typeof trackId === 'number')
                            await window.api.addTracksToPlaylist(pl.id, [trackId]);
                          showToast(`Added to "${pl.name}"`);
                        }}
                      >
                        {pl.color && <span style={{ color: pl.color }}>● </span>}
                        {pl.name}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="context-menu-separator" />

                {/* Play */}
                <div
                  className="context-menu-item"
                  onClick={() => {
                    closeMenu();
                    handleDoubleClick(menuItem);
                  }}
                >
                  ▶ Play
                </div>

                {/* Edit / Analysis — linked tracks only */}
                {menuIsLinked && menuTrack && (
                  <>
                    <div className="context-menu-separator" />
                    <div
                      className="context-menu-item"
                      onClick={() => {
                        closeMenu();
                        setDetailsTrack(menuTrack);
                      }}
                    >
                      ✏️ Edit Details
                    </div>
                    <div className="context-menu-item context-menu-item--has-submenu">
                      🔬 Analysis
                      <div className="context-submenu">
                        <div
                          className="context-menu-item"
                          onClick={() => {
                            closeMenu();
                            window.api.reanalyzeTrack(menuTrack.id);
                            showToast('Re-analysis started');
                          }}
                        >
                          🔄 Re-analyze
                        </div>
                        <div className="context-menu-separator" />
                        <div
                          className="context-menu-item"
                          onClick={() => {
                            closeMenu();
                            window.api.normalizeTracksAudio({ trackIds: [menuTrack.id] });
                            showToast('Normalization started');
                          }}
                        >
                          🔊 Normalize
                        </div>
                        <div className="context-menu-separator" />
                        <div
                          className="context-menu-item"
                          onClick={() => {
                            closeMenu();
                            setBeatGridTrack(menuTrack);
                          }}
                        >
                          🥁 Beat Grid…
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* Remap — only when broken link detected */}
                {(menuBrokenMatch || menuLinkedBroken) && (
                  <>
                    <div className="context-menu-separator" />
                    {menuBrokenMatch && (
                      <div
                        className="context-menu-item"
                        title={`Remap broken track: ${menuBrokenMatch.title}`}
                        onClick={async () => {
                          closeMenu();
                          const r = await window.api.remapTrack(menuBrokenMatch.id, menuItem.path);
                          if (r.ok) {
                            setBrokenTracks((p) => p.filter((b) => b.id !== menuBrokenMatch.id));
                            showToast(`Remapped: ${menuBrokenMatch.title}`);
                          } else showToast('Remap failed', false);
                        }}
                      >
                        🔗 Remap &ldquo;{menuBrokenMatch.title}&rdquo; to this file
                      </div>
                    )}
                    {menuLinkedBroken && (
                      <div
                        className="context-menu-item context-menu-item--disabled"
                        title="This track's file is missing from disk"
                      >
                        ⚠️ Broken link — file missing
                      </div>
                    )}
                  </>
                )}

                {/* Remove */}
                {menuIsLinked && (
                  <>
                    <div className="context-menu-separator" />
                    <div
                      className="context-menu-item context-menu-item--danger"
                      onClick={async () => {
                        closeMenu();
                        await window.api.removeTrack(menuTrack.id);
                        setTracksMap((prev) => {
                          const next = new Map(prev);
                          next.delete(menuItem.path);
                          return next;
                        });
                        showToast('Removed from library');
                      }}
                    >
                      🗑️ Remove from library
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* ── Confirm dialog (recursive scan / analyze) ─────────────────────── */}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          body={confirmDialog.body}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {/* ── Link-to-library dialog ────────────────────────────────────────── */}
      {linkDialog && (
        <LinkFolderDialog
          description={linkDialog.description}
          defaultName={linkDialog.defaultName}
          playlists={playlists}
          onCancel={() => setLinkDialog(null)}
          onConfirm={async ({ mode, newName, existingId }) => {
            const { paths } = linkDialog;
            setLinkDialog(null);
            let playlistId = null;
            if (mode === 'new') {
              const pl = await window.api.createPlaylist(newName || linkDialog.defaultName);
              playlistId = pl.id;
            } else if (mode === 'existing') {
              playlistId = existingId;
            }
            if (paths) {
              await linkFiles(paths, playlistId);
            } else {
              const res = await window.api.linkDirectory(currentPath, false, playlistId);
              showToast(`Linked ${res.linked}/${res.total} tracks`);
              await refreshVisibleTracks(displayItems);
            }
          }}
        />
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {detailsTrack && (
        <TrackDetails
          track={detailsTrack}
          onSave={handleDetailsSave}
          onCancel={() => setDetailsTrack(null)}
        />
      )}
      {beatGridTrack && (
        <BeatGridEditor
          track={beatGridTrack}
          onClose={() => setBeatGridTrack(null)}
          onApply={async (data) => {
            await window.api.adjustBpm({ trackId: beatGridTrack.id, ...data });
            setBeatGridTrack(null);
          }}
        />
      )}

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`music-library-toast${toast.ok ? '' : ' music-library-toast--warn'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
