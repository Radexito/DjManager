import fs from 'node:fs';
import os from 'node:os';

import { lockPath, syncRoot } from './paths.js';

/**
 * One writer per medium, enforced on the medium itself.
 *
 * A lock inside the application would only cover this process. The file lives
 * on the stick instead, so a second window, a second machine or a stale run
 * left behind by a killed process all meet the same holder record. The record
 * names its owner (pid, host, job, phase, start time) because a refusal that
 * cannot name the holder is useless to the person looking at it.
 *
 * Liveness is decided from the heartbeat first: another host's pid means
 * nothing here, so a record whose heartbeat is younger than `staleMs` is
 * treated as alive whatever it says. A record on this host whose process is
 * gone is stale immediately. Taking over a stale lock writes a fresh record
 * through a temporary file and re-reads it, so two contenders cannot both
 * believe they won.
 */

export const LOCK_VERSION = 1;

/** A heartbeat older than this is stale even when the pid still exists. */
export const DEFAULT_STALE_MS = 120_000;

/** Read the lock record, or null when the file is absent or unreadable. */
export function readLock(usbRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath(usbRoot), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Whether the process that wrote the record still exists on this host.
 * @param {object|null} lock
 * @param {object} [options]
 * @param {string} [options.hostname] host to compare against
 * @param {function(number, number): void} [options.kill] process probe
 */
export function holderAlive(lock, { hostname = os.hostname(), kill = process.kill } = {}) {
  if (!lock) return false;
  if (lock.host !== hostname) return true;
  try {
    kill(lock.pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Whether a lock record can be taken over.
 * @param {object|null} lock
 * @param {object} [options]
 * @param {number} [options.now] current time in ms
 * @param {number} [options.staleMs] heartbeat age that makes a record stale
 * @param {string} [options.hostname]
 * @param {function(number, number): void} [options.kill]
 */
export function lockIsStale(
  lock,
  {
    now = Date.now(),
    staleMs = DEFAULT_STALE_MS,
    hostname = os.hostname(),
    kill = process.kill,
  } = {}
) {
  if (!lock) return true;
  const beat = Number(lock.heartbeatAt ?? lock.startedAt ?? 0);
  if (!beat || now - beat > staleMs) return true;
  return !holderAlive(lock, { hostname, kill });
}

/** Replace the lock file atomically, so a reader never sees half a record. */
function writeLockFile(usbRoot, lock) {
  fs.mkdirSync(syncRoot(usbRoot), { recursive: true });
  const target = lockPath(usbRoot);
  const tmp = `${target}.${process.pid}.${lock.heartbeatAt}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock), 'utf8');
  try {
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* fsync is best effort on filesystems that do not support it */
  }
  fs.renameSync(tmp, target);
}

/**
 * Claim the medium for one job.
 *
 * @param {string} usbRoot mount point
 * @param {object} options
 * @param {string} options.jobId identifier of the job asking for the medium
 * @param {string} [options.trigger] manual, device or library
 * @param {string} [options.phase] phase the job starts in
 * @param {number} [options.now]
 * @param {number} [options.pid]
 * @param {string} [options.hostname]
 * @param {number} [options.staleMs]
 * @returns {{ok: true, lock: object, tookOver: boolean, previous: object|null}
 *   | {ok: false, reason: string, holder: object|null}}
 */
export function acquireLock(
  usbRoot,
  {
    jobId,
    trigger = 'manual',
    phase = 'plan',
    now = Date.now(),
    pid = process.pid,
    hostname = os.hostname(),
    staleMs = DEFAULT_STALE_MS,
  } = {}
) {
  if (!jobId) throw new Error('acquireLock: a jobId is required');
  fs.mkdirSync(syncRoot(usbRoot), { recursive: true });

  const lock = {
    version: LOCK_VERSION,
    jobId,
    pid,
    host: hostname,
    trigger,
    phase,
    startedAt: now,
    heartbeatAt: now,
  };
  const file = lockPath(usbRoot);

  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(lock), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, lock, tookOver: false, previous: null };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const previous = readLock(usbRoot);
  if (!lockIsStale(previous, { now, staleMs, hostname })) {
    return { ok: false, reason: 'device-busy', holder: previous };
  }

  writeLockFile(usbRoot, lock, { replace: true });
  const confirmed = readLock(usbRoot);
  if (confirmed?.jobId !== jobId) {
    return { ok: false, reason: 'device-busy', holder: confirmed };
  }
  return { ok: true, lock, tookOver: true, previous };
}

/**
 * Refresh the heartbeat and phase. Answers false when the medium is no longer
 * held by this job, which is how a job learns its lock was taken over.
 */
export function heartbeatLock(
  usbRoot,
  jobId,
  { phase, now = Date.now(), hostname = os.hostname(), pid = process.pid, trigger } = {}
) {
  const current = readLock(usbRoot);
  if (!current || current.jobId !== jobId) return false;
  const next = {
    ...current,
    ...(phase ? { phase } : {}),
    ...(trigger ? { trigger } : {}),
    pid,
    host: hostname,
    heartbeatAt: now,
  };
  writeLockFile(usbRoot, next, { replace: true });
  return true;
}

/** Release the medium, but only when this job still holds it. */
export function releaseLock(usbRoot, jobId) {
  const current = readLock(usbRoot);
  if (!current || current.jobId !== jobId) return false;
  try {
    fs.rmSync(lockPath(usbRoot), { force: true });
    return true;
  } catch {
    return false;
  }
}
