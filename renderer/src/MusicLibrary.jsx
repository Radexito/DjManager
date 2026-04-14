import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  createContext,
  useContext,
} from 'react';
import { List } from 'react-window';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { usePlayer } from './PlayerContext.jsx';
import { artworkUrl } from './artworkUrl.js';
import { parseQuery } from './searchParser.js';
import TrackDetails from './TrackDetails.jsx';
import CuePointsEditor from './CuePointsEditor.jsx';
import RatingStars from './RatingStars.jsx';
import './MusicLibrary.css';

const PAGE_SIZE = 50;
const ROW_HEIGHT = 50;
const PRELOAD_TRIGGER = 3;

const LS_COL_KEY = 'djman_column_visibility';
const LS_ORDER_KEY = 'djman_column_order';

// All possible columns — all are user-hideable.
const ALL_COLUMNS = [
  { key: 'index', label: '#', width: '40px' },
  { key: 'title', label: 'Title', width: 'minmax(120px, 2fr)' },
  { key: 'artist', label: 'Artist', width: 'minmax(90px, 1.5fr)' },
  { key: 'rating', label: 'Rating', width: '88px' },
  { key: 'bpm', label: 'BPM', width: '62px' },
  { key: 'key_camelot', label: 'Key', width: '52px' },
  { key: 'loudness', label: 'Loudness (LUFS)', width: '115px' },
  { key: 'cue', label: '◆', width: '28px' },
  { key: 'album', label: 'Album', width: 'minmax(80px, 1fr)' },
  { key: 'year', label: 'Year', width: '50px' },
  { key: 'label', label: 'Label', width: '100px' },
  { key: 'genres', label: 'Genres', width: '120px' },
  { key: 'user_tags', label: 'Tags', width: '120px' },
  { key: 'bitrate', label: 'Bitrate', width: '92px' },
  { key: 'duration', label: 'Duration', width: '65px' },
];

const ALL_COLUMN_KEYS = ALL_COLUMNS.map((c) => c.key);
const COL_BY_KEY = Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c]));

const DEFAULT_COL_VIS = {
  index: true,
  title: true,
  artist: true,
  rating: true,
  bpm: true,
  key_camelot: true,
  loudness: true,
  cue: true,
  album: false,
  year: false,
  label: false,
  genres: false,
  user_tags: false,
  bitrate: false,
  duration: false,
};

function loadColVis() {
  try {
    return { ...DEFAULT_COL_VIS, ...JSON.parse(localStorage.getItem(LS_COL_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_COL_VIS };
  }
}

function loadColOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_ORDER_KEY) ?? 'null');
    if (!Array.isArray(saved)) return ALL_COLUMN_KEYS;
    // merge: keep saved order, append any new keys not yet in saved
    const merged = saved.filter((k) => COL_BY_KEY[k]);
    ALL_COLUMN_KEYS.forEach((k) => {
      if (!merged.includes(k)) merged.push(k);
    });
    return merged;
  } catch {
    return ALL_COLUMN_KEYS;
  }
}

function fmtDuration(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function renderCell(t, colKey) {
  const bpmValue = t.bpm_override ?? t.bpm;
  switch (colKey) {
    case 'title':
      return t.title;
    case 'artist':
      return t.artist || 'Unknown';
    case 'bpm':
      return bpmValue ?? '...';
    case 'key_camelot':
      return t.key_camelot ?? '...';
    case 'loudness':
      return t.loudness != null ? t.loudness : '...';
    case 'album':
      return t.album || '—';
    case 'year':
      return t.year ?? '—';
    case 'label':
      return t.label || '—';
    case 'genres': {
      try {
        return JSON.parse(t.genres ?? '[]').join(', ') || '—';
      } catch {
        return '—';
      }
    }
    case 'cue':
      return null; // rendered as icon button in LibraryRow
    case 'rating':
      return null; // rendered as interactive RatingStars in LibraryRow
    case 'user_tags':
      return t.user_tags || '—';
    case 'duration':
      return fmtDuration(t.duration);
    case 'bitrate':
      return t.bitrate != null ? `${Math.round(t.bitrate / 1000)} kbps` : '—';
    default:
      return t[colKey] ?? '—';
  }
}

function cellClass(colKey, t) {
  const numeric = ['bpm', 'key_camelot', 'loudness', 'year', 'duration', 'bitrate'].includes(
    colKey
  );
  const over = colKey === 'bpm' && t.bpm_override != null;
  return `cell ${colKey}${numeric ? ' numeric' : ''}${over ? ' bpm--overridden' : ''}`;
}

// ── SubItem context — defined outside MusicLibrary so SubItem's type is stable across
//    re-renders, preventing unmount/remount that would kill CSS hover state ──────────────
const SubItemCtx = createContext(null);

function SubItem({ id, label, children, wide, scrollable }) {
  const ctx = useContext(SubItemCtx);
  if (!ctx) return null;
  const { isOverlay, onDrillDown } = ctx;
  if (isOverlay) {
    return (
      <div
        className="context-menu-item context-menu-item--has-submenu"
        onClick={(e) => {
          e.stopPropagation();
          onDrillDown({ id, label, content: children });
        }}
      >
        {label}
      </div>
    );
  }
  return (
    <div className="context-menu-item context-menu-item--has-submenu">
      {label}
      <div
        className={[
          'context-submenu',
          wide ? 'context-submenu--wide' : '',
          scrollable ? 'context-submenu--scrollable' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </div>
    </div>
  );
}

// ── LibraryRow — outside MusicLibrary so react-virtualized doesn't remount on re-render ──
function LibraryRow({
  index,
  style,
  tracks,
  selectedIds,
  currentTrackId,
  onRowClick,
  onDoubleClick,
  onContextMenu,
  onRatingChange,
  onCueClick,
  onDragStart,
  visibleColumns,
  gridTemplate,
  minScrollWidth,
  mediaPort,
  newTrackIds,
  onAnimationEnd,
}) {
  const t = tracks[index];
  if (!t) {
    return (
      <div
        style={{ ...style, gridTemplateColumns: gridTemplate, minWidth: minScrollWidth }}
        className="row row-loading"
      >
        Loading more tracks...
      </div>
    );
  }
  const isSelected = selectedIds.has(t.id);
  const isPlaying = currentTrackId === t.id;
  const isNew = newTrackIds?.has(t.id);
  return (
    <div
      style={{ ...style, gridTemplateColumns: gridTemplate, minWidth: minScrollWidth }}
      className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}${isSelected ? ' row--selected' : ''}${isPlaying ? ' row--playing' : ''}${t.analyzed === 0 ? ' row--analyzing' : ''}${isNew ? ' row--new' : ''}`}
      title={
        t.analyzed === 0
          ? `⏳ Analyzing / processing — "${t.title}" will be available shortly`
          : `${t.title} - ${t.artist || 'Unknown'}`
      }
      draggable={true}
      onDragStart={(e) => onDragStart(e, t)}
      onClick={(e) => onRowClick(e, t, index)}
      onDoubleClick={() => onDoubleClick(t, index)}
      onContextMenu={(e) => onContextMenu(e, t, index)}
      onAnimationEnd={isNew ? () => onAnimationEnd?.(t.id) : undefined}
    >
      {visibleColumns.map((col) =>
        col.key === 'index' ? (
          <div key="index" className="cell index">
            <span className="index-num">{index + 1}</span>
            <button
              className="index-play"
              title="Play"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur();
                onDoubleClick(t, index);
              }}
            >
              ▶
            </button>
          </div>
        ) : col.key === 'cue' ? (
          <div
            key="cue"
            className="cell cue"
            onClick={(e) => {
              e.stopPropagation();
              onCueClick?.(t);
            }}
            title={
              t.cue_count > 0
                ? `${t.cue_count} cue point(s) — click to edit`
                : 'No cue points — click to add'
            }
          >
            {t.cue_count > 0 ? (
              <span className="cue-dot cue-dot--has">◆</span>
            ) : (
              <span className="cue-dot cue-dot--empty">◇</span>
            )}
          </div>
        ) : col.key === 'rating' ? (
          <div key="rating" className="cell rating" onClick={(e) => e.stopPropagation()}>
            <RatingStars value={t.rating ?? 0} onChange={(val) => onRatingChange(t.id, val)} />
          </div>
        ) : col.key === 'title' ? (
          <div key="title" className="cell title">
            {artworkUrl(t.has_artwork ? t.artwork_path : null, mediaPort) ? (
              <img
                className="cell-artwork"
                src={artworkUrl(t.artwork_path, mediaPort)}
                alt=""
                draggable={false}
              />
            ) : (
              <span className="cell-artwork cell-artwork--placeholder">♪</span>
            )}
            <span className="cell-title-text">{t.title}</span>
          </div>
        ) : (
          <div key={col.key} className={cellClass(col.key, t)}>
            {renderCell(t, col.key)}
          </div>
        )
      )}
    </div>
  );
}

// ── SortableRow — must be defined outside MusicLibrary to avoid remount ────
function SortableRow({
  t,
  index,
  isSelected,
  isPlaying,
  onRowClick,
  onDoubleClick,
  onContextMenu,
  onRatingChange,
  onCueClick,
  visibleColumns,
  gridTemplate,
  minScrollWidth,
  mediaPort,
  isNew,
  onAnimationEnd,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: t.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    gridTemplateColumns: gridTemplate,
    minWidth: minScrollWidth,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}${isSelected ? ' row--selected' : ''}${isPlaying ? ' row--playing' : ''}${t.analyzed === 0 ? ' row--analyzing' : ''}${isNew ? ' row--new' : ''}`}
      title={
        t.analyzed === 0
          ? `⏳ Analyzing / processing — "${t.title}" will be available shortly`
          : `${t.title} - ${t.artist || 'Unknown'}`
      }
      onClick={(e) => onRowClick(e, t, index)}
      onDoubleClick={() => onDoubleClick(t, index)}
      onContextMenu={(e) => onContextMenu(e, t, index)}
      onAnimationEnd={isNew ? () => onAnimationEnd?.(t.id) : undefined}
    >
      {visibleColumns.map((col) =>
        col.key === 'index' ? (
          <div key="index" className="cell index drag-handle" {...attributes} {...listeners}>
            <span className="index-num">⠿</span>
            <button
              className="index-play"
              title="Play"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur();
                onDoubleClick(t, index);
              }}
            >
              ▶
            </button>
          </div>
        ) : col.key === 'cue' ? (
          <div
            key="cue"
            className="cell cue"
            onClick={(e) => {
              e.stopPropagation();
              onCueClick?.(t);
            }}
            title={
              t.cue_count > 0
                ? `${t.cue_count} cue point(s) — click to edit`
                : 'No cue points — click to add'
            }
          >
            {t.cue_count > 0 ? (
              <span className="cue-dot cue-dot--has">◆</span>
            ) : (
              <span className="cue-dot cue-dot--empty">◇</span>
            )}
          </div>
        ) : col.key === 'rating' ? (
          <div key="rating" className="cell rating" onClick={(e) => e.stopPropagation()}>
            <RatingStars value={t.rating ?? 0} onChange={(val) => onRatingChange(t.id, val)} />
          </div>
        ) : col.key === 'title' ? (
          <div key="title" className="cell title">
            {artworkUrl(t.has_artwork ? t.artwork_path : null, mediaPort) ? (
              <img
                className="cell-artwork"
                src={artworkUrl(t.artwork_path, mediaPort)}
                alt=""
                draggable={false}
              />
            ) : (
              <span className="cell-artwork cell-artwork--placeholder">♪</span>
            )}
            <span className="cell-title-text">{t.title}</span>
          </div>
        ) : (
          <div key={col.key} className={cellClass(col.key, t)}>
            {renderCell(t, col.key)}
          </div>
        )
      )}
    </div>
  );
}

