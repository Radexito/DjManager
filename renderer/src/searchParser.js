// ─── Field definitions ────────────────────────────────────────────────────────

export const FIELDS = {
  title: { type: 'text', label: 'TITLE' },
  artist: { type: 'text', label: 'ARTIST' },
  album: { type: 'text', label: 'ALBUM' },
  label: { type: 'text', label: 'LABEL' },
  genre: { type: 'text', label: 'GENRE' },
  bpm: { type: 'number', label: 'BPM' },
  key: { type: 'key', label: 'KEY' },
  loudness: { type: 'number', label: 'LOUDNESS' },
  year: { type: 'number', label: 'YEAR' },
  rating: { type: 'number', label: 'RATING' },
  duration: { type: 'number', label: 'DURATION' },
};

const TEXT_OPS = ['is not', 'is', 'contains'];
const NUM_OPS = ['in range', '>=', '<=', '>', '<', 'is'];
// longest first so the parser greedily matches "mode switch" before "mode"
const KEY_OPS = ['mode switch', 'adjacent', 'matches', 'is'];

export function getOpsForField(fieldKey) {
  const t = FIELDS[fieldKey]?.type;
  if (t === 'number') return NUM_OPS;
  if (t === 'key') return KEY_OPS;
  return TEXT_OPS;
}

// ─── Camelot helpers ──────────────────────────────────────────────────────────

/** Returns all 24 valid Camelot keys in lowercase (1a…12a, 1b…12b). */
export const CAMELOT_KEYS = [
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}a`),
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}b`),
];

function parseCamelot(key) {
  const m = String(key)
    .trim()
    .match(/^(\d+)([aAbB])$/);
  if (!m) return null;
  return { n: parseInt(m[1], 10), letter: m[2].toUpperCase() };
}

/** Exact key (normalised). */
export function camelotExact(key) {
  const c = parseCamelot(key);
  return c ? [`${c.n}${c.letter}`.toLowerCase()] : [key.toLowerCase()];
}

/** Same number, opposite letter — minor ↔ major atmosphere shift. */
export function camelotModeSwitch(key) {
  const c = parseCamelot(key);
  if (!c) return [key.toLowerCase()];
  const other = c.letter === 'A' ? 'B' : 'A';
  return [`${c.n}${other}`.toLowerCase()];
}

/** ±1 on the wheel, same letter — energy boost / drop. */
export function camelotAdjacent(key) {
  const c = parseCamelot(key);
  if (!c) return [key.toLowerCase()];
  const prev = c.n === 1 ? 12 : c.n - 1;
  const next = c.n === 12 ? 1 : c.n + 1;
  return [`${prev}${c.letter}`.toLowerCase(), `${next}${c.letter}`.toLowerCase()];
}

/** All four compatible keys (exact + adjacent + mode switch). */
export function camelotMatches(key) {
  return [...camelotExact(key), ...camelotModeSwitch(key), ...camelotAdjacent(key)];
}

// ─── Single-clause parser ─────────────────────────────────────────────────────

/**
 * Parse one clause like "BPM in range 140-145" → Filter object.
 * Returns null when the clause is empty or doesn't start with a known field.
 * Returns { field: '_text', ... } for unstructured text.
 */
function parseClause(clause) {
  const c = clause.trim();
  if (!c) return null;

  for (const [fieldKey, fieldDef] of Object.entries(FIELDS)) {
    const label = fieldDef.label; // e.g. "BPM"
    if (!c.toUpperCase().startsWith(label)) continue;

    const afterField = c.slice(label.length);
    // require whitespace after label so "ARTIST" doesn't match "ART"
    if (afterField.length > 0 && !/^\s/.test(afterField)) continue;
    const rest = afterField.trim();
    if (!rest) continue;

    const ops = getOpsForField(fieldKey); // already sorted longest-first
    for (const op of ops) {
      if (!rest.toLowerCase().startsWith(op.toLowerCase())) continue;
      const afterOp = rest.slice(op.length);
      if (afterOp.length > 0 && !/^\s/.test(afterOp)) continue;
      const value = afterOp.trim();
      if (!value) continue;

      if (op === 'in range') {
        const m = value.match(/^(-?\d+\.?\d*)\s*[-–]\s*(-?\d+\.?\d*)$/);
        if (!m) continue;
        return { field: fieldKey, op: 'range', from: Number(m[1]), to: Number(m[2]) };
      }

      return { field: fieldKey, op, value };
    }
  }

  // No structured match — free-text fallback
  return { field: '_text', op: 'contains', value: c };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse the full query string.
 *
 * "GENRE is Psytrance AND BPM in range 140-145"
 *   → { filters: [{field:'genre',op:'is',value:'Psytrance'}, {field:'bpm',op:'range',from:140,to:145}], remaining: '' }
 *
 * The last clause is returned as `remaining` when it hasn't been fully typed yet
 * (i.e. it parses as free-text but earlier clauses were structured).
 */
export function parseQuery(queryText) {
  if (!queryText?.trim()) return { filters: [], remaining: '' };

  const parts = queryText.split(/\s+AND\s+/i);
  const filters = [];

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const filter = parseClause(parts[i]);
    if (!filter) continue;

    if (filter.field === '_text') {
      if (!isLast) filters.push(filter); // mid-query free-text kept as-is
      // last free-text part = still being typed; becomes `remaining`
    } else {
      filters.push(filter);
    }
  }

  const lastParsed = parseClause(parts[parts.length - 1]);
  const remaining = !lastParsed || lastParsed.field === '_text' ? parts[parts.length - 1] : '';

  return { filters, remaining };
}

