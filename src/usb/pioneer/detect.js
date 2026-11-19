import fs from 'node:fs';
import path from 'node:path';

/** Folder every Pioneer export carries, next to the audio folder. */
export const PIONEER_DIR = 'PIONEER';

/** Playlist database rekordbox and the players read off the stick. */
export const PDB_RELATIVE_PATH = path.join(PIONEER_DIR, 'rekordbox', 'export.pdb');

/**
 * Whether a mounted root carries the Pioneer layout.
 *
 * The PIONEER folder is the marker: the exporter creates it on first write and
 * rekordbox creates it on first export, so its presence is enough to tell a
 * prepared stick from a plain one.
 * @param {string} root mount point
 * @param {{exists?: Function}} [deps] injectable existence check
 * @returns {boolean}
 */
export function isPioneerUsb(root, { exists = fs.existsSync } = {}) {
  if (!root) return false;
  try {
    return exists(path.join(root, PIONEER_DIR));
  } catch {
    return false;
  }
}

/**
 * Whether the root carries the playlist database, i.e. the library a player
 * would actually show.
 * @param {string} root mount point
 * @param {{exists?: Function}} [deps] injectable existence check
 * @returns {boolean}
 */
export function hasPioneerDatabase(root, { exists = fs.existsSync } = {}) {
  if (!root) return false;
  try {
    return exists(path.join(root, PDB_RELATIVE_PATH));
  } catch {
    return false;
  }
}
