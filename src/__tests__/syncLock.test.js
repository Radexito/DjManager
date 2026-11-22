import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireLock,
  heartbeatLock,
  lockIsStale,
  readLock,
  releaseLock,
} from '../sync/deviceLock.js';
import { lockPath } from '../sync/paths.js';

let roots = [];

function stick() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-lock-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('device lock', () => {
  it('creates a lock and refuses a second job, naming the holder', () => {
    const root = stick();
    const first = acquireLock(root, { jobId: 'job-a', trigger: 'manual', now: 1000 });
    expect(first.ok).toBe(true);
    expect(readLock(root)).toMatchObject({ jobId: 'job-a', trigger: 'manual', phase: 'plan' });

    const second = acquireLock(root, { jobId: 'job-b', now: 1100 });
    expect(second).toMatchObject({ ok: false, reason: 'device-busy' });
    expect(second.holder).toMatchObject({ jobId: 'job-a', pid: process.pid });
  });

  it('refreshes the heartbeat and refuses a release from another job', () => {
    const root = stick();
    acquireLock(root, { jobId: 'job-a', now: 1000 });
    expect(heartbeatLock(root, 'job-a', { phase: 'publish', now: 2000 })).toBe(true);
    expect(readLock(root)).toMatchObject({ phase: 'publish', heartbeatAt: 2000 });

    expect(releaseLock(root, 'job-b')).toBe(false);
    expect(fs.existsSync(lockPath(root))).toBe(true);

    expect(releaseLock(root, 'job-a')).toBe(true);
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });

  it('takes over a lock whose process is gone and records the previous holder', () => {
    const root = stick();
    fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({
        version: 1,
        jobId: 'dead-job',
        pid: 999_999,
        host: os.hostname(),
        phase: 'copy',
        startedAt: 1000,
        heartbeatAt: 1000,
      })
    );

    expect(lockIsStale(readLock(root), { now: 1500 })).toBe(true);
    const taken = acquireLock(root, { jobId: 'job-c', now: 1500 });
    expect(taken.ok).toBe(true);
    expect(taken.tookOver).toBe(true);
    expect(taken.previous).toMatchObject({ jobId: 'dead-job', phase: 'copy' });
    expect(readLock(root).jobId).toBe('job-c');
  });

  it('treats a fresh heartbeat from another host as alive whatever the pid says', () => {
    const root = stick();
    fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({
        version: 1,
        jobId: 'remote',
        pid: 999_999,
        host: 'another-host',
        startedAt: 1000,
        heartbeatAt: 1000,
      })
    );

    expect(lockIsStale(readLock(root), { now: 1500, staleMs: 5000 })).toBe(false);
    const refused = acquireLock(root, { jobId: 'job-d', now: 1500, staleMs: 5000 });
    expect(refused).toMatchObject({ ok: false, reason: 'device-busy' });
  });
});
