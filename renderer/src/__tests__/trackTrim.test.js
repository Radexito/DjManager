// renderer/src/__tests__/trackTrim.test.js
// The renderer mirror of the trim math (#463) must behave identically to
// src/audio/trackTrim.js — the editor validates with it and re-serialises the
// result into the same DB columns.
import { describe, it, expect } from 'vitest';
import { clampTrimRange, trackTrimRange, trimColumns, formatTrimTime } from '../trackTrim.js';

describe('renderer trackTrim — clampTrimRange', () => {
  it('returns null when no side is set', () => {
    expect(clampTrimRange(null, null, 60_000)).toBeNull();
    expect(clampTrimRange('', '', 60_000)).toBeNull();
  });

  it('clamps into [0, duration]', () => {
    expect(clampTrimRange(-1000, 30_000, 60_000)).toEqual({ startMs: 0, endMs: 30_000 });
    expect(clampTrimRange(10_000, 90_000, 60_000)).toEqual({ startMs: 10_000, endMs: 60_000 });
    // both sides clamp onto the file bounds -> that is the whole file again
    expect(clampTrimRange(-1000, 90_000, 60_000)).toBeNull();
  });

  it('rejects an inverted or empty range', () => {
    expect(clampTrimRange(30_000, 10_000, 60_000)).toBeNull();
    expect(clampTrimRange(30_000, 30_000, 60_000)).toBeNull();
  });

  it('treats a whole-file range as no trim', () => {
    expect(clampTrimRange(0, 60_000, 60_000)).toBeNull();
    expect(clampTrimRange(null, 60_000, 60_000)).toBeNull();
  });

  it('rounds to whole milliseconds', () => {
    expect(clampTrimRange('2000.6', '30000.2', 60_000)).toEqual({ startMs: 2001, endMs: 30_000 });
  });
});

describe('renderer trackTrim — trackTrimRange / trimColumns', () => {
  it('reads a stored trim off a track row', () => {
    expect(trackTrimRange({ duration: 120, trim_start_ms: 30_000, trim_end_ms: 90_000 })).toEqual({
      startMs: 30_000,
      endMs: 90_000,
    });
  });

  it('returns null for an untrimmed track', () => {
    expect(trackTrimRange({ duration: 120 })).toBeNull();
    expect(trackTrimRange(null)).toBeNull();
  });

  it('round-trips a range through the column mapping', () => {
    expect(trimColumns(30_000, 90_000, 120_000)).toEqual({
      trim_start_ms: 30_000,
      trim_end_ms: 90_000,
    });
    const track = { duration: 120, ...trimColumns(30_000, 90_000, 120_000) };
    expect(trackTrimRange(track)).toEqual(clampTrimRange(30_000, 90_000, 120_000));
  });

  it('serialises a cleared range to cleared columns', () => {
    expect(trimColumns(null, null, 120_000)).toEqual({ trim_start_ms: null, trim_end_ms: null });
  });
});

describe('renderer trackTrim — formatTrimTime', () => {
  it('formats millisecond positions as m:ss.d', () => {
    expect(formatTrimTime(0)).toBe('0:00.0');
    expect(formatTrimTime(30_000)).toBe('0:30.0');
    expect(formatTrimTime(90_500)).toBe('1:30.5');
    expect(formatTrimTime(3_600_000)).toBe('60:00.0');
  });

  it('formats unknown/invalid input as a placeholder', () => {
    expect(formatTrimTime(null)).toBe('--:--.-');
    expect(formatTrimTime('abc')).toBe('--:--.-');
  });

  it('clamps negative positions to zero', () => {
    expect(formatTrimTime(-5000)).toBe('0:00.0');
  });
});
