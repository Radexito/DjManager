// renderer/src/__tests__/waveformColors.test.js
// Pure colour maths for the waveforms (#608). No DOM, no jsdom quirks: these are plain functions.
import { describe, it, expect } from 'vitest';
import {
  WAVEFORM_MODES,
  compressBands,
  waveformColor,
  bigWaveformColor,
  overviewWaveformColor,
  css,
} from '../waveformColors.js';

const inRange = ({ r, g, b }) => [r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

describe('compressBands', () => {
  it('clamps out-of-range input instead of producing NaN or negatives', () => {
    const out = compressBands(-20, 999, 0);
    expect(out.bassC).toBe(0); // -20 clamps to 0
    expect(out.midC).toBeCloseTo(1, 6); // 999 clamps to 255
    expect(out.trebleC).toBe(0);
    expect(Number.isFinite(out.bassC + out.midC + out.trebleC)).toBe(true);
  });

  it('compresses harder for the quieter bands, so treble stays visible next to bass', () => {
    const { bassC, midC, trebleC } = compressBands(255, 60, 20);
    // raw ratios are 1 : 0.235 : 0.078; after compression they must be closer together
    expect(trebleC).toBeGreaterThan(20 / 255);
    expect(trebleC / bassC).toBeGreaterThan(0.078);
    expect(bassC).toBeGreaterThan(midC);
    expect(midC).toBeGreaterThan(trebleC);
  });
});

describe('waveformColor — the per-mode palette', () => {
  it('rgb maps treble→red, mid→green, bass→blue', () => {
    expect(waveformColor('rgb', 0, 0, 1)).toEqual({ r: 255, g: 0, b: 0 });
    expect(waveformColor('rgb', 0, 1, 0)).toEqual({ r: 0, g: 255, b: 0 });
    expect(waveformColor('rgb', 1, 0, 0)).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('classic keeps r and g locked together — blue body, bright peaks', () => {
    const bassOnly = waveformColor('classic', 1, 0, 0);
    expect(bassOnly.r).toBe(0);
    expect(bassOnly.g).toBe(0);
    expect(bassOnly.b).toBeGreaterThan(0); // body is blue

    const trebleOnly = waveformColor('classic', 0, 0, 1);
    expect(trebleOnly.r).toBe(trebleOnly.g); // the peak brightens r and g together
    expect(trebleOnly.r).toBeGreaterThan(trebleOnly.b);
  });

  it('3band gives blue for bass, orange for mid, white for treble', () => {
    const bass = waveformColor('3band', 1, 0, 0);
    const mid = waveformColor('3band', 0, 1, 0);
    const treble = waveformColor('3band', 0, 0, 1);
    expect(bass.b).toBeGreaterThan(bass.r); // blue
    expect(mid.r).toBeGreaterThan(mid.b); // orange: red+green, little blue
    expect(mid.g).toBeGreaterThan(0);
    expect(treble).toEqual({ r: 255, g: 255, b: 255 }); // treble drives all three channels
  });

  it('clamps its inputs and keeps every channel in 0..255', () => {
    for (const mode of WAVEFORM_MODES) {
      expect(inRange(waveformColor(mode, 2, -1, 5))).toBe(true);
    }
  });
});

// ── The point of #608 ─────────────────────────────────────────────────────────────────────────────
// rekordbox colours its large waveform differently from its thin overview strip: the large one is peaked
// (one channel saturates, the middle band barely shows - measured: no green at all), the overview keeps a
// broader mix. These tests pin the SPLIT and the mode handling; they deliberately do not claim we already
// reproduce rekordbox's large waveform exactly (that needs tuning, see waveformColors.js).
describe('big vs overview — the measured rekordbox split', () => {
  // a realistic EMA column: bass >> mid >> treble
  const column = { bass: 200, mid: 70, treble: 25, brightness: 0.9 };
  const peak = (c) => Math.max(c.r, c.g, c.b);
  const spread = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);

  it('the large flavour is peaked, the overview keeps a broader mix', () => {
    const big = bigWaveformColor('rgb', column);
    const over = overviewWaveformColor('rgb', column);
    expect(peak(big)).toBeGreaterThan(peak(over)); // the dominant channel saturates
    expect(spread(big)).toBeGreaterThan(spread(over)); // narrower hue range
    expect(over.g).toBeGreaterThan(0); // the overview always shows some mid content
  });

  it('the overview carries mid content proportionally, not flattened into the strongest band', () => {
    const over = overviewWaveformColor('rgb', column);
    const midHeavy = overviewWaveformColor('rgb', { ...column, mid: 200 });
    expect(midHeavy.g).toBeGreaterThan(over.g); // more mid really does mean more green
  });

  it('both flavours honour the colour-mode setting', () => {
    for (const mode of WAVEFORM_MODES) {
      expect(inRange(bigWaveformColor(mode, column))).toBe(true);
      expect(inRange(overviewWaveformColor(mode, column))).toBe(true);
    }
    // in classic mode both are blue-bodied (r === g), in rgb they are not
    const classicBig = bigWaveformColor('classic', column);
    const classicOver = overviewWaveformColor('classic', column);
    expect(classicBig.r).toBe(classicBig.g);
    expect(classicOver.r).toBe(classicOver.g);
    expect(bigWaveformColor('rgb', column).r).not.toBe(bigWaveformColor('rgb', column).g);
  });

  it('an unknown mode falls back to rgb rather than returning undefined channels', () => {
    const out = bigWaveformColor('nonsense', column);
    expect(inRange(out)).toBe(true);
    expect(out).toEqual(bigWaveformColor('rgb', column));
  });

  it('css() renders a usable fillStyle', () => {
    expect(css({ r: 1, g: 2, b: 3 })).toBe('rgb(1,2,3)');
  });
});
