import { useState, useRef, useEffect } from 'react';
import {
  parseClause,
  getSuggestions,
  getOpsForField,
  isCompleteClause,
  FIELDS,
} from './searchParser.js';
import './SearchBar.css';

const FIELD_ACCENT = { bpm: '#cf9e5e', key: '#b07ecf' };
/** Chip colour for fields without a dedicated accent (BPM and key have their own). */
const DEFAULT_FIELD_ACCENT = '#7ecf7e';

const OP_LABELS = {
  is: 'is',
  'is not': 'is not',
  contains: 'contains',
  'starts with': 'starts with',
  '>': '>',
  '<': '<',
  '>=': '≥',
  '<=': '≤',
  range: 'in range',
  adjacent: 'adjacent',
  'mode switch': 'mode switch',
  matches: 'matches',
};

/** Splits a query on the "AND" keyword, keeping the separator for reassembly. */
const AND_RE = /(\s+AND\s+)/i;

/**
 * Split a query into finished clauses and the clause still being typed, so the
 * finished ones can be shown as chips and only the last one stays editable.
 *
 * @param {string} value Raw query text.
 * @returns {{ priorClauses: string[], lastClauseRaw: string }} Finished clauses and
 *   the trailing one.
 */
function splitLastClause(value) {
  if (!value) return { priorClauses: [], lastClauseRaw: '' };
  const parts = value.split(AND_RE);
  const lastClauseRaw = parts[parts.length - 1] ?? '';
  const priorClauses = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    if (parts[i] !== '') priorClauses.push(parts[i]);
  }
  return { priorClauses, lastClauseRaw };
}

/**
 * Break the clause being typed into highlighted pieces: field label, operator and
 * value, coloured by field so the user can see how the query is parsed.
 *
 * @param {string} raw Clause text after the last AND.
 * @returns {{ fieldKey: string|null, segments: { text: string, cls: string, color?: string }[] }}
 *   Detected field and the styled segments to render; fieldKey is null for free text.
 */
function tokenizeLiveClause(raw) {
  if (!raw) return { fieldKey: null, segments: [] };
  const upper = raw.toUpperCase();

  for (const [fieldKey, fieldDef] of Object.entries(FIELDS)) {
    const label = fieldDef.label;
    if (!upper.startsWith(label)) continue;
    const afterField = raw.slice(label.length);
    if (afterField.length > 0 && !/^\s/.test(afterField)) continue;

    const fieldText = raw.slice(0, label.length);
    const accent = FIELD_ACCENT[fieldKey] ?? DEFAULT_FIELD_ACCENT;
    const wsAfterField = afterField.match(/^\s*/)[0];
    const afterWs = afterField.slice(wsAfterField.length);
    const afterWsUpper = afterWs.toUpperCase();

    const ops = getOpsForField(fieldKey);
    for (const op of ops) {
      const opUpper = op.toUpperCase();
      if (!afterWsUpper.startsWith(opUpper)) continue;
      const afterOp = afterWs.slice(op.length);
      if (afterOp.length > 0 && !/^\s/.test(afterOp)) continue;

      const opText = afterWs.slice(0, op.length);
      const wsAfterOp = afterOp.match(/^\s*/)[0];
      const valueText = afterOp.slice(wsAfterOp.length);

      return {
        fieldKey,
        segments: [
          { text: fieldText, cls: 'field', color: accent },
          { text: wsAfterField, cls: 'ws' },
          { text: opText, cls: 'op' },
          { text: wsAfterOp, cls: 'ws' },
          { text: valueText, cls: 'value' },
        ].filter((s) => s.text.length > 0),
      };
    }

    return {
      fieldKey,
      segments: [
        { text: fieldText, cls: 'field', color: accent },
        { text: afterField, cls: 'plain' },
      ].filter((s) => s.text.length > 0),
    };
  }

  return { fieldKey: null, segments: [{ text: raw, cls: 'plain' }] };
}

