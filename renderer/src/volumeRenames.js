/**
 * Follows a drive that came back under a different letter (#514).
 *
 * The main process watches the volume list and reports the volumes that moved
 * (`letterChanged: [{ from: 'E:\\', to: 'D:\\' }]`). Everything the renderer
 * remembers by drive letter - the browsed folder, the export target - is
 * rewritten from the old root to the new one instead of pointing at a path that
 * now belongs to a different device (or to nothing at all).
 *
 * Pure string logic so it can be unit tested without the main process.
 */

/** True for roots shaped like a Windows drive ("E:", "E:\", "E:/"). */
export function isDriveRoot(root) {
  return /^[a-zA-Z]:[\\/]?$/.test(String(root ?? ''));
}

/**
 * Applies every rename that contains `targetPath`.
 *
 * @param {string|null} targetPath path to rewrite (Windows letter or POSIX mount)
 * @param {{ from: string, to: string }[]} renames old root -> new root pairs
 * @returns {string|null} the rewritten path, or the original when nothing matches
 */
export function applyVolumeRenames(targetPath, renames = []) {
  if (!targetPath || !Array.isArray(renames) || renames.length === 0) return targetPath;

  let path = String(targetPath);
  for (const rename of renames) {
    const from = rename?.from;
    const to = rename?.to;
    if (!from || !to || from === to) continue;

    const caseInsensitive = isDriveRoot(from);
    const candidate = caseInsensitive ? path.toLowerCase() : path;
    const root = caseInsensitive ? String(from).toLowerCase() : String(from);

    if (candidate === root || candidate === root.replace(/[\\/]+$/, '')) {
      path = to;
    } else {
      // A naked root needs a separator before it can anchor a prefix match, and it
      // has to be the separator of the platform the root belongs to: `E:` uses
      // backslashes, a POSIX mount point uses forward slashes.
      const endsWithSep = root.endsWith('\\') || root.endsWith('/');
      const prefix = endsWithSep ? root : `${root}${caseInsensitive ? '\\' : '/'}`;
      if (candidate.startsWith(prefix)) path = to + path.slice(String(from).length);
    }
  }
  return path;
}
