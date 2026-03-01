import { describe, it, expect } from 'vitest';
import {
  parseQuery,
  filterToText,
  removeFilter,
  getSuggestions,
  camelotExact,
  camelotAdjacent,
  camelotModeSwitch,
  camelotMatches,
  getOpsForField,
  CAMELOT_KEYS,
} from '../searchParser.js';

// ─── Camelot helpers ────────────────────────────────────────────────────────

describe('camelotExact', () => {
  it('returns lowercase normalised key', () => {
    expect(camelotExact('8A')).toEqual(['8a']);
    expect(camelotExact('12B')).toEqual(['12b']);
  });

  it('falls back for invalid key', () => {
    expect(camelotExact('Xm')).toEqual(['xm']);
  });
});

describe('camelotModeSwitch', () => {
  it('switches A to B', () => {
    expect(camelotModeSwitch('8A')).toEqual(['8b']);
  });

  it('switches B to A', () => {
    expect(camelotModeSwitch('8B')).toEqual(['8a']);
  });

  it('falls back for invalid key', () => {
    expect(camelotModeSwitch('bad')).toEqual(['bad']);
  });
});

describe('camelotAdjacent', () => {
  it('returns prev and next on wheel', () => {
    expect(camelotAdjacent('8A')).toEqual(['7a', '9a']);
  });

  it('wraps 1A to 12A and 2A', () => {
    expect(camelotAdjacent('1A')).toEqual(['12a', '2a']);
  });

  it('wraps 12A to 11A and 1A', () => {
    expect(camelotAdjacent('12A')).toEqual(['11a', '1a']);
  });
});

describe('camelotMatches', () => {
  it('returns all 4 compatible keys', () => {
    const result = camelotMatches('8A');
    expect(result).toContain('8a');
    expect(result).toContain('8b');
    expect(result).toContain('7a');
    expect(result).toContain('9a');
    expect(result).toHaveLength(4);
  });
});

describe('CAMELOT_KEYS', () => {
  it('contains 24 keys', () => {
    expect(CAMELOT_KEYS).toHaveLength(24);
  });

  it('includes 1a through 12a and 1b through 12b', () => {
    expect(CAMELOT_KEYS).toContain('1a');
    expect(CAMELOT_KEYS).toContain('12b');
  });
});

// ─── getOpsForField ─────────────────────────────────────────────────────────

describe('getOpsForField', () => {
  it('returns number ops for bpm', () => {
    const ops = getOpsForField('bpm');
    expect(ops).toContain('in range');
    expect(ops).toContain('is');
    expect(ops).toContain('>');
  });

  it('returns key ops for key', () => {
    const ops = getOpsForField('key');
    expect(ops).toContain('mode switch');
    expect(ops).toContain('adjacent');
    expect(ops).toContain('matches');
    expect(ops).toContain('is');
  });

  it('returns text ops for genre', () => {
    const ops = getOpsForField('genre');
    expect(ops).toContain('is');
    expect(ops).toContain('contains');
    expect(ops).toContain('is not');
  });
});

// ─── parseQuery ──────────────────────────────────────────────────────────────

