import { useCallback, useEffect, useMemo, useState } from 'react';
import './TidalCollectionsPanel.css';

// Group order mirrors tidal-dl-ng's own collection tree.
const GROUP_ORDER = ['playlists', 'mixes', 'favorites'];

const GROUP_LABELS = {
  playlists: 'Playlists',
  mixes: 'Mixes & Radio',
  favorites: 'Favorites',
};

function groupRank(group) {
  const idx = GROUP_ORDER.indexOf(group);
  return idx === -1 ? GROUP_ORDER.length : idx;
}

/** Stable key for one collection row (ids are only unique per type). */
function collectionKey(col) {
  return `${col.type}:${col.id}`;
}

/**
 * Tree panel listing the logged-in TIDAL account's collections (playlists,
 * mixes & radio including My Daily Discovery and video mixes, favorites) with
 * a download action per collection. Loads through window.api.tidalListCollections.
 *
 * Branches start expanded: the user asked for the account tree, and collapsing
 * is remembered per branch in the local `collapsed` set.
 */
export default function TidalCollectionsPanel({ onDownload, busyKey, disabled = false }) {
  const [collections, setCollections] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.tidalListCollections();
      if (!res?.ok) {
        setError(res?.error ?? 'Could not load your TIDAL collections.');
        setCollections([]);
        setWarnings([]);
      } else {
        setCollections(res.collections ?? []);
        setWarnings(res.warnings ?? []);
      }
    } catch (err) {
      setError(err?.message ?? 'Could not load your TIDAL collections.');
      setCollections([]);
      setWarnings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const col of collections ?? []) {
      const list = byGroup.get(col.group) ?? [];
      list.push(col);
      byGroup.set(col.group, list);
    }
    return [...byGroup.entries()]
      .sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
      .map(([key, items]) => ({
        key,
        label: GROUP_LABELS[key] ?? key,
        items,
      }));
  }, [collections]);

  const isOpen = useCallback((key) => !collapsed.has(key), [collapsed]);

  const toggle = useCallback((key) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const renderNode = (col, depth) => {
    const key = collectionKey(col);
    const children = (collections ?? []).filter((c) => c.parentId === col.id);
    const open = isOpen(key);
    const busy = busyKey === key;

    return (
      <div key={key} className="tidal-tree-branch">
        <div
          className={`tidal-tree-node${depth > 0 ? ' tidal-tree-node--child' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <button
            type="button"
            className="tidal-tree-toggle"
            onClick={() => children.length > 0 && toggle(key)}
            disabled={children.length === 0}
            aria-expanded={children.length > 0 ? open : undefined}
            aria-label={open ? `Collapse ${col.title}` : `Expand ${col.title}`}
          >
            {children.length === 0 ? '·' : open ? '▾' : '▸'}
          </button>
          <button
            type="button"
            className="tidal-tree-label"
            onClick={() => children.length > 0 && toggle(key)}
            title={col.subtitle || col.title}
          >
            <span className="tidal-tree-title">{col.title}</span>
            {col.subtitle ? <span className="tidal-tree-subtitle">{col.subtitle}</span> : null}
          </button>
          {col.count > 0 ? <span className="tidal-tree-count">{col.count}</span> : null}
          <button
            type="button"
            className="tidal-tree-download"
            onClick={() => onDownload(col)}
            disabled={disabled || busy}
            title={`Download ${col.title}`}
            aria-label={`Download ${col.title}`}
          >
            {busy ? '…' : '↓'}
          </button>
        </div>
        {children.length > 0 && open ? (
          <div className="tidal-tree-children">
            {children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="tidal-collections">
      <div className="tidal-collections-head">
        <span className="tidal-collections-title">My collections</span>
        <button
          type="button"
          className="tidal-collections-reload"
          onClick={load}
          disabled={loading}
        >
          Reload
        </button>
      </div>

      {loading ? (
        <div className="tidal-collections-status">Loading collections…</div>
      ) : error ? (
        <div className="dl-fetch-error" style={{ padding: '4px 12px 8px' }}>
          ✗ {error}
        </div>
      ) : groups.length === 0 ? (
        <div className="tidal-collections-status">No collections found on this account.</div>
      ) : (
        <div className="tidal-tree" role="tree">
          {groups.map((group) => {
            const groupKey = `group:${group.key}`;
            const groupOpen = !collapsed.has(groupKey);
            return (
              <div key={group.key} className="tidal-tree-group">
                <button
                  type="button"
                  className="tidal-tree-group-head"
                  onClick={() => toggle(groupKey)}
                  aria-expanded={groupOpen}
                >
                  <span className="tidal-tree-caret">{groupOpen ? '▾' : '▸'}</span>
                  <span className="tidal-tree-group-title">{group.label}</span>
                  <span className="tidal-tree-count">{group.items.length}</span>
                </button>
                {groupOpen ? (
                  <div className="tidal-tree-children">
                    {group.items.filter((col) => !col.parentId).map((col) => renderNode(col, 0))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {!loading && !error && warnings.length > 0 && (
        <div className="tidal-collections-status" title={warnings.join('\n')}>
          Some collections could not be loaded ({warnings.length}).
        </div>
      )}

      {!loading && !error && groups.length > 0 && (
        <div className="tidal-collections-note">
          Downloading a collection adds its tracks to a playlist of the same name.
        </div>
      )}
    </div>
  );
}
