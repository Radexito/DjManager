import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SyncError } from './errors.js';

import { generationDir, generationsRoot, fromRelative, stagingRoot, toRelative } from './paths.js';

/**
 * Staging and publication of the files players read.
 *
 * A medium is never updated in place. New files are written under
 * `.djmanager/staging/<jobId>/`, verified there, and only then renamed over the
 * live path, which is atomic on the same filesystem. Before the rename the file
 * that is already on the stick is copied into `.djmanager/generations/<jobId>/`,
 * so the previous generation survives until the journal commits. A kill between
 * any two steps leaves either the old file or the new one, never half of each,
 * and the journal says which step was reached.
 */

/** How many generations to keep per medium. One is enough to roll back a job. */
export const GENERATION_KEEP = 1;

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Absolute path a relative target takes inside a job's staging folder. */
export function stagedPath(staging, relPath) {
  return path.join(staging, ...String(relPath).split('/'));
}

/** Write a buffer into staging, durable before returning. */
export function writeStagedBuffer(staging, relPath, buffer) {
  const abs = stagedPath(staging, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fd = fs.openSync(abs, 'w');
  try {
    fs.writeSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { relPath, size: buffer.length, sha256: sha256(buffer) };
}

/** Describe a file a writer already placed in staging. */
export function describeStaged(staging, relPath) {
  const abs = stagedPath(staging, relPath);
  const buffer = fs.readFileSync(abs);
  return { relPath, size: buffer.length, sha256: sha256(buffer) };
}

/** Best effort directory flush, so a rename is not lost on power failure. */
function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* not every platform allows fsync on a directory */
  }
}

/**
 * Move a file into place without ever exposing a partial file.
 * Falls back to a copy beside the target when staging and target are on
 * different filesystems, which cannot happen on a real medium but can in tests.
 */
function moveIntoPlace(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    const tmp = `${target}.tmp-${process.pid}`;
    fs.copyFileSync(source, tmp);
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    fs.rmSync(source, { force: true });
  }
  fsyncDir(path.dirname(target));
}

/** Keep the files that are about to be replaced, one generation deep. */
function backupTarget(usbRoot, jobId, relPath, journal) {
  const target = fromRelative(usbRoot, relPath);
  if (!fs.existsSync(target)) return null;
  const backup = fromRelative(generationDir(usbRoot, jobId), relPath);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup);
  const entry = { relPath, backup: toRelative(usbRoot, backup), size: fs.statSync(backup).size };
  journal?.append('backup', entry);
  return entry;
}

/**
 * Turn a filesystem refusal into something a person can act on.
 * A player or the operating system holding the file open makes the rename fail
 * with a sharing violation (EPERM/EACCES/EBUSY on Windows); the target is still
 * the old file, so the message says that and names what to close.
 */
export function describePublishFailure(err, relPath) {
  if (['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY'].includes(err?.code)) {
    return new SyncError(
      'file-locked',
      `Cannot replace ${relPath}: another program (a player or rekordbox) still holds it. ` +
        'Close it or eject the device, then sync again.',
      { relPath, cause: err.code }
    );
  }
  return err;
}

/**
 * Publish staged files, one atomic rename each.
 *
 * @param {object} options
 * @param {string} options.usbRoot mount point
 * @param {string} options.jobId
 * @param {string} options.staging folder the files were staged in
 * @param {Array<{relPath: string, size?: number, sha256?: string,
 *   verify?: function(string): void}>} options.entries
 * @param {object} [options.journal] journal opened for the job
 * @returns {Array<object>} what was published
 */
export function publishStaged({ usbRoot, jobId, staging, entries, journal, onFilePublished }) {
  for (const entry of entries) {
    const abs = stagedPath(staging, entry.relPath);
    if (!fs.existsSync(abs)) {
      throw new SyncError('staging-missing', `staged file is gone: ${entry.relPath}`, {
        relPath: entry.relPath,
      });
    }
    const buffer = fs.readFileSync(abs);
    if (buffer.length === 0) {
      throw new SyncError('staging-empty', `staged file is empty: ${entry.relPath}`, {
        relPath: entry.relPath,
      });
    }
    if (entry.size != null && buffer.length !== entry.size) {
      throw new SyncError('staging-changed', `staged file changed size: ${entry.relPath}`, {
        relPath: entry.relPath,
      });
    }
    const digest = sha256(buffer);
    if (entry.sha256 && digest !== entry.sha256) {
      throw new SyncError('staging-changed', `staged file changed: ${entry.relPath}`, {
        relPath: entry.relPath,
      });
    }
    if (typeof entry.verify === 'function') entry.verify(abs);
    journal?.append('verified', { relPath: entry.relPath, sha256: digest, size: buffer.length });
  }

  const published = [];
  for (const entry of entries) {
    const stagedAbs = stagedPath(staging, entry.relPath);
    const targetAbs = fromRelative(usbRoot, entry.relPath);
    const verificationDigest = entry.sha256 ?? sha256(fs.readFileSync(stagedAbs));
    journal?.append('publishing', {
      relPath: entry.relPath,
      sha256: verificationDigest,
      target: entry.relPath,
    });
    backupTarget(usbRoot, jobId, entry.relPath, journal);
    try {
      moveIntoPlace(stagedAbs, targetAbs);
    } catch (err) {
      throw describePublishFailure(err, entry.relPath);
    }
    const done = {
      relPath: entry.relPath,
      sha256: verificationDigest,
      size: fs.statSync(targetAbs).size,
    };
    journal?.append('published', done);
    published.push(done);
    if (typeof onFilePublished === 'function') onFilePublished(done, published.length);
  }
  pruneGenerations(usbRoot, GENERATION_KEEP);
  return published;
}

