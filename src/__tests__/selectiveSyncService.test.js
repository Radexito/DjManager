import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSelectiveSyncService } from '../main/services/selectiveSyncService.js';

let roots = [];

function stick() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'djman-selective-'));
  roots.push(root);
  return root;
}

const trackA = { id: 1, title: 'A', rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' };

function setup(overrides = {}) {
  const root = stick();
  mkdirSync(path.join(root, 'Contents'), { recursive: true });
  writeFileSync(path.join(root, 'Contents', 'b.mp3'), 'audio-b');

  const deps = {
    readIdentity: vi.fn(async () => ({ key: 'serial:T', label: 'STICK' })),
    getSelection: () => ({ playlists: [10], kinds: ['playlist'] }),
    saveSelection: vi.fn(() => [10]),
    saveLastPlan: vi.fn(),
    getLastPlan: () => null,
    getTrackStates: () =>
      new Map([
        [1, { track_id: 1, rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' }],
        [2, { track_id: 2, rev: 1, file_path: '/Contents/b.mp3', file_fingerprint: '2:2' }],
      ]),
    getPlaylistStates: () => new Map([[10, { rev: 3, signature: '1' }]]),
    loadManifest: () => ({ ownedFiles: new Set(['/Contents/b.mp3']) }),
    getPlaylist: (id) => ({ id, name: 'Set', rev: 3 }),
    getPlaylistTracks: () => [trackA],
    getCuePoints: () => [],
    readTrackCues: () => [],
    exportRunner: {
      plan: vi.fn(() => ({ options: {} })),
      run: vi.fn(async () => ({
        fingerprint: 'fp',
        state: {
          manifest: { exportId: 'e1', lastSync: 1 },
          tracks: new Map([[1, { id: 1 }]]),
          playlists: new Map([[10, { id: 10, track_ids: [1] }]]),
          revision: { key: 'k' },
        },
        summary: { trackCount: 1, newTrackCount: 1, playlistCount: 1 },
      })),
    },
    syncService: {
      runJob: vi.fn(async ({ execute }) => {
        const job = { id: 'job-1', note: vi.fn() };
        const result = await execute(job);
        return { ok: true, jobId: 'job-1', summary: result.summary };
      }),
    },
    recordExportState: vi.fn(async () => 'serial:T'),
    getRetentionMs: () => 7 * 86_400_000,
    now: () => 1000,
    log: () => {},
    ...overrides,
  };
  return { root, deps, service: createSelectiveSyncService(deps) };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('selective sync service', () => {
  it('previews an update and a playlist change for a device that lags the library', async () => {
    const { root, service } = setup({
      getPlaylistTracks: () => [{ ...trackA, rev: 4 }],
    });

    const preview = await service.preview({ usbRoot: root });
    expect(preview.selection).toEqual([10]);
    // Membership did not change, only the track revision did.
    expect(preview.actions.map((action) => action.type)).toEqual(['update']);
    expect(service.setSelection).toBeTypeOf('function');
  });

  it('shows removals only with mirror on, and never for a file we do not own', async () => {
    const { root, service } = setup();

    const normal = await service.preview({ usbRoot: root });
    expect(normal.actions).toEqual([]);

    const mirror = await service.preview({ usbRoot: root, mirror: true });
    expect(mirror.actions).toEqual([{ type: 'remove', trackId: 2, filePath: '/Contents/b.mp3' }]);
  });

  it('removes a track whose device cues the library already knows', async () => {
    const { root, service } = setup({
      readTrackCues: () => [
        { hotCueIndex: 0, positionMs: 1000 },
        { hotCueIndex: -1, positionMs: 5000 },
      ],
      getCuePoints: () => [
        { id: 1, track_id: 2, position_ms: 1040, hot_cue_index: 0 },
        { id: 2, track_id: 2, position_ms: 5100, hot_cue_index: -1 },
      ],
    });

    const mirror = await service.preview({ usbRoot: root, mirror: true });
    expect(mirror.actions).toEqual([{ type: 'remove', trackId: 2, filePath: '/Contents/b.mp3' }]);
  });

  it('keeps a track that carries a device cue the library does not have', async () => {
    const { root, service } = setup({
      readTrackCues: () => [{ hotCueIndex: 3, positionMs: 1000 }],
      getCuePoints: () => [{ id: 1, track_id: 2, position_ms: 1000, hot_cue_index: 0 }],
    });

    const mirror = await service.preview({ usbRoot: root, mirror: true });
    expect(mirror.actions).toEqual([
      { type: 'keep', trackId: 2, filePath: '/Contents/b.mp3', reason: 'device-cues' },
    ]);
  });

  it('refuses to apply a plan the caller did not see', async () => {
    const { root, deps, service } = setup();

    await expect(
      service.apply({ usbRoot: root, mirror: true, expectedHash: 'stale' })
    ).rejects.toMatchObject({ code: 'plan-changed' });
    expect(deps.syncService.runJob).not.toHaveBeenCalled();
  });

  it('does nothing at all when the plan is empty', async () => {
    const { root, deps, service } = setup();

    const result = await service.apply({ usbRoot: root });
    expect(result).toMatchObject({ ok: true, skipped: true, removed: 0 });
    expect(deps.syncService.runJob).not.toHaveBeenCalled();
    expect(deps.exportRunner.run).not.toHaveBeenCalled();
  });

  it('applies exactly the previewed plan, trashes the file and records both', async () => {
    const { root, deps, service } = setup();
    const preview = await service.preview({ usbRoot: root, mirror: true });

    const result = await service.apply({
      usbRoot: root,
      mirror: true,
      expectedHash: preview.hash,
    });

    expect(result).toMatchObject({ ok: true, removed: 1, planHash: preview.hash });
    expect(deps.syncService.runJob).toHaveBeenCalledTimes(1);
    expect(deps.exportRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ recordState: false })
    );

    expect(existsSync(path.join(root, 'Contents', 'b.mp3'))).toBe(false);
    expect(existsSync(path.join(root, '.device-trash', 'job-1', 'Contents', 'b.mp3'))).toBe(true);

    expect(deps.recordExportState).toHaveBeenCalledTimes(1);
    // Publication comes first, then the file move, then the state that forgets
    // the removed track. A crash in between leaves an orphan the next preview
    // still lists, instead of a file nothing points at.
    expect(deps.exportRunner.run.mock.invocationCallOrder[0]).toBeLessThan(
      deps.recordExportState.mock.invocationCallOrder[0]
    );
    const saved = deps.saveLastPlan.mock.calls[0][0];
    expect(saved).toMatchObject({ deviceKey: 'serial:T', hash: preview.hash });
    expect(saved.actions).toEqual(preview.actions);
  });

  it('names the holder when another sync owns the device', async () => {
    const { root, service } = setup({
      syncService: {
        runJob: vi.fn(async () => {
          throw Object.assign(new Error('The device is busy: held by pid 42'), {
            code: 'device-busy',
          });
        }),
      },
    });
    const preview = await service.preview({ usbRoot: root, mirror: true });

    await expect(
      service.apply({ usbRoot: root, mirror: true, expectedHash: preview.hash })
    ).rejects.toMatchObject({ code: 'device-busy' });
  });

  it('stores a new selection for the device', async () => {
    const { root, deps, service } = setup();
    await expect(
      service.setSelection({ usbRoot: root, playlistIds: [10, 11] })
    ).resolves.toMatchObject({ ok: true, deviceKey: 'serial:T', playlists: [10] });
    expect(deps.saveSelection).toHaveBeenCalledWith('serial:T', [10, 11]);
  });
});
