import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { List } from 'react-window';
import './FileExplorerView.css';

const ROW_HEIGHT = 36;
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.opus',
  '.wv',
]);

function isAudio(name) {
  return AUDIO_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase());
}

// ── Breadcrumbs ───────────────────────────────────────────────────────────────

function getBreadcrumbs(currentPath) {
  if (!currentPath) return [];
  const isWin = /^[A-Za-z]:/.test(currentPath);
  if (isWin) {
    const parts = currentPath.split('\\').filter(Boolean);
    const crumbs = [];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}\\${part}` : `${part}\\`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  const parts = currentPath.split('/').filter(Boolean);
  const crumbs = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

// ── Context menu ──────────────────────────────────────────────────────────────

function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="explorer-context-menu"
      style={{ position: 'fixed', left: x, top: y, zIndex: 9999 }}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="explorer-context-separator" />
        ) : (
          <button
            key={i}
            className="explorer-context-item"
            onClick={() => {
              item.action();
              onClose();
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div className="explorer-toast">{message}</div>;
}

// ── Row component (must be outside to avoid remounts) ────────────────────────

function ExplorerRow({ index, style, ariaAttributes, rowProps }) {
  const { items, linkedPaths, selectedPaths, onSelect, onOpen, onContextMenu } = rowProps;
  const item = items[index];
  if (!item) return <div style={style} />;

  const isSelected = selectedPaths.has(item.path);
  const isLinked = item.type === 'file' && linkedPaths.has(item.path);

  return (
    <div
      {...ariaAttributes}
      style={style}
      className={`explorer-row${isSelected ? ' selected' : ''}${item.type === 'dir' ? ' dir' : ''}`}
      onClick={(e) => onSelect(e, item)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => onContextMenu(e, item)}
    >
      <span className="explorer-row-icon">
        {item.type === 'dir' ? '📁' : isLinked ? '🔗' : '🎵'}
      </span>
      <span className="explorer-row-name">{item.name}</span>
      {item.type === 'file' && item.size != null && (
        <span className="explorer-row-size">{(item.size / 1024 / 1024).toFixed(1)} MB</span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FileExplorerView({ style }) {
  const [fsRoot, setFsRoot] = useState(null);
  const [homeDir, setHomeDir] = useState(null);
  const [currentPath, setCurrentPath] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [linkedPaths, setLinkedPaths] = useState(new Set());
  const [playlists, setPlaylists] = useState([]);
  const [contextMenu, setContextMenu] = useState(null);
  const [toast, setToast] = useState(null);
  const [recursiveFiles, setRecursiveFiles] = useState(null); // null = off, [] = scanning
  const [recursiveScanning, setRecursiveScanning] = useState(false);
  const listRef = useRef();
  const containerRef = useRef();
  const [listHeight, setListHeight] = useState(500);
  const lastClickIndex = useRef(null);

  const showToast = useCallback((msg) => setToast(msg), []);

  // Init
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

  // Resize observer for list height
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) setListHeight(entry.contentRect.height);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Load directory
  useEffect(() => {
    if (!currentPath || !fsRoot) return;
    setLoading(true);
    setError(null);
    setSelectedPaths(new Set());
    setRecursiveFiles(null);
    setRecursiveScanning(false);
    window.api.explorerCancelRecursive();
    window.api
      .browseDirectory(currentPath)
      .then(({ dirs: d, files: f, error: e }) => {
        if (e) setError(e);
        setDirs(d ?? []);
        setFiles(f ?? []);
        // Refresh linked status
        if (f?.length) {
          window.api.getTracksByPaths(f.map((x) => x.path)).then((tracks) => {
            setLinkedPaths(new Set(tracks.map((t) => t.file_path)));
          });
        } else {
          setLinkedPaths(new Set());
        }
      })
      .finally(() => setLoading(false));
  }, [currentPath, fsRoot]);

  // Recursive batch events
  useEffect(() => {
    const unsubBatch = window.api.onExplorerRecursiveBatch((batch) => {
      setRecursiveFiles((prev) => [...(prev ?? []), ...batch]);
    });
    const unsubDone = window.api.onExplorerRecursiveDone(() => {
      setRecursiveScanning(false);
    });
    return () => {
      unsubBatch();
      unsubDone();
    };
  }, []);

  const displayItems = useMemo(() => {
    if (recursiveFiles !== null) {
      return recursiveFiles.map((f) => ({ ...f, type: 'file' }));
    }
    return [
      ...dirs.map((d) => ({ ...d, type: 'dir' })),
      ...files.map((f) => ({ ...f, type: 'file' })),
    ];
  }, [dirs, files, recursiveFiles]);

  const navigateTo = useCallback((p) => {
    setCurrentPath(p);
    lastClickIndex.current = null;
  }, []);

  const handleOpen = useCallback(
    (item) => {
      if (item.type === 'dir') navigateTo(item.path);
    },
    [navigateTo]
  );

  const handleSelect = useCallback(
    (e, item) => {
      const idx = displayItems.findIndex((x) => x.path === item.path);
      if (e.shiftKey && lastClickIndex.current != null) {
        const lo = Math.min(lastClickIndex.current, idx);
        const hi = Math.max(lastClickIndex.current, idx);
        const range = new Set(displayItems.slice(lo, hi + 1).map((x) => x.path));
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          range.forEach((p) => next.add(p));
          return next;
        });
      } else if (e.ctrlKey || e.metaKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(item.path)) next.delete(item.path);
          else next.add(item.path);
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

  const selectedFilePaths = useMemo(() => {
    return displayItems
      .filter((x) => x.type === 'file' && selectedPaths.has(x.path))
      .map((x) => x.path);
  }, [displayItems, selectedPaths]);

  const selectedDirPaths = useMemo(() => {
    return displayItems
      .filter((x) => x.type === 'dir' && selectedPaths.has(x.path))
      .map((x) => x.path);
  }, [displayItems, selectedPaths]);

  const linkSelected = useCallback(
    async (playlistId = null) => {
      if (!selectedFilePaths.length) return;
      const results = await window.api.linkAudioFiles(selectedFilePaths, playlistId);
      const linked = results.filter((r) => !r.duplicate).length;
      showToast(`Linked ${linked} track(s)`);
      setLinkedPaths((prev) => {
        const next = new Set(prev);
        results.forEach((r) => {
          if (r.id) next.add(selectedFilePaths[results.indexOf(r)]);
        });
        return next;
      });
    },
    [selectedFilePaths, showToast]
  );

  const linkDir = useCallback(
    async (dirPath, recursive, playlistId = null) => {
      const res = await window.api.linkDirectory(dirPath, recursive, playlistId);
      showToast(`Linked ${res.linked}/${res.total} tracks`);
    },
    [showToast]
  );

  const handleContextMenu = useCallback(
    (e, item) => {
      e.preventDefault();
      if (!selectedPaths.has(item.path)) {
        setSelectedPaths(new Set([item.path]));
        lastClickIndex.current = displayItems.findIndex((x) => x.path === item.path);
      }

      const playlistItems = playlists.map((pl) => ({
        label: `  Add to "${pl.name}"`,
        action: () => {
          if (item.type === 'file') {
            window.api.linkAudioFiles([item.path], pl.id).then(() => showToast('Added'));
          } else {
            linkDir(item.path, false, pl.id);
          }
        },
      }));

      let items = [];

      if (item.type === 'file') {
        const isLinked = linkedPaths.has(item.path);
        items = [
          {
            label: isLinked ? '✓ Already in library' : 'Add to library',
            action: () => !isLinked && linkSelected(null),
          },
          'separator',
          { label: 'Add to playlist ▸', action: () => {} },
          ...playlistItems,
          'separator',
          {
            label: 'Remap broken link…',
            action: async () => {
              const tracks = await window.api.getTracksByPaths([item.path]);
              if (!tracks.length) {
                showToast('Not in library');
                return;
              }
              const res = await window.api.remapTrack(tracks[0].id, item.path);
              showToast(res.ok ? 'Remapped' : 'Remap failed');
            },
          },
        ];
      } else {
        items = [
          { label: 'Import folder (flat)', action: () => linkDir(item.path, false, null) },
          { label: 'Import folder (recursive)', action: () => linkDir(item.path, true, null) },
          'separator',
          {
            label: 'Import as playlist (flat)',
            action: async () => {
              const pl = await window.api.createPlaylist(item.name);
              linkDir(item.path, false, pl.id);
            },
          },
          {
            label: 'Import as playlist (recursive)',
            action: async () => {
              const pl = await window.api.createPlaylist(item.name);
              linkDir(item.path, true, pl.id);
            },
          },
          'separator',
          { label: 'Add to playlist ▸', action: () => {} },
          ...playlistItems,
          'separator',
          {
            label: 'Remap broken folder…',
            action: async () => {
              const res = await window.api.remapFolder(item.path);
              showToast(res.ok ? `Remapped ${res.count} track(s)` : 'Remap failed');
            },
          },
        ];
      }

      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [selectedPaths, displayItems, playlists, linkedPaths, linkSelected, linkDir, showToast]
  );

  const toggleRecursive = useCallback(() => {
    if (recursiveScanning) {
      window.api.explorerCancelRecursive();
      setRecursiveScanning(false);
      return;
    }
    if (recursiveFiles !== null) {
      setRecursiveFiles(null);
      return;
    }
    setRecursiveFiles([]);
    setRecursiveScanning(true);
    window.api.explorerStartRecursive(currentPath);
  }, [recursiveFiles, recursiveScanning, currentPath]);

  const breadcrumbs = useMemo(() => getBreadcrumbs(currentPath), [currentPath]);

  const rowProps = useMemo(
    () => ({
      items: displayItems,
      linkedPaths,
      selectedPaths,
      onSelect: handleSelect,
      onOpen: handleOpen,
      onContextMenu: handleContextMenu,
    }),
    [displayItems, linkedPaths, selectedPaths, handleSelect, handleOpen, handleContextMenu]
  );

  const canLinkSelected = selectedFilePaths.length > 0;

  return (
    <div className="explorer-view" style={style}>
      {/* Toolbar */}
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
                : 'Scan recursively'
          }
          onClick={toggleRecursive}
        >
          {recursiveScanning ? '⏳' : '🔍'}
        </button>
        {canLinkSelected && (
          <button className="explorer-btn accent" onClick={() => linkSelected(null)}>
            + Library ({selectedFilePaths.length})
          </button>
        )}
      </div>

      {/* Breadcrumb path for recursive view */}
      {recursiveFiles !== null && (
        <div className="explorer-recursive-banner">
          Recursive view of <strong>{currentPath}</strong>
          {recursiveScanning && ' — scanning…'}
          {!recursiveScanning && ` — ${recursiveFiles.length} file(s)`}
        </div>
      )}

      {/* File list */}
      <div className="explorer-list-container" ref={containerRef}>
        {loading && <div className="explorer-empty">Loading…</div>}
        {!loading && error && <div className="explorer-empty error">{error}</div>}
        {!loading && !error && displayItems.length === 0 && (
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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
