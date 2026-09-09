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
 * @param {Map<string, object>} existingTracks - trackId → manifest track row (has `file_path`, `file_size`, `bitrate`)
 * @param {string} trackId
 * @param {Map<string, boolean>} usedNames - mutated: registers the reused filename so later new tracks don't collide with it
 * @returns {{ path: string, meta: { fileSize: number, bitrate: number } | null } | null}
 *   The reusable `{ path, meta }` pair (same shape `copyTrackToUsb()` returns), or
 *   `null` if the track isn't already on the USB and `copyTrackToUsb()` must be called.
 */
export function reuseExistingUsbTrack(existingTracks, trackId, usedNames) {
  const existing = existingTracks.get(trackId);
  if (!existing?.file_path) return null;

  const name = path.basename(existing.file_path).toLowerCase();
  if (name) usedNames.set(name, true);

  const meta =
    existing.file_size || existing.bitrate
      ? { fileSize: existing.file_size, bitrate: existing.bitrate }
      : null;

  return { path: existing.file_path, meta };
}