/**
 * Display text of a filter chip's value.
 *
 * @param {object} filter Parsed filter; range filters show "from–to".
 */
function ChipValue({ filter }) {
  if (filter.op === 'range')
    return (
      <>
        {filter.from}–{filter.to}
      </>
    );
  return <>{filter.value}</>;
}

/**
 * Search input with structured query support: finished clauses are shown as chips
 * (click to edit, × to remove) while the trailing clause stays live-highlighted,
 * with a suggestion dropdown of fields, operators and values.
 *
 * @param {string} value Current query text.
 * @param {(value: string) => void} onChange Receives the updated query.
 */
export default function SearchBar({ value, onChange }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingIndex, setEditingIndex] = useState(null);
  const inputRef = useRef(null);
  const editInputRef = useRef(null);
  const cancelEditRef = useRef(false);
  const skipNextBlurRef = useRef(false);
  const editCaretRef = useRef('select');

  const { priorClauses, lastClauseRaw } = splitLastClause(value);
  const chips = priorClauses.map((raw) => {
    const filter = parseClause(raw);
    return filter && filter.field !== '_text'
      ? { kind: 'field', filter, raw }
      : { kind: 'text', raw };
  });

  const suggestions = showDropdown ? getSuggestions(value) : [];
  const { fieldKey: draftField, segments: liveSegments } = tokenizeLiveClause(lastClauseRaw);

  useEffect(() => {
    if (editingIndex === null) {
      if (editCaretRef.current === 'live-start') {
        editCaretRef.current = 'select';
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(0, 0);
      }
      return;
    }
    const el = editInputRef.current;
    if (!el) return;
    el.focus();
    if (editCaretRef.current === 'start') {
      el.setSelectionRange(0, 0);
    } else if (editCaretRef.current === 'end') {
      const len = el.value.length;
      el.setSelectionRange(len, len);
    } else {
      el.select();
    }
    editCaretRef.current = 'select';
  }, [editingIndex]);

  const handleChange = (e) => {
    const prefix = value.slice(0, value.length - lastClauseRaw.length);
    onChange(prefix + e.target.value);
    setActiveIndex(0);
    setShowDropdown(true);
  };

  const applySuggestion = (s) => {
    onChange(s.insertText);
    setActiveIndex(0);
    setShowDropdown(true);
    inputRef.current?.focus();
  };

  const handleRemoveChip = (index) => {
    const remaining = priorClauses.filter((_, i) => i !== index);
    const prefix = remaining.length ? remaining.join(' AND ') + ' AND ' : '';
    onChange(prefix + lastClauseRaw);
    inputRef.current?.focus();
  };

  const saveEdit = (index, rawText) => {
    const trimmed = rawText.trim();
    const updated = [...priorClauses];
    if (trimmed) {
      updated[index] = trimmed;
    } else {
      updated.splice(index, 1);
    }
    const prefix = updated.length ? updated.join(' AND ') + ' AND ' : '';
    onChange(prefix + lastClauseRaw);
  };

  const commitEdit = (index, rawText) => {
    saveEdit(index, rawText);
    setEditingIndex(null);
  };

  const commitClause = () => {
    onChange(value + ' AND ');
    setActiveIndex(0);
    setShowDropdown(true);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Backspace' && lastClauseRaw === '' && chips.length > 0) {
      e.preventDefault();
      handleRemoveChip(chips.length - 1);
      return;
    }

    if (
      e.key === 'ArrowLeft' &&
      chips.length > 0 &&
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0
    ) {
      e.preventDefault();
      editCaretRef.current = 'end';
      setEditingIndex(chips.length - 1);
      return;
    }

    if (e.key === ' ' && isCompleteClause(lastClauseRaw)) {
      e.preventDefault();
      commitClause();
      return;
    }

    if (showDropdown && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && suggestions[activeIndex])) {
        e.preventDefault();
        applySuggestion(suggestions[activeIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setShowDropdown(false);
        return;
      }
    }

    if (e.key === 'Tab' && lastClauseRaw.trim() !== '') {
      e.preventDefault();
      commitClause();
    }
  };

  const handleClear = () => {
    onChange('');
    setShowDropdown(false);
    inputRef.current?.focus();
  };

  return (
    <div className="search-bar">
      {}
      <div
        className="search-bar__input-row"
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {chips.map((chip, i) =>
          i === editingIndex ? (
            <input
              key={i}
              ref={editInputRef}
              className={
                (chip.kind === 'field'
                  ? `search-chip search-chip--${chip.filter.field}`
                  : 'search-chip search-chip--text') + ' search-chip__edit-input'
              }
              defaultValue={chip.raw.trim()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelEditRef.current = true;
                  e.currentTarget.blur();
                } else if (
                  e.key === 'ArrowLeft' &&
                  i > 0 &&
                  e.currentTarget.selectionStart === 0 &&
                  e.currentTarget.selectionEnd === 0
                ) {
                  e.preventDefault();
                  skipNextBlurRef.current = true;
                  saveEdit(i, e.currentTarget.value);
                  editCaretRef.current = 'end';
                  setEditingIndex(i - 1);
                } else if (
                  e.key === 'ArrowRight' &&
                  e.currentTarget.selectionStart === e.currentTarget.value.length &&
                  e.currentTarget.selectionEnd === e.currentTarget.value.length
                ) {
                  e.preventDefault();
                  skipNextBlurRef.current = true;
                  saveEdit(i, e.currentTarget.value);
                  if (i < chips.length - 1) {
                    editCaretRef.current = 'start';
                    setEditingIndex(i + 1);
                  } else {
                    editCaretRef.current = 'live-start';
                    setEditingIndex(null);
                  }
                }
              }}
              onBlur={(e) => {
                if (skipNextBlurRef.current) {
                  skipNextBlurRef.current = false;
                  return;
                }
                if (cancelEditRef.current) {
                  cancelEditRef.current = false;
                  setEditingIndex(null);
                  return;
                }
                commitEdit(i, e.target.value);
              }}
            />
          ) : (
            <span
              key={i}
              className={
                chip.kind === 'field'
                  ? `search-chip search-chip--${chip.filter.field}`
                  : 'search-chip search-chip--text'
              }
              onDoubleClick={() => setEditingIndex(i)}
            >
              {chip.kind === 'field' ? (
                <>
                  <span className="search-chip__field">
                    {FIELDS[chip.filter.field]?.label ?? chip.filter.field.toUpperCase()}
                  </span>
                  <span className="search-chip__op">
                    {OP_LABELS[chip.filter.op] ?? chip.filter.op}
                  </span>
                  <span className="search-chip__value">
                    <ChipValue filter={chip.filter} />
                  </span>
                </>
              ) : (
                <span className="search-chip__value">{chip.raw.trim()}</span>
              )}
              <button
                className="search-chip__remove"
                onClick={() => handleRemoveChip(i)}
                aria-label="Remove filter"
              >
                ×
              </button>
            </span>
          )
        )}

        <span
          className={[
            'search-bar__live-wrap',
            lastClauseRaw ? 'search-bar__live-wrap--active' : '',
            lastClauseRaw && draftField ? `search-bar__live-wrap--${draftField}` : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="search-bar__highlight" aria-hidden="true">
            {liveSegments.map((seg, i) => (
              <span
                key={i}
                className={`search-bar__hl-${seg.cls}`}
                style={seg.color ? { color: seg.color } : undefined}
              >
                {seg.text}
              </span>
            ))}
          </span>
          <input
            ref={inputRef}
            className="search-bar__input search-input"
            placeholder="Search… or try: GENRE is Techno AND BPM in range 130-140 AND KEY adjacent 8A"
            value={lastClauseRaw}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (value) setShowDropdown(true);
            }}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            spellCheck={false}
            autoComplete="off"
          />
        </span>
        {value && (
          <button className="search-bar__clear" onClick={handleClear} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {}
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
