// src/audio/trackTrim.js
//
// Trim range helpers (#463). A track may carry a "usable range" — where
// playback should start and where it should stop — stored per track as
// `trim_start_ms` / `trim_end_ms` (NULL = no trim). This module is pure: it
// validates/clamps the range, and re-bases analysis data (beat grid, cue
// points) onto the trimmed timeline for the Rekordbox export.
//
// renderer/src/trackTrim.js mirrors clampTrimRange()/trackTrimRange() for the
// renderer process (the renderer is a separate Vite root and cannot import
// from src/ — same reason renderer/src/searchParser.js is mirrored).

/** Coerce to a finite number; null/''/garbage → null. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Validate and clamp a trim range against the track duration.
 *
 * Rules (issue #463): trim start must be >= 0, trim end must be <= duration,
 * trim start must be < trim end. Invalid input is CLAMPED where that is
 * meaningful (negative start, end past the file) and REJECTED — returns null —
 * when nothing usable is left (start >= end, range outside the file).
 *
 * @param {number|null} startMs    Trim start in milliseconds (null = file start)
 * @param {number|null} endMs      Trim end in milliseconds (null = file end)
 * @param {number} [durationMs=0]  Track duration in milliseconds (0 = unknown)
 * @returns {{ startMs: number, endMs: number } | null}
 *          null means "no trim" — play/export the whole file.
 */
export function clampTrimRange(startMs, endMs, durationMs = 0) {
  const rawStart = toNumber(startMs);
  const rawEnd = toNumber(endMs);
  if (rawStart === null && rawEnd === null) return null;

  const duration = toNumber(durationMs);
  const durationMsKnown = duration !== null && duration > 0 ? duration : null;

  let start = rawStart === null ? null : Math.max(0, rawStart);
  let end = rawEnd;

  if (durationMsKnown !== null) {
    if (end !== null && end > durationMsKnown) end = durationMsKnown;
    if (start !== null && start > durationMsKnown) start = durationMsKnown;
  }

  const s = start ?? 0;
  const e = end ?? durationMsKnown;
  if (e === null) return null; // unbounded end and no known duration — not usable
  if (e - s <= 0) return null; // start >= end — nothing left to play
  if (durationMsKnown !== null && s <= 0 && e >= durationMsKnown) return null; // whole file

  return { startMs: Math.round(s), endMs: Math.round(e) };
}

/**
 * Trim range of a track row (as returned by the DB / the renderer's track
 * list). Returns null when the track carries no usable trim.
 */
export function trackTrimRange(track) {
  if (!track) return null;
  const durationSec = toNumber(track.duration);
  const durationMs = durationSec !== null && durationSec > 0 ? durationSec * 1000 : 0;
  return clampTrimRange(track.trim_start_ms ?? null, track.trim_end_ms ?? null, durationMs);
}

/**
 * Serialize pending trim settings into the `tracks` columns (#463) — the
 * inverse of trackTrimRange(). Clamps to the file and, crucially, keeps an
 * UNSET side NULL: "no end set" must stay distinguishable from "end pinned to
 * today's file duration" (a later re-import may change the duration). A range
 * that is invalid or covers the whole file clears both columns — that is the
 * reset path.
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

/**
 * Re-base a beat grid (the DB `beatgrid` JSON column) onto the trimmed
 * timeline: times shift back by the trim start and beats outside the trimmed
 * range are dropped. Accepts both shapes the analyzer writes — an array of
 * positions in seconds, or an array of objects with position/time/offset.
 * Returns a JSON string in the same shape, or the input unchanged when there
 * is nothing to shift.
 */
export function shiftBeatgridForTrim(beatgridJson, startMs, endMs) {
  if (!beatgridJson) return beatgridJson ?? null;

  const start = toNumber(startMs) ?? 0;
  const end = toNumber(endMs);
  const lengthMs = end === null ? null : end - start;
  if (start <= 0 && lengthMs === null) return beatgridJson;

  let parsed;
  try {
    parsed = typeof beatgridJson === 'string' ? JSON.parse(beatgridJson) : beatgridJson;
  } catch {
    return beatgridJson; // malformed JSON — leave it to the writer's fallback
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return beatgridJson;

  const numeric = typeof parsed[0] === 'number';
  const shifted = [];
  for (const entry of parsed) {
    const rawSec = numeric
      ? toNumber(entry)
      : toNumber(entry?.position ?? entry?.time ?? entry?.offset);
    if (rawSec === null) continue;
    const sec = rawSec - start / 1000;
    const ms = sec * 1000;
    if (ms < 0) continue; // before the trim start
    if (lengthMs !== null && ms > lengthMs) continue; // after the trim end
    if (numeric) {
      shifted.push(round3(sec));
    } else {
      const field = entry.position != null ? 'position' : entry.time != null ? 'time' : 'offset';
      shifted.push({ ...entry, [field]: round3(sec) });
    }
  }
  return JSON.stringify(shifted);
}

/**
 * Re-base cue points onto the trimmed timeline: positions shift back by the
 * trim start, cues that would fall outside the trimmed range are dropped
 * (they cannot be represented in the exported file).
 */
export function shiftCuePointsForTrim(cuePoints, startMs, endMs) {
  if (!Array.isArray(cuePoints) || cuePoints.length === 0) return cuePoints ?? [];

  const start = toNumber(startMs) ?? 0;
  const end = toNumber(endMs);
  const lengthMs = end === null ? null : end - start;
  if (start <= 0 && lengthMs === null) return cuePoints;

  return cuePoints
    .map((cue) => ({ ...cue, position_ms: Math.round((toNumber(cue.position_ms) ?? 0) - start) }))
    .filter((cue) => cue.position_ms >= 0 && (lengthMs === null || cue.position_ms <= lengthMs));
}
