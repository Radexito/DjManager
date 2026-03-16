import { useState, useEffect, useCallback, useRef } from 'react';
import './AutoTaggerModal.css';

const APPLY_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'label', label: 'Label' },
  { key: 'year', label: 'Year' },
  { key: 'genres', label: 'Genres' },
];

function getFieldValue(result, key) {
  if (key === 'genres') return result.genres?.join(', ') ?? '';
  return result[key] != null ? String(result[key]) : '';
}

function DiffRow({ label, oldVal, options, value, onChange }) {
  const changed = value !== '' && value !== oldVal;
  return (
    <div className={`at-diff-row ${changed ? 'at-diff-row--changed' : ''}`}>
      <span className="at-diff-row__label">{label}</span>
      <span className="at-diff-row__old" title="Current value">
        {oldVal || '—'}
      </span>
      <span className="at-diff-row__arrow">→</span>
      <select
        className={`at-diff-select ${changed ? 'at-diff-select--changed' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={options.length <= 1}
      >
        {options.map((opt, i) => (
          <option key={i} value={opt.value}>
            {opt.label}
            {opt.source ? ` (${opt.source})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function AutoTaggerModal({ track, onApply, onClose }) {
  const [query, setQuery] = useState(() => [track.artist, track.title].filter(Boolean).join(' '));
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selections, setSelections] = useState({});
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.autoTagSearch(query.trim());
      if (!res.ok) throw new Error(res.error);
      setResults(res.results);
      // Pre-fill selections with first result's values where current is empty
      const init = {};
      APPLY_FIELDS.forEach(({ key }) => {
        const firstVal = res.results.find((r) => getFieldValue(r, key))
          ? getFieldValue(
              res.results.find((r) => getFieldValue(r, key)),
              key
            )
          : '';
        init[key] = firstVal;
      });
      setSelections(init);
    } catch (e) {
      setError(e.message ?? 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [query]);

  const getOptions = useCallback(
    (key) => {
      const seen = new Set(['']);
      const opts = [{ value: '', label: '— keep current —', source: '' }];
      results.forEach((r) => {
        const val = getFieldValue(r, key);
        if (val && !seen.has(val)) {
          seen.add(val);
          opts.push({ value: val, label: val, source: r.source });
        }
      });
      return opts;
    },
    [results]
  );

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

  const handleApply = useCallback(() => {
    const update = {};
    APPLY_FIELDS.forEach(({ key }) => {
      const val = selections[key];
      if (!val) return;
      if (key === 'year') {
        const n = parseInt(val, 10);
        if (n) update.year = n;
      } else if (key === 'genres') {
        const arr = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (arr.length) update.genres = JSON.stringify(arr);
      } else {
        update[key] = val;
      }
    });
    onApply(update);
  }, [selections, onApply]);

  const hasChanges = APPLY_FIELDS.some(({ key }) => {
    const val = selections[key];
    return val && val !== currentVal(key);
  });

  return (
    <div className="at-overlay" onClick={onClose}>
      <div className="at-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="at-header">
          <span className="at-header__title">🔍 Auto-tag</span>
          <button className="at-header__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Search bar */}
        <div className="at-search-bar">
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
          {loading && <div className="at-sources-label">Searching MusicBrainz &amp; Discogs…</div>}
          {error && <div className="at-error at-error--inline">{error}</div>}
        </div>

        {/* Per-field dropdowns */}
        <div className="at-diff">
          <div className="at-diff-header">
            <span className="at-diff-col">Field</span>
            <span className="at-diff-col">Current</span>
            <span className="at-diff-col at-diff-col--arrow"></span>
            <span className="at-diff-col at-diff-col--new">New value</span>
          </div>
          {APPLY_FIELDS.map(({ key, label }) => (
            <DiffRow
              key={key}
              label={label}
              oldVal={currentVal(key)}
              options={getOptions(key)}
              value={selections[key] ?? ''}
              onChange={(val) => setSelections((s) => ({ ...s, [key]: val }))}
            />
          ))}
        </div>

        {results.length === 0 && !loading && (
          <div className="at-diff-hint">Search to populate options for each field.</div>
        )}
        {results.length > 0 && (
          <div className="at-diff-hint">
            {results.length} result{results.length !== 1 ? 's' : ''} from MusicBrainz &amp; Discogs.
            Highlighted rows will be updated.
          </div>
        )}

        {/* Actions */}
        <div className="at-diff-actions">
          <button className="at-btn at-btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="at-btn at-btn--primary" onClick={handleApply} disabled={!hasChanges}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
