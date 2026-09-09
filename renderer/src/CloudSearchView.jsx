import { useState, useEffect, useCallback, useRef } from 'react';
import './CloudSearchView.css';

const SOURCES = [
  { id: 'youtube', label: 'YouTube', icon: '▶️' },
  { id: 'tidal', label: 'TIDAL', icon: '🌊' },
];

const TIDAL_TYPES = [
  { id: 'track', label: 'Track' },
  { id: 'album', label: 'Album' },
  { id: 'playlist', label: 'Playlist' },
];

function fmtDuration(secs) {
  if (!secs && secs !== 0) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function resultKey(r) {
  return `${r.source}:${r.id}`;
}

// Column set is derived from the *displayed* results' source/type, not the current
// form controls — the user may change the type dropdown after a search completes.
function getColumns(source, type) {
  if (source === 'youtube') {
    return [
      {
        key: 'title',
        label: 'Title',
        width: 'minmax(200px, 3fr)',
        className: 'cloud-search-title',
        render: (r) => r.title,
      },
      {
        key: 'duration',
        label: 'Duration',
        width: '80px',
        render: (r) => fmtDuration(r.durationSec),
      },
    ];
  }
  if (type === 'album') {
    return [
      {
        key: 'title',
        label: 'Title',
        width: 'minmax(160px, 2fr)',
        className: 'cloud-search-title',
        render: (r) => r.title,
      },
      {
        key: 'artist',
        label: 'Artist',
        width: 'minmax(100px, 1fr)',
        className: 'cloud-search-cell--ellipsis',
        tooltip: true,
        render: (r) => r.artist || '—',
      },
      { key: 'tracks', label: 'Tracks', width: '70px', render: (r) => r.numTracks ?? '—' },
      { key: 'length', label: 'Length', width: '80px', render: (r) => fmtDuration(r.durationSec) },
    ];
  }
  if (type === 'playlist') {
    return [
      {
        key: 'title',
        label: 'Title',
        width: 'minmax(160px, 2fr)',
        className: 'cloud-search-title',
        render: (r) => r.title,
      },
      { key: 'tracks', label: 'Tracks', width: '70px', render: (r) => r.numTracks ?? '—' },
      { key: 'length', label: 'Length', width: '80px', render: (r) => fmtDuration(r.durationSec) },
    ];
  }
  // 'track' (tidal)
  return [
    {
      key: 'title',
      label: 'Title',
      width: 'minmax(160px, 2fr)',
      className: 'cloud-search-title',
      render: (r) => r.title,
    },
    {
      key: 'artist',
      label: 'Artist',
      width: 'minmax(100px, 1fr)',
      className: 'cloud-search-cell--ellipsis',
      tooltip: true,
      render: (r) => r.artist || '—',
    },
    {
      key: 'album',
      label: 'Album',
      width: 'minmax(100px, 1fr)',
      className: 'cloud-search-cell--ellipsis',
      tooltip: true,
      render: (r) => r.album || '—',
    },
    {
      key: 'duration',
      label: 'Duration',
      width: '70px',
      render: (r) => fmtDuration(r.durationSec),
    },
  ];
}

export default function CloudSearchView({ onGoToLibrary, onGoToTidalSetup, style }) {
  const [source, setSource] = useState('youtube');
  const [tidalType, setTidalType] = useState('track');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [tidalSetup, setTidalSetup] = useState(null); // null = unknown | { installed, loggedIn }
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState(new Map()); // key -> 'pending'|'downloading'|'done'|'failed'
  const [downloadError, setDownloadError] = useState(null);
  const [downloadDone, setDownloadDone] = useState(false);
  const inputRef = useRef(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    window.api.tidalCheck?.().then(setTidalSetup);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    setSelected(new Set());
    setDownloadStatus(new Map());
    setDownloadError(null);
    setDownloadDone(false);
    try {
      const res = await window.api.cloudSearch({
        source,
        query: q,
        types: source === 'tidal' ? [tidalType] : undefined,
        limit: 25,
      });
      if (seq !== searchSeq.current) return; // stale response — a newer search started
      if (!res.ok) {
        setSearchError(res.error || 'Search failed');
        setResults([]);
      } else {
        setResults(res.results);
      }
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setSearchError(e.message ?? 'Search failed');
      setResults([]);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [query, source, tidalType]);

  const handleSubmit = (e) => {
    e.preventDefault();
    runSearch();
  };

  const toggleSelected = (r) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = resultKey(r);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) =>
      prev.size === results.length ? new Set() : new Set(results.map(resultKey))
    );
  };

  const selectedResults = results.filter((r) => selected.has(resultKey(r)));

  const handleDownload = async () => {
    if (selectedResults.length === 0 || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    setDownloadDone(false);
    const statuses = new Map(selectedResults.map((r) => [resultKey(r), 'pending']));
    setDownloadStatus(new Map(statuses));

    const byYoutube = selectedResults.filter((r) => r.source === 'youtube');
    const byTidal = selectedResults.filter((r) => r.source === 'tidal');

    // YouTube results are independent videos — download one at a time, reusing
    // the same IPC channel the URL-paste flow uses.
    for (const r of byYoutube) {
      const k = resultKey(r);
      statuses.set(k, 'downloading');
      setDownloadStatus(new Map(statuses));
      try {
        const res = await window.api.ytDlpDownloadUrl({ url: r.url });
        statuses.set(k, res.ok ? 'done' : 'failed');
      } catch {
        statuses.set(k, 'failed');
      }
      setDownloadStatus(new Map(statuses));
    }

    // TIDAL supports a batch of selectedEntries in a single call, but an album/playlist
    // result's `id` is the album/playlist id, not a track id — it must be expanded into
    // its individual track entries first, the same way TidalDownloadView does, or the
    // download URLs built from it point at nonexistent tracks.
    if (byTidal.length > 0) {
      for (const r of byTidal) statuses.set(resultKey(r), 'downloading');
      setDownloadStatus(new Map(statuses));

      const trackEntries = [];
      let expansionError = null;
      for (const r of byTidal) {
        if (r.type === 'track') {
          trackEntries.push({ id: r.id, title: r.title, artist: r.artist });
          continue;
        }
        try {
          const info = await window.api.tidalFetchInfo(r.url);
          if (!info.ok) {
            expansionError = info.error || `Failed to expand ${r.type} "${r.title}"`;
            statuses.set(resultKey(r), 'failed');
            continue;
          }
          for (const entry of info.entries ?? []) {
            trackEntries.push({ id: entry.id, title: entry.title, artist: entry.artist });
          }
        } catch (e) {
          expansionError = e.message ?? `Failed to expand ${r.type} "${r.title}"`;
          statuses.set(resultKey(r), 'failed');
        }
      }
      setDownloadStatus(new Map(statuses));

      if (trackEntries.length > 0) {
        try {
          const res = await window.api.tidalDownloadUrl({
            url: byTidal[0].url,
            selectedEntries: trackEntries,
          });
          for (const r of byTidal) {
            if (statuses.get(resultKey(r)) === 'failed') continue;
            statuses.set(resultKey(r), res.ok ? 'done' : 'failed');
          }
          if (!res.ok) setDownloadError(res.error || 'TIDAL download failed');
        } catch (e) {
          for (const r of byTidal) {
            if (statuses.get(resultKey(r)) !== 'failed') statuses.set(resultKey(r), 'failed');
          }
          setDownloadError(e.message ?? 'TIDAL download failed');
        }
      } else if (expansionError) {
        setDownloadError(expansionError);
      }
      setDownloadStatus(new Map(statuses));
    }

    setDownloading(false);
    if ([...statuses.values()].some((s) => s === 'done')) {
      setDownloadDone(true);
    }
  };

  const tidalUnavailable =
    source === 'tidal' && tidalSetup && (!tidalSetup.installed || !tidalSetup.loggedIn);

  return (
    <div className="cloud-search-view" style={style}>
      <div className="cloud-search-header">
        <h2>Cloud Search</h2>
        <p className="cloud-search-subtitle">
          Search YouTube or TIDAL by keyword and download straight into your library.
        </p>
      </div>

      <div className="cloud-search-source-toggle">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            className={`cloud-search-source-btn${source === s.id ? ' active' : ''}`}
            onClick={() => setSource(s.id)}
            type="button"
          >
            <span>{s.icon}</span> {s.label}
          </button>
        ))}
      </div>

      <form className="cloud-search-bar" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          className="cloud-search-input"
          type="text"
          placeholder={`Search ${source === 'youtube' ? 'YouTube' : 'TIDAL'}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {source === 'tidal' && (
          <select
            className="cloud-search-type-select"
            value={tidalType}
            onChange={(e) => setTidalType(e.target.value)}
          >
            {TIDAL_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        <button
          className="cloud-search-submit-btn"
          type="submit"
          disabled={!query.trim() || searching || tidalUnavailable}
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {tidalUnavailable && (
        <div className="cloud-search-notice">
          {!tidalSetup.installed
            ? 'TIDAL is not set up yet.'
            : 'You need to log in to TIDAL first.'}{' '}
          <button
            className="cloud-search-link-btn"
            type="button"
            onClick={() => onGoToTidalSetup?.()}
          >
            Go to the TIDAL tab
          </button>
        </div>
      )}

      {searchError && <div className="cloud-search-error">{searchError}</div>}
      {downloadError && <div className="cloud-search-error">{downloadError}</div>}
      {downloadDone && !downloading && (
        <div className="cloud-search-notice">
          Download finished.{' '}
          <button className="cloud-search-link-btn" type="button" onClick={() => onGoToLibrary?.()}>
            Go to Library
          </button>
        </div>
      )}

      {results.length > 0 &&
        (() => {
          const columns = getColumns(results[0]?.source, results[0]?.type);
          const gridTemplateColumns = `28px ${columns.map((c) => c.width).join(' ')} 20px`;
          return (
            <div className="cloud-search-results">
              <div className="cloud-search-results-header">
                <label className="cloud-search-select-all">
                  <input
                    type="checkbox"
                    checked={selected.size === results.length && results.length > 0}
                    onChange={toggleSelectAll}
                  />
                  Select all ({results.length})
                </label>
                <button
                  className="cloud-search-download-btn"
                  type="button"
                  disabled={selectedResults.length === 0 || downloading}
                  onClick={handleDownload}
                >
                  {downloading ? 'Downloading…' : `Download Selected (${selectedResults.length})`}
                </button>
              </div>

              <div className="cloud-search-table">
                <div
                  className="cloud-search-row cloud-search-row--head"
                  style={{ gridTemplateColumns }}
                >
                  <span />
                  {columns.map((c) => (
                    <span key={c.key}>{c.label}</span>
                  ))}
                  <span />
                </div>
                {results.map((r) => {
                  const k = resultKey(r);
                  const status = downloadStatus.get(k);
                  return (
                    <div
                      key={k}
                      className={`cloud-search-row${selected.has(k) ? ' cloud-search-row--selected' : ''}`}
                      style={{ gridTemplateColumns }}
                      onClick={() => toggleSelected(r)}
                    >
                      <span onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(k)}
                          onChange={() => toggleSelected(r)}
                        />
                      </span>
                      {columns.map((c) => (
                        <span
                          key={c.key}
                          className={c.className}
                          title={c.tooltip ? c.render(r) : undefined}
                        >
                          {c.render(r)}
                        </span>
                      ))}
                      <span
                        className={
                          status ? `cloud-search-status cloud-search-status--${status}` : ''
                        }
                      >
                        {status ? (status === 'done' ? '✓' : status === 'failed' ? '✗' : '⋯') : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

      {!searching && results.length === 0 && !searchError && query.trim() && (
        <div className="cloud-search-empty">No results yet — press Search.</div>
      )}
    </div>
  );
}
