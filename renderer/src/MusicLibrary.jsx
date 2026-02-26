import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { FixedSizeList as List } from 'react-window';
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
import './MusicLibrary.css';

const PAGE_SIZE = 50;
const ROW_HEIGHT = 50;
const PRELOAD_TRIGGER = 3;

// ── LibraryRow — outside MusicLibrary so react-window doesn't remount on re-render ──
function LibraryRow({ index, style, data }) {
  const { tracks, selectedIds, currentTrackId, onRowClick, onDoubleClick, onContextMenu } = data;
  const t = tracks[index];
  if (!t) {
    return (
      <div style={style} className="row row-loading">
        Loading more tracks...
      </div>
    );
  }
  const isSelected = selectedIds.has(t.id);
  const isPlaying = currentTrackId === t.id;
  const bpmValue = t.bpm_override ?? t.bpm;
  return (
    <div
      style={style}
      className={`row ${index % 2 === 0 ? 'row-even' : 'row-odd'}${isSelected ? ' row--selected' : ''}${isPlaying ? ' row--playing' : ''}`}
      title={`${t.title} - ${t.artist || 'Unknown'}`}
      onClick={(e) => onRowClick(e, t, index)}
      onDoubleClick={() => onDoubleClick(t, index)}
      onContextMenu={(e) => onContextMenu(e, t, index)}
    >
      <div className="cell index">{index + 1}</div>
      <div className="cell title">{t.title}</div>
      <div className="cell artist">{t.artist || 'Unknown'}</div>
      <div className={`cell numeric${t.bpm_override != null ? ' bpm--overridden' : ''}`}>
        {bpmValue ?? '...'}
      </div>
      <div className="cell numeric">{t.key_camelot ?? '...'}</div>
      <div className="cell numeric">{t.loudness != null ? t.loudness : '...'}</div>
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
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: t.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const bpmValue = t.bpm_override ?? t.bpm;
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
      <div className="cell index drag-handle" {...attributes} {...listeners}>
        ⠿
      </div>
      <div className="cell title">{t.title}</div>
      <div className="cell artist">{t.artist || 'Unknown'}</div>
      <div className={`cell numeric${t.bpm_override != null ? ' bpm--overridden' : ''}`}>
        {bpmValue ?? '...'}
      </div>
      <div className="cell numeric">{t.key_camelot ?? '...'}</div>
      <div className="cell numeric">{t.loudness != null ? t.loudness : '...'}</div>
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
  const [playlistSubmenu, setPlaylistSubmenu] = useState(null); // [{ id, name, color, is_member }]
  const [loadKey, setLoadKey] = useState(0);
  const [playlistInfo, setPlaylistInfo] = useState(null); // { name, total_duration, track_count }
  const [activeId, setActiveId] = useState(null); // DnD active drag id
  const [sortSaved, setSortSaved] = useState(true); // false when sorted away from position order

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true); // ref copy of hasMore — avoids stale closures in loadTracks
  const resetTokenRef = useRef(0); // incremented on every reset; stale fetches compare and discard
  const listRef = useRef();
  const sortedTracksRef = useRef([]);
  const lastSelectedIndexRef = useRef(null);

  const columns = [
    { key: 'index', label: '#', width: '5%' },
    { key: 'title', label: 'Title', width: '35%' },
    { key: 'artist', label: 'Artist', width: '28%' },
    { key: 'bpm', label: 'BPM', width: '10%' },
    { key: 'key_camelot', label: 'Key', width: '8%' },
    { key: 'loudness', label: 'Loudness (LUFS)', width: '14%' },
  ];

  const [sortBy, setSortBy] = useState({ key: 'index', asc: true });

  const loadTracks = useCallback(async () => {
    if (loadingRef.current || !hasMoreRef.current) return;

    loadingRef.current = true;
    const token = resetTokenRef.current;

    try {
      const rows = await window.api.getTracks({
        limit: PAGE_SIZE,
        offset: offsetRef.current,
        search,
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

  // Ctrl+A — select all tracks including unloaded ones
  useEffect(() => {
    const onKeyDown = async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const ids = await window.api.getTrackIds({
          search,
          playlistId: selectedPlaylist !== 'music' ? selectedPlaylist : undefined,
        });
        setSelectedIds(new Set(ids));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [search, selectedPlaylist]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
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
    }
  }, []);

  const handleDoubleClick = useCallback(
    (track, index) => {
      play(track, sortedTracksRef.current, index, isPlaylistView ? selectedPlaylist : null);
    },
    [play, isPlaylistView, selectedPlaylist]
  );

  // ── Context menu ───────────────────────────────────────────────────────────

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
      setContextMenu({ x: e.clientX, y: e.clientY, targetIds });
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

  return (
    <div className="music-library">
      <input
        className="search-input"
        placeholder="Search title / artist / album"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

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

      <div className="header">
        {columns.map((col) => (
          <div
            key={col.key}
            className={`header-cell ${['bpm', 'key_camelot', 'loudness'].includes(col.key) ? 'right' : ''}`}
            onClick={() => handleSort(col.key)}
          >
            {col.label} {sortBy.key === col.key ? (sortBy.asc ? '▲' : '▼') : ''}
          </div>
        ))}
      </div>

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
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeTrack && (
                <div className="row row-drag-overlay">
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
          ref={listRef}
          height={600}
          itemCount={sortedTracks.length + (hasMore ? 1 : 0)}
          itemSize={ROW_HEIGHT}
          width="100%"
          onItemsRendered={handleItemsRendered}
          className="track-list"
          itemData={{
            tracks: sortedTracks,
            selectedIds,
            currentTrackId: playingTrackId,
            onRowClick: handleRowClick,
            onDoubleClick: handleDoubleClick,
            onContextMenu: handleContextMenu,
          }}
        >
          {LibraryRow}
        </List>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={handleReanalyze}>
            🔄 Re-analyze{selectionLabel}
          </div>
          <div className="context-menu-item context-menu-item--has-submenu">
            🎵 BPM{selectionLabel}
            <div className="context-submenu">
              <div className="context-menu-item" onClick={() => handleBpmAdjust(2)}>
                ✕2 Double BPM
              </div>
              <div className="context-menu-item" onClick={() => handleBpmAdjust(0.5)}>
                ÷2 Halve BPM
              </div>
            </div>
          </div>
          {isPlaylistView ? (
            <div
              className="context-menu-item context-menu-item--danger"
              onClick={handleRemoveFromPlaylist}
            >
              ➖ Remove from playlist{selectionLabel}
            </div>
          ) : (
            <div className="context-menu-item context-menu-item--danger" onClick={handleRemove}>
              🗑️ Remove from library{selectionLabel}
            </div>
          )}
          <div className="context-menu-separator" />
          {/* Add to Playlist submenu */}
          {playlistSubmenu !== null &&
            (playlistSubmenu.length === 0 ? (
              <div className="context-menu-item context-menu-item--disabled">➕ No playlists</div>
            ) : (
              <div className="context-menu-item context-menu-item--has-submenu">
                ➕ Add to playlist
                <div className="context-submenu">
                  {playlistSubmenu.map((pl) => (
                    <div
                      key={pl.id}
                      className={`context-menu-item${pl.is_member ? ' context-menu-item--checked' : ''}`}
                      onClick={() =>
                        !pl.is_member && handleAddToPlaylist(pl.id, contextMenu?.targetIds ?? [])
                      }
                    >
                      {pl.color && (
                        <span className="ctx-color-dot" style={{ background: pl.color }} />
                      )}
                      {pl.is_member ? '✓ ' : ''}
                      {pl.name}
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default MusicLibrary;
