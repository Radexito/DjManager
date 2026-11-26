import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readLibrary, readPdb } from '../usb/pioneer/formats/pdbRead.js';
import { getAnlzFolder } from '../usb/pioneer/formats/anlz.js';
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

/** A stand-in for ffmpeg that appends one line per call, so a test can count them. */
function recordingFfmpeg(dir, logFile) {
  const file = path.join(dir, 'ffmpeg-record');
  fs.writeFileSync(
    file,
    `#!/bin/sh
log="${logFile}"
for last; do :; done
printf 'call\\n' >> "$log"
printf '\\377\\330\\377\\331' > "$last"
`,
    { mode: 0o755 }
  );
  return file;
}

/** A stand-in for ffmpeg: writes the smallest valid JPEG to its last argument. */
function stubFfmpeg(dir) {
  const file = path.join(dir, 'ffmpeg-stub');
  fs.writeFileSync(
    file,
    `#!/bin/sh
for last; do :; done
printf '\\377\\330\\377\\331' > "$last"
`,
    { mode: 0o755 }
  );
  return file;
}

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

  it('writes ANLZ only for a track whose analysis or files changed', async () => {
    const root = stick();
    const calls = [];
    const writeAnlzStub = async ({ usbRoot, usbFilePath }) => {
      const dir = path.join(usbRoot, ...getAnlzFolder(usbFilePath).split('/'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ANLZ0000.DAT'), `dat-${calls.length}`);
      fs.writeFileSync(path.join(dir, 'ANLZ0000.EXT'), `ext-${calls.length}`);
      calls.push(usbFilePath);
    };
    const anlzPaths = (usbFilePath) => {
      const dir = path.join(root, ...getAnlzFolder(usbFilePath).split('/'));
      return ['ANLZ0000.DAT', 'ANLZ0000.EXT'].map((name) => path.join(dir, name));
    };
    const runWith = async (list) => {
      const { runner } = buildRunner({ getPlaylistTracks: () => list, writeAnlz: writeAnlzStub });
      return runOn(root, runner, runner.plan({ playlistIds: [7] }));
    };

    const first = await runWith(tracks);
    expect(calls).toHaveLength(2);
    expect(first.summary).toMatchObject({ anlzWrittenCount: 2, anlzSkippedCount: 0 });
    expect(loadManifest(root).tracks.get(1).anlz_digest).toMatch(/^[0-9a-f]{64}$/);

    const files = anlzPaths('/Contents/1 - Opening.mp3');
    const mtimes = () => files.map((file) => fs.statSync(file).mtimeMs);
    const written = mtimes();

    // Nothing about the analysis changed: no ffmpeg pass, no write, same files.
    const second = await runWith(tracks);
    expect(calls).toHaveLength(2);
    expect(second.summary).toMatchObject({ anlzWrittenCount: 0, anlzSkippedCount: 2 });
    expect(mtimes()).toEqual(written);

    // A different beat grid for one track rewrites that track only.
    const changed = [{ ...tracks[0], beatgrid: '{"v":1,"bpm":124}' }, tracks[1]];
    const third = await runWith(changed);
    expect(calls).toHaveLength(3);
    expect(third.summary).toMatchObject({ anlzWrittenCount: 1, anlzSkippedCount: 1 });

    // A file removed from the medium is written again even with the same digest.
    fs.rmSync(files[1]);
    const fourth = await runWith(changed);
    expect(calls).toHaveLength(4);
    expect(fourth.summary).toMatchObject({ anlzWrittenCount: 1, anlzSkippedCount: 1 });
    expect(fs.existsSync(files[1])).toBe(true);
  });

  it('writes one audio file and one ANLZ pair when one track joins a full playlist', async () => {
    const root = stick();
    const anlzCalls = [];
    const writeAnlzStub = async ({ usbRoot, usbFilePath }) => {
      const dir = path.join(usbRoot, ...getAnlzFolder(usbFilePath).split('/'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ANLZ0000.DAT'), 'dat');
      fs.writeFileSync(path.join(dir, 'ANLZ0000.EXT'), 'ext');
      anlzCalls.push(usbFilePath);
    };
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...tracks[0],
      id: 1000 + index,
      title: `Track ${index}`,
      file_path: `/library/track-${index}.mp3`,
    }));
    let list = many;
    const { runner, copyTrackToUsb } = buildRunner({
      getPlaylistTracks: () => list,
      writeAnlz: writeAnlzStub,
    });

    await runOn(root, runner, runner.plan({ playlistIds: [7] }));
    expect(copyTrackToUsb).toHaveBeenCalledTimes(100);
    expect(anlzCalls).toHaveLength(100);

    const copiedBefore = copyTrackToUsb.mock.calls.length;
    const anlzBefore = anlzCalls.length;
    list = [...many, { ...tracks[0], id: 2000, title: 'New one', file_path: '/library/new.mp3' }];

    const second = await runOn(root, runner, runner.plan({ playlistIds: [7] }));

    expect(copyTrackToUsb.mock.calls.length - copiedBefore).toBe(1);
    expect(anlzCalls.length - anlzBefore).toBe(1);
    expect(second.summary).toMatchObject({ anlzWrittenCount: 1, anlzSkippedCount: 100 });
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

  it('changes the fingerprint when a cover is added to a track already on the stick', () => {
    // Without artwork_path in the fingerprint an automatic sync computes the same
    // digest, starts no job, and the new cover never reaches the medium (#45).
    const { runner } = buildRunner();
    const before = runner.plan({ playlistIds: [7] });

    const withCover = [{ ...tracks[0], artwork_path: '/covers/opening.jpg' }, tracks[1]];
    const after = buildRunner({ getPlaylistTracks: () => withCover }).runner.plan({
      playlistIds: [7],
    });

    expect(runner.fingerprint(after)).not.toBe(runner.fingerprint(before));
    expect(runner.fingerprint(after)).not.toBe(
      runner.fingerprint(runner.plan({ playlistIds: [7] }))
    );
  });

  it('records the artwork id per track and keeps it when the covers in play change', async () => {
    if (process.platform === 'win32') return;
    const root = stick();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-covers-'));
    roots.push(scratch);
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
    ]);
    const coverA = path.join(scratch, 'a.jpg');
    const coverB = path.join(scratch, 'b.jpg');
    fs.writeFileSync(coverA, jpeg);
    fs.writeFileSync(coverB, jpeg);
    const decoder = stubFfmpeg(scratch);

    const runWith = async (list) => {
      const { runner } = buildRunner({
        getPlaylistTracks: () => list,
        getFfmpegRuntimePath: () => decoder,
      });
      return runOn(root, runner, runner.plan({ playlistIds: [7] }));
    };
    const trackRows = (root_) =>
      Object.fromEntries([...loadManifest(root_).tracks].map(([id, row]) => [id, row.artwork_id]));

    // First export: only the first track carries a cover.
    await runWith([{ ...tracks[0], artwork_path: coverA }, tracks[1]]);
    expect(trackRows(root)).toEqual({ 1: 1, 2: 0 });
    expect(fs.existsSync(path.join(root, 'PIONEER', 'Artwork', '00001', 'a1.jpg'))).toBe(true);
    let library = publishedLibrary(root);
    expect(library.tracks.find((track) => track.id === 1).artworkId).toBe(1);
    expect(library.artwork.map((row) => row.id)).toEqual([1]);

    // Second export, no manual export in between: the second track gains a cover.
    await runWith([
      { ...tracks[0], artwork_path: coverA },
      { ...tracks[1], artwork_path: coverB },
    ]);
    expect(trackRows(root)).toEqual({ 1: 1, 2: 2 });
    expect(fs.existsSync(path.join(root, 'PIONEER', 'Artwork', '00001', 'a2.jpg'))).toBe(true);
    library = publishedLibrary(root);
    expect(library.tracks.find((track) => track.id === 2).artworkId).toBe(2);

    // Third export: the first cover is gone. The second keeps id 2; numbering by
    // position would hand id 1 to a cover the device has cached under 2.
    await runWith([tracks[0], { ...tracks[1], artwork_path: coverB }]);
    expect(trackRows(root)).toEqual({ 1: 0, 2: 2 });
    library = publishedLibrary(root);
    expect(library.tracks.find((track) => track.id === 2).artworkId).toBe(2);
    expect(library.artwork.map((row) => row.id)).toEqual([2]);
  });

  it('does not encode a cover whose source has not changed', async () => {
    if (process.platform === 'win32') return;
    const root = stick();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-covers-'));
    roots.push(scratch);
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
    ]);
    const cover = path.join(scratch, 'a.jpg');
    fs.writeFileSync(cover, jpeg);
    const logFile = path.join(scratch, 'ffmpeg.log');
    const decoder = recordingFfmpeg(scratch, logFile);
    const calls = () =>
      fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').length : 0;

    const list = [{ ...tracks[0], artwork_path: cover }, tracks[1]];
    const runAgain = async () => {
      const { runner } = buildRunner({
        getPlaylistTracks: () => list,
        getFfmpegRuntimePath: () => decoder,
      });
      return runOn(root, runner, runner.plan({ playlistIds: [7] }));
    };

    const small = path.join(root, 'PIONEER', 'Artwork', '00001', 'a1.jpg');
    const thumb = path.join(root, 'PIONEER', 'Artwork', '00001', 'a1_m.jpg');

    const first = await runAgain();
    expect(calls()).toBe(2);
    expect(first.summary).toMatchObject({ coverCount: 1, coverWrittenCount: 1 });
    const mtimes = () => [fs.statSync(small).mtimeMs, fs.statSync(thumb).mtimeMs];
    const written = mtimes();
    const bytes = fs.readFileSync(small);

    // Same source: nothing is encoded, nothing is written over, and the manifest
    // keeps the digest that allowed the skip.
    const second = await runAgain();
    expect(calls()).toBe(2);
    expect(second.summary).toMatchObject({ coverCount: 1, coverWrittenCount: 0 });
    expect(mtimes()).toEqual(written);
    expect(fs.readFileSync(small)).toEqual(bytes);
    expect(loadManifest(root).tracks.get(1).artwork_source_hash).toMatch(/^[0-9a-f]{64}$/);
    // The database still points at the cover that is already there.
    expect(publishedLibrary(root).tracks.find((track) => track.id === 1).artworkId).toBe(1);

    // A different source with the same path is a different cover: encode again.
    fs.writeFileSync(cover, Buffer.concat([jpeg, Buffer.from([0x01])]));
    const third = await runAgain();
    expect(calls()).toBe(4);
    expect(third.summary).toMatchObject({ coverCount: 1, coverWrittenCount: 1 });
  });

  it('points tag assignments at the numbers the medium uses, not the library ids', async () => {
    const root = stick();
    const libraryTracks = [
      { ...tracks[0], id: 10 },
      { ...tracks[1], id: 16 },
    ];
    const { runner } = buildRunner({
      getPlaylistTracks: () => libraryTracks,
      getMyTags: () => [{ id: 5, name: 'Peak Time', parentId: 0, sequenceNo: 0, attribute: 0 }],
      getTagAssignmentsForTracks: () => [
        { track_id: 10, tag_id: 5 },
        { track_id: 16, tag_id: 5 },
      ],
    });

    await runOn(root, runner, runner.plan({ playlistIds: [7] }));

    const ext = readPdb(fs.readFileSync(path.join(root, 'PIONEER', 'rekordbox', 'exportExt.pdb')));
    const rows = (ext.tables.get(4) ?? []).map((row) => [
      row.readUInt32LE(4),
      row.readUInt32LE(8),
    ]);
    // The PDB writer numbered the tracks 1 and 2; the library called them 10 and
    // 16. A row naming 10 or 16 would describe tracks that are not on the medium.
    expect(rows).toEqual([
      [1, 5],
      [2, 5],
    ]);
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
