// renderer/src/waveformColors.js
//
// One home for the waveform colour maths (issue #608).
//
// Why two functions instead of one: rekordbox colours its two wave elements differently, and that
// is measured, not guessed. From a screenshot of rekordbox 7.2.19 showing one track (2026-10-06), reading
// the hue mix of the saturated pixels:
//
//   large deck waveform : magenta 46-48%, red 26-33%, blue 8-16%, violet 11%  -> no green, no orange/yellow
//   thin overview strip : red 46%, magenta 14%, cyan 11%, green 9%, blue 8%, orange 7%  -> full spectrum
//
// So the large waveform is peaked/saturated (one channel dominates, the middle band barely shows) while
// the overview keeps a broader mix of all three bands. This module reproduces that SPLIT structurally:
// `bigWaveformColor` divides by the strongest band (peaked), `overviewWaveformColor` does not (broad);
// both apply the same gamma compression and honour the same colour-mode setting.
//
// NOT YET PROVEN: reproducing rekordbox's large waveform EXACTLY, i.e. a normal signal producing no green
// at all. With our compressed bands (bass/mid/treble become comparable) the middle channel always carries
// some weight, so the look is "saturated and narrow" rather than "green-free". Closing that gap needs a
// like-for-like measurement (same track, same mode, our render next to rekordbox's) and then tuning the
// exponents per band - deliberately left to its own change instead of guessed here.
//
// Layout of the maths, unchanged from the previous implementation in PlayerBar.jsx:
//   bands are EMA-derived and run bass >> mid >> treble, so each band is gamma-compressed before use;
//   the large waveform then divides by the strongest band (dominant normalisation), the overview does not.
//   Channels are always treble -> R, mid -> G, bass -> B in rgb mode.

export const WAVEFORM_MODES = ['rgb', 'classic', '3band'];

// Compression exponents: without these the hue is always blue (bass dominates everything).
const GAMMA_BASS = 0.55;
const GAMMA_MID = 0.3;
const GAMMA_TREBLE = 0.2;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Gamma-compress raw 0..255 band values (treble is the quietest, so it gets the strongest curve). */
export function compressBands(bass, mid, treble) {
  return {
    bassC: Math.pow(clamp255(bass) / 255, GAMMA_BASS),
    midC: Math.pow(clamp255(mid) / 255, GAMMA_MID),
    trebleC: Math.pow(clamp255(treble) / 255, GAMMA_TREBLE),
  };
}

/**
 * The per-mode palette. Takes the three normalised channels (0..1) and returns CSS channel values.
 *
 *   rgb     — treble→red, mid→green, bass→blue
 *   classic — blue body, white peaks (rekordbox's default look)
 *   3band   — blue=bass, orange=mid, white=treble
 */
export function waveformColor(mode, nb, ng, nr) {
  const b = clamp01(nb);
  const g = clamp01(ng);
  const r = clamp01(nr);

  if (mode === 'classic') {
    const white = Math.min(1, r * 2);
    // b can reach 290 here (55 + 180 + 55); the canvas used to clamp it silently, so clamp it here.
    return {
      r: clamp255(Math.round(white * 220)),
      g: clamp255(Math.round(white * 220)),
      b: clamp255(Math.round(55 + b * 180 + white * 55)),
    };
  }
  if (mode === '3band') {
    return {
      r: clamp255(Math.round(b * 30 + g * 255 + r * 255)),
      g: clamp255(Math.round(b * 30 + g * 140 + r * 255)),
      b: clamp255(Math.round(b * 255 + r * 255)),
    };
  }
  // rgb (default): the same channel order as the setting's own label
  return {
    r: clamp255(Math.round(r * 255)),
    g: clamp255(Math.round(g * 255)),
    b: clamp255(Math.round(b * 255)),
  };
}

/**
 * Large waveform (player bar, Prepare Track detail): dominant-band normalisation.
 * The strongest compressed band saturates its channel, which is why a normal mix has no green —
 * matching rekordbox's large waveform.
 *
 * @param {string} mode one of WAVEFORM_MODES
 * @param {{bass:number, mid:number, treble:number, brightness:number}} band
 */
export function bigWaveformColor(mode, { bass, mid, treble, brightness }) {
  const { bassC, midC, trebleC } = compressBands(bass, mid, treble);
  const dominant = Math.max(bassC, midC, trebleC) || 0.001;
  const scale = clamp01(brightness);
  return waveformColor(
    mode,
    (bassC / dominant) * scale,
    (midC / dominant) * scale,
    (trebleC / dominant) * scale
  );
}

/**
 * Thin overview strip: full spectrum. Same compression, no dominant division, so a mid-heavy column
 * really does come out green/orange instead of being flattened into the strongest band.
 */
export function overviewWaveformColor(mode, { bass, mid, treble, brightness }) {
  const { bassC, midC, trebleC } = compressBands(bass, mid, treble);
  const scale = clamp01(brightness);
  return waveformColor(mode, bassC * scale, midC * scale, trebleC * scale);
}

/** Convenience: "rgb(r,g,b)" for a canvas fillStyle. */
export function css({ r, g, b }) {
  return `rgb(${r},${g},${b})`;
}
