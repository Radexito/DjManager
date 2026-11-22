import fs from 'node:fs';
import path from 'node:path';

import { fromRelative, toRelative } from './paths.js';

/**
 * Removals go to a trash folder on the medium, not to nothing.
 *
 * A mirror sync deletes tracks the selection no longer contains. Moving the
 * file into `.device-trash/<syncId>/` keeps the bytes readable on the stick
 * until a later successful sync, so a wrong selection costs a copy back rather
 * than a re-copy from the library. Only files this application wrote are ever
 * offered here; the caller decides that from the manifest.
 */

export const TRASH_DIR = '.device-trash';

/** Seven days, unless the caller configures otherwise. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function trashRoot(usbRoot) {
  return path.join(usbRoot, TRASH_DIR);
}

/**
 * Move one file into this sync's trash folder.
 * @param {object} options
 * @param {string} options.usbRoot
 * @param {string} options.syncId job id, so one apply owns one folder
 * @param {string} options.relPath path relative to the medium
 * @returns {{moved: boolean, trashPath?: string, relPath: string}}
 */
export function moveToTrash({ usbRoot, syncId, relPath }) {
  const source = fromRelative(usbRoot, relPath);
  if (!fs.existsSync(source)) return { moved: false, relPath };
  const target = path.join(trashRoot(usbRoot), syncId, ...String(relPath).split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(source, target);
    fs.rmSync(source, { force: true });
  }
  return { moved: true, relPath, trashPath: toRelative(usbRoot, target) };
}

/**
 * Drop trash folders older than the retention window.
 * @param {object} options
 * @param {string} options.usbRoot
 * @param {number} [options.retentionMs]
 * @param {function(): number} [options.now]
 * @returns {{removed: number}}
 */
export function pruneTrash({ usbRoot, retentionMs = DEFAULT_RETENTION_MS, now = Date.now }) {
  const root = trashRoot(usbRoot);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    let info;
    try {
      info = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    if (now() - info.mtimeMs < retentionMs) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}

/** Trash folders on the medium, newest first. */
export function listTrash(usbRoot) {
  let names;
  try {
    names = fs.readdirSync(trashRoot(usbRoot));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const dir = path.join(trashRoot(usbRoot), name);
      try {
        const info = fs.statSync(dir);
        return info.isDirectory() ? { name, mtimeMs: info.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
