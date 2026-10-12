// renderer/src/trackTrim.js
//
// Trim range helpers for the renderer (#463). This mirrors
// src/audio/trackTrim.js (main process) — the renderer is a separate Vite root
// and cannot import from src/, the same way searchParser.js exists on both
// sides. Keep the validation rules in sync.

/** Coerce to a finite number; null/''/garbage → null. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate and clamp a trim range against the track duration.
 *
 * Rules (issue #463): trim start must be >= 0, trim end must be <= duration,
 * trim start must be < trim end. Clamps what can be clamped (negative start,
 * end past the file) and returns null when nothing usable is left.
 *
 * @returns {{ startMs: number, endMs: number } | null} null = no trim
 */
export function clampTrimRange(startMs, endMs, durationMs = 0) {
  const rawStart = toNumber(startMs);
  const rawEnd = toNumber(endMs);
  if (rawStart === null && rawEnd === null) return null;

  const duration = toNumber(durationMs);
  const durationKnown = duration !== null && duration > 0 ? duration : null;

  let start = rawStart === null ? null : Math.max(0, rawStart);
  let end = rawEnd;

  if (durationKnown !== null) {
    if (end !== null && end > durationKnown) end = durationKnown;
    if (start !== null && start > durationKnown) start = durationKnown;
  }

  const s = start ?? 0;
  const e = end ?? durationKnown;
  if (e === null) return null;
  if (e - s <= 0) return null;
  if (durationKnown !== null && s <= 0 && e >= durationKnown) return null;

  return { startMs: Math.round(s), endMs: Math.round(e) };
}

/** Trim range of a track object, or null when it has no usable trim. */
export function trackTrimRange(track) {
  if (!track) return null;
  const durationSec = toNumber(track.duration);
  const durationMs = durationSec !== null && durationSec > 0 ? durationSec * 1000 : 0;
  return clampTrimRange(track.trim_start_ms ?? null, track.trim_end_ms ?? null, durationMs);
}

/**
 * Serialize pending trim settings into the `tracks` columns (#463) — the
 * inverse of trackTrimRange(). Clamps to the file and keeps an UNSET side NULL
 * ("no end set" stays distinguishable from "end pinned to the current file
 * duration"). A range that is invalid or covers the whole file clears both
 * columns — that is the reset path.
 *
 * @param {number|null} startMs    trim start the user set (null = file start)
 * @param {number|null} endMs      trim end the user set (null = file end)
 * @param {number} [durationMs=0]  track duration in milliseconds
 * @returns {{ trim_start_ms: number|null, trim_end_ms: number|null }}
 */
export function trimColumns(startMs, endMs, durationMs = 0) {
  const range = clampTrimRange(startMs, endMs, durationMs);
  if (!range) return { trim_start_ms: null, trim_end_ms: null };
  return {
    trim_start_ms: toNumber(startMs) === null ? null : range.startMs,
    trim_end_ms: toNumber(endMs) === null ? null : range.endMs,
  };
}

/** `m:ss.d` label for a millisecond position (matches the cue list format). */
export function formatTrimTime(ms) {
  const n = toNumber(ms);
  if (n === null) return '--:--.-';
  const totalSec = Math.max(0, n) / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const tenth = Math.floor((totalSec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenth}`;
}
