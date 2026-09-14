// #258 — "Real DJ mode": export a stick that gives the player nothing to mix
// with. The CDJ shows no waveform and no BPM, so the set has to be mixed by ear.
//
// Two halves, both needed:
//   1. the PDB ships BPM 0 (see applyBlindMode) — no BPM in the browser or on
//      the deck;
//   2. the ANLZ is still written, but blind (see writeAnlz({ blind: true })) —
//      no waveform sections and an empty beat grid.
//
// The ANLZ must EXIST. Without it the player treats the track as unanalysed and
// generates its own waveform + grid, which is the opposite of the point. This is
// also the state a failed export used to leave behind, confirmed on hardware to
// play with nothing displayed. The library keeps everything either way: this is
// purely an export-time transformation.

export const BLIND_MODE_SETTING = 'export_blind_mode';

/** Resolve the flag: explicit per-export value wins, else the stored setting. */
export function resolveBlindMode(explicit, getSettingFn) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  return typeof getSettingFn === 'function' && getSettingFn(BLIND_MODE_SETTING, 'false') === 'true';
}

/**
 * Strip the beat information a standalone player would display.
 * `analyzePath` is deliberately kept: it points at the blind ANLZ, and clearing
 * it would make the player think the track was never analysed.
 */
export function applyBlindMode(track, blindMode) {
  if (!blindMode) return track;
  return { ...track, bpm: 0 };
}
