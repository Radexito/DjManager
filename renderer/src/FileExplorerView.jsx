import {
  Fragment,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { List } from 'react-window';
import { usePlayer } from './PlayerContext.jsx';
import { artworkUrl } from './artworkUrl.js';
import TrackDetails from './TrackDetails.jsx';
import BeatGridEditor from './BeatGridEditor.jsx';
import { buildExplorerContextMenu } from './explorerContextMenu.js';
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
  { key: 'cues', label: 'Cues', width: '78px' },
  { key: 'loudness', label: 'Loudness', width: '90px' },
  { key: 'duration', label: 'Duration', width: '65px' },
];

const GRID = COLUMNS.map((c) => c.width).join(' ');
const MIN_WIDTH = 758;
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

/** m:ss.d, the way a cue position reads on a CDJ. */
function fmtCueTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** One line per cue for the tooltip: 'A 0:12.4 (loop 0:04.0) — Intro'. */
function cuesTitleOf(cues, cueCount) {
  if (cues?.length) {
    return cues
      .map((c) => {
        const name = c.letter ? `${c.letter}` : 'Memory';
        const loop = c.type === 'loop' ? ` (loop ${fmtCueTime(c.loopMs)})` : '';
        const label = c.label ? ` — ${c.label}` : '';
        return `${name} ${fmtCueTime(c.positionMs)}${loop}${label}`;
      })
      .join('\n');
  }
  if (cueCount > 0) return `${cueCount} cue point(s)`;
  return 'No cue points';
}

/** Export cues as chips, or the library's own cue count when there is one. */
function CueCell({ cues, cueCount }) {
  if (cues?.length) {
    const shown = cues.slice(0, 4);
    return (
      <>
        {shown.map((cue, i) => (
          <span
            key={`${cue.hotCue}-${cue.positionMs}-${i}`}
            className={`cue-chip${cue.memory ? ' cue-chip--memory' : ''}`}
            style={cue.color ? { borderColor: cue.color, color: cue.color } : undefined}
          >
            {cue.letter ?? 'M'}
          </span>
        ))}
        {cues.length > shown.length && (
          <span className="cue-chip cue-chip--more">{`+${cues.length - shown.length}`}</span>
        )}
      </>
    );
  }
  if (cueCount > 0) return <span className="cue-dot cue-dot--has">◆</span>;
  return <span className="cue-dot cue-dot--empty">◇</span>;
}

