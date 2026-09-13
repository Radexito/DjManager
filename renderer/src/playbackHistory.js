// Playback history ring buffer (#507).
//
// Kept in its own module so PlayerContext.jsx only exports components (the
// react-refresh lint rule) and so the buffer logic is directly unit-testable.
// The history is persisted to localStorage so the history control is useful
// across restarts.

export const HISTORY_MAX = 50;
export const HISTORY_STORAGE_KEY = 'djman_playback_history';

// Binary columns the track rows carry (`SELECT t.*` includes the waveform
// BLOBs). They are useless for the history menu and would blow up localStorage
// once serialised, so they never reach the persisted copy.
const HISTORY_BINARY_KEYS = new Set(['waveform_overview', 'waveform_detail_hires']);

/** Copy of a track with the binary payload dropped (for persistence only). */
function slimHistoryTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const slim = {};
  for (const [key, value] of Object.entries(track)) {
    if (HISTORY_BINARY_KEYS.has(key)) continue;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
    slim[key] = value;
  }
  return slim;
}

/**
 * Prepend `track` to the history ring buffer (returns a new array).
 * The same track starting again back to back (repeat "one", or re-clicking the
 * playing row) does not add a duplicate entry.
 */
export function appendHistoryEntry(history, track) {
  if (!track || track.id == null) return history;
  if (history[0]?.id === track.id) return history;
  const next = [track, ...history];
  return next.length > HISTORY_MAX ? next.slice(0, HISTORY_MAX) : next;
}

/** Read the persisted history. Never throws: corrupted or unavailable storage
 *  (private mode, quota, no localStorage at all) degrades to an empty history. */
export function loadHistory() {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(slimHistoryTrack)
      .filter((entry) => entry && entry.id != null)
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** Write the history to localStorage; a failing store leaves it in memory. */
export function persistHistory(history) {
  try {
    globalThis.localStorage?.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(history.map(slimHistoryTrack).filter(Boolean))
    );
  } catch {
    // storage full or disabled - history simply stays session-only
  }
}
