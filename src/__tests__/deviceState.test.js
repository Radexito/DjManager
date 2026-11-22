import { afterEach, describe, expect, it } from 'vitest';

import db from '../db/database.js';
import {
  deleteDeviceState,
  getCueBase,
  getDeviceSyncState,
  getPlaylistStates,
  getTrackStates,
  saveCueBase,
  saveDeviceSyncState,
  savePlaylistStates,
  saveTrackStates,
} from '../db/deviceStateRepository.js';
import { rebuildMergeBase } from '../sync/mergeBase.js';

const DEVICE = 'serial:TEST1234';

afterEach(() => {
  deleteDeviceState(DEVICE);
  db.prepare('DELETE FROM device_sync_state').run();
});

describe('device state', () => {
  it('keeps one row per device and updates it in place', () => {
    saveDeviceSyncState({
      deviceKey: DEVICE,
      exportId: 'export-1',
      label: 'STICK',
      serial: 'TEST1234',
      filesystem: 'vfat',
      mountPath: '/media/a',
      lastSync: 100,
      libraryRevision: '9:1:1:1:0',
    });
    expect(getDeviceSyncState(DEVICE)).toMatchObject({
      export_id: 'export-1',
      label: 'STICK',
      last_mount_path: '/media/a',
      library_revision: '9:1:1:1:0',
    });

    saveDeviceSyncState({
      deviceKey: DEVICE,
      exportId: 'export-1',
      label: 'STICK',
      serial: 'TEST1234',
      filesystem: 'vfat',
      mountPath: '/media/b',
      lastSync: 200,
      libraryRevision: '10:1:1:1:0',
    });
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM device_sync_state WHERE device_key = ?')
      .get(DEVICE);
    expect(rows.n).toBe(1);
    expect(getDeviceSyncState(DEVICE)).toMatchObject({
      last_mount_path: '/media/b',
      library_revision: '10:1:1:1:0',
    });
  });

  it('stores track states and drops the ones no longer exported', () => {
    saveTrackStates(DEVICE, [
      { trackId: 1, filePath: '/Contents/a.mp3', rev: 2, hash: 'h1', fileFingerprint: '1:1' },
      { trackId: 2, filePath: '/Contents/b.mp3', rev: 3, hash: 'h2', fileFingerprint: '2:2' },
    ]);
    expect([...getTrackStates(DEVICE).keys()]).toEqual([1, 2]);

    saveTrackStates(DEVICE, [
      { trackId: 1, filePath: '/Contents/a.mp3', rev: 4, hash: 'h1', fileFingerprint: '1:1' },
    ]);
    const states = getTrackStates(DEVICE);
    expect([...states.keys()]).toEqual([1]);
    expect(states.get(1).rev).toBe(4);
  });

  it('stores playlist revisions and membership signatures', () => {
    savePlaylistStates(DEVICE, [{ playlistId: 10, rev: 2, signature: '1,2,3' }]);
    expect(getPlaylistStates(DEVICE).get(10)).toMatchObject({ rev: 2, signature: '1,2,3' });
  });

  it('keeps the cue base for a track', () => {
    saveCueBase({
      deviceKey: DEVICE,
      trackId: 5,
      hash: 'abc',
      cues: [{ positionMs: 1000, label: 'A' }],
    });
    expect(getCueBase(DEVICE, 5)).toMatchObject({
      hash: 'abc',
      cues: [{ positionMs: 1000, label: 'A' }],
    });
    expect(getCueBase(DEVICE, 6)).toBeNull();
  });

  it('rebuilds the merge base from a manifest and reports what is lost', () => {
    const manifest = {
      exportId: 'export-9',
      lastSync: 77,
      tracks: new Map([
        [1, { id: 1, file_path: '/Contents/a.mp3', rev: 3, hash: 'h1' }],
        [2, { id: 2, file_path: '/Contents/b.mp3', rev: 1 }],
      ]),
      playlists: new Map([[10, { id: 10, name: 'Set', rev: 2, track_ids: [1] }]]),
      ownedFiles: new Set(['/Contents/a.mp3', '/Contents/b.mp3']),
      retired: new Map(),
    };
    const resolveTrack = (id) => (id === 1 ? { id: 1, file_path: '/library/a.mp3', rev: 3 } : null);

    const result = rebuildMergeBase({ deviceKey: DEVICE, manifest, resolveTrack });

    expect(result.restored).toBe(1);
    expect(result.lost).toEqual([{ trackId: 2, filePath: '/Contents/b.mp3' }]);
    const state = getDeviceSyncState(DEVICE);
    expect(state.export_id).toBe('export-9');
    expect(JSON.parse(state.manifest_json).tracks).toHaveLength(2);
    expect(getTrackStates(DEVICE).get(1)).toMatchObject({
      file_path: '/Contents/a.mp3',
      rev: 3,
      hash: 'h1',
    });
    expect(getPlaylistStates(DEVICE).get(10).signature).toBe('1');
  });
});