/** Convert a filter back to its display string. */
export function filterToText(f) {
  const label = FIELDS[f.field]?.label ?? f.field.toUpperCase();
  if (f.op === 'range') return `${label} in range ${f.from}-${f.to}`;
  return `${label} ${f.op} ${f.value}`;
}

/** Remove the filter at `index` and return the updated query string. */
export function removeFilter(queryText, index) {
  const { filters } = parseQuery(queryText);
  return filters
    .filter((_, i) => i !== index)
    .map(filterToText)
    .join(' AND ');
}

// ─── Autocomplete suggestions ─────────────────────────────────────────────────

/**
 * Returns contextual suggestions for what the user is currently typing.
 * Each suggestion: { type: 'field'|'operator'|'value'|'hint', text, insertText, description? }
 */
export function getSuggestions(queryText) {
  // Work on the clause being typed (after the last AND)
  const andParts = queryText.split(/\s+AND\s+/i);
  const current = andParts[andParts.length - 1];
  const currentTrimUp = current.trim().toUpperCase();
  const prefix = andParts
    .slice(0, -1)
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' AND ');

  const full = (clauseSuffix) => (prefix ? `${prefix} AND ${clauseSuffix}` : clauseSuffix);

  // ── Check if we already have a field token ────────────────────────────────
  let matchedField = null;
  let afterField = '';
  for (const [key, def] of Object.entries(FIELDS)) {
    const label = def.label;
    if (currentTrimUp === label || currentTrimUp.startsWith(label + ' ')) {
      matchedField = [key, def];
      afterField = current.trim().slice(label.length).trim();
      break;
    }
  }

  if (matchedField) {
    const [fieldKey, fieldDef] = matchedField;
    const ops = getOpsForField(fieldKey);
    const afterLow = afterField.toLowerCase();

    // ── Check if we already have an operator token ───────────────────────
    const matchedOp = ops.find(
      (op) => afterLow === op.toLowerCase() || afterLow.startsWith(op.toLowerCase() + ' ')
    );

    if (matchedOp) {
      const clauseBase = `${fieldDef.label} ${matchedOp} `;
      return getValueHints(fieldKey, matchedOp, full(clauseBase));
    }

    // Suggest operators filtered by what's been typed so far
    const clauseBase = fieldDef.label + ' ';
    return ops
      .filter((op) => afterField === '' || op.toLowerCase().startsWith(afterLow))
      .map((op) => ({
        type: 'operator',
        text: op,
        insertText: full(clauseBase + op + ' '),
        description: opDescription(fieldKey, op),
      }));
  }

  // ── Suggest field names ───────────────────────────────────────────────────
  return Object.entries(FIELDS)
    .filter(([, def]) => currentTrimUp === '' || def.label.startsWith(currentTrimUp))
    .map(([key, def]) => ({
      type: 'field',
      text: def.label,
      insertText: full(def.label + ' '),
    }));
}

function opDescription(fieldKey, op) {
  if (fieldKey === 'key') {
    const map = {
      is: 'exact key match',
      adjacent: '±1 on wheel — energy shift',
      'mode switch': 'minor ↔ major — atmosphere',
      matches: 'all compatible keys',
    };
    return map[op];
  }
  if (op === 'in range') return 'e.g. 130-140';
  return undefined;
}

function getValueHints(fieldKey, op, base) {
  if (fieldKey === 'key') {
    const desc = {
      is: 'exact — e.g. 8A',
      adjacent: 'energy shift — e.g. 8A',
      'mode switch': 'atmosphere — e.g. 8A',
      matches: 'all compatible — e.g. 8A',
    };
    return CAMELOT_KEYS.map((k) => ({
      type: 'value',
      text: k.toUpperCase(),
      insertText: base + k.toUpperCase(),
      description: desc[op],
    }));
  }

  const hints = {
    bpm: { 'in range': '130-140', is: '128', '>': '130', '<': '140', '>=': '128', '<=': '140' },
    loudness: { 'in range': '-10--6', is: '-8', '>': '-10', '<': '-6' },
    year: { 'in range': '2020-2024', is: '2024', '>': '2020' },
    rating: { 'in range': '3-5', is: '5', '>=': '4' },
    duration: { '>': '180', '<': '300', 'in range': '180-300' },
  };

  const hint = hints[fieldKey]?.[op];
  if (!hint) return [];
  return [{ type: 'hint', text: hint, insertText: base + hint, description: `e.g. ${hint}` }];
}
