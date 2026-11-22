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
    getPlaylist: (id) => ({ id, name: 'Set' }),
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

  it('plans an automatic sync from the playlists the manifest carries', () => {
    const root = stick();
    const { runner } = buildRunner();
    expect(runner.planFor(root)).toBeNull();

    const maps = { tracks: new Map(), playlists: new Map([[7, { id: 7, name: 'Set' }]]) };
    saveManifest(root, maps.tracks, maps.playlists);
    const auto = runner.planFor(root);
    expect(auto.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof auto.execute).toBe('function');
  });

  it('leaves a medium alone when the manifest names only deleted playlists', () => {
    const root = stick();
    const { runner } = buildRunner({ getPlaylist: () => null });
    saveManifest(root, new Map(), new Map([[99, { id: 99, name: 'Gone' }]]));
    expect(runner.planFor(root)).toBeNull();
  });
});