/**
 * Move one staged artifact into place. Artifacts are audio files and playlist
 * files: they are not part of a published generation, so they are journaled as
 * `artifact` rather than `published`, and a crash while moving one leaves the
 * staging copy to be cleaned up instead of restoring an older track.
 */
export function moveStagedArtifact({ usbRoot, staging, relPath, journal }) {
  const source = stagedPath(staging, relPath);
  if (!fs.existsSync(source)) {
    throw new SyncError('staging-missing', `staged artifact is gone: ${relPath}`, { relPath });
  }
  const target = fromRelative(usbRoot, relPath);
  moveIntoPlace(source, target);
  const done = { relPath, size: fs.statSync(target).size };
  journal?.append('artifact', done);
  return done;
}

/** Move every staged file under a folder, one artifact at a time. */
export function moveStagedTree({ usbRoot, staging, relDir, journal }) {
  const from = stagedPath(staging, relDir);
  if (!fs.existsSync(from)) return [];
  const moved = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      moved.push(
        moveStagedArtifact({
          usbRoot,
          staging,
          relPath: toRelative(staging, abs),
          journal,
        })
      );
    }
  };
  walk(from);
  return moved;
}

/**
 * Drop all but the newest `keep` generation folders.
 * @param {string} usbRoot mount point
 * @param {number} [keep]
 */
export function pruneGenerations(usbRoot, keep = GENERATION_KEEP) {
  const root = generationsRoot(usbRoot);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  const dirs = names
    .map((name) => {
      const dir = path.join(root, name);
      try {
        if (!fs.statSync(dir).isDirectory()) return null;
        return { dir, name, mtimeMs: fs.statSync(dir).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of dirs.slice(Math.max(keep, 0))) {
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
}

/** Remove the staging folder of a job that finished, failed or was abandoned. */
export function discardStaging(usbRoot, jobId) {
  fs.rmSync(stagingRoot(usbRoot, jobId), { recursive: true, force: true });
}

/**
 * Finish what an interrupted job left behind, without guessing.
 *
 * Every file the journal marked `publishing` but never `published` is checked
 * against the digest that was about to be written. A target that already
 * carries those bytes was published before the crash: record it. A target that
 * does not (missing or different) is restored from the generation the same job
 * kept, which is the file the medium had before it started.
 *
 * @param {object} options
 * @param {string} options.usbRoot
 * @param {string} options.jobId
 * @param {object[]} options.events journal events of that job
 * @param {object} options.journal journal to append the outcome to
 */
export function recoverJob({ usbRoot, jobId, events, journal }) {
  const publishedRel = new Set(
    events.filter((event) => event.event === 'published').map((event) => event.relPath)
  );
  const pending = events.filter(
    (event) => event.event === 'publishing' && !publishedRel.has(event.relPath)
  );

  for (const event of pending) {
    const target = fromRelative(usbRoot, event.relPath);
    const backup = fromRelative(generationDir(usbRoot, jobId), event.relPath);
    const targetExists = fs.existsSync(target);
    const digest = targetExists ? sha256(fs.readFileSync(target)) : null;
    if (targetExists && (!event.sha256 || digest === event.sha256)) {
      journal.append('published', {
        relPath: event.relPath,
        sha256: digest,
        recovered: true,
      });
      continue;
    }
    if (fs.existsSync(backup)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(backup, target);
      journal.append('restored', { relPath: event.relPath, from: toRelative(usbRoot, backup) });
      continue;
    }
    journal.append('recovered-absent', { relPath: event.relPath });
  }

  journal.append('abandoned', { reason: 'interrupted', pending: pending.length });
  discardStaging(usbRoot, jobId);
  return { restored: pending.length, jobId };
}
