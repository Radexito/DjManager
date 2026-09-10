// #258 — "Real DJ mode": export a USB that behaves like a plain stick. The
// standalone player shows no waveform and no BPM, so the set has to be mixed by
// ear. This is purely an export-time transformation — the library keeps all
// analysed data, nothing is deleted.

export const BLIND_MODE_SETTING = 'export_blind_mode';

/**
 * Resolve the blind-mode flag: an explicit per-export value wins, otherwise the
 * stored setting decides (default off).
 * @param {boolean|null|undefined} explicit
 * @param {(key: string, def?: any) => any} [getSettingFn]
 */
export function resolveBlindMode(explicit, getSettingFn) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  if (typeof getSettingFn !== 'function') return false;
  return getSettingFn(BLIND_MODE_SETTING, 'false') === 'true';
}

/**
 * Blank the beat information a standalone player reads out of the PDB.
 * Keeps every other field untouched (title/artist/cues/key all still export).
 */
export function applyBlindMode(track, blindMode) {
  if (!blindMode) return track;
  return { ...track, bpm: 0, analyzePath: '' };
}

/** Blind mode writes no ANLZ files at all (grid + waveform live there). */
export function shouldWriteAnlz(blindMode) {
  return !blindMode;
}
