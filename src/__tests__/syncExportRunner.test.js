import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readLibrary } from '../usb/pioneer/formats/pdbRead.js';
import { writePdb } from '../usb/pioneer/formats/pdb.js';
import { writeSettingFiles } from '../usb/pioneer/formats/settings.js';
import { loadManifest, saveManifest } from '../usb/pioneer/manifest.js';
import { reuseExistingUsbTrack } from '../usb/pioneer/formats/reuse.js';
import { createPioneerExportRunner } from '../usb/pioneer/exportRunner.js';
import { readLibrary as readDeviceLibrary } from '../usb/pioneer/onelibrary/index.js';
import { startJob } from '../sync/job.js';
import { generationDir } from '../sync/paths.js';

let roots = [];

function stick() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-runner-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

const tracks = [
  {
    id: 1,
    title: 'Opening',
    artist: 'Artist',
    album: 'Album',
    year: '2026',
    label: 'Label',
    genres: '["House"]',
    duration: 180,
    bitrate: 320000,
    file_size: 1_000,
    bpm: 124,
    bpm_override: null,
    key_raw: '8A',
    key_camelot: '8A',
    beatgrid: null,
    beatgrid_offset: 0,
    trim_start_ms: null,
    trim_end_ms: null,
    rating: 0,
    comments: '',
    replay_gain: null,
    loudness: -9,
    file_path: '/library/opening.mp3',
    track_number: 1,
  },
  {
    id: 2,
    title: 'Closer',
    artist: 'Artist',
    album: 'Album',
    year: '2026',
    label: 'Label',
    genres: '["House"]',
    duration: 200,
    bitrate: 320000,
    file_size: 2_000,
    bpm: 126,
    bpm_override: null,
    key_raw: '9A',
    key_camelot: '9A',
    beatgrid: null,
    beatgrid_offset: 0,
    trim_start_ms: null,
    trim_end_ms: null,
    rating: 0,
    comments: '',
    replay_gain: null,
    loudness: -8,
    file_path: '/library/closer.mp3',
    track_number: 2,
  },
];