function exportCountLabel(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * One-line summary for a detected DJ export (#504), e.g.
 * "Rekordbox export - 3 playlists / 42 tracks". Formats with no reader yet
 * show "not parsed yet" instead of an invented count.
 */
function exportSummaryLine(exp) {
  const parts = [];
  if (exp.playlists != null) parts.push(exportCountLabel(exp.playlists, 'playlist'));
  if (exp.trackCount != null) parts.push(exportCountLabel(exp.trackCount, 'track'));
  return `${exp.label} export - ${parts.length ? parts.join(' / ') : 'not parsed yet'}`;
}

const ALL_TRACKS_ID = 'all-tracks';

/** An export track as one of the file items the listing already renders. */
function exportTrackToItem(t, cues) {
  const filePath = t.absolute_path || t.file_path;
  const item = { type: 'file', path: filePath, name: t.title || basename(t.file_path) };
  item.track = {
    ...fileToSyntheticTrack(item),
    id: `export:${t.id ?? filePath}`,
    title: item.name,
    artist: t.artist || null,
    album: t.album || null,
    bpm: t.bpm ?? null,
    key_camelot: t.key_camelot ?? null,
    duration: t.duration ?? null,
    // From the export's ANLZ files, so the stick reads as it does on the deck.
    cues: cues ?? null,
    cue_count: cues?.length ?? 0,
  };
  return item;
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
  onOpenAsLibrary,
  exportFolders,
  mediaPort,
}) {
  const item = items[index];
  if (!item) return <div style={style} />;

  const track =
    tracksMap.get(item.path) ??
    // An export track carries its own metadata (the manifest), so it renders like
    // any other file row until it is linked into the library (#504).
    (item.type === 'file' ? (item.track ?? fileToSyntheticTrack(item)) : null);
  const isSelected = selectedPaths.has(item.path);
  const isPlaying = item.type === 'file' && item.path === playingFilePath;
  const isLinked = track?.is_linked === 1;
  const isAnalyzing = isLinked && track?.analyzed === 0;

  if (item.type === 'dir') {
    // A folder that is itself an export gets its own icon and a shortcut, so it
    // is recognisable one level above instead of being found by accident.
    const exportInfo = exportFolders?.[item.path] ?? null;
    return (
      <div
        style={{ ...style, gridTemplateColumns: GRID, minWidth: MIN_WIDTH }}
        className={`row row-even explorer-dir-row${isSelected ? ' row--selected' : ''}${
          exportInfo ? ' explorer-dir-row--export' : ''
        }`}
        onClick={(e) => onRowClick(e, item)}
        onDoubleClick={() => onDoubleClick(item)}
        onContextMenu={(e) => onContextMenu(e, item)}
      >
        <div className="cell index">
          <span className="index-num">{exportInfo ? '📚' : '📁'}</span>
        </div>
        <div className="cell" />
        <div className="cell title">
          <span className="cell-artwork cell-artwork--placeholder">{exportInfo ? '📚' : '📁'}</span>
          <span className="cell-title-text">{item.name}</span>
          {exportInfo && (
            <button
              className="cell-export-chip"
              title={`${exportInfo.label} export - open as a library instead of folders`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenAsLibrary?.(item.path);
              }}
            >
              Library
            </button>
          )}
        </div>
        <div className="cell artist" />
        <div className="cell bpm numeric" />
        <div className="cell key_camelot numeric" />
        <div className="cell cues" />
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
      <div className="cell cues" title={cuesTitleOf(item.track?.cues, track?.cue_count)}>
        <CueCell cues={item.track?.cues} cueCount={track?.cue_count} />
      </div>
      <div className="cell loudness numeric">{track?.loudness != null ? track.loudness : '—'}</div>
      <div className="cell duration numeric">{fmtDuration(track?.duration)}</div>
    </div>
  );
}

// ── Listing ──────────────────────────────────────────────────────────────────
// The header row and the virtualized rows, shared by a folder and by an export,
// so both behave the same way: same columns, same selection, same context menu.

function FileListPane({ containerRef, listRef, listHeight, loading, items, rowProps, emptyLabel }) {
  return (
    <>
      <div className="header" style={{ gridTemplateColumns: GRID, minWidth: MIN_WIDTH }}>
        {COLUMNS.map((col) => (
          <div key={col.key} className="header-cell">
            {col.label}
          </div>
        ))}
      </div>

      <div className="explorer-list-container" ref={containerRef}>
        {loading && <div className="explorer-empty">Loading…</div>}
        {!loading && items.length === 0 && <div className="explorer-empty">{emptyLabel}</div>}
        {!loading && items.length > 0 && (
          <List
            listRef={listRef}
            defaultHeight={listHeight}
            rowCount={items.length}
            rowHeight={ROW_HEIGHT}
            width="100%"
            overscanCount={8}
            rowComponent={ExplorerRow}
            rowProps={rowProps}
          />
        )}
      </div>
    </>
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
  const [drives, setDrives] = useState([]); // Windows drive roots (C:\, D:\ ...)
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
  // Nudge applied after measuring the rendered menu so it never overflows the
  // viewport bottom/right edge (#310).
  const menuRef = useRef(null);
  const [menuShift, setMenuShift] = useState({ x: 0, y: 0 });
  const [detailsTrack, setDetailsTrack] = useState(null);
  const [beatGridTrack, setBeatGridTrack] = useState(null);
  const [toast, setToast] = useState(null);
  const [linkDialog, setLinkDialog] = useState(null); // { defaultName, paths|null, description }
  const [confirmDialog, setConfirmDialog] = useState(null); // { title, body, confirmLabel, onConfirm }
  const [favourites, setFavourites] = useState([]); // [{ path, name }]

  // Broken links — populated by slow background scan
  const [brokenTracks, setBrokenTracks] = useState([]);
  const brokenScanRunning = useRef(false);

  // Recursive scan
  const [recursiveFiles, setRecursiveFiles] = useState(null);
  const [recursiveScanning, setRecursiveScanning] = useState(false);

  // Mounted volumes, both platforms (#504): Windows hands back one volume per
  // drive letter, Linux one per mount point, so the pane renders a single list
  // and the watcher further down can tell when it changed.
  const [volumes, setVolumes] = useState([]);

  // Detected DJ-software exports per drive (#504) - read-only inspection,
  // cached by drive root so navigating inside a drive does not rescan.
  const [driveExports, setDriveExports] = useState({});
  const [driveExportsScanning, setDriveExportsScanning] = useState({});
  const [expandedExport, setExpandedExport] = useState(null); // `${driveRoot}|${software}`

  // Export found at (or above) the folder that is open. When there is one the
  // pane shows a library view of it (its playlists and tracks) instead of the
  // folders it happens to be made of, with a toggle back to the file listing.
  const [exportContext, setExportContext] = useState(null); // { path, root, exports }
  // The file listing stays the default: a folder that holds an export usually
  // has other things in it too, and the library view is a view of the export,
  // not a replacement for the folder (#504).
  const [exportViewMode, setExportViewMode] = useState('files'); // 'files' | 'library'
  const [exportFolders, setExportFolders] = useState({}); // dir path -> { software, label }
  const [exportCues, setExportCues] = useState({}); // track path -> cue points from ANLZ
  const [folderChoice, setFolderChoice] = useState(null); // { name, path, label }
  // What the user asked for when they entered a folder: 'library' only when they
  // chose it, so the view never sticks to the next folder that happens to be one.
  const libraryIntentRef = useRef(null);
  const [openExportPlaylist, setOpenExportPlaylist] = useState(ALL_TRACKS_ID);

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
    window.api.getComputerRoot().then(({ root, home, drives, volumes }) => {
      setFsRoot(root);
      setHomeDir(home);
      setDrives(drives ?? []);
      setVolumes(volumes ?? []);
      setCurrentPath(home ?? root);
    });
    window.api.getPlaylists().then(setPlaylists);
    window.api.getSetting('explorer_favourites', []).then((favs) => {
      let parsed = favs;
      if (typeof favs === 'string') {
        try {
          parsed = favs ? JSON.parse(favs) : [];
        } catch {
          parsed = []; // corrupt/legacy stored value — reset rather than crash
        }
      }
      setFavourites(Array.isArray(parsed) ? parsed : []);
    });
    const unsub = window.api.onPlaylistsUpdated(() => window.api.getPlaylists().then(setPlaylists));
    return unsub;
  }, []);

  // Single write path for favourites so a multi-selection update persists once
  // (one setSetting) instead of once per folder.
  const updateFavourites = useCallback((paths, add) => {
    setFavourites((prev) => {
      const current = new Set(prev.map((f) => f.path));
      const next = add
        ? [
            ...prev,
            ...paths
              .filter((p) => !current.has(p))
              .map((p) => ({ path: p, name: basename(p) || p })),
          ]
        : prev.filter((f) => !paths.includes(f.path));
      if (next.length === prev.length) return prev;
      window.api.setSetting('explorer_favourites', JSON.stringify(next));
      return next;
    });
  }, []);

  const removeFavourite = useCallback(
    (path) => updateFavourites([path], false),
    [updateFavourites]
  );

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

  // ── DJ export detection per drive (read-only, #504) ───────────────────────

  const detectDriveExports = useCallback(async (driveRoot) => {
    setDriveExportsScanning((prev) => ({ ...prev, [driveRoot]: true }));
    try {
      const res = await window.api.detectDriveExports(driveRoot);
      setDriveExports((prev) => ({ ...prev, [driveRoot]: res?.exports ?? [] }));
    } catch {
      setDriveExports((prev) => ({ ...prev, [driveRoot]: [] }));
    } finally {
      setDriveExportsScanning((prev) => ({ ...prev, [driveRoot]: false }));
    }
  }, []);

  // What the drive pane lists. Windows sends drive roots, Linux sends mount
  // points; on Linux only the mounts a user can act on survive the filter (the
  // system root, plus removable media), which keeps swap, the package cache and
  // the other system subvolumes out of the pane.
  const mountRows = useMemo(() => {
    if (volumes.length === 0) {
      return drives.map((root) => ({ id: root, root, label: root, removable: false }));
    }
    const linux = volumes.some((v) => String(v.id ?? '').startsWith('linux:'));
    return volumes
      .filter((v) => !linux || v.system || v.removable)
      .map((v) => ({
        id: v.id ?? v.root,
        root: v.root,
        label: v.label || v.root,
        removable: !!v.removable,
      }));
  }, [volumes, drives]);

  // The mount the current path lives on. The longest matching root wins, so a
  // stick mounted under /run/media beats the filesystem root.
  const activeDrive = useMemo(() => {
    let best = null;
    for (const mount of mountRows) {
      if (currentPath !== mount.root && !(currentPath?.startsWith(mount.root) ?? false)) continue;
      if (!best || mount.root.length > best.length) best = mount.root;
    }
    return best;
  }, [mountRows, currentPath]);

  // Scan the selected mount once; the refresh button on the row rescans.
  useEffect(() => {
    if (!activeDrive || driveExports[activeDrive] !== undefined) return;
    detectDriveExports(activeDrive);
  }, [activeDrive, driveExports, detectDriveExports]);

  // A volume that appeared, disappeared or came back somewhere else while the
  // app was running (#504). Without this the pane kept whatever it saw on mount:
  // a stick plugged in mid-session never showed up, an unplugged one stayed
  // clickable and its export list stayed stale.
  useEffect(() => {
    const unsubscribe = window.api.onDrivesUpdated?.((payload) => {
      setDrives(payload?.drives ?? []);
      setVolumes(payload?.volumes ?? []);
    });
    return () => unsubscribe?.();
  }, []);

  // Is the open folder an export (or inside one)? Detection walks up from the
  // folder, so opening the export itself and opening a folder inside it both
  // land on the same view.
  useEffect(() => {
    let cancelled = false;
    // Entering a folder always starts on its listing; the library view is only
    // shown when that is what was chosen for this folder.
    setExportViewMode(libraryIntentRef.current === currentPath ? 'library' : 'files');
    if (!currentPath) {
      setExportContext(null);
      return () => {};
    }
    Promise.resolve(window.api.findExportAt?.(currentPath))
      .then((res) => {
        if (cancelled) return;
        setExportContext(
          res?.exports?.length ? { path: currentPath, root: res.root, exports: res.exports } : null
        );
      })
      .catch(() => {
        if (!cancelled) setExportContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  // Mark the folders in this listing that are exports themselves.
  useEffect(() => {
    const dirs = dirEntries.dirs.map((dir) => dir.path);
    if (dirs.length === 0) {
      setExportFolders({});
      return () => {};
    }
    let cancelled = false;
    Promise.resolve(window.api.exportRoots?.(dirs))
      .then((res) => {
        if (!cancelled) setExportFolders(res?.roots ?? {});
      })
      .catch(() => {
        if (!cancelled) setExportFolders({});
      });
    return () => {
      cancelled = true;
    };
  }, [dirEntries.dirs]);

  const activeExport = exportContext?.exports?.[0] ?? null;
  const exportPlaylists = useMemo(() => activeExport?.entries ?? [], [activeExport]);

  // Rekordbox shows the whole collection next to the playlists, so an export is
  // browsed the same way here: All tracks first, then one entry per playlist.
  const allExportTracks = useMemo(() => {
    if (activeExport?.tracks?.length) return activeExport.tracks;
    const seen = new Map();
    for (const pl of exportPlaylists) {
      for (const t of pl.tracks ?? []) if (!seen.has(t.id)) seen.set(t.id, t);
    }
    return [...seen.values()];
  }, [activeExport, exportPlaylists]);

  const sidebarEntries = useMemo(
    () => [
      {
        id: ALL_TRACKS_ID,
        name: 'All tracks',
        tracks: allExportTracks,
        trackCount: allExportTracks.length,
      },
      ...exportPlaylists,
    ],
    [allExportTracks, exportPlaylists]
  );

  const shownExportPlaylist =
    sidebarEntries.find((pl) => pl.id === openExportPlaylist) ?? sidebarEntries[0] ?? null;
  const exportTrackPaths = (shownExportPlaylist?.tracks ?? [])
    .map((t) => t.absolute_path || t.file_path)
    .filter(Boolean);

  // The library view is the one the user asked for; the listing is the default.
  const showExportLibrary =
    !!activeExport && exportViewMode === 'library' && recursiveFiles === null;

  const exportItems = useMemo(
    () =>
      (shownExportPlaylist?.tracks ?? []).map((t) =>
        exportTrackToItem(t, exportCues[t.absolute_path])
      ),
    [shownExportPlaylist, exportCues]
  );

  // Cues live in the export's ANLZ files, one read per track, once per session.
  useEffect(() => {
    if (!exportContext?.root || !activeExport) return () => {};
    const wanted = (shownExportPlaylist?.tracks ?? []).filter(
      (t) => t.analyze_path && exportCues[t.absolute_path] === undefined
    );
    if (wanted.length === 0) return () => {};
    let cancelled = false;
    Promise.resolve(
      window.api.exportCues?.({
        root: exportContext.root,
        tracks: wanted.map((t) => ({ path: t.absolute_path, analyzePath: t.analyze_path })),
      })
    )
      .then((res) => {
        if (!cancelled && res?.cues) setExportCues((prev) => ({ ...prev, ...res.cues }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [exportContext, activeExport, shownExportPlaylist, exportCues]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const displayItems = useMemo(() => {
    // An export is browsed through this very listing, so its tracks play, select
    // and answer the context menu exactly like files in a folder (#504).
    if (showExportLibrary) return exportItems;
    if (recursiveFiles !== null) return recursiveFiles.map((f) => ({ ...f, type: 'file' }));
    return [
      ...dirEntries.dirs.map((d) => ({ ...d, type: 'dir' })),
      ...dirEntries.files.map((f) => ({ ...f, type: 'file' })),
    ];
  }, [dirEntries, recursiveFiles, showExportLibrary, exportItems]);

  // Are the export's files already in the library? Same lookup the folder listing
  // does, so a track shows its linked state and the menu offers the right action.
  useEffect(() => {
    const paths = exportItems.map((item) => item.path).filter(Boolean);
    if (paths.length === 0) return () => {};
    let cancelled = false;
    Promise.resolve(window.api.getTracksByPaths(paths))
      .then((tracks) => {
        if (cancelled || !tracks?.length) return;
        setTracksMap((prev) => {
          const next = new Map(prev);
          tracks.forEach((t) => next.set(t.file_path, t));
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [exportItems]);

  // ── Keyboard: Ctrl+A selects all visible rows (mirrors MusicLibrary) ─────
  // MusicLibrary is unmounted while this tab is active, but other views stay
  // mounted (hidden via display:none) — gate on visibility so Ctrl+A is only
  // stolen when the Explorer is actually the active view.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'a') return;
      const target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
      if (!containerRef.current?.offsetParent) return; // view hidden
      e.preventDefault();
      setSelectedPaths(new Set(displayItems.map((x) => x.path)));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [displayItems, setSelectedPaths]);

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
        // A folder that is an export can be seen two ways, so ask rather than
        // guess: the same folder is a library and a folder full of files.
        const exportInfo = exportFolders?.[item.path];
        if (exportInfo) {
          setFolderChoice({ name: item.name, path: item.path, label: exportInfo.label });
          return;
        }
        navigateTo(item.path);
        return;
      }
      const fileItems = displayItems.filter((x) => x.type === 'file');
      const idx = fileItems.findIndex((x) => x.path === item.path);
      // An export track carries its own metadata, so playing from a library view
      // hands the player the same fields as playing a linked file (#504).
      const trackForItem = tracksMap.get(item.path) ?? item.track ?? fileToSyntheticTrack(item);
      const queue = fileItems.map(
        (f) => tracksMap.get(f.path) ?? f.track ?? fileToSyntheticTrack(f)
      );

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
    [displayItems, tracksMap, play, navigateTo, patchCurrentTrack, exportFolders]
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

  // `silent` lets batch callers suppress the per-folder toast and report one
  // aggregate result instead; it always returns the raw IPC result.
  const linkDir = useCallback(
    async (dirPath, recursive, playlistId = null, silent = false) => {
      const res = await window.api.linkDirectory(dirPath, recursive, playlistId);
      if (!silent) showToast(`Linked ${res.linked}/${res.total} tracks`);
      if (res.filePaths?.length) {
        const tracks = await window.api.getTracksByPaths(res.filePaths);
        setTracksMap((prev) => {
          const next = new Map(prev);
          tracks.forEach((t) => next.set(t.file_path, t));
          return next;
        });
      }
      return res;
    },
    [showToast]
  );

  // Import every selected folder. Import, create-playlist and remap all apply
  // per folder, so a multi-selection runs the action for each of them.
  const importFolders = useCallback(
    async (dirPaths, recursive) => {
      if (dirPaths.length === 1) return linkDir(dirPaths[0], recursive);
      let linked = 0;
      let total = 0;
      for (const dirPath of dirPaths) {
        const res = await linkDir(dirPath, recursive, null, true);
        linked += res?.linked ?? 0;
        total += res?.total ?? 0;
      }
      showToast(`Linked ${linked}/${total} tracks`);
    },
    [linkDir, showToast]
  );

  const createPlaylistsForFolders = useCallback(
    async (dirPaths, recursive) => {
      const silent = dirPaths.length > 1;
      let created = 0;
      let linked = 0;
      let total = 0;
      for (const dirPath of dirPaths) {
        const pl = await window.api.createPlaylist(basename(dirPath) || dirPath);
        const res = await linkDir(dirPath, recursive, pl.id, silent);
        linked += res?.linked ?? 0;
        total += res?.total ?? 0;
        created += 1;
      }
      if (silent) showToast(`Created ${created} playlists, linked ${linked}/${total} tracks`);
    },
    [linkDir, showToast]
  );

  const remapFolders = useCallback(
    async (dirPaths) => {
      let count = 0;
      let failed = 0;
      for (const dirPath of dirPaths) {
        const res = await window.api.remapFolder(dirPath);
        if (res?.ok) count += res.count ?? 0;
        else failed += 1;
      }
      if (failed) showToast(`Remap failed for ${failed} folder(s)`, false);
      else showToast(`Remapped ${count} track(s)`);
    },
    [showToast]
  );

  // Add every selected file to a playlist: unlinked files are linked first
  // (one call), then all resulting track ids are added in a single request.
  const addFilesToPlaylist = useCallback(
    async (filePaths, playlist) => {
      const isLinkedTrack = (p) => {
        const t = tracksMap.get(p);
        return t?.is_linked === 1 && typeof t.id === 'number';
      };
      const trackIds = filePaths.filter(isLinkedTrack).map((p) => tracksMap.get(p).id);
      const toLink = filePaths.filter((p) => !isLinkedTrack(p));
      if (toLink.length) {
        const results = await linkFiles(toLink);
        for (const r of results) if (typeof r.id === 'number') trackIds.push(r.id);
      }
      if (trackIds.length) await window.api.addTracksToPlaylist(playlist.id, trackIds);
      showToast(`Added ${trackIds.length} track(s) to "${playlist.name}"`);
    },
    [tracksMap, linkFiles, showToast]
  );

  // Delete every selected linked file, behind one confirmation listing them all.
  const removeFiles = useCallback(
    (filePaths) => {
      const items = filePaths
        .map((p) => ({ path: p, id: tracksMap.get(p)?.id }))
        .filter((x) => typeof x.id === 'number');
      if (!items.length) return;
      const names = items.map((x) => basename(x.path));
      const many = items.length > 1;
      const listed = `${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}`;
      setConfirmDialog({
        title: many ? `🗑️ Delete ${items.length} files?` : '🗑️ Delete file?',
        body: `${
          many ? `${items.length} files (${listed})` : `"${names[0]}"`
        } will be permanently deleted from your disk and removed from the library.\n\nThis cannot be undone.`,
        confirmLabel: many ? `Delete ${items.length} files` : 'Delete file',
        onConfirm: async () => {
          setConfirmDialog(null);
          for (const it of items) await window.api.removeLinkedFile(it.id);
          setTracksMap((prev) => {
            const next = new Map(prev);
            for (const it of items) next.delete(it.path);
            return next;
          });
          if (many) showToast(`Deleted ${items.length} files`);
          else showToast(`Deleted: ${names[0]}`);
        },
      });
    },
    [tracksMap, showToast]
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

  // Shift the menu up/left by exactly the overflow once it renders, so it
  // always stays inside the window bounds (#310).
  useLayoutEffect(() => {
    if (!contextMenu) {
      setMenuShift({ x: 0, y: 0 });
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const shiftX = Math.max(0, rect.right - window.innerWidth + 8);
    const shiftY = Math.max(0, rect.bottom - window.innerHeight + 8);
    setMenuShift((prev) =>
      prev.x === -shiftX && prev.y === -shiftY ? prev : { x: -shiftX, y: -shiftY }
    );
  }, [contextMenu]);

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

  // Hand an export selection to the library dialog. Same dialog the folder flows
  // use, so tracks can go into the library or into a playlist (#504).
  const addExportTracks = useCallback((tracks, name, softwareLabel) => {
    const paths = (tracks ?? []).map((t) => t.absolute_path || t.file_path).filter(Boolean);
    if (paths.length === 0) return;
    setLinkDialog({
      defaultName: name || 'Export',
      paths,
      description: `${paths.length} track(s) in "${name ?? 'export'}"${
        softwareLabel ? ` (${softwareLabel} export)` : ''
      }`,
    });
  }, []);

  // Opening a folder as a library: same navigation, different view.
  const handleOpenAsLibrary = useCallback(
    (path) => {
      libraryIntentRef.current = path;
      setFolderChoice(null);
      setExportViewMode('library');
      navigateTo(path);
    },
    [navigateTo]
  );

  // Opening it as a folder: the listing, and nothing remembered for next time.
  const handleOpenAsFolder = useCallback(
    (path) => {
      libraryIntentRef.current = null;
      setFolderChoice(null);
      setExportViewMode('files');
      navigateTo(path);
    },
    [navigateTo]
  );

  const rowProps = useMemo(
    () => ({
      items: displayItems,
      tracksMap,
      selectedPaths,
      playingFilePath,
      onRowClick: handleRowClick,
      onDoubleClick: handleDoubleClick,
      onOpenAsLibrary: handleOpenAsLibrary,
      exportFolders,
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
      handleOpenAsLibrary,
      exportFolders,
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

  // ── Context menu model ────────────────────────────────────────────────────
  // Built from the whole selection (see explorerContextMenu.js): per-item
  // actions target every selected folder/file with count-aware wording, while
  // single-item-only actions stay visible but disabled behind a "<N> selected"
  // header. Nothing below treats the clicked row specially - only its kind
  // (folder vs file) decides which menu is shown.
  const menuModel = useMemo(() => {
    if (!contextMenu?.item) return null;
    const clicked = contextMenu.item;
    const isDir = clicked.type === 'dir';
    const clickedTrack = tracksMap.get(clicked.path) ?? null;
    const clickedLinked = clickedTrack?.is_linked === 1;
    const selection = displayItems.filter((x) => selectedPaths.has(x.path));
    const selectionPaths = selection.map((x) => x.path);
    return buildExplorerContextMenu({
      selection,
      clickedItem: clicked,
      favourites,
      playlists: isDir ? [] : playlists,
      linkedPaths: isDir ? [] : selectionPaths.filter((p) => tracksMap.get(p)?.is_linked === 1),
      brokenDirPaths: isDir
        ? selectionPaths.filter((p) => brokenTracks.some((b) => b.file_path.startsWith(p)))
        : [],
      brokenFileMatch:
        !isDir && !clickedLinked ? (brokenByFilename.get(basename(clicked.path)) ?? null) : null,
      clickedTrackMissing:
        !isDir && clickedLinked && brokenTracks.some((b) => b.id === clickedTrack?.id),
    });
  }, [
    contextMenu,
    displayItems,
    selectedPaths,
    tracksMap,
    favourites,
    playlists,
    brokenTracks,
    brokenByFilename,
  ]);

  // Create a playlist named after the clicked file and link every target into it.
  const createPlaylistAndLink = async (filePaths) => {
    const pl = await window.api.createPlaylist(menuFilename);
    await linkFiles(filePaths, pl.id);
  };

  const remapClickedFile = async (broken, filePath) => {
    const r = await window.api.remapTrack(broken.id, filePath);
    if (r.ok) {
      setBrokenTracks((p) => p.filter((b) => b.id !== broken.id));
      showToast(`Remapped: ${broken.title}`);
    } else showToast('Remap failed', false);
  };

  // Every action reads its targets from the entry's `paths`, so a menu entry can
  // never silently fall back to the clicked row.
  const runMenuAction = (entry) => {
    const paths = entry.paths ?? [];
    closeMenu();
    switch (entry.id) {
      case 'favourite-add':
        updateFavourites(paths, true);
        if (paths.length > 1) showToast(`Added ${paths.length} folders to Favourites`);
        break;
      case 'favourite-remove':
        updateFavourites(paths, false);
        if (paths.length > 1) showToast(`Removed ${paths.length} folders from Favourites`);
        break;
      case 'import-flat':
        importFolders(paths, false);
        break;
      case 'import-recursive':
        importFolders(paths, true);
        break;
      case 'create-playlist-flat':
        createPlaylistsForFolders(paths, false);
        break;
      case 'create-playlist-recursive':
        createPlaylistsForFolders(paths, true);
        break;
      case 'remap-folders':
        remapFolders(paths);
        break;
      case 'add-to-library':
        linkFiles(paths);
        break;
      case 'playlist-new':
        createPlaylistAndLink(paths);
        break;
      case 'playlist-existing':
        addFilesToPlaylist(paths, { id: entry.playlistId, name: entry.label });
        break;
      case 'play':
        if (menuItem) handleDoubleClick(menuItem);
        break;
      case 'edit-details':
        if (menuTrack) setDetailsTrack(menuTrack);
        break;
      case 'prepare-track':
        if (menuTrack) setBeatGridTrack(menuTrack);
        break;
      case 'reanalyze':
        if (menuTrack) {
          window.api.reanalyzeTrack(menuTrack.id);
          showToast('Re-analysis started');
        }
        break;
      case 'normalize':
        if (menuTrack) {
          window.api.normalizeTracksAudio({ trackIds: [menuTrack.id] });
          showToast('Normalization started');
        }
        break;
      case 'remap-track':
        if (menuBrokenMatch && menuItem) remapClickedFile(menuBrokenMatch, menuItem.path);
        break;
      case 'remove-files':
        removeFiles(paths);
        break;
      default:
        break;
    }
  };

  const renderMenuEntry = (entry, key) => {
    if (entry.type === 'separator') return <div key={key} className="context-menu-separator" />;
    if (entry.type === 'header')
      return (
        <div key={key} className="context-menu-header">
          {entry.label}
        </div>
      );
    // A submenu parent only hosts children - clicking it must not close the menu.
    const clickable = Boolean(entry.id) && !entry.submenu && !entry.disabled;
    const classes = [
      'context-menu-item',
      entry.submenu ? 'context-menu-item--has-submenu' : '',
      entry.disabled ? 'context-menu-item--disabled' : '',
      entry.danger ? 'context-menu-item--danger' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={key}
        className={classes}
        title={entry.disabled ? entry.disabledReason : entry.title}
        onClick={clickable ? () => runMenuAction(entry) : undefined}
      >
        {entry.color && <span style={{ color: entry.color }}>● </span>}
        {entry.label}
        {entry.submenu && !entry.disabled && (
          <div
            className={`context-submenu${entry.id === 'add-to-playlist' ? ' context-submenu--scrollable' : ''}`}
          >
            {entry.submenu.map((sub, i) => renderMenuEntry(sub, `${key}-${i}`))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`explorer-view${detailsTrack ? ' explorer-view--with-panel' : ''}`}
      style={style}
    >
      {/* ── Favourites sidebar ────────────────────────────────────────────── */}
      <div className="explorer-favourites">
        {mountRows.length > 1 && (
          <>
            <div className="explorer-favourites__header">Drives</div>
            {mountRows.map((mount) => {
              const isActiveMount = activeDrive === mount.root;
              const exports = driveExports[mount.root];
              const scanning = driveExportsScanning[mount.root];
              return (
                <Fragment key={mount.id}>
                  <div
                    className={`explorer-favourites__item${
                      isActiveMount ? ' explorer-favourites__item--active' : ''
                    }`}
                    title={mount.root}
                    onClick={() => navigateTo(mount.root)}
                  >
                    <span className="explorer-favourites__icon">
                      {mount.removable ? '🔌' : '💽'}
                    </span>
                    <span className="explorer-favourites__name">{mount.label}</span>
                    {mount.removable && (
                      <span className="explorer-favourites__badge" title="Removable drive">
                        USB
                      </span>
                    )}
                    <button
                      className="explorer-favourites__remove"
                      title="Rescan this drive for DJ software exports"
                      onClick={(e) => {
                        e.stopPropagation();
                        detectDriveExports(mount.root);
                      }}
                    >
                      ↻
                    </button>
                  </div>
                  {isActiveMount && (
                    <div className="explorer-drive-exports">
                      {scanning && (
                        <div className="explorer-drive-exports__empty">
                          Scanning for DJ exports...
                        </div>
                      )}
                      {!scanning && exports && exports.length === 0 && (
                        <div className="explorer-drive-exports__empty">No DJ exports found</div>
                      )}
                      {(exports ?? []).map((exp) => {
                        const key = `${mount.root}|${exp.software}`;
                        const open = expandedExport === key;
                        return (
                          <div key={key} className="explorer-drive-export">
                            <button
                              className="explorer-drive-export__head"
                              title={exp.path}
                              onClick={() => setExpandedExport(open ? null : key)}
                            >
                              <span className="explorer-drive-export__caret">
                                {open ? '▾' : '▸'}
                              </span>
                              <span className="explorer-drive-export__name">
                                {exportSummaryLine(exp)}
                              </span>
                            </button>
                            {open && (
                              <div className="explorer-drive-export__body">
                                {exp.entries.length === 0 ? (
                                  <div className="explorer-drive-export__note">
                                    {exp.note ?? 'No readable track listing.'}
                                  </div>
                                ) : (
                                  exp.entries.map((pl) => (
                                    <div key={pl.id} className="explorer-drive-export__playlist">
                                      <div className="explorer-drive-export__playlist-name">
                                        {`${pl.name} (${pl.trackCount})`}
                                      </div>
                                      {pl.tracks.map((t) => (
                                        <div key={t.id} className="explorer-drive-export__track">
                                          <span className="explorer-drive-export__track-title">
                                            {t.title || basename(t.file_path)}
                                          </span>
                                          {t.artist && (
                                            <span className="explorer-drive-export__track-artist">
                                              {t.artist}
                                            </span>
                                          )}
                                          <button
                                            className="explorer-export-add"
                                            title="Add to library or a playlist"
                                            onClick={() => addExportTracks([t], pl.name, exp.label)}
                                          >
                                            ＋
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </>
        )}
        <div className="explorer-favourites__header">Favourites</div>
        {favourites.length === 0 ? (
          <div className="explorer-favourites__empty">Right-click a folder to add favourites</div>
        ) : (
          favourites.map((fav) => (
            <div
              key={fav.path}
              className={`explorer-favourites__item${currentPath === fav.path ? ' explorer-favourites__item--active' : ''}`}
              title={fav.path}
              onClick={() => navigateTo(fav.path)}
            >
              <span className="explorer-favourites__icon">📁</span>
              <span className="explorer-favourites__name">{fav.name}</span>
              <button
                className="explorer-favourites__remove"
                title="Remove from favourites"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFavourite(fav.path);
                }}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="explorer-view__main">
        {/* ── Toolbar ───────────────────────────────────────────────────────── */}
        <div className="explorer-toolbar">
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
                selectedFileItems.length > 0
                  ? selectedFileItems.map((f) => f.path)
                  : showExportLibrary
                    ? exportTrackPaths
                    : null;
              const folderFileCount = displayItems.filter((x) => x.type === 'file').length;
              const description =
                selectedFileItems.length > 0
                  ? `${paths.length} selected file(s) from "${folderName}"`
                  : showExportLibrary
                    ? `${paths.length} track(s) in "${
                        shownExportPlaylist?.name ?? 'export'
                      }" (${activeExport?.label ?? ''} export)`
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

        {showExportLibrary ? (
          <div className="explorer-export-library">
            <div className="explorer-export-library__banner">
              <div className="explorer-export-library__heading">
                <span className="explorer-export-library__title">
                  📚 {activeExport.label} export
                </span>
                <span className="explorer-export-library__meta">
                  {`${exportPlaylists.length} playlist${exportPlaylists.length === 1 ? '' : 's'}`}
                  {activeExport.trackCount != null
                    ? ` · ${activeExport.trackCount} track${activeExport.trackCount === 1 ? '' : 's'}`
                    : ''}
                </span>
                <span className="explorer-export-library__path" title={exportContext.root}>
                  {exportContext.root}
                </span>
              </div>
              <div className="explorer-export-library__modes">
                <button className="explorer-btn active">Library</button>
                <button className="explorer-btn" onClick={() => setExportViewMode('files')}>
                  Files
                </button>
              </div>
            </div>

            <div className="explorer-export-library__body">
              <div className="explorer-export-library__playlists">
                {sidebarEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`explorer-export-library__playlist${
                      shownExportPlaylist?.id === entry.id
                        ? ' explorer-export-library__playlist--active'
                        : ''
                    }`}
                  >
                    <button
                      className="explorer-export-library__playlist-main"
                      title={entry.name}
                      onClick={() => setOpenExportPlaylist(entry.id)}
                    >
                      <span className="explorer-export-library__playlist-name">{entry.name}</span>
                      <span className="explorer-export-library__playlist-count">
                        {entry.trackCount}
                      </span>
                    </button>
                    <button
                      className="explorer-export-library__playlist-add"
                      title={`Add "${entry.name}" to the library`}
                      onClick={() => addExportTracks(entry.tracks, entry.name, activeExport.label)}
                    >
                      ＋
                    </button>
                  </div>
                ))}
              </div>

              <div className="explorer-export-library__list">
                {exportItems.length === 0 ? (
                  <div className="explorer-empty">
                    {activeExport.note ?? 'No readable track listing.'}
                  </div>
                ) : (
                  <FileListPane
                    containerRef={containerRef}
                    listRef={listRef}
                    listHeight={listHeight}
                    loading={false}
                    items={exportItems}
                    rowProps={rowProps}
                    emptyLabel="No tracks here"
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {activeExport && (
              <div className="explorer-export-banner">
                <span>
                  📚 {activeExport.label} export
                  {exportContext.root === currentPath ? ' here' : ` at ${exportContext.root}`}
                </span>
                <button className="explorer-btn" onClick={() => setExportViewMode('library')}>
                  Open as library
                </button>
              </div>
            )}

            <FileListPane
              containerRef={containerRef}
              listRef={listRef}
              listHeight={listHeight}
              loading={loading}
              items={displayItems}
              rowProps={rowProps}
              emptyLabel="No audio files here"
            />
          </>
        )}

        {/* ── Context menu ──────────────────────────────────────────────────── */}
        {contextMenu && (
          <>
            <div className="context-backdrop-invisible" onClick={closeMenu} />
            <div
              className={`context-menu${contextMenu.flipLeft ? ' context-menu--flip-left' : ''}${contextMenu.flipUp ? ' context-menu--flip-up' : ''}`}
              ref={menuRef}
              style={{ top: contextMenu.y + menuShift.y, left: contextMenu.x + menuShift.x }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {menuModel?.entries.map((entry, i) => renderMenuEntry(entry, `menu-${i}`))}
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
        {folderChoice && (
          <div className="explorer-dialog-backdrop" onMouseDown={() => setFolderChoice(null)}>
            <div className="explorer-dialog" onMouseDown={(e) => e.stopPropagation()}>
              <div className="explorer-dialog__title">Open {folderChoice.name}</div>
              <p className="explorer-dialog__body">
                {`This folder holds a ${folderChoice.label} export. Open it as a library to see its
              playlists and tracks, or as a folder to browse the files it is made of.`}
              </p>
              <div className="explorer-dialog__actions">
                <button className="explorer-btn" onClick={() => setFolderChoice(null)}>
                  Cancel
                </button>
                <button
                  className="explorer-btn"
                  onClick={() => handleOpenAsFolder(folderChoice.path)}
                >
                  Open as folder
                </button>
                <button
                  className="explorer-btn accent"
                  onClick={() => handleOpenAsLibrary(folderChoice.path)}
                >
                  Open as library
                </button>
              </div>
            </div>
          </div>
        )}

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

        {/* ── Beat Grid Editor (fixed overlay — kept inside main so it stays
           within the stacking context of the main panel) ──────────────── */}
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
      {/* end .explorer-view__main */}

      {/* ── Details side panel (sibling to main, same row) ────────────────── */}
      {detailsTrack && (
        <TrackDetails
          track={detailsTrack}
          onSave={handleDetailsSave}
          onCancel={() => setDetailsTrack(null)}
        />
      )}
    </div>
  );
}
