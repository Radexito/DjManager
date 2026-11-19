import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createPioneerUsb } from '../usb/pioneer/index.js';
import { readPdb } from '../usb/pioneer/formats/pdbRead.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'djman-manager-'));
}

/** A track the database writer accepts. */
function track(id = 1) {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: '',
    file_path: `/Contents/Artist - Track ${id}.mp3`,
    filename: `Artist - Track ${id}.mp3`,
    duration: 180,
    bpm: 128,
    genres: [],
    track_number: id,
    year: '',
    label: '',
    comments: '',
    rating: 0,
    file_size: 4096,
    bitrate: 320,
    sample_rate: 44100,
    bit_depth: 16,
  };
}

describe('createPioneerUsb', () => {
  it('refuses to exist without a mount point', () => {
    expect(() => createPioneerUsb({})).toThrow(/mount point is required/);
  });

  it('knows the layout of the medium', () => {
    const root = tempDir();
    const usb = createPioneerUsb({ root });

    expect(usb.format).toBe('pioneer');
    expect(usb.paths.audioDir()).toBe(path.join(root, 'Contents'));
    expect(usb.paths.audioPath('a.mp3')).toBe('/Contents/a.mp3');
    expect(usb.paths.database()).toBe(path.join(root, 'PIONEER', 'rekordbox', 'export.pdb'));
    expect(usb.paths.anlzFolder('/Contents/a.mp3')).toMatch(/^PIONEER\/USBANLZ/);
  });

  it('round-trips the export manifest', () => {
    const usb = createPioneerUsb({ root: tempDir() });
    expect(usb.manifest.path()).toContain('export-manifest.json');

    usb.manifest.save(new Map([[1, { id: 1, file_path: '/Contents/a.mp3' }]]), new Map());
    const loaded = usb.manifest.load();
    expect(loaded.tracks.get(1)).toEqual({ id: 1, file_path: '/Contents/a.mp3' });
    expect(loaded.playlists.size).toBe(0);
  });

  it('treats a missing manifest as empty', () => {
    const usb = createPioneerUsb({ root: tempDir() });
    const loaded = usb.manifest.load();
    expect(loaded.tracks.size).toBe(0);
    expect(loaded.playlists.size).toBe(0);
  });

  it('writes a database that reads back', () => {
    const root = tempDir();
    const usb = createPioneerUsb({ root });
    usb.write.database({ tracks: [track(1), track(2)], playlists: [] });

    const buffer = fs.readFileSync(usb.paths.database());
    const db = readPdb(buffer);
    expect(db.tables.get(0).length).toBeGreaterThanOrEqual(2);
  });

  it('reads the library back off the medium', () => {
    const root = tempDir();
    const usb = createPioneerUsb({ root });
    usb.write.database({ tracks: [track(1)], playlists: [{ id: 5, name: 'Set', track_ids: [1] }] });

    const lib = usb.read.library();
    expect(lib.tracks.map((t) => t.title)).toContain('Track 1');
    expect(lib.playlists.map((p) => p.name)).toContain('Set');
  });

  it('reports no library before anything was written', () => {
    expect(createPioneerUsb({ root: tempDir() }).read.library()).toBeNull();
  });

  it('writes the settings files', () => {
    const root = tempDir();
    createPioneerUsb({ root }).write.settings();
    expect(fs.existsSync(path.join(root, 'PIONEER', 'MYSETTING.DAT'))).toBe(true);
  });

  it('reports no cues when the manifest names tracks the library does not have', () => {
    const root = tempDir();
    const usb = createPioneerUsb({ root, deps: { resolveTrack: () => null } });
    usb.manifest.save(new Map([[7, { id: 7, file_path: '/Contents/gone.mp3' }]]), new Map());

    const scan = usb.read.cues({ mode: 'extend' });
    expect(scan.tracks).toEqual([]);
    expect(scan.summary.tracks).toBe(0);
  });
});
