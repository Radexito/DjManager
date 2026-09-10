import { useState, useRef, useEffect } from 'react';
import {
  parseClause,
  getSuggestions,
  getOpsForField,
  isCompleteClause,
  FIELDS,
} from './searchParser.js';
import './SearchBar.css';

// Field accent colors, matched to the .search-chip--{field} rules in SearchBar.css
const FIELD_ACCENT = { bpm: '#cf9e5e', key: '#b07ecf' };
const DEFAULT_FIELD_ACCENT = '#7ecf7e';

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

// Splits the query on " AND " while keeping the delimiter, so every character
// of `value` is accounted for. Everything before the last delimiter is a
// "confirmed" clause rendered as a removable chip; the last clause is always
// the live, plain-text portion that stays in the real input — even once it
// happens to parse into a valid filter — so a clause only locks into a chip
// once the user deliberately moves on to a new one (types "AND").
const AND_RE = /(\s+AND\s+)/i;

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

// Tokenizes the clause currently being typed into colorable segments, so the
// live input can be highlighted the same way a committed chip would be —
// without waiting for " AND " to lock it in. Segment text is never trimmed or
// reordered: concatenating every segment's `text` reproduces `raw` exactly,
// which keeps the invisible input's characters aligned with the highlight
// overlay drawn behind it.
function tokenizeLiveClause(raw) {
  if (!raw) return { fieldKey: null, segments: [] };
  const upper = raw.toUpperCase();

  for (const [fieldKey, fieldDef] of Object.entries(FIELDS)) {
    const label = fieldDef.label;
    if (!upper.startsWith(label)) continue;
    const afterField = raw.slice(label.length);
    // require whitespace after label so "ARTIST" doesn't match "ART"
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

    // Field matched but no complete operator yet — color the field, leave the rest plain.
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
  const [editingIndex, setEditingIndex] = useState(null);
  const inputRef = useRef(null);
  const editInputRef = useRef(null);
  const cancelEditRef = useRef(false);
  const skipNextBlurRef = useRef(false);
  // 'select' | 'start' | 'end' | 'live-start' — where the caret should land
  // the next time editingIndex changes, consumed once by the effect below.
  const editCaretRef = useRef('select');

  const { priorClauses, lastClauseRaw } = splitLastClause(value);
  const chips = priorClauses.map((raw) => {
    const filter = parseClause(raw);
    return filter && filter.field !== '_text'
      ? { kind: 'field', filter, raw }
      : { kind: 'text', raw };
  });

  // Suggestions are keyed to the full current input value
  const suggestions = showDropdown ? getSuggestions(value) : [];
  const { fieldKey: draftField, segments: liveSegments } = tokenizeLiveClause(lastClauseRaw);

  // Places focus/caret whenever editingIndex changes — covers double-click
  // entry as well as arrow-key navigation between chips (and back out into
  // the live input), which move editingIndex programmatically.
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

  // ── event handlers ──────────────────────────────────────────────────────────

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

  // Double-clicking a committed chip re-opens it as editable text. Committing
  // (blur, Enter, or Tab) rewrites just that clause in place; clearing it out
  // entirely removes the chip, same as the × button. Split from commitEdit so
  // arrow-key navigation can save the current chip and move editingIndex to
  // an adjacent one in the same gesture, without the "close to null" step.
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

  // Locks the current live clause in as its own block, same as if the user
  // had typed " AND " — a fresh empty clause starts right after.
  const commitClause = () => {
    onChange(value + ' AND ');
    setActiveIndex(0);
    setShowDropdown(true);
  };

  const handleKeyDown = (e) => {
    // Backspace on an empty live clause deletes the last confirmed chip.
    if (e.key === 'Backspace' && lastClauseRaw === '' && chips.length > 0) {
      e.preventDefault();
      handleRemoveChip(chips.length - 1);
      return;
    }

    // ArrowLeft at the very start of the live input steps back into the
    // last committed chip, opening it for editing with the caret at its end.
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

    // Space auto-commits the clause once it's unambiguous (a complete
    // number, range, or Camelot key) — text values can contain spaces
    // mid-typing, so those only commit via " AND " or Tab.
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

    // Tab with nothing left to autocomplete commits whatever's typed as its
    // own block — a structured filter chip, or a free-text chip.
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

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <div className="search-bar">
      {/* ── text input row ── */}
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