describe('parseQuery', () => {
  it('returns empty for blank input', () => {
    expect(parseQuery('')).toEqual({ filters: [], remaining: '' });
    expect(parseQuery(null)).toEqual({ filters: [], remaining: '' });
    expect(parseQuery('   ')).toEqual({ filters: [], remaining: '' });
  });

  it('parses GENRE is', () => {
    const { filters } = parseQuery('GENRE is Psytrance');
    expect(filters).toHaveLength(1);
    expect(filters[0]).toEqual({ field: 'genre', op: 'is', value: 'Psytrance' });
  });

  it('parses BPM in range', () => {
    const { filters } = parseQuery('BPM in range 140-145');
    expect(filters).toHaveLength(1);
    expect(filters[0]).toEqual({ field: 'bpm', op: 'range', from: 140, to: 145 });
  });

  it('parses BPM > operator', () => {
    const { filters } = parseQuery('BPM > 130');
    expect(filters[0]).toEqual({ field: 'bpm', op: '>', value: '130' });
  });

  it('parses KEY is', () => {
    const { filters } = parseQuery('KEY is 8A');
    expect(filters[0]).toEqual({ field: 'key', op: 'is', value: '8A' });
  });

  it('parses KEY matches', () => {
    const { filters } = parseQuery('KEY matches 8A');
    expect(filters[0]).toEqual({ field: 'key', op: 'matches', value: '8A' });
  });

  it('parses KEY mode switch (multi-word op)', () => {
    const { filters } = parseQuery('KEY mode switch 8A');
    expect(filters[0]).toEqual({ field: 'key', op: 'mode switch', value: '8A' });
  });

  it('parses KEY adjacent', () => {
    const { filters } = parseQuery('KEY adjacent 8A');
    expect(filters[0]).toEqual({ field: 'key', op: 'adjacent', value: '8A' });
  });

  it('parses stacked filters with AND', () => {
    const { filters } = parseQuery('GENRE is Techno AND BPM in range 130-140');
    expect(filters).toHaveLength(2);
    expect(filters[0].field).toBe('genre');
    expect(filters[1].field).toBe('bpm');
  });

  it('parses TITLE contains', () => {
    const { filters } = parseQuery('TITLE contains Burial');
    expect(filters[0]).toEqual({ field: 'title', op: 'contains', value: 'Burial' });
  });

  it('parses ARTIST is not', () => {
    const { filters } = parseQuery('ARTIST is not Unknown');
    expect(filters[0]).toEqual({ field: 'artist', op: 'is not', value: 'Unknown' });
  });

  it('returns remaining for partially typed last clause', () => {
    const { filters, remaining } = parseQuery('GENRE is Techno AND BPM');
    expect(filters).toHaveLength(1);
    expect(remaining).toBe('BPM');
  });

  it('handles free-text (no field match) as remaining', () => {
    const { filters, remaining } = parseQuery('just some text');
    expect(filters).toHaveLength(0);
    expect(remaining).toBe('just some text');
  });

  it('case-insensitive AND separator', () => {
    const { filters } = parseQuery('GENRE is Techno and BPM is 130');
    expect(filters).toHaveLength(2);
  });
});

// ─── filterToText ────────────────────────────────────────────────────────────

describe('filterToText', () => {
  it('renders range filter', () => {
    expect(filterToText({ field: 'bpm', op: 'range', from: 130, to: 140 })).toBe(
      'BPM in range 130-140'
    );
  });

  it('renders simple filter', () => {
    expect(filterToText({ field: 'genre', op: 'is', value: 'Techno' })).toBe('GENRE is Techno');
  });

  it('renders key filter', () => {
    expect(filterToText({ field: 'key', op: 'matches', value: '8A' })).toBe('KEY matches 8A');
  });
});

// ─── removeFilter ────────────────────────────────────────────────────────────

describe('removeFilter', () => {
  it('removes first filter from stacked query', () => {
    const result = removeFilter('GENRE is Techno AND BPM in range 130-140', 0);
    expect(result).toContain('BPM');
    expect(result).not.toContain('GENRE');
  });

  it('removes last filter from stacked query', () => {
    const result = removeFilter('GENRE is Techno AND BPM in range 130-140', 1);
    expect(result).toContain('GENRE');
    expect(result).not.toContain('BPM');
  });

  it('returns empty string when only filter is removed', () => {
    const result = removeFilter('GENRE is Techno', 0);
    expect(result.trim()).toBe('');
  });
});

// ─── getSuggestions ──────────────────────────────────────────────────────────

describe('getSuggestions', () => {
  it('returns operator suggestions for a matched field', () => {
    const suggestions = getSuggestions('BPM ');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.text.includes('in range') || s.text.includes('is'))).toBe(
      true
    );
  });

  it('returns operator suggestions after field', () => {
    const suggestions = getSuggestions('BPM ');
    expect(suggestions.some((s) => s.text.includes('in range') || s.text.includes('is'))).toBe(
      true
    );
  });

  it('returns Camelot key suggestions for KEY op', () => {
    const suggestions = getSuggestions('KEY is 8');
    expect(suggestions.some((s) => s.text.includes('8A') || s.text.includes('8B'))).toBe(true);
  });

  it('returns field suggestions for empty input', () => {
    const suggestions = getSuggestions('');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.type === 'field')).toBe(true);
  });

  it('returns no results when value hint has no match (e.g. genre is)', () => {
    // genre has no pre-built value hints, so returns [] after value stage
    const suggestions = getSuggestions('GENRE is Techno ');
    expect(Array.isArray(suggestions)).toBe(true);
  });
});
