import { useState, useRef } from 'react';
import {
  parseQuery,
  getSuggestions,
  filterToText,
  removeFilter,
  FIELDS,
  CAMELOT_KEYS,
} from './searchParser.js';
import './SearchBar.css';

const OP_LABELS = {
  is: 'is',
  'is not': 'is not',
  contains: 'contains',
  '>': '>',
  '<': '<',
  '>=': '≥',
  '<=': '≤',
  range: 'in range',
  adjacent: 'adjacent',
  'mode switch': 'mode switch',
  matches: 'matches',
};

function ChipValue({ filter }) {
  if (filter.op === 'range')
    return (
      <>
        {filter.from}–{filter.to}
      </>
    );
  return <>{filter.value}</>;
}

export default function SearchBar({ value, onChange }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);

  const { filters } = parseQuery(value);
  const structuredFilters = filters.filter((f) => f.field !== '_text');

  // Suggestions are keyed to the full current input value
  const suggestions = showDropdown ? getSuggestions(value) : [];

  // ── event handlers ──────────────────────────────────────────────────────────

  const handleChange = (e) => {
    onChange(e.target.value);
    setActiveIndex(0);
    setShowDropdown(true);
  };
  const applySuggestion = (s) => {
    onChange(s.insertText);
    setActiveIndex(0);
    setShowDropdown(true);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (!showDropdown || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Tab' || (e.key === 'Enter' && suggestions[activeIndex])) {
      e.preventDefault();
      applySuggestion(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  };

  const handleRemove = (index) => {
    onChange(removeFilter(value, index));
    inputRef.current?.focus();
  };

  const handleClear = () => {
    onChange('');
    setShowDropdown(false);
    inputRef.current?.focus();
  };

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <div className="search-bar">
      {/* ── parsed filter chips ── */}
      {structuredFilters.length > 0 && (
        <div className="search-bar__chips">
          {structuredFilters.map((filter, i) => (
            <span key={i} className={`search-chip search-chip--${filter.field}`}>
              <span className="search-chip__field">
                {FIELDS[filter.field]?.label ?? filter.field.toUpperCase()}
              </span>
              <span className="search-chip__op">{OP_LABELS[filter.op] ?? filter.op}</span>
              <span className="search-chip__value">
                <ChipValue filter={filter} />
              </span>
              <button
                className="search-chip__remove"
                onClick={() => handleRemove(i)}
                aria-label="Remove filter"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── text input row ── */}
      <div className="search-bar__input-row">
        <input
          ref={inputRef}
          className="search-bar__input"
          placeholder="Search… or try: GENRE is Techno AND BPM in range 130-140 AND KEY adjacent 8A"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (value) setShowDropdown(true);
          }}
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          spellCheck={false}
          autoComplete="off"
        />
        {value && (
          <button className="search-bar__clear" onClick={handleClear} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {/* ── autocomplete dropdown ── */}
      {showDropdown && suggestions.length > 0 && (
        <ul className="search-dropdown" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={i}
              role="option"
              aria-selected={i === activeIndex}
              className={[
                'search-dropdown__item',
                `search-dropdown__item--${s.type}`,
                i === activeIndex ? 'search-dropdown__item--active' : '',
              ].join(' ')}
              onMouseDown={() => applySuggestion(s)}
            >
              <span className="search-dropdown__text">{s.text}</span>
              {s.description && <span className="search-dropdown__desc">{s.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
