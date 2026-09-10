// src/__tests__/trackTrim.test.js
// Unit tests for the pure trim math (#463) — no Electron, no SQLite.
import { describe, it, expect } from 'vitest';
import {
  clampTrimRange,
  trackTrimRange,
  trimColumns,
  shiftBeatgridForTrim,
  shiftCuePointsForTrim,
} from '../audio/trackTrim.js';

const MIN = 60_000; // 1 minute

describe('clampTrimRange — clamping to [0, duration]', () => {
  it('returns null when neither side is set (no trim)', () => {
    expect(clampTrimRange(null, null, MIN)).toBeNull();
    expect(clampTrimRange(undefined, undefined, MIN)).toBeNull();
  });

  it('treats garbage input as "not set"', () => {
    expect(clampTrimRange('abc', null, MIN)).toBeNull();
    expect(clampTrimRange(null, NaN, MIN)).toBeNull();
    expect(clampTrimRange(Infinity, null, MIN)).toBeNull();
  });

  it('clamps a negative trim start to 0', () => {
    expect(clampTrimRange(-5000, 30_000, MIN)).toEqual({ startMs: 0, endMs: 30_000 });
  });

  it('clamps a trim end past the file to the duration', () => {
    expect(clampTrimRange(20_000, 90_000, MIN)).toEqual({ startMs: 20_000, endMs: MIN });
  });

  it('keeps a fully inside range unchanged', () => {
    expect(clampTrimRange(10_000, 50_000, MIN)).toEqual({ startMs: 10_000, endMs: 50_000 });
  });

  it('defaults an unset end to the file end', () => {
    expect(clampTrimRange(10_000, null, MIN)).toEqual({ startMs: 10_000, endMs: MIN });
  });

  it('defaults an unset start to 0', () => {
    expect(clampTrimRange(null, 40_000, MIN)).toEqual({ startMs: 0, endMs: 40_000 });
  });

  it('returns null for a range that covers the whole file (no trim needed)', () => {
    expect(clampTrimRange(0, MIN, MIN)).toBeNull();
    expect(clampTrimRange(0, 99_999, MIN)).toBeNull();
    // start of 0 with no end = play everything
    expect(clampTrimRange(0, null, MIN)).toBeNull();
  });

  it('rounds fractional milliseconds', () => {
    expect(clampTrimRange('10000.4', '40000.6', MIN)).toEqual({ startMs: 10_000, endMs: 40_001 });
  });
});

describe('clampTrimRange — trim-in must stay before trim-out', () => {
  it('rejects an inverted range', () => {
    expect(clampTrimRange(40_000, 20_000, MIN)).toBeNull();
  });

  it('rejects an empty range (start === end)', () => {
    expect(clampTrimRange(30_000, 30_000, MIN)).toBeNull();
  });

  it('rejects a range that only becomes empty after clamping', () => {
    // start beyond the file clamps down onto the clamped end -> nothing left
    expect(clampTrimRange(70_000, 80_000, MIN)).toBeNull();
    expect(clampTrimRange(MIN, null, MIN)).toBeNull();
  });

  it('rejects a start-only trim when the duration is unknown', () => {
    expect(clampTrimRange(30_000, null, 0)).toBeNull();
  });
});

describe('trackTrimRange — reading trim off a track row', () => {
  it('reads the millisecond columns using duration in seconds', () => {
    const track = { duration: 120, trim_start_ms: 30_000, trim_end_ms: 90_000 };
    expect(trackTrimRange(track)).toEqual({ startMs: 30_000, endMs: 90_000 });
  });

  it('returns null for a track without trim columns', () => {
    expect(trackTrimRange({ duration: 120 })).toBeNull();
    expect(trackTrimRange(null)).toBeNull();
  });

  it('returns null when the stored range is invalid or covers everything', () => {
    expect(
      trackTrimRange({ duration: 120, trim_start_ms: 90_000, trim_end_ms: 30_000 })
    ).toBeNull();
    expect(trackTrimRange({ duration: 120, trim_start_ms: 0, trim_end_ms: null })).toBeNull();
  });

  it('clamps a stored end past the duration', () => {
    expect(trackTrimRange({ duration: 60, trim_start_ms: 10_000, trim_end_ms: 90_000 })).toEqual({
      startMs: 10_000,
      endMs: 60_000,
    });
  });
});

