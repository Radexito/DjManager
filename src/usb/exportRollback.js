import fs from 'fs';
import path from 'path';

/**
 * Cancelling a USB export leaves the user with a choice: keep the part of the
 * run that already landed on the stick, or remove it again.
 *
 * Removing must never touch library data that was on the stick before this run
 * started. A stick that already carried an export from an earlier run keeps its
 * tracks, playlists, audio files and beat grids exactly as they were, and a
 * track that this run REUSED (already present) counts as pre-existing data.
 *
 * This module holds the decision, separate from the I/O, so the scoping rules
 * can be unit tested without a stick:
 *
 * - a file is deletable only when this run created it AND no pre-existing
 *   manifest entry claims that same path;
 * - an ANLZ folder is deletable only when this run created the folder
 *   (the caller records a folder only when it did not exist before the run) and
 *   only for a track this run copied, so beat grids of reused tracks survive;
 * - a manifest track/playlist entry is droppable only when the pre-run manifest
 *   did not already have that id, so re-exported playlists fall back to their
 *   pre-run content instead of disappearing;
 * - `mode: 'keep'` removes nothing at all.
 */

/** USB-relative, slash-separated, case-insensitive form used for comparisons. */
function normalizeUsbPath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** Accepts `{ path }` or a plain string entry. */
function entryPath(entry) {
  if (!entry) return '';
  return typeof entry === 'string' ? entry : entry.path || '';
}

/**
 * Decides what a cancelled export run may remove or must keep.
 *
 * @param {object} opts
 * @param {'keep'|'remove'} opts.mode
 * @param {Array<{ path: string, trackId?: number|string }|string>} [opts.createdFiles]
 *   audio files this run actually wrote (files skipped because they were
 *   already on the stick are not part of this list)
 * @param {string[]} [opts.createdAnlzFolders]
 *   PIONEER/USBANLZ folders this run created
 * @param {Array<number|string>} [opts.runTrackIds] tracks this run exported
 * @param {Array<number|string>} [opts.runPlaylistIds] playlists this run exported
 * @param {Array<number|string>} [opts.preExistingTrackIds] track ids in the manifest before the run
 * @param {Array<number|string>} [opts.preExistingPlaylistIds] playlist ids in the manifest before the run
 * @param {string[]} [opts.preExistingAudioPaths] USB paths the pre-run manifest points at
 * @returns {{
 *   mode: 'keep'|'remove',
 *   remove: boolean,
 *   filesToDelete: string[],
 *   foldersToDelete: string[],
 *   dropTrackIds: Array<number|string>,
 *   dropPlaylistIds: Array<number|string>,
 *   keptTrackIds: Array<number|string>,
 *   keptFiles: number,
 *   droppedTracks: number,
 *   droppedPlaylists: number
 * }}
 */
export function planExportRollback({
  mode,
  createdFiles = [],
  createdAnlzFolders = [],
  runTrackIds = [],
  runPlaylistIds = [],
  preExistingTrackIds = [],
  preExistingPlaylistIds = [],
  preExistingAudioPaths = [],
} = {}) {
  const remove = mode === 'remove';

  const preTracks = new Set(preExistingTrackIds.map(String));
  const prePlaylists = new Set(preExistingPlaylistIds.map(String));
  const protectedFiles = new Set(preExistingAudioPaths.map(normalizeUsbPath).filter(Boolean));

  const filesToDelete = [];
  const foldersToDelete = [];
  const keptTrackIds = [];
  const seenFiles = new Set();
  const seenFolders = new Set();

  if (remove) {
    for (const entry of createdFiles) {
      const p = entryPath(entry);
      const key = normalizeUsbPath(p);
      if (!key || seenFiles.has(key)) continue;
      // A path an earlier export already owned is pre-existing data, not ours.
      if (protectedFiles.has(key)) continue;
      seenFiles.add(key);
      filesToDelete.push(p);
    }
    for (const folder of createdAnlzFolders) {
      const key = normalizeUsbPath(folder);
      if (!key || seenFolders.has(key)) continue;
      seenFolders.add(key);
      foldersToDelete.push(folder);
    }
    for (const id of runTrackIds) {
      if (preTracks.has(String(id))) keptTrackIds.push(id);
    }
  }

  const dropTrackIds = remove ? runTrackIds.filter((id) => !preTracks.has(String(id))) : [];
  const dropPlaylistIds = remove
    ? runPlaylistIds.filter((id) => !prePlaylists.has(String(id)))
    : [];

  return {
    mode: remove ? 'remove' : 'keep',
    remove,
    filesToDelete,
    foldersToDelete,
    dropTrackIds,
    dropPlaylistIds,
    keptTrackIds: remove ? keptTrackIds : [...runTrackIds],
    keptFiles: createdFiles.length - filesToDelete.length,
    droppedTracks: dropTrackIds.length,
    droppedPlaylists: dropPlaylistIds.length,
  };
}

/**
 * Performs the deletions a `planExportRollback()` plan asks for. Everything is
 * best effort: a file that is already gone is not an error, and one failure
 * does not stop the rest of the rollback (the caller reports the failures).
 *
 * @param {string} usbRoot
 * @param {{ filesToDelete: string[], foldersToDelete: string[] }} plan
 * @returns {{ removedFiles: number, removedFolders: number, failures: string[] }}
 */
export function applyExportRollback(usbRoot, plan) {
  const failures = [];
  let removedFiles = 0;
  let removedFolders = 0;

  for (const rel of plan?.filesToDelete || []) {
    const abs = path.join(usbRoot, String(rel).replace(/^[/\\]+/, ''));
    try {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        removedFiles += 1;
      }
    } catch (err) {
      failures.push(`${rel}: ${err.message}`);
    }
  }

  for (const rel of plan?.foldersToDelete || []) {
    const abs = path.join(usbRoot, String(rel).replace(/^[/\\]+/, ''));
    try {
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { recursive: true, force: true });
        removedFolders += 1;
      }
    } catch (err) {
      failures.push(`${rel}: ${err.message}`);
    }
  }

  return { removedFiles, removedFolders, failures };
}