// ── SortableColItem — draggable row in the column-visibility dropdown ──────
function SortableColItem({ colKey, label, checked, onToggle }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: colKey,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="col-dropdown__item">
      <span className="col-drag-handle" {...attributes} {...listeners} title="Drag to reorder">
        ☰
      </span>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="col-dropdown__label">{label}</span>
    </div>
  );
}

function MusicLibrary({ selectedPlaylist, search, onSearchChange }) {
  const isPlaylistView = selectedPlaylist !== 'music';
  const {
    play,
    stop,
    currentTrack,
    isPlaying,
    togglePlay,
    currentPlaylistId,
    mediaPort,
    patchCurrentTrack,
    reloadCurrentTrack,
    updateQueue,
  } = usePlayer();

  // Only highlight a track as "playing" when the source context matches this view.
  // Library view: only highlight when played from library (currentPlaylistId === null).
  // Playlist view: only highlight when played from this specific playlist.
  const playingTrackId = isPlaylistView
    ? String(currentPlaylistId) === String(selectedPlaylist)
      ? currentTrack?.id
      : null
    : currentPlaylistId === null
      ? currentTrack?.id
      : null;

  const [tracks, setTracks] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [newTrackIds, setNewTrackIds] = useState(new Set()); // IDs of rows to animate in

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [contextMenu, setContextMenu] = useState(null); // { x, y, targetIds }
  const [toast, setToast] = useState(null); // { msg, ok } | null
  const toastTimerRef = useRef(null);
  const [drillStack, setDrillStack] = useState([]); // overlay drill-down stack [{ id, label, content }]
  const [playlistSubmenu, setPlaylistSubmenu] = useState(null); // [{ id, name, color, is_member }]
  const [newPlaylistInputActive, setNewPlaylistInputActive] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newPlaylistError, setNewPlaylistError] = useState('');
  const newPlaylistInputRef = useRef(null);
  const [loadKey, setLoadKey] = useState(0);
  const [playlistInfo, setPlaylistInfo] = useState(null); // { name, total_duration, track_count }
  const [activeId, setActiveId] = useState(null); // DnD active drag id
  const [sortSaved, setSortSaved] = useState(true); // false when sorted away from position order
  const [colVis, setColVis] = useState(loadColVis);
  const [colOrder, setColOrder] = useState(loadColOrder);
  const [colMenuAnchor, setColMenuAnchor] = useState(null); // { x, y } | null
  const [detailsTrack, setDetailsTrack] = useState(null);
  const [detailsBulkTracks, setDetailsBulkTracks] = useState(null); // array | null
  const [cueTrack, setCueTrack] = useState(null);
  const [bpmEditValue, setBpmEditValue] = useState(''); // value for inline Set BPM input

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true); // ref copy of hasMore — avoids stale closures in loadTracks
  const resetTokenRef = useRef(0); // incremented on every reset; stale fetches compare and discard
  const listRef = useRef();
  const sortedTracksRef = useRef([]);
  const lastSelectedIndexRef = useRef(null);
  const colDropdownRef = useRef(null);
  const headerRef = useRef(null);
  const headerScrollRef = useRef(null); // syncs header horizontal scroll to content scroll
  const dndScrollRef = useRef(null); // ref to playlist DnD scroll container
  // Tracks whether we should resume playback after normalization finishes re-analyzing
  const normalizeResumeRef = useRef(null); // { id, shouldResume } | null
  // When set to true, the next loadTracks call will animate truly-new incoming rows
  const animateNextLoadRef = useRef(false);
  // Snapshot of IDs already in the list before a reload — used to diff truly-new rows
  const preReloadIdsRef = useRef(new Set());
  // Refs that stay in sync so the onLibraryUpdated closure (empty deps) can read current values
  const selectedPlaylistRef = useRef(selectedPlaylist);
  const searchRef = useRef(search);
  const currentPlaylistIdRef = useRef(currentPlaylistId);
  const updateQueueRef = useRef(updateQueue);
  useEffect(() => {
    selectedPlaylistRef.current = selectedPlaylist;
  }, [selectedPlaylist]);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  useEffect(() => {
    currentPlaylistIdRef.current = currentPlaylistId;
  }, [currentPlaylistId]);
  useEffect(() => {
    updateQueueRef.current = updateQueue;
  }, [updateQueue]);

  // Track previous view identity so the reset effect knows whether the VIEW changed
  // (search/playlist switch → clear selection) vs. just a data reload (loadKey bump → keep selection)
  const prevSelectedPlaylistRef = useRef(selectedPlaylist);
  const prevSearchRef = useRef(search);

  const visibleColumns = useMemo(
    () => colOrder.map((k) => COL_BY_KEY[k]).filter((c) => c && colVis[c.key] !== false),
    [colVis, colOrder]
  );
  const gridTemplate = useMemo(
    () => visibleColumns.map((c) => c.width).join(' '),
    [visibleColumns]
  );
  const minScrollWidth = useMemo(() => {
    const sum = visibleColumns.reduce((acc, c) => {
      const mm = c.width.match(/minmax\((\d+)px/);
      if (mm) return acc + parseInt(mm[1], 10);
      const px = c.width.match(/^(\d+)px$/);
      if (px) return acc + parseInt(px[1], 10);
      return acc;
    }, 0);
    const gapTotal = Math.max(0, visibleColumns.length - 1) * 6; // 6px column-gap
    return sum + gapTotal + 16; // 8px left + 8px right padding
  }, [visibleColumns]);

  const [sortBy, setSortBy] = useState({ key: 'index', asc: true });

  const loadTracks = useCallback(async () => {
    if (loadingRef.current || !hasMoreRef.current) return;

    loadingRef.current = true;
    const token = resetTokenRef.current;

    try {
      const { filters, remaining } = parseQuery(search);
      const structuredFilters = filters.filter((f) => f.field !== '_text');
      const textSearch = remaining || filters.find((f) => f.field === '_text')?.value || '';

      const rows = await window.api.getTracks({
        limit: PAGE_SIZE,
        offset: offsetRef.current,
        search: textSearch,
        filters: structuredFilters,
        playlistId: selectedPlaylist !== 'music' ? selectedPlaylist : undefined,
      });

      if (token !== resetTokenRef.current) return; // stale — reset happened mid-flight

      // On first page: replace all tracks atomically (no flash from empty-list state)
      if (offsetRef.current === 0) {
        // Animate only rows that weren't already in the list before reload
        if (animateNextLoadRef.current) {
          animateNextLoadRef.current = false;
          const truly = new Set(
            rows.filter((r) => !preReloadIdsRef.current.has(r.id)).map((r) => r.id)
          );
          if (truly.size > 0) setNewTrackIds((prev) => new Set([...prev, ...truly]));
        }
        setTracks(rows);
      } else {
        setTracks((prev) => [...prev, ...rows]);
      }
      offsetRef.current += rows.length;

      if (rows.length < PAGE_SIZE) {
        hasMoreRef.current = false;
        setHasMore(false);
      }
    } finally {
      if (token === resetTokenRef.current) loadingRef.current = false;
    }
  }, [search, selectedPlaylist]); // no hasMore in deps — we use hasMoreRef

  const sortedTracks = useMemo(() => {
    const sorted = [...tracks].sort((a, b) => {
      if (sortBy.key === 'index') return 0;
      // For BPM, prefer the override value
      const va = sortBy.key === 'bpm' ? (a.bpm_override ?? a.bpm ?? '') : (a[sortBy.key] ?? '');
      const vb = sortBy.key === 'bpm' ? (b.bpm_override ?? b.bpm ?? '') : (b[sortBy.key] ?? '');
      if (typeof va === 'string' || typeof vb === 'string') {
        const sa = String(va ?? '');
        const sb = String(vb ?? '');
        return sortBy.asc ? sa.localeCompare(sb) : sb.localeCompare(sa);
      }
      if (typeof va === 'number') return sortBy.asc ? va - vb : vb - va;
      return 0;
    });
    sortedTracksRef.current = sorted;
    return sorted;
  }, [tracks, sortBy]);

  useEffect(() => {
    // Snapshot IDs currently visible so loadTracks can diff truly-new rows
    preReloadIdsRef.current = new Set(sortedTracksRef.current.map((t) => t.id));

    // Only clear selection + reset sort when the VIEW changes (user navigated to a
    // different playlist or typed a new search). Pure data reloads (loadKey bumps from
    // import/playlist-updated) should preserve selection so the user isn't surprised.
    const viewChanged =
      prevSelectedPlaylistRef.current !== selectedPlaylist || prevSearchRef.current !== search;
    prevSelectedPlaylistRef.current = selectedPlaylist;
    prevSearchRef.current = search;

    offsetRef.current = 0;
    loadingRef.current = false;
    hasMoreRef.current = true;
    resetTokenRef.current += 1;
    setHasMore(true);
    if (viewChanged) {
      setSelectedIds(new Set());
      lastSelectedIndexRef.current = null;
      setSortBy({ key: 'index', asc: true });
      setSortSaved(true);
    }

    // Use setTimeout so the state updates above are committed before we load.
    // The cleanup cancels the timer — in StrictMode this means the first
    // invocation's timer is always cancelled, leaving only one load per reset.
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) loadTracks();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, selectedPlaylist, loadKey, loadTracks]);

  // Listen for background analysis updates
  useEffect(() => {
    const unsub = window.api.onTrackUpdated(({ trackId, analysis }) => {
      // analyzed: 0 means an intermediate event (normalization done, re-analysis pending)
      // analyzed: undefined or 1 means analysis is complete
      const isAnalyzed = analysis.analyzed !== 0;
      const merged = { ...analysis, analyzed: isAnalyzed ? 1 : 0 };

      setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, ...merged } : t)));

      // Keep PlayerContext's currentTrack in sync
      patchCurrentTrack(trackId, merged);

      // If this completes the full analysis of a track being normalized that was playing,
      // reload the audio element to use the new normalized file, then optionally resume
      if (isAnalyzed) {
        console.log(
          '[normalize] track-updated (full analysis) trackId=',
          trackId,
          'normalized_file_path=',
          analysis.normalized_file_path,
          'resume ref=',
          normalizeResumeRef.current
        );
        if (analysis.normalized_file_path && normalizeResumeRef.current?.id === trackId) {
          const { shouldResume } = normalizeResumeRef.current;
          normalizeResumeRef.current = null;
          console.log(
            '[normalize] calling reloadCurrentTrack path=',
            analysis.normalized_file_path,
            'shouldResume=',
            shouldResume
          );
          reloadCurrentTrack(analysis.normalized_file_path, shouldResume);
        }
      }
    });
    return unsub;
  }, [patchCurrentTrack, reloadCurrentTrack]);

  // Refresh list when new tracks are imported
  useEffect(() => {
    const unsub = window.api.onLibraryUpdated(async () => {
      const isDefaultView = selectedPlaylistRef.current === 'music' && !searchRef.current;
      if (isDefaultView) {
        // getTracks orders by created_at DESC (newest first), so using currentCount as the
        // offset would skip the N newest tracks and return the (N+1)th oldest — which is
        // already on screen, not the just-imported track (#204).  Fetch from offset 0 and
        // dedup against what's already loaded instead.
        const rows = await window.api.getTracks({ limit: PAGE_SIZE, offset: 0 });
        if (rows.length > 0) {
          const existingIds = new Set(sortedTracksRef.current.map((t) => t.id));
          const newRows = rows.filter((r) => !existingIds.has(r.id));
          if (newRows.length > 0) {
            setNewTrackIds((prev) => new Set([...prev, ...newRows.map((r) => r.id)]));
            setTracks((prev) => {
              const prevIds = new Set(prev.map((t) => t.id));
              const deduped = newRows.filter((r) => !prevIds.has(r.id));
              if (deduped.length === 0) return prev;
              const merged = [...prev, ...deduped];
              // Keep the player queue in sync when playing from the music (all-tracks) view.
              if (currentPlaylistIdRef.current === null) {
                updateQueueRef.current(merged);
              }
              return merged;
            });
            offsetRef.current = sortedTracksRef.current.length + newRows.length;
            // If the batch we fetched is smaller than a full page, we've reached the end.
            if (rows.length < PAGE_SIZE) {
              hasMoreRef.current = false;
              setHasMore(false);
            }
          }
        }
      } else {
        // Filtered / playlist view: full reload (content may have changed meaningfully)
        preReloadIdsRef.current = new Set(sortedTracksRef.current.map((t) => t.id));
        animateNextLoadRef.current = true;
        setLoadKey((k) => k + 1);
      }
    });
    return unsub;
  }, []);

  // Keep player queue in sync when tracks are added/removed from the current playlist (#213).
  // The all-tracks view is handled inside onLibraryUpdated; playlist view needs its own sync
  // because it does a full reload (setLoadKey) rather than a soft-append.
  useEffect(() => {
    if (
      isPlaylistView &&
      currentPlaylistId !== null &&
      String(currentPlaylistId) === String(selectedPlaylist) &&
      sortedTracksRef.current.length > 0
    ) {
      updateQueue(sortedTracksRef.current);
    }
    // Only react to track count changes — sort-order changes should not reshuffle the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.length, isPlaylistView, selectedPlaylist, currentPlaylistId]);

  // Reload playlist info (name, duration) when entering playlist view or tracks change
  useEffect(() => {
    if (!isPlaylistView) {
      setPlaylistInfo(null);
      return;
    }
    window.api.getPlaylist(Number(selectedPlaylist)).then(setPlaylistInfo);
  }, [isPlaylistView, selectedPlaylist, tracks.length]);

  // Reload when playlists mutated externally (track added/removed)
  useEffect(() => {
    const unsub = window.api.onPlaylistsUpdated(() => setLoadKey((k) => k + 1));
    return unsub;
  }, []);

  // DnD sensors
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = async (e) => {
      // Ctrl+A — select all tracks including unloaded ones
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const { filters, remaining } = parseQuery(search);
        const structuredFilters = filters.filter((f) => f.field !== '_text');
        const textSearch = remaining || filters.find((f) => f.field === '_text')?.value || '';
        const ids = await window.api.getTrackIds({
          search: textSearch,
          filters: structuredFilters,
          playlistId: selectedPlaylist !== 'music' ? selectedPlaylist : undefined,
        });
        setSelectedIds(new Set(ids));
        return;
      }
      // Enter or E — open details for single selected track
      if ((e.key === 'Enter' || e.key === 'e') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        setSelectedIds((prev) => {
          if (prev.size === 1) {
            const id = [...prev][0];
            const track = sortedTracksRef.current.find((t) => t.id === id);
            if (track) setDetailsTrack(track);
          }
          return prev;
        });
        return;
      }
      // Escape — close details or context menu
      if (e.key === 'Escape') {
        setDetailsTrack(null);
        setContextMenu(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [search, selectedPlaylist]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => {
      setContextMenu(null);
      setDrillStack([]);
      setNewPlaylistInputActive(false);
      setNewPlaylistName('');
      setNewPlaylistError('');
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [contextMenu]);

  // ── Selection ──────────────────────────────────────────────────────────────

  const handleRowClick = useCallback((e, track, index) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(track.id)) next.delete(track.id);
        else next.add(track.id);
        return next;
      });
      lastSelectedIndexRef.current = index;
    } else if (e.shiftKey && lastSelectedIndexRef.current !== null) {
      const start = Math.min(lastSelectedIndexRef.current, index);
      const end = Math.max(lastSelectedIndexRef.current, index);
      const rangeIds = sortedTracksRef.current.slice(start, end + 1).map((t) => t.id);
      setSelectedIds(new Set(rangeIds));
    } else {
      setSelectedIds(new Set([track.id]));
      lastSelectedIndexRef.current = index;
      // If the cue panel is already open, follow the selection
      setCueTrack((prev) => (prev ? track : null));
    }
  }, []);

  const handleDoubleClick = useCallback(
    (track, index) => {
      play(
        track,
        sortedTracksRef.current,
        index,
        isPlaylistView ? selectedPlaylist : null,
        isPlaylistView ? (playlistInfo?.name ?? null) : null
      );
    },
    [play, isPlaylistView, selectedPlaylist, playlistInfo]
  );

  // ── Details panel ──────────────────────────────────────────────────────────

  const handleDetailsClose = useCallback(() => {
    setDetailsTrack(null);
    setDetailsBulkTracks(null);
  }, []);

  // ── Cue points panel ───────────────────────────────────────────────────────

  const handleCueClick = useCallback((track) => {
    setCueTrack((prev) => (prev?.id === track.id ? null : track));
  }, []);

  const handleCueClose = useCallback(() => setCueTrack(null), []);

  const handleCuePointsChange = useCallback(
    (pts) => {
      setCueTrack((prev) => (prev ? { ...prev, cue_count: pts.length } : prev));
      setTracks((prev) =>
        prev.map((t) => (t.id === cueTrack?.id ? { ...t, cue_count: pts.length } : t))
      );
    },
    [cueTrack?.id]
  );

  const handleDetailsSave = useCallback((result) => {
    if (Array.isArray(result)) {
      // bulk save: update each track in state
      setTracks((prev) =>
        prev.map((t) => {
          const updated = result.find((u) => u.id === t.id);
          return updated ? { ...t, ...updated } : t;
        })
      );
      setDetailsBulkTracks(null);
    } else {
      setTracks((prev) => prev.map((t) => (t.id === result.id ? { ...t, ...result } : t)));
      setDetailsTrack(result);
    }
  }, []);

  const handleDetailsPrev = useCallback(() => {
    const tracks = sortedTracksRef.current;
    if (!detailsTrack) return;
    const idx = tracks.findIndex((t) => t.id === detailsTrack.id);
    if (idx > 0) {
      setDetailsTrack(tracks[idx - 1]);
      setSelectedIds(new Set([tracks[idx - 1].id]));
    }
  }, [detailsTrack]);

  const handleDetailsNext = useCallback(() => {
    const tracks = sortedTracksRef.current;
    if (!detailsTrack) return;
    const idx = tracks.findIndex((t) => t.id === detailsTrack.id);
    if (idx >= 0 && idx < tracks.length - 1) {
      setDetailsTrack(tracks[idx + 1]);
      setSelectedIds(new Set([tracks[idx + 1].id]));
    }
  }, [detailsTrack]);

  // ── Column visibility ──────────────────────────────────────────────────────

  const toggleCol = useCallback((key) => {
    setColVis((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(LS_COL_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const handleColDragEnd = useCallback(({ active, over }) => {
    if (!over || active.id === over.id) return;
    setColOrder((prev) => {
      const oldIndex = prev.indexOf(active.id);
      const newIndex = prev.indexOf(over.id);
      const next = arrayMove(prev, oldIndex, newIndex);
      localStorage.setItem(LS_ORDER_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Close column dropdown on outside click or Escape
  useEffect(() => {
    if (!colMenuAnchor) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setColMenuAnchor(null);
    };
    const onMouse = (e) => {
      if (!colDropdownRef.current?.contains(e.target)) setColMenuAnchor(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouse);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouse);
    };
  }, [colMenuAnchor]);

  // Sync header horizontal scroll with the scroll container (library or playlist)
  useEffect(() => {
    const el = isPlaylistView ? dndScrollRef.current : listRef.current?.element;
    if (!el) return;
    const sync = () => {
      if (headerScrollRef.current) headerScrollRef.current.scrollLeft = el.scrollLeft;
    };
    el.addEventListener('scroll', sync, { passive: true });
    return () => el.removeEventListener('scroll', sync);
  });

  const handleRatingChange = useCallback(
    async (trackId, newRating) => {
      try {
        await window.api.updateTrack(trackId, { rating: newRating });
        setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, rating: newRating } : t)));
      } catch (e) {
        console.error('Failed to save rating:', e);
      }
    },
    [setTracks]
  );

  const handleContextMenu = useCallback(
    async (e, track, index) => {
      e.preventDefault();
      if (!selectedIds.has(track.id)) {
        setSelectedIds(new Set([track.id]));
        lastSelectedIndexRef.current = index;
      }
      const targetIds = selectedIds.has(track.id) ? [...selectedIds] : [track.id];
      // Fetch playlist membership for single track (representative for submenu)
      const playlists = await window.api.getPlaylistsForTrack(targetIds[0]);
      setPlaylistSubmenu(playlists);

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const MENU_W = 200; // approximate menu width

      // Switch to bottom-sheet overlay when the window is too cramped
      const overlayMode = vw < 500 || vh < 420;

      // Clamp x so menu doesn't overflow the right edge
      const x = Math.min(e.clientX, vw - MENU_W - 8);
      // Clamp y so menu has at least 16px clearance from bottom
      const y = Math.min(e.clientY, vh - 16);
      // Flip submenus to the left when the menu is in the right half
      const flipLeft = x > vw / 2;
      // Flip submenus to grow upward when menu is in the lower 50% of the screen
      const flipUp = e.clientY > vh * 0.5;
      // Available space below click point — used by submenus as max-height
      const submenuMaxH = Math.max(120, vh - y - 8);

      // Collect track objects for all selected ids (only those loaded into sortedTracksRef)
      const targetTracks = targetIds
        .map((id) => sortedTracksRef.current.find((t) => t.id === id))
        .filter(Boolean);

      setContextMenu({
        x,
        y,
        targetIds,
        track,
        targetTracks,
        overlayMode,
        flipLeft,
        flipUp,
        submenuMaxH,
      });
    },
    [selectedIds]
  );

  const handleReanalyze = useCallback(async () => {
    const targetIds = contextMenu?.targetIds ?? [];
    setContextMenu(null);
    setTracks((prev) => prev.map((t) => (targetIds.includes(t.id) ? { ...t, analyzed: 0 } : t)));
    for (const id of targetIds) await window.api.reanalyzeTrack(id);
  }, [contextMenu]);

  const showToast = useCallback((msg, ok = true) => {
    clearTimeout(toastTimerRef.current);
    setToast({ msg, ok });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const handleNormalizeTracks = useCallback(async () => {
    const targetIds = contextMenu?.targetIds ?? [];
    setContextMenu(null);

    // Pause if the currently-playing track is among those being normalized
    const playingTarget = currentTrack && targetIds.includes(currentTrack.id);
    if (playingTarget) {
      normalizeResumeRef.current = { id: currentTrack.id, shouldResume: isPlaying };
      if (isPlaying) togglePlay(); // pause
    }

    // Gray out tracks immediately so there's instant visual feedback
    setTracks((prev) => prev.map((t) => (targetIds.includes(t.id) ? { ...t, analyzed: 0 } : t)));
    const { normalized, skipped } = await window.api.normalizeTracksAudio({ trackIds: targetIds });
    if (normalized === 0) {
      // Un-gray if nothing was normalized
      setTracks((prev) => prev.map((t) => (targetIds.includes(t.id) ? { ...t, analyzed: 1 } : t)));
      const wasPlaying = normalizeResumeRef.current?.shouldResume ?? false;
      normalizeResumeRef.current = null;
      // Resume if we paused for nothing
      if (playingTarget && wasPlaying) togglePlay();
      showToast(
        skipped > 0
          ? 'No analyzed tracks — analyze tracks first to get loudness data.'
          : 'Nothing to normalize.',
        false
      );
    }
    // On success: track-updated IPC events (from normalization + re-analysis) update each row
    // and reloadCurrentTrack resumes playback once re-analysis is done
  }, [contextMenu, currentTrack, isPlaying, togglePlay, showToast]);

  const handleResetNormalization = useCallback(async () => {
    const targetIds = contextMenu?.targetIds ?? [];
    setContextMenu(null);
    await window.api.resetNormalization({ trackIds: targetIds });
    // Clear gain + normalized path, mark as re-analyzing (analysis runs in background)
    setTracks((prev) =>
      prev.map((t) =>
        targetIds.includes(t.id)
          ? { ...t, replay_gain: null, normalized_file_path: null, analyzed: 0 }
          : t
      )
    );
    for (const id of targetIds) {
      patchCurrentTrack(id, { replay_gain: null, normalized_file_path: null });
    }
    showToast(
      `Reset ${targetIds.length} track${targetIds.length !== 1 ? 's' : ''} — re-analyzing…`
    );
  }, [contextMenu, patchCurrentTrack, showToast]);

  const handleRemove = useCallback(async () => {
    const targetIds = contextMenu?.targetIds ?? [];
    const n = targetIds.length;
    const msg =
      n === 1
        ? 'Remove this track from your library? This cannot be undone.'
        : `Remove ${n} tracks from your library? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    if (currentTrack && targetIds.includes(currentTrack.id)) stop();
    setContextMenu(null);
    for (const id of targetIds) await window.api.removeTrack(id);
    setTracks((prev) => prev.filter((t) => !targetIds.includes(t.id)));
    setSelectedIds(new Set());
    offsetRef.current = Math.max(0, offsetRef.current - targetIds.length);
  }, [contextMenu, currentTrack, stop]);

  const handleRemoveFromPlaylist = useCallback(async () => {
    const targetIds = contextMenu?.targetIds ?? [];
    const n = targetIds.length;
    const msg =
      n === 1 ? 'Remove this track from the playlist?' : `Remove ${n} tracks from the playlist?`;
    if (!window.confirm(msg)) return;
    if (currentTrack && targetIds.includes(currentTrack.id)) stop();
    setContextMenu(null);
    for (const id of targetIds) {
      await window.api.removeTrackFromPlaylist(Number(selectedPlaylist), id);
    }
    setTracks((prev) => prev.filter((t) => !targetIds.includes(t.id)));
    setSelectedIds(new Set());
    offsetRef.current = Math.max(0, offsetRef.current - targetIds.length);
  }, [contextMenu, selectedPlaylist, currentTrack, stop]);

  const handleAddToPlaylist = useCallback(async (playlistId, targetIds) => {
    setContextMenu(null);
    if (!targetIds?.length) return;
    try {
      await window.api.addTracksToPlaylist(playlistId, targetIds);
    } catch (err) {
      console.error('addTracksToPlaylist failed:', err);
    }
  }, []);

  const handleAddToNewPlaylist = useCallback(
    async (e) => {
      e?.preventDefault();
      const name = newPlaylistName.trim();
      if (!name) {
        setNewPlaylistInputActive(false);
        setNewPlaylistName('');
        return;
      }
      const targetIds = contextMenu?.targetIds ?? [];
      const result = await window.api.createPlaylist(name, null);
      if (result?.error === 'duplicate') {
        setNewPlaylistError('Name already exists');
        newPlaylistInputRef.current?.focus();
        return;
      }
      if (result?.id && targetIds.length) {
        await window.api.addTracksToPlaylist(result.id, targetIds);
      }
      setNewPlaylistInputActive(false);
      setNewPlaylistName('');
      setNewPlaylistError('');
      setContextMenu(null);
    },
    [contextMenu, newPlaylistName]
  );

  const handleBpmAdjust = useCallback(
    async (factor) => {
      const targetIds = contextMenu?.targetIds ?? [];
      setContextMenu(null);
      if (!targetIds.length) return;

      // Optimistic update
      setTracks((prev) =>
        prev.map((t) => {
          if (!targetIds.includes(t.id)) return t;
          const base = t.bpm_override ?? t.bpm;
          if (base == null) return t;
          return { ...t, bpm_override: Math.round(base * factor * 10) / 10 };
        })
      );

      // Persist to DB and reconcile with returned values
      const updated = await window.api.adjustBpm({ trackIds: targetIds, factor });
      const updatedById = new Map(updated.map((r) => [r.id, r]));
      setTracks((prev) =>
        prev.map((t) => {
          const u = updatedById.get(t.id);
          return u ? { ...t, bpm_override: u.bpm_override } : t;
        })
      );
    },
    [contextMenu]
  );

  const handleSetBpm = useCallback(
    async (rawValue) => {
      const targetIds = contextMenu?.targetIds ?? [];
      const parsed = parseFloat(rawValue);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      const bpmOverride = Math.round(parsed * 10) / 10;
      setContextMenu(null);
      setBpmEditValue('');
      if (!targetIds.length) return;

      // Optimistic update
      setTracks((prev) =>
        prev.map((t) => (targetIds.includes(t.id) ? { ...t, bpm_override: bpmOverride } : t))
      );

      // Persist each track
      await Promise.all(
        targetIds.map((id) => window.api.updateTrack(id, { bpm_override: bpmOverride }))
      );
    },
    [contextMenu]
  );

  const handleFindSimilar = useCallback(
    (queryText) => {
      setContextMenu(null);
      onSearchChange(queryText);
    },
    [onSearchChange]
  );

  // ── DnD (playlist view only) ───────────────────────────────────────────────

  const handleDragStart = useCallback(({ active }) => setActiveId(active.id), []);

  const handleDragEnd = useCallback(
    ({ active, over }) => {
      setActiveId(null);
      if (!over || active.id === over.id) return;
      setSortBy({ key: 'index', asc: true }); // reset sort so DnD operates on position order
      const prev = sortedTracksRef.current;
      const oldIndex = prev.findIndex((t) => t.id === active.id);
      const newIndex = prev.findIndex((t) => t.id === over.id);
      const reordered = arrayMove(prev, oldIndex, newIndex);
      setTracks(reordered);
      window.api.reorderPlaylist(
        Number(selectedPlaylist),
        reordered.map((t) => t.id)
      );
      setSortSaved(true);
    },
    [selectedPlaylist]
  );

  const handleTrackDragStart = useCallback(
    (e, track) => {
      const ids = selectedIds.has(track.id) ? [...selectedIds] : [track.id];
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/dj-tracks', JSON.stringify(ids));
    },
    [selectedIds]
  );

  const handleRowAnimationEnd = useCallback((trackId) => {
    setNewTrackIds((prev) => {
      if (!prev.has(trackId)) return prev;
      const next = new Set(prev);
      next.delete(trackId);
      return next;
    });
  }, []);

  const handleSaveOrder = useCallback(async () => {
    await window.api.reorderPlaylist(
      Number(selectedPlaylist),
      sortedTracksRef.current.map((t) => t.id)
    );
    setSortBy({ key: 'index', asc: true }); // revert to position order after saving
    setSortSaved(true);
  }, [selectedPlaylist]);

  // ── Misc ───────────────────────────────────────────────────────────────────

  const handleItemsRendered = useCallback(
    ({ stopIndex }) => {
      if (stopIndex >= sortedTracksRef.current.length - PRELOAD_TRIGGER) {
        loadTracks(); // loadTracks checks hasMoreRef and loadingRef internally
      }
    },
    [loadTracks]
  );

  const handleSort = useCallback(
    (key) => {
      setSortBy((prev) => {
        const next = { key, asc: prev.key === key ? !prev.asc : true };
        if (isPlaylistView) setSortSaved(next.key === 'index');
        return next;
      });
    },
    [isPlaylistView]
  );

  // ── Row (library view) — handled by LibraryRow above via itemData ─────────

  const selectionLabel =
    contextMenu?.targetIds?.length > 1 ? ` (${contextMenu.targetIds.length} tracks)` : '';

  const formatDuration = (secs) => {
    if (!secs) return '';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const activeTrack = activeId ? tracks.find((t) => t.id === activeId) : null;

  const subItemCtxValue = useMemo(
    () => ({
      isOverlay: !!contextMenu?.overlayMode,
      onDrillDown: ({ id, label, content }) =>
        setDrillStack((prev) => [...prev, { id, label, content }]),
    }),
    [contextMenu?.overlayMode]
  );

  return (
    <div
      className={`music-library${detailsTrack || detailsBulkTracks || cueTrack ? ' music-library--with-panel' : ''}`}
    >
      <div className="music-library__main">
        {/* Playlist header bar */}
        {isPlaylistView && playlistInfo && (
          <div className="playlist-header-bar">
            <span className="playlist-header-name">{playlistInfo.name}</span>
            <span className="playlist-header-meta">
              {playlistInfo.track_count} tracks · {formatDuration(playlistInfo.total_duration)}
            </span>
            {!sortSaved && (
              <button className="btn-save-order" onClick={handleSaveOrder}>
                💾 Save Order
              </button>
            )}
          </div>
        )}

        <div className="table-scroll-wrap library-mode">
          {isPlaylistView ? (
            <div ref={headerScrollRef} style={{ overflow: 'hidden' }}>
              <div
                ref={headerRef}
                className="header"
                style={{ gridTemplateColumns: gridTemplate, minWidth: minScrollWidth }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setColMenuAnchor({ x: e.clientX, y: e.clientY });
                }}
              >
                {visibleColumns.map((col) => (
                  <div
                    key={col.key}
                    className={`header-cell ${['bpm', 'key_camelot', 'loudness', 'year', 'duration', 'bitrate'].includes(col.key) ? 'right' : ''}`}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label} {sortBy.key === col.key ? (sortBy.asc ? '▲' : '▼') : ''}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div ref={headerScrollRef} style={{ overflow: 'hidden' }}>
              <div
                ref={headerRef}
                className="header"
                style={{ gridTemplateColumns: gridTemplate, minWidth: minScrollWidth }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setColMenuAnchor({ x: e.clientX, y: e.clientY });
                }}
              >
                {visibleColumns.map((col) => (
                  <div
                    key={col.key}
                    className={`header-cell ${['bpm', 'key_camelot', 'loudness', 'year', 'duration', 'bitrate'].includes(col.key) ? 'right' : ''}`}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label} {sortBy.key === col.key ? (sortBy.asc ? '▲' : '▼') : ''}
                  </div>
                ))}
              </div>
            </div>
          )}

          {colMenuAnchor && (
            <div
              className="col-dropdown"
              ref={colDropdownRef}
              style={{ position: 'fixed', left: colMenuAnchor.x, top: colMenuAnchor.y }}
            >
              <DndContext collisionDetection={closestCenter} onDragEnd={handleColDragEnd}>
                <SortableContext items={colOrder} strategy={verticalListSortingStrategy}>
                  {colOrder.map((key) => {
                    const col = COL_BY_KEY[key];
                    if (!col) return null;
                    return (
                      <SortableColItem
                        key={key}
                        colKey={key}
                        label={col.label}
                        checked={colVis[key] !== false}
                        onToggle={() => toggleCol(key)}
                      />
                    );
                  })}
                </SortableContext>
              </DndContext>
            </div>
          )}

          {/* Playlist view: full DnD list */}
          {isPlaylistView ? (
            tracks.length === 0 ? (
              <div className="playlist-empty-state">
                No tracks in this playlist.
                <br />
                Drag tracks from your library here, or right-click to add.
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={sortedTracks.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div ref={dndScrollRef} className="playlist-dnd-list">
                    {sortedTracks.map((t, index) => (
                      <SortableRow
                        key={t.id}
                        t={t}
                        index={index}
                        isSelected={selectedIds.has(t.id)}
                        isPlaying={playingTrackId === t.id}
                        onRowClick={handleRowClick}
                        onDoubleClick={handleDoubleClick}
                        onContextMenu={handleContextMenu}
                        onRatingChange={handleRatingChange}
                        onCueClick={handleCueClick}
                        onDragStart={handleTrackDragStart}
                        visibleColumns={visibleColumns}
                        gridTemplate={gridTemplate}
                        minScrollWidth={minScrollWidth}
                        mediaPort={mediaPort}
                        isNew={newTrackIds.has(t.id)}
                        onAnimationEnd={handleRowAnimationEnd}
                      />
                    ))}
                  </div>
                </SortableContext>
                <DragOverlay>
                  {activeTrack && (
                    <div
                      className="row row-drag-overlay"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      <div className="cell index">⠿</div>
                      <div className="cell title">{activeTrack.title}</div>
                      <div className="cell artist">{activeTrack.artist || 'Unknown'}</div>
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            )
          ) : (
            /* Library view: virtualised list */
            <List
              key={gridTemplate}
              listRef={listRef}
              defaultHeight={600}
              rowCount={sortedTracks.length + (hasMore ? 1 : 0)}
              rowHeight={ROW_HEIGHT}
              width="100%"
              style={{}}
              onRowsRendered={handleItemsRendered}
              className="track-list"
              rowComponent={LibraryRow}
              rowProps={{
                tracks: sortedTracks,
                selectedIds,
                currentTrackId: playingTrackId,
                onRowClick: handleRowClick,
                onDoubleClick: handleDoubleClick,
                onContextMenu: handleContextMenu,
                onRatingChange: handleRatingChange,
                onCueClick: handleCueClick,
                onDragStart: handleTrackDragStart,
                visibleColumns,
                gridTemplate,
                minScrollWidth,
                mediaPort,
                newTrackIds,
                onAnimationEnd: handleRowAnimationEnd,
              }}
            />
          )}
        </div>
        {/* end .table-scroll-wrap */}

        {contextMenu && (
          <SubItemCtx.Provider value={subItemCtxValue}>
            <>
              {contextMenu.overlayMode && (
                <div
                  className="context-backdrop"
                  onClick={() => {
                    setContextMenu(null);
                    setDrillStack([]);
                  }}
                />
              )}
              <div
                className={[
                  'context-menu',
                  contextMenu.overlayMode ? 'context-menu--overlay' : '',
                  contextMenu.flipLeft ? 'context-menu--flip-left' : '',
                  contextMenu.flipUp ? 'context-menu--flip-up' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  contextMenu.overlayMode
                    ? undefined
                    : {
                        top: contextMenu.y,
                        left: contextMenu.x,
                        '--submenu-max-h': `${contextMenu.submenuMaxH}px`,
                      }
                }
                onMouseDown={(e) => e.stopPropagation()}
              >
                {/* ── Overlay drill-down view ── */}
                {contextMenu.overlayMode && drillStack.length > 0 ? (
                  <>
                    <div
                      className="context-menu__back"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDrillStack((prev) => prev.slice(0, -1));
                      }}
                    >
                      ‹ {drillStack.length > 1 ? drillStack[drillStack.length - 2].label : 'Back'}
                    </div>
                    <div className="context-menu-item context-menu-item--header">
                      {drillStack[drillStack.length - 1].label}
                    </div>
                    {drillStack[drillStack.length - 1].content}
                  </>
                ) : (
                  <>
                    {/* ── Add to playlist ── */}
                    {playlistSubmenu !== null &&
                      (playlistSubmenu.length === 0 ? (
                        <>
                          {newPlaylistInputActive ? (
                            <form
                              className="ctx-new-playlist-form"
                              onSubmit={handleAddToNewPlaylist}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                ref={newPlaylistInputRef}
                                className="ctx-new-playlist-input"
                                value={newPlaylistName}
                                onChange={(e) => {
                                  setNewPlaylistName(e.target.value);
                                  setNewPlaylistError('');
                                }}
                                placeholder="Playlist name"
                                autoFocus
                                onBlur={handleAddToNewPlaylist}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setNewPlaylistInputActive(false);
                                    setNewPlaylistName('');
                                    setNewPlaylistError('');
                                  }
                                }}
                              />
                              {newPlaylistError && (
                                <div className="ctx-new-playlist-error">{newPlaylistError}</div>
                              )}
                            </form>
                          ) : (
                            <div
                              className="context-menu-item"
                              onClick={() => {
                                setNewPlaylistInputActive(true);
                                setTimeout(() => newPlaylistInputRef.current?.focus(), 0);
                              }}
                            >
                              ➕ Add to new playlist…
                            </div>
                          )}
                        </>
                      ) : (
                        <SubItem id="add-to-playlist" label="➕ Add to playlist" scrollable>
                          <div
                            className="context-menu-item ctx-new-playlist-item"
                            onClick={() => {
                              setNewPlaylistInputActive(true);
                              setTimeout(() => newPlaylistInputRef.current?.focus(), 0);
                            }}
                          >
                            {newPlaylistInputActive ? (
                              <form
                                className="ctx-new-playlist-form"
                                onSubmit={handleAddToNewPlaylist}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <input
                                  ref={newPlaylistInputRef}
                                  className="ctx-new-playlist-input"
                                  value={newPlaylistName}
                                  onChange={(e) => {
                                    setNewPlaylistName(e.target.value);
                                    setNewPlaylistError('');
                                  }}
                                  placeholder="Playlist name"
                                  autoFocus
                                  onBlur={handleAddToNewPlaylist}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                      setNewPlaylistInputActive(false);
                                      setNewPlaylistName('');
                                      setNewPlaylistError('');
                                    }
                                  }}
                                />
                                {newPlaylistError && (
                                  <div className="ctx-new-playlist-error">{newPlaylistError}</div>
                                )}
                              </form>
                            ) : (
                              '✚ New playlist…'
                            )}
                          </div>
                          <div className="context-menu-separator" />
                          {playlistSubmenu.map((pl) => (
                            <div
                              key={pl.id}
                              className={`context-menu-item${pl.is_member ? ' context-menu-item--checked' : ''}`}
                              onClick={() =>
                                !pl.is_member &&
                                handleAddToPlaylist(pl.id, contextMenu?.targetIds ?? [])
                              }
                            >
                              {pl.color && (
                                <span className="ctx-color-dot" style={{ background: pl.color }} />
                              )}
                              {pl.is_member ? '✓ ' : ''}
                              {pl.name}
                            </div>
                          ))}
                        </SubItem>
                      ))}

                    {/* ── Find similar ── */}
                    {contextMenu.targetTracks?.length > 0 && (
                      <SubItem id="find-similar" label="🔍 Find similar" wide>
                        {contextMenu.targetTracks.length === 1 ? (
                          /* ── Single-track options ── */
                          <>
                            {contextMenu.track.key_camelot && (
                              <>
                                <div className="context-menu-item context-menu-item--header">
                                  🎹 Key: {contextMenu.track.key_camelot.toUpperCase()}
                                </div>
                                <div
                                  className="context-menu-item"
                                  onClick={() =>
                                    handleFindSimilar(
                                      `KEY is ${contextMenu.track.key_camelot.toUpperCase()}`
                                    )
                                  }
                                >
                                  Same key
                                </div>
                                <div
                                  className="context-menu-item"
                                  onClick={() =>
                                    handleFindSimilar(
                                      `KEY adjacent ${contextMenu.track.key_camelot.toUpperCase()}`
                                    )
                                  }
                                >
                                  Adjacent — energy shift
                                </div>
                                <div
                                  className="context-menu-item"
                                  onClick={() =>
                                    handleFindSimilar(
                                      `KEY mode switch ${contextMenu.track.key_camelot.toUpperCase()}`
                                    )
                                  }
                                >
                                  Mode switch — minor↔major
                                </div>
                                <div
                                  className="context-menu-item"
                                  onClick={() =>
                                    handleFindSimilar(
                                      `KEY matches ${contextMenu.track.key_camelot.toUpperCase()}`
                                    )
                                  }
                                >
                                  All compatible keys
                                </div>
                              </>
                            )}
                            {(contextMenu.track.bpm_override ?? contextMenu.track.bpm) != null &&
                              (() => {
                                const bpm = Math.round(
                                  contextMenu.track.bpm_override ?? contextMenu.track.bpm
                                );
                                return (
                                  <>
                                    {contextMenu.track.key_camelot && (
                                      <div className="context-menu-separator" />
                                    )}
                                    <div className="context-menu-item context-menu-item--header">
                                      ♩ BPM: {bpm}
                                    </div>
                                    <div
                                      className="context-menu-item"
                                      onClick={() => handleFindSimilar(`BPM is ${bpm}`)}
                                    >
                                      Exact BPM
                                    </div>
                                    <div
                                      className="context-menu-item"
                                      onClick={() =>
                                        handleFindSimilar(`BPM in range ${bpm - 5}-${bpm + 5}`)
                                      }
                                    >
                                      Similar BPM (±5)
                                    </div>
                                    <div
                                      className="context-menu-item"
                                      onClick={() =>
                                        handleFindSimilar(`BPM in range ${bpm - 2}-${bpm + 2}`)
                                      }
                                    >
                                      Very similar BPM (±2)
                                    </div>
                                  </>
                                );
                              })()}
                            {contextMenu.track.key_camelot &&
                              (contextMenu.track.bpm_override ?? contextMenu.track.bpm) != null &&
                              (() => {
                                const bpm = Math.round(
                                  contextMenu.track.bpm_override ?? contextMenu.track.bpm
                                );
                                return (
                                  <>
                                    <div className="context-menu-separator" />
                                    <div className="context-menu-item context-menu-item--header">
                                      🎯 Combined
                                    </div>
                                    <div
                                      className="context-menu-item"
                                      onClick={() =>
                                        handleFindSimilar(
                                          `KEY matches ${contextMenu.track.key_camelot.toUpperCase()} AND BPM in range ${bpm - 5}-${bpm + 5}`
                                        )
                                      }
                                    >
                                      Compatible key + similar BPM
                                    </div>
                                  </>
                                );
                              })()}
                            {(() => {
                              try {
                                const genres = JSON.parse(contextMenu.track.genres ?? '[]');
                                if (!genres.length) return null;
                                return (
                                  <>
                                    <div className="context-menu-separator" />
                                    <div className="context-menu-item context-menu-item--header">
                                      🏷 Genre
                                    </div>
                                    {genres.slice(0, 3).map((g) => (
                                      <div
                                        key={g}
                                        className="context-menu-item"
                                        onClick={() => handleFindSimilar(`GENRE is ${g}`)}
                                      >
                                        {g}
                                      </div>
                                    ))}
                                  </>
                                );
                              } catch {
                                return null;
                              }
                            })()}
                          </>
                        ) : (
                          /* ── Multi-track options only ── */
                          (() => {
                            const tt = contextMenu.targetTracks;
                            const bpms = tt
                              .map((t) => t.bpm_override ?? t.bpm)
                              .filter((b) => b != null)
                              .map((b) => Math.round(b));
                            const keys = tt.map((t) => t.key_camelot).filter(Boolean);
                            const allGenres = tt.flatMap((t) => {
                              try {
                                return JSON.parse(t.genres ?? '[]');
                              } catch {
                                return [];
                              }
                            });
                            const genreCount = allGenres.reduce((acc, g) => {
                              acc[g] = (acc[g] ?? 0) + 1;
                              return acc;
                            }, {});
                            const topGenres = Object.entries(genreCount)
                              .sort((a, b) => b[1] - a[1])
                              .slice(0, 3)
                              .map(([g]) => g);
                            const keyCounts = keys.reduce((acc, k) => {
                              const n = k.toLowerCase();
                              acc[n] = (acc[n] ?? 0) + 1;
                              return acc;
                            }, {});
                            const topKey = Object.entries(keyCounts).sort(
                              (a, b) => b[1] - a[1]
                            )[0]?.[0];
                            const bpmMin = bpms.length ? Math.min(...bpms) : null;
                            const bpmMax = bpms.length ? Math.max(...bpms) : null;
                            return (
                              <>
                                <div className="context-menu-item context-menu-item--header">
                                  📦 {tt.length} tracks selected
                                </div>
                                {bpms.length > 0 && bpmMin !== bpmMax && (
                                  <div
                                    className="context-menu-item"
                                    onClick={() =>
                                      handleFindSimilar(`BPM in range ${bpmMin}-${bpmMax}`)
                                    }
                                  >
                                    BPM range {bpmMin}–{bpmMax}
                                  </div>
                                )}
                                {bpms.length > 0 && bpmMin === bpmMax && (
                                  <div
                                    className="context-menu-item"
                                    onClick={() => handleFindSimilar(`BPM is ${bpmMin}`)}
                                  >
                                    BPM {bpmMin} (all same)
                                  </div>
                                )}
                                {topKey && (
                                  <div
                                    className="context-menu-item"
                                    onClick={() =>
                                      handleFindSimilar(`KEY matches ${topKey.toUpperCase()}`)
                                    }
                                  >
                                    Keys compatible with {topKey.toUpperCase()}
                                  </div>
                                )}
                                {topKey && bpms.length > 0 && (
                                  <div
                                    className="context-menu-item"
                                    onClick={() =>
                                      handleFindSimilar(
                                        `KEY matches ${topKey.toUpperCase()} AND BPM in range ${bpmMin}-${bpmMax}`
                                      )
                                    }
                                  >
                                    Compatible key + BPM range
                                  </div>
                                )}
                                {topGenres.map((g) => (
                                  <div
                                    key={g}
                                    className="context-menu-item"
                                    onClick={() => handleFindSimilar(`GENRE is ${g}`)}
                                  >
                                    Genre: {g}
                                  </div>
                                ))}
                              </>
                            );
                          })()
                        )}
                      </SubItem>
                    )}

                    {/* ── separator ── */}
                    <div className="context-menu-separator" />

                    {/* ── Edit Details ── */}
                    <div
                      className="context-menu-item"
                      onClick={() => {
                        const targetTracks = contextMenu?.targetTracks ?? [];
                        setContextMenu(null);
                        if (targetTracks.length === 1) {
                          setDetailsBulkTracks(null);
                          setDetailsTrack(targetTracks[0]);
                          setSelectedIds(new Set([targetTracks[0].id]));
                        } else if (targetTracks.length > 1) {
                          setDetailsTrack(null);
                          setDetailsBulkTracks(targetTracks);
                        }
                      }}
                    >
                      ✏️ Edit Details{selectionLabel}
                    </div>

                    {/* ── Edit Cue Points ── */}
                    {contextMenu?.targetTracks?.length === 1 && (
                      <div
                        className="context-menu-item"
                        onClick={() => {
                          const track = contextMenu.targetTracks[0];
                          setContextMenu(null);
                          handleCueClick(track);
                        }}
                      >
                        ◆ Edit Cue Points
                      </div>
                    )}

                    {/* ── Analysis submenu ── */}
                    <SubItem id="analysis" label={`🔬 Analysis${selectionLabel}`}>
                      <div className="context-menu-item" onClick={handleReanalyze}>
                        🔄 Re-analyze
                      </div>
                      <div className="context-menu-separator" />
                      <div className="context-menu-item" onClick={handleNormalizeTracks}>
                        🔊 Normalize
                      </div>
                      <div className="context-menu-item" onClick={handleResetNormalization}>
                        ↩ Reset normalization
                      </div>
                      <div className="context-menu-separator" />
                      <SubItem id="bpm" label="🎵 BPM">
                        <div className="context-menu-item" onClick={() => handleBpmAdjust(2)}>
                          ✕2 Double BPM
                        </div>
                        <div className="context-menu-item" onClick={() => handleBpmAdjust(0.5)}>
                          ÷2 Halve BPM
                        </div>
                        <div className="context-menu-separator" />
                        <div
                          className="context-menu-item context-menu-item--set-bpm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="set-bpm-label">Set BPM:</span>
                          <input
                            className="set-bpm-input"
                            type="number"
                            min="20"
                            max="400"
                            step="0.1"
                            placeholder="e.g. 128"
                            value={bpmEditValue}
                            onChange={(e) => setBpmEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSetBpm(bpmEditValue);
                              if (e.key === 'Escape') {
                                setBpmEditValue('');
                                setContextMenu(null);
                              }
                            }}
                            autoFocus={false}
                          />
                          <button
                            className="set-bpm-apply"
                            disabled={!bpmEditValue}
                            onClick={() => handleSetBpm(bpmEditValue)}
                          >
                            ✓
                          </button>
                        </div>
                      </SubItem>
                    </SubItem>

                    {/* ── Remove ── */}
                    {isPlaylistView ? (
                      <>
                        <div
                          className="context-menu-item context-menu-item--danger"
                          onClick={handleRemoveFromPlaylist}
                        >
                          ➖ Remove from playlist{selectionLabel}
                        </div>
                        <div
                          className="context-menu-item context-menu-item--danger"
                          onClick={handleRemove}
                        >
                          🗑️ Remove from library{selectionLabel}
                        </div>
                      </>
                    ) : (
                      <div
                        className="context-menu-item context-menu-item--danger"
                        onClick={handleRemove}
                      >
                        🗑️ Remove from library{selectionLabel}
                      </div>
                    )}
                  </>
                )}{' '}
                {/* end drill-down conditional */}
              </div>
            </>
          </SubItemCtx.Provider>
        )}
        {toast && (
          <div className={`music-library-toast${toast.ok ? '' : ' music-library-toast--warn'}`}>
            {toast.msg}
          </div>
        )}
      </div>
      {/* end .music-library__main */}

      {detailsTrack &&
        (() => {
          const idx = sortedTracksRef.current.findIndex((t) => t.id === detailsTrack.id);
          return (
            <TrackDetails
              track={detailsTrack}
              onSave={handleDetailsSave}
              onCancel={handleDetailsClose}
              onPrev={handleDetailsPrev}
              onNext={handleDetailsNext}
              hasPrev={idx > 0}
              hasNext={idx >= 0 && idx < sortedTracksRef.current.length - 1}
            />
          );
        })()}
      {detailsBulkTracks && (
        <TrackDetails
          tracks={detailsBulkTracks}
          onSave={handleDetailsSave}
          onCancel={handleDetailsClose}
        />
      )}
      {cueTrack && (
        <div className="cue-panel">
          <div className="cue-panel__header">
            <span className="cue-panel__title">{cueTrack.title}</span>
            <button className="cue-panel__close" onClick={handleCueClose} title="Close">
              ✕
            </button>
          </div>
          <CuePointsEditor trackId={cueTrack.id} onCuePointsChange={handleCuePointsChange} />
        </div>
      )}
    </div>
  );
}

export default MusicLibrary;