describe('trimColumns — serialization round trip', () => {
  it('maps a fully specified range onto the DB columns', () => {
    expect(trimColumns(30_000, 90_000, 120_000)).toEqual({
      trim_start_ms: 30_000,
      trim_end_ms: 90_000,
    });
  });

  it('keeps an unset side NULL instead of pinning it to the file duration', () => {
    expect(trimColumns(30_000, null, 120_000)).toEqual({
      trim_start_ms: 30_000,
      trim_end_ms: null,
    });
    expect(trimColumns(null, 90_000, 120_000)).toEqual({
      trim_start_ms: null,
      trim_end_ms: 90_000,
    });
  });

  it('clears both columns when nothing is set or the range is unusable', () => {
    expect(trimColumns(null, null, 120_000)).toEqual({ trim_start_ms: null, trim_end_ms: null });
    expect(trimColumns(90_000, 30_000, 120_000)).toEqual({
      trim_start_ms: null,
      trim_end_ms: null,
    });
    expect(trimColumns(0, 120_000, 120_000)).toEqual({ trim_start_ms: null, trim_end_ms: null });
  });

  it('clamps what the user set and rounds it', () => {
    expect(trimColumns(-1000, 100_000, 120_000)).toEqual({
      trim_start_ms: 0,
      trim_end_ms: 100_000,
    });
    expect(trimColumns(10_000.4, 999_999, 120_000)).toEqual({
      trim_start_ms: 10_000,
      trim_end_ms: 120_000,
    });
    // clamping both sides onto the file bounds leaves no trim at all
    expect(trimColumns(-1000, 120_000, 120_000)).toEqual({
      trim_start_ms: null,
      trim_end_ms: null,
    });
  });

  it('round-trips a saved range back through the columns unchanged', () => {
    const durationMs = 180_000;
    for (const [rawStart, rawEnd] of [
      [30_000, 120_000],
      [-1000, 60_000],
      [45_000, durationMs + 5000],
      [12_000, null],
      [null, 150_000],
    ]) {
      const columns = trimColumns(rawStart, rawEnd, durationMs);
      const track = { duration: durationMs / 1000, ...columns };
      expect(trackTrimRange(track)).toEqual(clampTrimRange(rawStart, rawEnd, durationMs));
    }
  });

  it('round-trips a cleared trim back to null', () => {
    const track = { duration: 120, ...trimColumns(null, null, 120_000) };
    expect(trackTrimRange(track)).toBeNull();
  });
});

describe('shiftBeatgridForTrim — re-basing the grid onto the trimmed timeline', () => {
  it('shifts numeric beats back by the trim start and drops the rest', () => {
    // beats at 1s..5s, trim = 2s..4s -> 0,1,2 inside the range
    expect(shiftBeatgridForTrim('[1,2,3,4,5]', 2000, 4000)).toBe('[0,1,2]');
  });

  it('shifts object beats keeping their field name', () => {
    const input = JSON.stringify([{ position: 1.5 }, { position: 3 }, { position: 7 }]);
    expect(shiftBeatgridForTrim(input, 2000, 9000)).toBe(
      JSON.stringify([{ position: 1 }, { position: 5 }])
    );
  });

  it('handles time/offset shaped entries', () => {
    const input = JSON.stringify([{ time: 4 }, { offset: 5 }]);
    expect(shiftBeatgridForTrim(input, 3000, 9000)).toBe(
      JSON.stringify([{ time: 1 }, { offset: 2 }])
    );
  });

  it('returns the input untouched when there is nothing to shift', () => {
    expect(shiftBeatgridForTrim('[1,2,3]', 0, null)).toBe('[1,2,3]');
    expect(shiftBeatgridForTrim('[1,2,3]', null, null)).toBe('[1,2,3]');
    expect(shiftBeatgridForTrim(null, 1000, 5000)).toBeNull();
  });

  it('leaves malformed JSON to the writer fallback', () => {
    expect(shiftBeatgridForTrim('not json', 1000, 5000)).toBe('not json');
  });

  it('drops every beat when none falls inside the range', () => {
    expect(shiftBeatgridForTrim('[10,20,30]', 1000, 2000)).toBe('[]');
  });
});

describe('shiftCuePointsForTrim — moving cues onto the trimmed timeline', () => {
  const cues = [
    { id: 1, position_ms: 1000, label: 'intro' },
    { id: 2, position_ms: 6000, label: 'drop' },
    { id: 3, position_ms: 30_000, label: 'outro' },
  ];

  it('shifts every cue back by the trim start', () => {
    expect(shiftCuePointsForTrim(cues, 1000, 30_000)).toEqual([
      { id: 1, position_ms: 0, label: 'intro' },
      { id: 2, position_ms: 5000, label: 'drop' },
      { id: 3, position_ms: 29_000, label: 'outro' },
    ]);
  });

  it('drops cues outside the trimmed range', () => {
    expect(shiftCuePointsForTrim(cues, 5000, 10_000)).toEqual([
      { id: 2, position_ms: 1000, label: 'drop' },
    ]);
  });

  it('does not mutate the input cues', () => {
    const original = cues.map((c) => ({ ...c }));
    shiftCuePointsForTrim(cues, 1000, 30_000);
    expect(cues).toEqual(original);
  });

  it('returns an empty list for empty or missing input', () => {
    expect(shiftCuePointsForTrim([], 1000, 5000)).toEqual([]);
    expect(shiftCuePointsForTrim(null, 1000, 5000)).toEqual([]);
  });

  it('returns the cues untouched when there is no trim start', () => {
    expect(shiftCuePointsForTrim(cues, 0, null)).toBe(cues);
  });
});
