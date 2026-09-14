import path from 'path';

/**
 * Decides whether a track already present in a previous export's manifest can
 * be reused as-is, avoiding a redundant `copyTrackToUsb()` call.
 *
 * On a 2nd+ export to the same USB, `usedNames` is pre-populated from the
 * existing manifest so *new* tracks don't collide with already-exported
 * filenames. But if the main export loop still calls `copyTrackToUsb()` for
 * a track that's already on the USB, that track's own filename collides with
 * itself in `usedNames` and gets renamed to "... (1).ext" — the real file is
 * left untouched on disk, but the manifest/PDB now points at a path that
 * doesn't exist. Because the ANLZ folder hash is derived from that same path
 * string, the beat grid/waveform data also gets written to the wrong
 * directory. See issue #247.
 *
 * #463: the manifest remembers the trim range the file was written with, so a
 * track whose trim changed is NOT reused — it is re-copied (and re-trimmed)
 * instead of leaving a stale untrimmed file on the stick.
 *
 * @param {Map<string, object>} existingTracks - trackId → manifest track row (has `file_path`, `file_size`, `bitrate`, `trim_start_ms`, `trim_end_ms`)
 * @param {string} trackId
 * @param {Map<string, boolean>} usedNames - mutated: registers the reused filename so later new tracks don't collide with it
 * @param {{ trimStartMs?: number|null, trimEndMs?: number|null }} [opts] - the trim range the track has NOW
 * @returns {{ path: string, meta: { fileSize: number, bitrate: number } | null } | null}
 *   The reusable `{ path, meta }` pair (same shape `copyTrackToUsb()` returns), or
 *   `null` if the track isn't already on the USB and `copyTrackToUsb()` must be called.
 */
export function reuseExistingUsbTrack(existingTracks, trackId, usedNames, opts = {}) {
  const existing = existingTracks.get(trackId);
  if (!existing?.file_path) return null;

  // Trim changed since the file was exported — the audio on the stick no longer
  // matches the track, so it must be copied again.
  const trimStartMs = opts.trimStartMs ?? null;
  const trimEndMs = opts.trimEndMs ?? null;
  const exportedTrimStart = existing.trim_start_ms ?? null;
  const exportedTrimEnd = existing.trim_end_ms ?? null;
  if (trimStartMs !== exportedTrimStart || trimEndMs !== exportedTrimEnd) return null;

  const name = path.basename(existing.file_path).toLowerCase();
  if (name) usedNames.set(name, true);

  const meta =
    existing.file_size || existing.bitrate
      ? { fileSize: existing.file_size, bitrate: existing.bitrate }
      : null;

  return { path: existing.file_path, meta };
}
