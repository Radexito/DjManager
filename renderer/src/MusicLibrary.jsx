import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
import SearchBar from './SearchBar.jsx';
import { parseQuery } from './searchParser.js';
import TrackDetails from './TrackDetails.jsx';
import './MusicLibrary.css';

const PAGE_SIZE = 50;
const ROW_HEIGHT = 50;
const PRELOAD_TRIGGER = 3;

const LS_COL_KEY = 'djman_column_visibility';
const LS_ORDER_KEY = 'djman_column_order';

// All possible columns — all are user-hideable.
const ALL_COLUMNS = [
  { key: 'index', label: '#', width: '44px' },
  { key: 'title', label: 'Title', width: 'minmax(120px, 2fr)' },
  { key: 'artist', label: 'Artist', width: 'minmax(90px, 1.5fr)' },
  { key: 'bpm', label: 'BPM', width: '70px' },
  { key: 'key_camelot', label: 'Key', width: '60px' },
  { key: 'loudness', label: 'Loudness (LUFS)', width: '100px' },
  { key: 'album', label: 'Album', width: 'minmax(80px, 1fr)' },
  { key: 'year', label: 'Year', width: '55px' },
  { key: 'label', label: 'Label', width: '100px' },
  { key: 'genres', label: 'Genres', width: '120px' },
  { key: 'duration', label: 'Duration', width: '70px' },
];

const ALL_COLUMN_KEYS = ALL_COLUMNS.map((c) => c.key);
const COL_BY_KEY = Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c]));

const DEFAULT_COL_VIS = {
  index: true,
  title: true,
  artist: true,
  bpm: true,
  key_camelot: true,
  loudness: true,
  album: false,
  year: false,
  label: false,
  genres: false,
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
    case 'duration':
      return fmtDuration(t.duration);
    default:
      return t[colKey] ?? '—';
  }
}

