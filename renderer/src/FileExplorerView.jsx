import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { List } from 'react-window';
import { usePlayer } from './PlayerContext.jsx';
import { artworkUrl } from './artworkUrl.js';
import TrackDetails from './TrackDetails.jsx';
import BeatGridEditor from './BeatGridEditor.jsx';
import { buildExplorerContextMenu } from './explorerContextMenu.js';
import './MusicLibrary.css';
import './FileExplorerView.css';

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
/** Minimum grid width in px so the title column keeps readable space on narrow windows. */
const MIN_WIDTH = 680;
/** Height in px of one explorer row, fed to the virtualised list. */
const ROW_HEIGHT = 50;

/** Format a duration in seconds as m:ss, or an em dash when unknown. */
function fmtDuration(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Last path segment of a POSIX or Windows path. */
function basename(p) {
  return p.replace(/.*[\\/]/, '');
}

/**
 * Wrap a file on disk as a track-shaped object so files that are not in the
 * library yet can still be listed, played and shown in the player bar.
 *
 * @param {{ path: string, name: string }} f Directory entry for the file.
 * @returns {object} Track with an "explorer:" id and null metadata.
 */
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

/**
 * One row of the virtualised file list: a directory entry, or a file with the
 * metadata of its library track when it is linked (else a placeholder).
 *
 * @param {number} index Row index in the flat item list.
 * @param {object} style Position style supplied by the virtualiser.
 * @param {{ type: string, path: string, name: string }[]} items Flat list of entries.
 * @param {Map<string, object>} tracksMap Library tracks keyed by file path.
 * @param {Set<string>} selectedPaths Paths currently selected.
 * @param {string|null} playingFilePath Path of the track being played.
 * @param {(event: object, item: object) => void} onRowClick Selects or toggles a row.
 * @param {(item: object) => void} onDoubleClick Opens a folder or plays/queues a file.
 * @param {(event: object, item: object) => void} onContextMenu Opens the row menu.
 * @param {number} mediaPort Local media server port used for artwork URLs.
 */
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

/**
 * Split a path into breadcrumb segments, handling Windows drive letters and
 * POSIX paths.
 *
 * @param {string|null} p Absolute path.
 * @returns {{ label: string, path: string }[]} Crumbs from the root to the path.
 */
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

/**
 * Small confirm/cancel dialog used for destructive explorer actions.
 *
 * @param {string} title Dialog title.
 * @param {string} body Explanatory text.
 * @param {string} [confirmLabel] Label of the confirm button.
 * @param {() => void} onConfirm Runs the action and closes the dialog.
 * @param {() => void} onCancel Closes the dialog without acting.
 */
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

/**
 * Asks where an Explorer file or folder should be imported to: the library, an
 * existing playlist, or a new playlist created on the fly.
 *
 * @param {string} [description] Extra warning text about the selected files.
 * @param {string} defaultName Suggested name for a new playlist.
 * @param {{ id: string, name: string }[]} playlists Playlists available as targets.
 * @param {(target: object) => void} onConfirm Receives { type: 'library' | 'existing' | 'create', ... }.
 * @param {() => void} onCancel Cancels the import.
 */
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

/**
 * Filesystem browser: navigates drives and folders, shows library metadata for
 * linked files, previews playback and imports files or folders into the library
 * or a playlist.
 *
 * @param {object} style Inline style, used by the shell to hide inactive views.
 */
export default function FileExplorerView({ style }) {
  const { play, currentTrack, mediaPort, patchCurrentTrack } = usePlayer();

  const [fsRoot, setFsRoot] = useState(null);
  const [drives, setDrives] = useState([]);
  const [homeDir, setHomeDir] = useState(null);
  const [currentPath, setCurrentPath] = useState(null);
  const [dirEntries, setDirEntries] = useState({ dirs: [], files: [] });
  const [loading, setLoading] = useState(false);
  const [analyzingPath, setAnalyzingPath] = useState(null);
  const pendingAnalysisIds = useRef(new Set());
  const [tracksMap, setTracksMap] = useState(new Map());
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [playlists, setPlaylists] = useState([]);
  const [contextMenu, setContextMenu] = useState(null);
  const menuRef = useRef(null);
  const [menuShift, setMenuShift] = useState({ x: 0, y: 0 });
  const [detailsTrack, setDetailsTrack] = useState(null);
  const [beatGridTrack, setBeatGridTrack] = useState(null);
  const [toast, setToast] = useState(null);
  const [linkDialog, setLinkDialog] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [favourites, setFavourites] = useState([]);

  const [brokenTracks, setBrokenTracks] = useState([]);
  const brokenScanRunning = useRef(false);

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

  useEffect(() => {
    window.api.getComputerRoot().then(({ root, home, drives }) => {
      setFsRoot(root);
      setHomeDir(home);
      setDrives(drives ?? []);
      setCurrentPath(home ?? root);
    });
    window.api.getPlaylists().then(setPlaylists);
    window.api.getSetting('explorer_favourites', []).then((favs) => {
      let parsed = favs;
      if (typeof favs === 'string') {
        try {
          parsed = favs ? JSON.parse(favs) : [];
        } catch {
          parsed = [];
        }
      }
      setFavourites(Array.isArray(parsed) ? parsed : []);
    });
    const unsub = window.api.onPlaylistsUpdated(() => window.api.getPlaylists().then(setPlaylists));
    return unsub;
  }, []);

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

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([e]) => setListHeight(e.contentRect.height));
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

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
      if (pendingAnalysisIds.current.has(trackId)) {
        pendingAnalysisIds.current.delete(trackId);
        if (pendingAnalysisIds.current.size === 0) {
          setAnalyzingPath(null);
        }
      }
    });
    return unsub;
  }, [patchCurrentTrack]);

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

  const displayItems = useMemo(() => {
    if (recursiveFiles !== null) return recursiveFiles.map((f) => ({ ...f, type: 'file' }));
    return [
      ...dirEntries.dirs.map((d) => ({ ...d, type: 'dir' })),
      ...dirEntries.files.map((f) => ({ ...f, type: 'file' })),
    ];
  }, [dirEntries, recursiveFiles]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'a') return;
      const target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
      if (!containerRef.current?.offsetParent) return;
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

  const navigateTo = useCallback((p) => {
    setCurrentPath(p);
    lastClickIndex.current = null;
  }, []);

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

      play(trackForItem, queue, idx);

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
          patchCurrentTrack(syntheticId, linked[0]);
        });
      }
    },
    [displayItems, tracksMap, play, navigateTo, patchCurrentTrack]
  );

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

  const watchFoldersAsPlaylists = useCallback(
    async (dirPaths, recursive) => {
      let created = 0;
      let added = 0;
      let linked = 0;
      const problems = [];
      for (const dirPath of dirPaths) {
        const res = await window.api.createFolderPlaylist({ folderPath: dirPath, recursive });
        if (res?.ok) {
          created += 1;
          added += res.added ?? 0;
          linked += res.linked ?? 0;
        } else {
          const why =
            res?.error === 'duplicate-name'
              ? 'a playlist with that name already exists'
              : (res?.error ?? 'failed');
          problems.push(`${basename(dirPath) || dirPath}: ${why}`);
        }
      }
      if (created > 0) {
        const what = created === 1 ? 'Tracking folder' : `Tracking ${created} folders`;
        const extra = problems.length ? ` (${problems.join('; ')})` : '';
        showToast(
          `${what}: ${added} track${added === 1 ? '' : 's'} added, ${linked} linked${extra}`,
          problems.length === 0
        );
      } else {
        showToast(problems.join('; ') || 'Could not create the folder playlist', false);
      }
    },
    [showToast]
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

  const menuItem = contextMenu?.item ?? null;
  const menuTrack = menuItem ? (tracksMap.get(menuItem.path) ?? null) : null;
  const menuIsLinked = menuTrack?.is_linked === 1;
  const menuIsDir = menuItem?.type === 'dir';
  const menuFilename = menuItem ? basename(menuItem.path) : '';
  const menuBrokenMatch =
    menuItem && !menuIsLinked && !menuIsDir ? (brokenByFilename.get(menuFilename) ?? null) : null;

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
      case 'watch-folder-playlist':
        watchFoldersAsPlaylists(paths, false);
        break;
      case 'watch-folder-playlist-recursive':
        watchFoldersAsPlaylists(paths, true);
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
      {}
      <div className="explorer-favourites">
        {drives.length > 1 && (
          <>
            <div className="explorer-favourites__header">Drives</div>
            {drives.map((d) => (
              <div
                key={d}
                className={`explorer-favourites__item${
                  currentPath === d || currentPath.startsWith(d)
                    ? ' explorer-favourites__item--active'
                    : ''
                }`}
                title={d}
                onClick={() => navigateTo(d)}
              >
                <span className="explorer-favourites__icon">💽</span>
                <span className="explorer-favourites__name">{d}</span>
              </div>
            ))}
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
        {}
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

        {}
        <div className="header" style={{ gridTemplateColumns: GRID, minWidth: MIN_WIDTH }}>
          {COLUMNS.map((col) => (
            <div key={col.key} className="header-cell">
              {col.label}
            </div>
          ))}
        </div>

        {}
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

        {}
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

        {}
        {confirmDialog && (
          <ConfirmDialog
            title={confirmDialog.title}
            body={confirmDialog.body}
            confirmLabel={confirmDialog.confirmLabel}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}

        {}
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

        {}
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

        {}
        {toast && (
          <div className={`music-library-toast${toast.ok ? '' : ' music-library-toast--warn'}`}>
            {toast.msg}
          </div>
        )}
      </div>
      {}

      {}
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
