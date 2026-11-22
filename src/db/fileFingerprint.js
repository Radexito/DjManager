import fs from 'node:fs';

/**
 * A cheap identity for the bytes of a file: size and modification time.
 *
 * A full hash is only worth its cost when this value moves. Everything that
 * resolves a track's file records the fingerprint when it writes the path
 * (import, link, move, normalisation), and a sync compares the stored value
 * against one stat call before deciding to read the file at all.
 *
 * @param {string|null} filePath
 * @param {{stat?: function(string): {size: number, mtimeMs: number}}} [options]
 * @returns {string|null} `size:mtime` or null when the file cannot be read
 */
export function fileFingerprint(filePath, { stat = fs.statSync } = {}) {
  if (!filePath) return null;
  try {
    const info = stat(filePath);
    return `${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Whether two fingerprints describe the same file state. */
export function sameFingerprint(a, b) {
  return (a ?? null) === (b ?? null);
}
