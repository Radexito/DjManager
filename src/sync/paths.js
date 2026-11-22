import path from 'node:path';

/**
 * Layout of the working area this application keeps on a medium.
 *
 * Everything lives under one hidden folder at the mount point, so a stick the
 * user also uses elsewhere stays recognisable: `.djmanager/` holds the lock,
 * the journals, the staging area and the previous generation of the files we
 * publish. Players ignore it, and deleting it costs nothing but the ability to
 * explain the next sync.
 *
 * Paths recorded in a journal are relative to the mount point and always use
 * forward slashes, so one journal reads the same on Windows and Linux.
 */

export const SYNC_DIR_NAME = '.djmanager';

/** Absolute path of the application's working folder on a medium. */
export function syncRoot(usbRoot) {
  return path.join(usbRoot, SYNC_DIR_NAME);
}

/** Absolute path of the device lock. */
export function lockPath(usbRoot) {
  return path.join(syncRoot(usbRoot), 'sync.lock');
}

/** Folder holding one journal per job. */
export function journalsDir(usbRoot) {
  return path.join(syncRoot(usbRoot), 'journal');
}

/** Absolute path of one job's journal. */
export function journalPath(usbRoot, jobId) {
  return path.join(journalsDir(usbRoot), `${jobId}.jsonl`);
}

/** Folder a job writes new files into before they are published. */
export function stagingRoot(usbRoot, jobId) {
  return path.join(syncRoot(usbRoot), 'staging', jobId);
}

/** Folder holding the previous published generation, one subfolder per job. */
export function generationsRoot(usbRoot) {
  return path.join(syncRoot(usbRoot), 'generations');
}

/** Folder holding the files one job replaced when it published. */
export function generationDir(usbRoot, jobId) {
  return path.join(generationsRoot(usbRoot), jobId);
}

/**
 * Mount-relative path with forward slashes, the form a journal stores.
 * @param {string} usbRoot mount point
 * @param {string} absPath absolute path inside the medium
 */
export function toRelative(usbRoot, absPath) {
  return path.relative(usbRoot, absPath).split(path.sep).join('/');
}

/**
 * Absolute path for a mount-relative path read from a journal.
 * @param {string} usbRoot mount point
 * @param {string} relPath forward-slash path relative to the mount point
 */
export function fromRelative(usbRoot, relPath) {
  return path.join(usbRoot, ...String(relPath).split('/'));
}
