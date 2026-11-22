import { acquireLock, heartbeatLock, releaseLock } from './deviceLock.js';
import { SyncError } from './errors.js';
import { readJournal, SyncJournal, unfinishedJobs } from './journal.js';
import { stagingRoot } from './paths.js';
import {
  describeStaged,
  discardStaging,
  moveStagedArtifact,
  moveStagedTree,
  publishStaged,
  recoverJob,
  stagedPath,
  writeStagedBuffer,
} from './publication.js';

/**
 * One sync job on one medium.
 *
 * The job owns the lock, the journal and the staging folder, and it is the only
 * place that decides when a file becomes visible on the stick. Callers hand it
 * work in phases and it reports progress for each one. Cancellation is checked
 * between phases and between files; it is refused once publication started,
 * because stopping halfway through a rename set is the one state the journal
 * cannot make safe.
 */

/** Human-facing phase order. Progress is reported from this list. */
export const PHASES = ['plan', 'copy', 'analysis', 'database', 'publish', 'done'];

/** Identifier that sorts by time and is a legal file name on every platform. */
export function newJobId(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${process.pid}`;
}

/** Reopen an interrupted job's journal and settle what it published. */
function recoverInterrupted(usbRoot, currentJobId, now) {
  const recovered = [];
  for (const interrupted of unfinishedJobs(usbRoot)) {
    if (interrupted.jobId === currentJobId) continue;
    try {
      const journal = new SyncJournal({ usbRoot, jobId: interrupted.jobId, now });
      const events = readJournal(usbRoot, interrupted.jobId);
      recovered.push(recoverJob({ usbRoot, jobId: interrupted.jobId, events, journal }));
    } catch (err) {
      // A journal that cannot be replayed must not block the new job. It stays
      // on the stick untouched, which is exactly what makes it explainable.
      recovered.push({ jobId: interrupted.jobId, error: err.message });
    }
  }
  return recovered;
}

/**
 * Claim a medium and open a job on it.
 *
 * @param {object} options
 * @param {string} options.usbRoot mount point
 * @param {string} [options.trigger] manual, device, library or test
 * @param {string|null} [options.fingerprint] planned library state, recorded in the journal
 * @param {string} [options.jobId] reuse an id when resuming
 * @param {number} [options.staleMs]
 * @param {function(): number} [options.now]
 * @param {string} [options.hostname]
 * @param {number} [options.pid]
 * @param {function(object): void} [options.onProgress] progress sink
 * @param {function(string, object): void} [options.onPhase] phase hook, also used by crash tests
 * @returns {{ok: true, job: object, recovered: object[]}
 *   | {ok: false, reason: string, holder: object|null}}
 */
export function startJob({
  usbRoot,
  trigger = 'manual',
  fingerprint = null,
  jobId,
  staleMs,
  now = Date.now,
  hostname,
  pid,
  onProgress = () => {},
  onPhase = () => {},
} = {}) {
  if (!usbRoot) throw new SyncError('missing-usb-root', 'A mount point is required');
  const id = jobId ?? newJobId(now());

  const acquired = acquireLock(usbRoot, {
    jobId: id,
    trigger,
    now: now(),
    hostname,
    pid,
    staleMs,
  });
  if (!acquired.ok) {
    return { ok: false, reason: acquired.reason, holder: acquired.holder };
  }

  const journal = new SyncJournal({ usbRoot, jobId: id, now });
  journal.append('job-start', {
    trigger,
    fingerprint,
    pid: acquired.lock.pid,
    host: acquired.lock.host,
    tookOver: acquired.tookOver,
    previous: acquired.previous,
  });

  const recovered = recoverInterrupted(usbRoot, id, now);

  const job = {
    id,
    usbRoot,
    trigger,
    staging: stagingRoot(usbRoot, id),
    journal,
    phase: 'plan',
    pct: 0,
    startedAt: now(),
    cancelled: false,
    released: false,
    pid: acquired.lock.pid,
    host: acquired.lock.host,
  };

  /** Move to the next phase: heartbeat, journal, progress, lock ownership check. */
  job.enter = (phase, { pct, msg, detail = {} } = {}) => {
    if (job.cancelled && phase !== 'publish') {
      throw new SyncError('cancelled', 'Sync was cancelled', { jobId: job.id });
    }
    job.phase = phase;
    if (pct != null) job.pct = pct;
    const alive = heartbeatLock(usbRoot, job.id, { phase, now: now(), hostname, pid });
    journal.append('phase', { phase, pct: job.pct, ...(msg ? { msg } : {}), ...detail });
    onProgress({ jobId: job.id, usbRoot, trigger, phase, pct: job.pct, msg: msg ?? null });
    onPhase(phase, { jobId: job.id, ...detail });
    if (!alive) {
      throw new SyncError('lock-lost', 'Another writer took the medium', { jobId: job.id });
    }
  };

  /** Progress inside a phase, without a journal line per file. */
  job.report = (msg, pct) => {
    if (pct != null) job.pct = pct;
    onProgress({ jobId: job.id, usbRoot, trigger, phase: job.phase, pct: job.pct, msg });
  };

  /** Stop here if cancellation was requested. */
  job.checkpoint = () => {
    if (job.cancelled) {
      throw new SyncError('cancelled', 'Sync was cancelled', { jobId: job.id });
    }
    if (job.released) {
      throw new SyncError('job-released', 'Sync job already finished', { jobId: job.id });
    }
  };

  /** Ask the job to stop. Refused while files are being published. */
  job.cancel = () => {
    if (job.phase === 'publish') {
      return {
        ok: false,
        code: 'publishing',
        message: 'Cannot stop while publishing',
        jobId: job.id,
      };
    }
    job.cancelled = true;
    journal.append('cancel-requested', { phase: job.phase });
    return { ok: true, jobId: job.id };
  };

  /** Write a buffer into staging and record its digest. */
  job.stageBuffer = (relPath, buffer) => {
    job.checkpoint();
    const entry = writeStagedBuffer(job.staging, relPath, buffer);
    journal.append('staged', entry);
    return entry;
  };

  /** Absolute staging path for a writer that writes the file itself. */
  job.stagePath = (relPath) => stagedPath(job.staging, relPath);

  /** Digest of a file a writer already placed in staging. */
  job.describeStaged = (relPath) => {
    const entry = describeStaged(job.staging, relPath);
    journal.append('staged', entry);
    return entry;
  };

  /** Move one finished artifact (audio, playlist file) into place. */
  job.commitArtifact = (relPath) =>
    moveStagedArtifact({ usbRoot, staging: job.staging, relPath, journal });

  /** Move every file staged under a folder (playlists, artwork) into place. */
  job.commitArtifactTree = (relDir) =>
    moveStagedTree({ usbRoot, staging: job.staging, relDir, journal });

  /** Publish the staged files that players read, one atomic rename each. */
  job.publish = (entries, { onFilePublished } = {}) => {
    job.checkpoint();
    job.enter('publish', { pct: 95, msg: 'Publishing database' });
    const published = publishStaged({
      usbRoot,
      jobId: job.id,
      staging: job.staging,
      entries,
      journal,
      onFilePublished,
    });
    return published;
  };

  /** Close the job as successful. The fingerprint is what the next check compares. */
  job.commit = ({ fingerprint: committedFingerprint = null, summary = null } = {}) => {
    job.enter('done', { pct: 100, msg: 'Done' });
    journal.append('committed', { fingerprint: committedFingerprint, summary });
    discardStaging(usbRoot, job.id);
  };

  /** Close the job as failed, keeping the journal for the next explanation. */
  job.fail = (err) => {
    if (job.released) return;
    try {
      journal.append('failed', {
        code: err?.code ?? 'internal',
        message: err?.message ?? String(err),
      });
    } catch {
      /* the journal itself is unavailable; nothing else to record */
    }
    discardStaging(usbRoot, job.id);
  };

  /** Give the medium back. Safe to call twice. */
  job.release = () => {
    if (job.released) return;
    job.released = true;
    releaseLock(usbRoot, job.id);
  };

  /** Snapshot for the status channel. */
  job.snapshot = () => ({
    jobId: job.id,
    usbRoot,
    trigger,
    pid: job.pid,
    host: job.host,
    phase: job.phase,
    pct: job.pct,
    startedAt: job.startedAt,
    cancellable: job.phase !== 'publish',
    ejectable: job.phase !== 'publish',
  });

  job.enter('plan', { pct: 0, msg: 'Planning export' });

  return { ok: true, job, recovered };
}
