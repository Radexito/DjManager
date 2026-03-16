import { useState, useEffect, useCallback, useRef } from 'react';
import './AutoTaggerModal.css';

const SOURCES = ['MusicBrainz', 'Discogs'];

// Fields we can apply from a search result to the track form
const APPLY_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'label', label: 'Label' },
  { key: 'year', label: 'Year' },
  { key: 'genres', label: 'Genres' },
];

function ResultCard({ result, onSelect }) {
  return (
    <button className="at-result-card" onClick={() => onSelect(result)}>
      <div className="at-result-card__title">{result.title || '—'}</div>
      <div className="at-result-card__artist">{result.artist || '—'}</div>
      <div className="at-result-card__meta">
        {[result.album, result.label, result.year].filter(Boolean).join(' · ')}
      </div>
      {result.genres.length > 0 && (
        <div className="at-result-card__genres">{result.genres.join(', ')}</div>
      )}
      {result.url && <div className="at-result-card__source">{result.source}</div>}
    </button>
  );
}

function DiffRow({ label, oldVal, newVal }) {
  const changed = oldVal !== newVal && newVal !== '';
  return (
    <div className={`at-diff-row ${changed ? 'at-diff-row--changed' : ''}`}>
      <span className="at-diff-row__label">{label}</span>
      <span className="at-diff-row__old" title="Current value">
        {oldVal || '—'}
      </span>
      <span className="at-diff-row__arrow">→</span>
      <span className={`at-diff-row__new ${changed ? 'at-diff-row__new--changed' : ''}`}>
        {newVal || '—'}
      </span>
    </div>
  );
}

export default function AutoTaggerModal({ track, onApply, onClose }) {
  const [source, setSource] = useState('MusicBrainz');
  const [query, setQuery] = useState(() => [track.artist, track.title].filter(Boolean).join(' '));
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null);
        else onClose();
      }
    },
    [onClose, selected]
  );
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setSelected(null);
    try {
      const res = await window.api.autoTagSearch(query.trim(), source);
      if (!res.ok) throw new Error(res.error);
      setResults(res.results);
    } catch (e) {
      setError(e.message ?? 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [query, source]);

  const handleApply = useCallback(() => {
    if (!selected) return;
    // Build update object — only include non-empty result fields
    const update = {};
    if (selected.title) update.title = selected.title;
    if (selected.artist) update.artist = selected.artist;
    if (selected.album) update.album = selected.album;
    if (selected.label) update.label = selected.label;
    if (selected.year) update.year = parseInt(selected.year, 10) || null;
    if (selected.genres.length > 0) update.genres = JSON.stringify(selected.genres);
    onApply(update);
  }, [selected, onApply]);

  // Format current track field for display in diff
  function currentVal(key) {
    if (key === 'genres') {
      try {
        return JSON.parse(track.genres ?? '[]').join(', ');
      } catch {
        return track.genres ?? '';
      }
    }
    return track[key] != null ? String(track[key]) : '';
  }

  function resultVal(key) {
    if (key === 'genres') return selected?.genres?.join(', ') ?? '';
    return selected?.[key] != null ? String(selected[key]) : '';
  }

  return (
    <div className="at-overlay" onClick={selected ? undefined : onClose}>
      <div className="at-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="at-header">
          <span className="at-header__title">
            {selected ? '📋 Preview Changes' : '🔍 Auto-tag'}
          </span>
          <button className="at-header__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {!selected && (
          <>
            {/* Search bar */}
            <div className="at-search-bar">
              <div className="at-source-toggle">
                {SOURCES.map((s) => (
                  <button
                    key={s}
                    className={`at-source-btn ${source === s ? 'at-source-btn--active' : ''}`}
                    onClick={() => setSource(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="at-search-input-row">
                <input
                  ref={inputRef}
                  className="at-search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && search()}
                  placeholder="Artist - Title"
                />
                <button className="at-search-btn" onClick={search} disabled={loading}>
                  {loading ? '…' : 'Search'}
                </button>
              </div>
            </div>

            {/* Results */}
            <div className="at-results">
              {error && <div className="at-error">{error}</div>}
              {loading && <div className="at-loading">Searching {source}…</div>}
              {results !== null && results.length === 0 && (
                <div className="at-empty">No results found.</div>
              )}
              {results?.map((r, i) => (
                <ResultCard key={i} result={r} onSelect={setSelected} />
              ))}
            </div>
          </>
        )}

        {selected && (
          <>
            {/* Diff preview */}
            <div className="at-diff">
              <div className="at-diff-header">
                <span className="at-diff-col">Field</span>
                <span className="at-diff-col">Current</span>
                <span className="at-diff-col at-diff-col--arrow"></span>
                <span className="at-diff-col at-diff-col--new">New</span>
              </div>
              {APPLY_FIELDS.map(({ key, label }) => (
                <DiffRow key={key} label={label} oldVal={currentVal(key)} newVal={resultVal(key)} />
              ))}
            </div>
            <div className="at-diff-hint">Only highlighted rows will be updated.</div>

            {/* Actions */}
            <div className="at-diff-actions">
              <button className="at-btn at-btn--secondary" onClick={() => setSelected(null)}>
                ← Back
              </button>
              <button className="at-btn at-btn--primary" onClick={handleApply}>
                Apply
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
