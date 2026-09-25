// src/library/folderPlaylistSync.js
// #267 — the pure half of folder-tracked playlists: compare what a folder holds
// with what the playlist holds. No fs, no DB: the caller does the I/O, which
// keeps the interesting decisions (what to add, what went missing) testable.
import path from 'path';

/** Absolute so `..` cannot fool a comparison; case-folded on Windows. */
export function normalisePath(filePath, platform = process.platform) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True when `filePath` sits inside `folder`.
 * With `recursive: false` only the folder's own files count — a sub-folder's
 * track is not part of a non-recursive mirror.
 */
export function isInsideFolder(
  filePath,
  folder,
  { recursive = true, platform = process.platform } = {}
) {
  const file = normalisePath(filePath, platform);
  const root = normalisePath(folder, platform);
  if (!file || !root || file === root) return false;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!file.startsWith(prefix)) return false;
  if (recursive) return true;
  return !file.slice(prefix.length).includes(path.sep);
}

/**
 * Plan the next sync of a folder-tracked playlist.
 *
 * `add` is what the folder has and the playlist does not; `missing` is what the
 * playlist holds from inside that folder and the folder no longer offers (deleted
 * or moved away — the caller asks the user before removing anything). Tracks the
 * user added by hand from somewhere else are never reported missing.
 *
 * The caller decides the file scope (a non-recursive mirror simply passes the
 * folder's own files), so this stays pure and easy to reason about.
 *
 * @param {{ folderFiles?: string[], playlistTracks?: {id:number, file_path?:string}[],
 *           folder: string, platform?: string }} opts
 * @returns {{ add: string[], missing: {id:number, file_path:string}[], unchanged: number }}
 */
export function planFolderSync({
  folderFiles = [],
  playlistTracks = [],
  folder,
  platform = process.platform,
}) {
  const inFolder = new Map(); // normalised path → the path as the folder gave it
  for (const file of folderFiles) {
    const key = normalisePath(file, platform);
    if (key && !inFolder.has(key)) inFolder.set(key, file);
  }

  const held = new Set();
  const missing = [];
  for (const track of playlistTracks) {
    const key = normalisePath(track?.file_path, platform);
    if (!key) continue;
    held.add(key);
    // Only tracks that live in the tracked folder can go missing: a track added
    // by hand from elsewhere is none of this folder's business.
    if (!inFolder.has(key) && isInsideFolder(track.file_path, folder, { platform })) {
      missing.push({ id: track.id, file_path: track.file_path });
    }
  }

  const add = [];
  for (const [key, original] of inFolder) if (!held.has(key)) add.push(original);

  const byPath = (a, b) =>
    (a.file_path ?? a).localeCompare(b.file_path ?? b, undefined, { numeric: true });
  add.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  missing.sort(byPath);

  return { add, missing, unchanged: inFolder.size - add.length };
}