function buildRunner(overrides = {}) {
  const copyTrackToUsb = vi.fn(async (track, root) => {
    const name = `${track.id} - ${track.title}.mp3`;
    const dir = path.join(root, 'Contents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `audio-${track.id}`);
    return { path: `/Contents/${name}`, meta: { fileSize: 8, bitrate: 320000 } };
  });

  const deps = {
    getSetting: () => '-9',
    getPlaylist: (id) => ({ id, name: 'Set', rev: 3 }),
    getPlaylists: () => [{ id: 7, name: 'Set' }],
    getPlaylistTracks: (id) => (String(id) === '7' ? tracks : []),
    getCuePoints: () => [],
    loadManifest,
    saveManifest,
    reuseExistingUsbTrack,
    copyTrackToUsb,
    resolveExportTrim: () => null,
    exportDurationSec: (track) => track.duration,
    resolveExportSampleInfo: async () =>
      new Map(tracks.map((track) => [track.id, { sampleRate: 44100, bitDepth: 16 }])),
    backfillPdbSampleInfo: async () => {},
    writeAnlz: async () => {},
    writeSettingFiles,
    runPdbExporter: (payload, root) =>
      writePdb(payload, path.join(root, 'PIONEER', 'rekordbox', 'export.pdb')),
    getFfmpegRuntimePath: () => 'ffmpeg',
    send: () => {},
    ...overrides,
  };
  return { deps, copyTrackToUsb, runner: createPioneerExportRunner(deps) };
}

async function runOn(root, runner, snapshot) {
  const started = startJob({ usbRoot: root, trigger: 'test', fingerprint: 'fp' });
  expect(started.ok).toBe(true);
  try {
    const result = await runner.run({ job: started.job, plan: snapshot });
    started.job.commit({ fingerprint: result.fingerprint, summary: result.summary });
    return result;
  } finally {
    started.job.release();
  }
}

function publishedLibrary(root) {
  const buffer = fs.readFileSync(path.join(root, 'PIONEER', 'rekordbox', 'export.pdb'));
  return readLibrary(buffer);
}

describe('export runner', () => {
  it('writes audio, playlists, settings and a readable database', async () => {
    const root = stick();
    const { runner, copyTrackToUsb } = buildRunner();
    const snapshot = runner.plan({ playlistIds: [7] });

    const result = await runOn(root, runner, snapshot);

    expect(result.summary).toMatchObject({ trackCount: 2, newTrackCount: 2 });
    expect(copyTrackToUsb).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.join(root, 'Contents')).sort()).toEqual([
      '1 - Opening.mp3',
      '2 - Closer.mp3',
    ]);

    const m3u = fs.readFileSync(path.join(root, 'playlists', 'Set.m3u'), 'utf8');
    expect(m3u).toContain('../Contents/1 - Opening.mp3');
    expect(m3u).toContain('#EXTINF:180,Artist - Opening');

    expect(fs.existsSync(path.join(root, 'PIONEER', 'MYSETTING.DAT'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'PIONEER', 'rekordbox', 'export-manifest.json'))).toBe(
      true
    );
    const library = publishedLibrary(root);
    expect(library.tracks).toHaveLength(2);
    expect(library.playlists).toHaveLength(1);

    // The state a sync records has to survive the manifest round trip: the
    // playlist revision drives change detection, and trackIds is the library
    // membership, while track_ids is the subset the player carries.
    const statePlaylist = result.state.playlists.get(7);
    expect(statePlaylist).toMatchObject({ rev: 3, trackIds: [1, 2], track_ids: [1, 2] });
    const reloaded = loadManifest(root).playlists.get(7);
    expect(reloaded).toMatchObject({ rev: 3, trackIds: [1, 2] });
    expect(fs.existsSync(path.join(root, '.djmanager', 'staging'))).toBe(true);
  });

  it('keeps the previous database generation when it publishes again', async () => {
    const root = stick();
    const { runner, copyTrackToUsb } = buildRunner();
    const snapshot = runner.plan({ playlistIds: [7] });
    await runOn(root, runner, snapshot);
    copyTrackToUsb.mockClear();

    // Second run reuses what the manifest already lists, so no audio is copied.
    await runOn(root, runner, snapshot);
    expect(copyTrackToUsb).not.toHaveBeenCalled();
    expect(publishedLibrary(root).tracks).toHaveLength(2);

    const generations = fs.readdirSync(path.join(root, '.djmanager', 'generations'));
    expect(generations).toHaveLength(1);
    const previous = path.join(
      generationDir(root, generations[0]),
      'PIONEER',
      'rekordbox',
      'export.pdb'
    );
    expect(readLibrary(fs.readFileSync(previous)).tracks).toHaveLength(2);
  });

  it('writes a version 2 manifest with a stable export id and the row revisions', async () => {
    const root = stick();
    const { runner } = buildRunner();
    const snapshot = runner.plan({ playlistIds: [7] });

    await runOn(root, runner, snapshot);
    const first = loadManifest(root);
    expect(first.version).toBe(2);
    expect(first.exportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.tracks.get(1)).toMatchObject({ rev: 1, file_path: '/Contents/1 - Opening.mp3' });

    await runOn(root, runner, snapshot);
    const second = loadManifest(root);
    expect(second.exportId).toBe(first.exportId);
  });

  it('asks the change tracker before building an export', async () => {
    const root = stick();
    saveManifest(root, new Map(), new Map([[7, { id: 7, name: 'Set' }]]));

    const idle = buildRunner({ hasPendingWork: async () => false });
    await expect(idle.runner.planFor(root)).resolves.toBeNull();

    const busy = buildRunner({ hasPendingWork: async () => true });
    const plan = await busy.runner.planFor(root);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the device state after publishing', async () => {
    const root = stick();
    const recordExportState = vi.fn(async () => 'serial:TEST');
    const { runner } = buildRunner({
      recordExportState,
      revisionSummary: () => ({ key: '9:2:1:2:0' }),
    });

    await runOn(root, runner, runner.plan({ playlistIds: [7] }));

    expect(recordExportState).toHaveBeenCalledTimes(1);
    const call = recordExportState.mock.calls[0][0];
    expect(call.manifest.version).toBe(2);
    expect(call.revision).toEqual({ key: '9:2:1:2:0' });
    expect([...call.tracks.keys()].sort()).toEqual([1, 2]);
  });

  it('replaces the device rows instead of merging when mirror is on', async () => {
    const root = stick();
    const { runner } = buildRunner({ getPlaylistTracks: () => [tracks[0]] });
    const snapshot = runner.plan({ playlistIds: [7], mirror: true });

    await runOn(root, runner, snapshot);

    const manifest = loadManifest(root);
    expect(manifest.tracks.size).toBe(1);
    expect(publishedLibrary(root).tracks).toHaveLength(1);
    expect(manifest.retired.size).toBe(0);
  });

  it('changes the fingerprint when a field the export writes changes', () => {
    const { runner } = buildRunner();
    const first = runner.plan({ playlistIds: [7] });
    const second = runner.plan({ playlistIds: [7] });
    expect(runner.fingerprint(first)).toBe(runner.fingerprint(second));

    const changedTracks = [tracks[0], { ...tracks[1], title: 'Closer (Extended)' }];
    const changed = buildRunner({
      getPlaylistTracks: () => changedTracks,
    }).runner.plan({ playlistIds: [7] });
    expect(runner.fingerprint(changed)).not.toBe(runner.fingerprint(first));
  });

  it('writes no device library unless it is turned on and has a key', async () => {
    const root = stick();
    const { runner } = buildRunner();
    await runOn(root, runner, runner.plan({ playlistIds: [7] }));

    expect(fs.existsSync(path.join(root, 'PIONEER', 'rekordbox', 'exportLibrary.db'))).toBe(false);
  });

  it('writes an encrypted device library that agrees with the pdb', async () => {
    const root = stick();
    const { runner } = buildRunner({
      getSetting: (name, fallback) =>
        name === 'export_onelibrary'
          ? '1'
          : name === 'rekordbox_library_key'
            ? 'test-library-key'
            : fallback,
      getMyTags: () => [{ id: 5, name: 'Peak Time', parentId: 0, sequenceNo: 0, attribute: 0 }],
      getTagAssignmentsForTracks: () => [{ track_id: 1, tag_id: 5 }],
      getMyTagMasterId: () => 4242,
    });
    const result = await runOn(root, runner, runner.plan({ playlistIds: [7] }));
    expect(result.warnings).toEqual([]);

    const file = path.join(root, 'PIONEER', 'rekordbox', 'exportLibrary.db');
    expect(fs.existsSync(file)).toBe(true);
    // SQLCipher writes a salt where SQLite writes its header.
    expect(fs.readFileSync(file).subarray(0, 16).toString('utf8')).not.toBe('SQLite format 3\0');

    const library = readDeviceLibrary(file, { key: 'test-library-key' });
    expect(library.content).toHaveLength(2);
    expect(library.membership).toHaveLength(2);
    expect(library.content[0]).toMatchObject({
      title: 'Opening',
      path: '/Contents/1 - Opening.mp3',
      fileType: 1,
    });
    expect(library.myTags).toEqual([expect.objectContaining({ myTag_id: 5, name: 'Peak Time' })]);
    expect(library.property[0]).toMatchObject({ myTagMasterDBID: 4242 });
  });

  it('says so when the library cannot be written because no key is configured', async () => {
    const root = stick();
    const { runner } = buildRunner({
      getSetting: (name, fallback) => (name === 'export_onelibrary' ? '1' : fallback),
    });

    const result = await runOn(root, runner, runner.plan({ playlistIds: [7] }));

    expect(fs.existsSync(path.join(root, 'PIONEER', 'rekordbox', 'exportLibrary.db'))).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('device-library-key-missing');
    expect(result.warnings[0].message).toMatch(/no library key is configured/);
  });

  it('says so when the medium already carries a library it did not update', async () => {
    const root = stick();
    const { runner } = buildRunner();
    const library = path.join(root, 'PIONEER', 'rekordbox', 'exportLibrary.db');
    fs.mkdirSync(path.dirname(library), { recursive: true });
    fs.writeFileSync(library, 'written by rekordbox');

    const result = await runOn(root, runner, runner.plan({ playlistIds: [7] }));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('device-library-not-updated');
    expect(result.warnings[0].message).toMatch(/because export_onelibrary is off/);
    // Untouched: the export may not overwrite what it cannot re-encrypt.
    expect(fs.readFileSync(library, 'utf8')).toBe('written by rekordbox');
  });

  it("warns when the medium is in rekordbox's sync set", async () => {
    const root = stick();
    const { runner } = buildRunner();
    const record = path.join(root, 'PIONEER', 'rekordbox', 'playlists3.sync');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, 'DBID=0');

    const result = await runOn(root, runner, runner.plan({ playlistIds: [7] }));

    const syncWarning = result.warnings.find((w) => w.code === 'rekordbox-sync-record');
    expect(syncWarning).toBeDefined();
    expect(syncWarning.message).toContain('PIONEER/rekordbox/playlists3.sync');
    expect(syncWarning.message).toMatch(/rewrite or clear this export/);
    // The file is not ours to touch.
    expect(fs.readFileSync(record, 'utf8')).toBe('DBID=0');
  });

  it('plans an automatic sync from the playlists the manifest carries', async () => {
    const root = stick();
    const { runner } = buildRunner();
    await expect(runner.planFor(root)).resolves.toBeNull();

    const maps = { tracks: new Map(), playlists: new Map([[7, { id: 7, name: 'Set' }]]) };
    saveManifest(root, maps.tracks, maps.playlists);
    const auto = await runner.planFor(root);
    expect(auto.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof auto.execute).toBe('function');
  });

  it('leaves a medium alone when the manifest names only deleted playlists', async () => {
    const root = stick();
    const { runner } = buildRunner({ getPlaylist: () => null });
    saveManifest(root, new Map(), new Map([[99, { id: 99, name: 'Gone' }]]));
    await expect(runner.planFor(root)).resolves.toBeNull();
  });
});