function cellClass(colKey, t) {
  const numeric = ['bpm', 'key_camelot', 'loudness', 'year', 'duration'].includes(colKey);
  const over = colKey === 'bpm' && t.bpm_override != null;
  return `cell ${colKey}${numeric ? ' numeric' : ''}${over ? ' bpm--overridden' : ''}`;
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
  visibleColumns,
  gridTemplate,
}) {
  const t = tracks[index];
  if (!t) {
    return (
      <div style={{ ...style, gridTemplateColumns: gridTemplate }} className="row row-loading">
        Loading more tracks...
      </div>
    );
  }
  const isSelected = selectedIds.has(t.id);
  const isPlaying = currentTrackId === t.id;
  return (
    <div
      style={{ ...style, gridTemplateColumns: gridTemplate }}
      className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}${isSelected ? ' row--selected' : ''}${isPlaying ? ' row--playing' : ''}`}
      title={`${t.title} - ${t.artist || 'Unknown'}`}
      onClick={(e) => onRowClick(e, t, index)}
      onDoubleClick={() => onDoubleClick(t, index)}
      onContextMenu={(e) => onContextMenu(e, t, index)}
    >
      {visibleColumns.map((col) =>
        col.key === 'index' ? (
          <div key="index" className="cell index">
            {index + 1}
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
  visibleColumns,
  gridTemplate,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: t.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    gridTemplateColumns: gridTemplate,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}${isSelected ? ' row--selected' : ''}${isPlaying ? ' row--playing' : ''}`}
      title={`${t.title} - ${t.artist || 'Unknown'}`}
      onClick={(e) => onRowClick(e, t, index)}
      onDoubleClick={() => onDoubleClick(t, index)}
      onContextMenu={(e) => onContextMenu(e, t, index)}
    >
      {visibleColumns.map((col) =>
        col.key === 'index' ? (
          <div key="index" className="cell index drag-handle" {...attributes} {...listeners}>
            ⠿
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

function MusicLibrary({ selectedPlaylist }) {
  const isPlaylistView = selectedPlaylist !== 'music';
  const { play, currentTrack, currentPlaylistId } = usePlayer();

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
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [contextMenu, setContextMenu] = useState(null); // { x, y, targetIds }
  const [drillStack, setDrillStack] = useState([]); // overlay drill-down stack [{ id, label, content }]
  const [playlistSubmenu, setPlaylistSubmenu] = useState(null); // [{ id, name, color, is_member }]
  const [loadKey, setLoadKey] = useState(0);
  const [playlistInfo, setPlaylistInfo] = useState(null); // { name, total_duration, track_count }
  const [activeId, setActiveId] = useState(null); // DnD active drag id
  const [sortSaved, setSortSaved] = useState(true); // false when sorted away from position order
  const [colVis, setColVis] = useState(loadColVis);
  const [colOrder, setColOrder] = useState(loadColOrder);
  const [colMenuAnchor, setColMenuAnchor] = useState(null); // { x, y } | null
  const [detailsTrack, setDetailsTrack] = useState(null);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true); // ref copy of hasMore — avoids stale closures in loadTracks
  const resetTokenRef = useRef(0); // incremented on every reset; stale fetches compare and discard
  const listRef = useRef();
  const sortedTracksRef = useRef([]);
  const lastSelectedIndexRef = useRef(null);
  const colDropdownRef = useRef(null);
  const headerRef = useRef(null);

  const visibleColumns = useMemo(
    () => colOrder.map((k) => COL_BY_KEY[k]).filter((c) => c && colVis[c.key] !== false),
    [colVis, colOrder]
  );
  const gridTemplate = useMemo(
    () => visibleColumns.map((c) => c.width).join(' '),
    [visibleColumns]
  );

  // Sync header scrollLeft to List's horizontal scroll.
  useEffect(() => {
    const listEl = listRef.current?.element;
    if (!listEl) return;
    const sync = () => {
      if (headerRef.current) headerRef.current.scrollLeft = listEl.scrollLeft;
    };
    listEl.addEventListener('scroll', sync, { passive: true });
    return () => listEl.removeEventListener('scroll', sync);
  }, [gridTemplate]); // re-attach when List remounts (key={gridTemplate})

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

      setTracks((prev) => [...prev, ...rows]);
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
      if (typeof va === 'string') return sortBy.asc ? va.localeCompare(vb) : vb.localeCompare(va);
      if (typeof va === 'number') return sortBy.asc ? va - vb : vb - va;
      return 0;
    });
    sortedTracksRef.current = sorted;
    return sorted;
  }, [tracks, sortBy]);

  useEffect(() => {
    offsetRef.current = 0;
    loadingRef.current = false;
    hasMoreRef.current = true;
    resetTokenRef.current += 1;
    setTracks([]);
    setHasMore(true);
    setSelectedIds(new Set());
    lastSelectedIndexRef.current = null;
    setSortBy({ key: 'index', asc: true }); // reset sort when switching view/search
    setSortSaved(true);

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
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, ...analysis, analyzed: 1 } : t))
      );
    });
    return unsub;
  }, []);

  // Refresh list when new tracks are imported
  useEffect(() => {
    const unsub = window.api.onLibraryUpdated(() => setLoadKey((k) => k + 1));
    return unsub;
  }, []);

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
      setSelectedIds((prev) => {
        // Re-clicking the sole selected track opens the details panel
        if (prev.size === 1 && prev.has(track.id)) {
          setDetailsTrack(track);
        }
        return new Set([track.id]);
      });
      lastSelectedIndexRef.current = index;
    }
  }, []);

  const handleDoubleClick = useCallback(
    (track, index) => {
      play(track, sortedTracksRef.current, index, isPlaylistView ? selectedPlaylist : null);
    },
    [play, isPlaylistView, selectedPlaylist]
  );

  // ── Details panel ──────────────────────────────────────────────────────────

  const handleDetailsClose = useCallback(() => setDetailsTrack(null), []);

  const handleDetailsSave = useCallback((updatedTrack) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === updatedTrack.id ? { ...t, ...updatedTrack } : t))
    );
    setDetailsTrack(updatedTrack);
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

  const handleRemove = useCallback(async () => {
    const targetIds = contextMenu?.targetIds ?? [];
    setContextMenu(null);
    for (const id of targetIds) await window.api.removeTrack(id);
    setTracks((prev) => prev.filter((t) => !targetIds.includes(t.id)));
    setSelectedIds(new Set());
    offsetRef.current = Math.max(0, offsetRef.current - targetIds.length);
  }, [contextMenu]);

  const handleRemoveFromPlaylist = useCallback(async () => {
    const targetIds = contextMenu?.targetIds ?? [];
    setContextMenu(null);
    for (const id of targetIds) {
      await window.api.removeTrackFromPlaylist(Number(selectedPlaylist), id);
    }
    setTracks((prev) => prev.filter((t) => !targetIds.includes(t.id)));
    setSelectedIds(new Set());
    offsetRef.current = Math.max(0, offsetRef.current - targetIds.length);
  }, [contextMenu, selectedPlaylist]);

  const handleAddToPlaylist = useCallback(async (playlistId, targetIds) => {
    setContextMenu(null);
    if (!targetIds?.length) return;
    try {
      await window.api.addTracksToPlaylist(playlistId, targetIds);
    } catch (err) {
      console.error('addTracksToPlaylist failed:', err);
    }
  }, []);

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

  const handleFindSimilar = useCallback((queryText) => {
    setContextMenu(null);
    setSearch(queryText);
  }, []);

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
    ({ visibleStopIndex }) => {
      if (visibleStopIndex >= sortedTracksRef.current.length - PRELOAD_TRIGGER) {
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

  // In normal mode: CSS hover fly-out.
  // In overlay mode: clicking pushes children onto drillStack (drill-down navigation).
  const SubItem = ({ id, label, children, wide }) => {
    const isOverlay = contextMenu?.overlayMode;
    if (isOverlay) {
      return (
        <div
          className="context-menu-item context-menu-item--has-submenu"
          onClick={(e) => {
            e.stopPropagation();
            setDrillStack((prev) => [...prev, { id, label, content: children }]);
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
          className={['context-submenu', wide ? 'context-submenu--wide' : '']
            .filter(Boolean)
            .join(' ')}
        >
          {children}
        </div>
      </div>
    );
  };

  return (
    <div className={`music-library${detailsTrack ? ' music-library--with-panel' : ''}`}>
      <div className="music-library__main">
        <SearchBar value={search} onChange={setSearch} />

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

        <div
          ref={headerRef}
          className="header"
          style={{ gridTemplateColumns: gridTemplate }}
          onContextMenu={(e) => {
            e.preventDefault();
            setColMenuAnchor({ x: e.clientX, y: e.clientY });
          }}
        >
          {visibleColumns.map((col) => (
            <div
              key={col.key}
              className={`header-cell ${['bpm', 'key_camelot', 'loudness', 'year', 'duration'].includes(col.key) ? 'right' : ''}`}
              onClick={() => handleSort(col.key)}
            >
              {col.label} {sortBy.key === col.key ? (sortBy.asc ? '▲' : '▼') : ''}
            </div>
          ))}
        </div>

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
              Right-click tracks in your library to add them.
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
                <div className="playlist-dnd-list">
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
                      visibleColumns={visibleColumns}
                      gridTemplate={gridTemplate}
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
              visibleColumns,
              gridTemplate,
            }}
          />
        )}

        {contextMenu && (
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
                      <div className="context-menu-item context-menu-item--disabled">
                        ➕ No playlists
                      </div>
                    ) : (
                      <SubItem id="add-to-playlist" label="➕ Add to playlist">
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

                  {/* ── Analysis submenu ── */}
                  <SubItem id="analysis" label={`🔬 Analysis${selectionLabel}`}>
                    <div className="context-menu-item" onClick={handleReanalyze}>
                      🔄 Re-analyze
                    </div>
                    <div className="context-menu-separator" />
                    <SubItem id="bpm" label="🎵 BPM">
                      <div className="context-menu-item" onClick={() => handleBpmAdjust(2)}>
                        ✕2 Double BPM
                      </div>
                      <div className="context-menu-item" onClick={() => handleBpmAdjust(0.5)}>
                        ÷2 Halve BPM
                      </div>
                    </SubItem>
                  </SubItem>

                  {/* ── Remove ── */}
                  {isPlaylistView ? (
                    <div
                      className="context-menu-item context-menu-item--danger"
                      onClick={handleRemoveFromPlaylist}
                    >
                      ➖ Remove from playlist{selectionLabel}
                    </div>
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
    </div>
  );
}

export default MusicLibrary;
