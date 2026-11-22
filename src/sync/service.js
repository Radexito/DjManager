import fs from 'node:fs';
import path from 'node:path';

import { SyncError } from './errors.js';
import { startJob } from './job.js';
import { lastCommit } from './journal.js';

/**
 * The sync engine: one job per medium, automatic starts when it is safe, and a
 * status a caller can refuse to stop or eject from.
 *
 * Automatic sync is deliberately conservative. It only considers a medium this
 * application already wrote to (the manifest is there), it compares the
 * fingerprint of what would be exported with the fingerprint of the last
 * committed job, and it requires that fingerprint to be stable for a debounce
 * window before it starts. A library that did not change produces no job and no
 * write on the device, which is the difference between "sync" and "rewrite the
 * whole stick every fifteen seconds".
 */

/** What a refusal says when the medium is held by someone else. */
export function describeHolder(holder) {
  if (!holder) return 'another writer';
  const who = holder.host ? `${holder.host} pid ${holder.pid}` : `pid ${holder.pid}`;
  return `${who} (job ${holder.jobId ?? 'unknown'}, phase ${holder.phase ?? 'unknown'})`;
}

/** A medium this application has exported to before. */
export function hasDjManagerData(usbRoot) {
  return fs.existsSync(path.join(usbRoot, 'PIONEER', 'rekordbox', 'export-manifest.json'));
}

/**
 * @param {object} options
 * @param {function(string, any): void} [options.send] renderer event sink
 * @param {function(string): Promise<{fingerprint: string, execute: function}|null>}
 *   [options.planFor] describes the work a medium needs, or null to leave it alone
 * @param {function(): string[]} [options.findRoots] mounted removable media
 * @param {function(): boolean} [options.isLibraryBusy] an import or analysis is writing
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.debounceMs]
 * @param {function(): number} [options.now]
 * @param {object} [options.logger]
 */
export function createSyncService({
  send = () => {},
  planFor = () => null,
  findRoots = () => [],
  isLibraryBusy = () => false,
  pollIntervalMs = 15_000,
  debounceMs = 3_000,
  now = Date.now,
  logger = console,
} = {}) {
  const active = new Map();
  const pending = new Map();
  let timer = null;
  let ticking = false;

  const emit = (channel, payload) => {
    try {
      send(channel, payload);
    } catch {
      /* a closed window must not fail a running job */
    }
  };

  /**
   * Run one job start to finish.
   * @param {object} options
   * @param {string} options.usbRoot
   * @param {string} [options.trigger]
   * @param {string|null} [options.fingerprint]
   * @param {function(object): Promise<{fingerprint?: string, summary?: object}>} options.execute
   * @returns {Promise<object>}
   */
  async function runJob({ usbRoot, trigger = 'manual', fingerprint = null, execute } = {}) {
    if (!usbRoot) throw new SyncError('missing-usb-root', 'A mount point is required');
    if (typeof execute !== 'function') {
      throw new SyncError('missing-plan', 'A job needs work to run');
    }

    const running = active.get(usbRoot);
    if (running) {
      const holder = running.snapshot();
      throw new SyncError('device-busy', `The device is busy: held by ${describeHolder(holder)}`, {
        holder,
      });
    }
    if (active.size > 0) {
      const other = [...active.values()][0].snapshot();
      throw new SyncError('sync-in-progress', 'Another sync is already running', { holder: other });
    }
    if (trigger !== 'manual' && isLibraryBusy()) {
      throw new SyncError('library-busy', 'The library is being written by an import or analysis');
    }

    const started = startJob({
      usbRoot,
      trigger,
      fingerprint,
      now,
      onProgress: (progress) => emit('sync-progress', progress),
    });
    if (!started.ok) {
      throw new SyncError(
        started.reason,
        `The device is busy: held by ${describeHolder(started.holder)}`,
        { holder: started.holder }
      );
    }

    const { job, recovered } = started;
    active.set(usbRoot, job);
    emit('sync-started', { ...job.snapshot(), recovered });

    try {
      const result = (await execute(job)) ?? {};
      job.commit({
        fingerprint: result.fingerprint ?? fingerprint,
        summary: result.summary ?? null,
      });
      const finished = { ...job.snapshot(), ok: true, summary: result.summary ?? null, recovered };
      emit('sync-finished', finished);
      return finished;
    } catch (err) {
      job.fail(err);
      emit('sync-finished', {
        ...job.snapshot(),
        ok: false,
        code: err?.code ?? 'internal',
        message: err?.message ?? String(err),
      });
      throw err;
    } finally {
      job.release();
      active.delete(usbRoot);
    }
  }

  /** Stop the running job, unless it is publishing. */
  function cancel({ usbRoot } = {}) {
    const jobs = usbRoot ? [active.get(usbRoot)].filter(Boolean) : [...active.values()];
    if (jobs.length === 0) {
      return { ok: false, code: 'no-sync', message: 'No sync is running' };
    }
    const results = jobs.map((job) => job.cancel());
    const refused = results.find((result) => !result.ok);
    if (refused) {
      return {
        ok: false,
        code: refused.code,
        message: refused.message ?? 'Sync cannot stop now',
        jobId: refused.jobId,
      };
    }
    return { ok: true, jobIds: results.map((result) => result.jobId) };
  }

  /** State the renderer or a stop/eject action branches on. */
  function status() {
    const jobs = [...active.values()].map((job) => job.snapshot());
    return {
      ok: true,
      jobs,
      canCancel: jobs.some((job) => job.cancellable),
      canEject: jobs.every((job) => job.ejectable),
    };
  }

  /** True while this engine or the library is writing. */
  function isBusy() {
    return active.size > 0 || isLibraryBusy();
  }

  async function tick() {
    if (ticking || active.size > 0) return;
    ticking = true;
    try {
      if (isLibraryBusy()) return;
      const roots = findRoots();
      for (const usbRoot of roots) {
        if (active.has(usbRoot)) continue;
        let plan = null;
        try {
          plan = await planFor(usbRoot);
        } catch (err) {
          logger.warn?.(`[sync] could not plan ${usbRoot}: ${err.message}`);
          continue;
        }
        if (!plan?.fingerprint || typeof plan.execute !== 'function') {
          pending.delete(usbRoot);
          continue;
        }
        const last = lastCommit(usbRoot);
        if (last?.fingerprint && last.fingerprint === plan.fingerprint) {
          pending.delete(usbRoot);
          continue;
        }
        const seen = pending.get(usbRoot);
        if (!seen || seen.fingerprint !== plan.fingerprint) {
          pending.set(usbRoot, { fingerprint: plan.fingerprint, since: now() });
          continue;
        }
        if (now() - seen.since < debounceMs) continue;
        pending.delete(usbRoot);
        try {
          await runJob({
            usbRoot,
            trigger: 'auto',
            fingerprint: plan.fingerprint,
            execute: plan.execute,
          });
        } catch (err) {
          if (err?.code !== 'cancelled') {
            logger.warn?.(`[sync] automatic sync failed: ${err?.message ?? err}`);
          }
        }
      }
      for (const usbRoot of [...pending.keys()]) {
        if (!roots.includes(usbRoot)) pending.delete(usbRoot);
      }
    } finally {
      ticking = false;
    }
  }

  return {
    runJob,
    cancel,
    status,
    isBusy,
    /** Recompute automatic sync now. Used by tests and by the device watcher. */
    checkNow: tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, pollIntervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    /** Exposed for tests: which media are waiting for a stable fingerprint. */
    pending() {
      return [...pending.entries()].map(([usbRoot, state]) => ({ usbRoot, ...state }));
    },
  };
}
