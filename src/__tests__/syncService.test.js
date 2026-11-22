import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncJournal } from '../sync/journal.js';
import { lockPath } from '../sync/paths.js';
import { createSyncService, describeHolder, hasDjManagerData } from '../sync/service.js';

let roots = [];

function stick() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-sync-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** Everything under a folder, with mtimes, to prove nothing was written. */
function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${path.relative(root, abs)}/`);
        walk(abs);
      } else {
        out.push(`${path.relative(root, abs)}:${fs.statSync(abs).mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

function service(overrides = {}) {
  return createSyncService({
    send: vi.fn(),
    findRoots: () => [],
    planFor: () => null,
    isLibraryBusy: () => false,
    pollIntervalMs: 60_000,
    debounceMs: 1_000,
    now: () => 1_000,
    logger: { warn: vi.fn() },
    ...overrides,
  });
}

describe('sync service', () => {
  it('runs one job, commits its fingerprint and reports progress', async () => {
    const root = stick();
    const send = vi.fn();
    const svc = service({ send, findRoots: () => [root] });

    const result = await svc.runJob({
      usbRoot: root,
      trigger: 'manual',
      fingerprint: 'planned',
      execute: async (job) => {
        job.enter('copy', { pct: 10, msg: 'copying' });
        job.stageBuffer('Contents/a.mp3', Buffer.from('audio'));
        job.commitArtifact('Contents/a.mp3');
        return { fingerprint: 'published', summary: { trackCount: 1 } };
      },
    });

    expect(result).toMatchObject({ ok: true, summary: { trackCount: 1 } });
    expect(fs.readFileSync(path.join(root, 'Contents/a.mp3'), 'utf8')).toBe('audio');
    const events = send.mock.calls.filter(([channel]) => channel === 'sync-finished');
    expect(events.at(-1)[1]).toMatchObject({ ok: true, summary: { trackCount: 1 } });
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });

  it('refuses a second job on the same medium and names the holder', async () => {
    const root = stick();
    const svc = service();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const first = svc.runJob({
      usbRoot: root,
      trigger: 'manual',
      execute: async (job) => {
        job.enter('copy');
        await gate;
        return { fingerprint: 'one' };
      },
    });

    await expect(
      svc.runJob({ usbRoot: root, trigger: 'auto', execute: async () => ({}) })
    ).rejects.toMatchObject({ code: 'device-busy' });

    await expect(
      svc.runJob({ usbRoot: root, trigger: 'auto', execute: async () => ({}) })
    ).rejects.toThrow(/held by .*pid \d+/);

    release();
    await first;
    expect(describeHolder(null)).toBe('another writer');
  });

  it('refuses to stop while publishing and reports that ejecting is unsafe', async () => {
    const root = stick();
    const svc = service();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const running = svc.runJob({
      usbRoot: root,
      execute: async (job) => {
        job.enter('publish', { pct: 95 });
        await gate;
        return { fingerprint: 'done' };
      },
    });

    expect(svc.cancel()).toMatchObject({ ok: false, code: 'publishing' });
    expect(svc.status()).toMatchObject({ canCancel: false, canEject: false });

    release();
    await running;
    expect(svc.status()).toMatchObject({ canCancel: false, canEject: true });
  });

  it('stops between phases and records the job as failed', async () => {
    const root = stick();
    const svc = service();

    const running = svc.runJob({
      usbRoot: root,
      execute: async (job) => {
        job.enter('copy');
        expect(svc.cancel()).toMatchObject({ ok: true });
        job.checkpoint();
        return { fingerprint: 'never' };
      },
    });

    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    const journals = fs.readdirSync(path.join(root, '.djmanager', 'journal'));
    const events = fs
      .readFileSync(path.join(root, '.djmanager', 'journal', journals[0]), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    expect(events).toContain('cancel-requested');
    expect(events.at(-1)).toBe('failed');
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });

  it('waits for a stable fingerprint before an automatic sync starts', async () => {
    const root = stick();
    let clock = 0;
    const execute = vi.fn(async (job) => {
      job.enter('copy');
      return { fingerprint: 'fp-1' };
    });
    const svc = service({
      findRoots: () => [root],
      planFor: () => ({ fingerprint: 'fp-1', execute }),
      now: () => clock,
    });

    await svc.checkNow();
    expect(execute).not.toHaveBeenCalled();
    expect(svc.pending()).toEqual([{ usbRoot: root, fingerprint: 'fp-1', since: 0 }]);

    clock = 900;
    await svc.checkNow();
    expect(execute).not.toHaveBeenCalled();

    clock = 1_000;
    await svc.checkNow();
    expect(execute).toHaveBeenCalledTimes(1);

    // The commit recorded fp-1, so the next pass has nothing to do.
    clock = 5_000;
    await svc.checkNow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not start while the library is being written', async () => {
    const root = stick();
    const execute = vi.fn();
    const svc = service({
      findRoots: () => [root],
      planFor: () => ({ fingerprint: 'fp-1', execute }),
      isLibraryBusy: () => true,
    });

    await svc.checkNow();
    expect(execute).not.toHaveBeenCalled();
    expect(svc.pending()).toEqual([]);
  });

  it('does not write to a medium whose last commit matches the plan', async () => {
    const root = stick();
    const journal = new SyncJournal({ usbRoot: root, jobId: 'previous' });
    journal.append('committed', { fingerprint: 'same-state' });
    const before = snapshot(root);

    const execute = vi.fn();
    const svc = service({
      findRoots: () => [root],
      planFor: () => ({ fingerprint: 'same-state', execute }),
      now: () => 50_000,
    });
    await svc.checkNow();
    await svc.checkNow();

    expect(execute).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });

  it('recognises a medium this application exported to before', () => {
    const root = stick();
    expect(hasDjManagerData(root)).toBe(false);
    fs.mkdirSync(path.join(root, 'PIONEER', 'rekordbox'), { recursive: true });
    fs.writeFileSync(path.join(root, 'PIONEER', 'rekordbox', 'export-manifest.json'), '{}');
    expect(hasDjManagerData(root)).toBe(true);
  });
});
