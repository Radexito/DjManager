import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPioneerExportService } from '../main/services/pioneerExportService.js';

const service = createPioneerExportService({ app: { on: () => {} }, send: () => {} });
const dirs = [];

/** Creates a scratch directory and registers it for removal after the suite. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-pioneer-export-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('trackToFilename', () => {
  it('joins artist and title and strips characters a FAT32 stick rejects', () => {
    expect(service.trackToFilename({ artist: 'AC/DC', title: 'Back:In*Black?' }, '.mp3')).toBe(
      'AC_DC - Back_In_Black_.mp3'
    );
  });

  it('falls back to the source file name when the tags are empty', () => {
    expect(
      service.trackToFilename({ file_path: '/music/unknown artist - track.flac' }, '.flac')
    ).toBe('unknown artist - track.flac');
  });
});

describe('saveManifest', () => {
  it('keeps the export id when the caller passes the previous manifest', () => {
    const root = tempDir();
    const first = service.saveManifest(root, new Map(), new Map());
    expect(first.exportId).toMatch(/^[0-9a-f-]{36}$/);

    const staged = tempDir();
    const again = service.saveManifest(staged, new Map(), new Map(), { previous: first });
    expect(again.exportId).toBe(first.exportId);

    const written = JSON.parse(
      fs.readFileSync(path.join(staged, 'PIONEER', 'rekordbox', 'export-manifest.json'), 'utf8')
    );
    expect(written.exportId).toBe(first.exportId);
  });
});

describe('exportDurationSec', () => {
  it('uses the stored duration when the track carries no trim', () => {
    expect(service.exportDurationSec({ duration: 210 })).toBe(210);
  });

  it('uses the trimmed range when there is one, and the whole file when applyTrim is off', () => {
    const track = { duration: 210, trim_start_ms: 10000, trim_end_ms: 70000 };

    expect(service.exportDurationSec(track)).toBe(60);
    expect(service.exportDurationSec(track, false)).toBe(210);
  });
});

describe('resolveExportTrim', () => {
  it('returns null for an untrimmed track so callers export the whole file', () => {
    expect(service.resolveExportTrim({ duration: 100 }, '/usb', '/Contents/a.mp3')).toBeNull();
  });

  it('reports the trim range and only points at a file that exists on the stick', () => {
    const usbRoot = tempDir();
    const track = { duration: 100, trim_start_ms: 5000, trim_end_ms: 25000 };

    const missing = service.resolveExportTrim(track, usbRoot, '/Contents/a.mp3');
    expect(missing).toMatchObject({ startMs: 5000, endMs: 25000, sourceFilePath: null });

    fs.mkdirSync(path.join(usbRoot, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(usbRoot, 'Contents', 'a.mp3'), 'x');
    const present = service.resolveExportTrim(track, usbRoot, '/Contents/a.mp3');
    expect(present.sourceFilePath).toBe(path.join(usbRoot, 'Contents', 'a.mp3'));
  });
});

describe('export manifest', () => {
  it('round-trips tracks and playlists through the manifest file', () => {
    const usbRoot = tempDir();
    const tracks = new Map([[1, { id: 1, title: 'one' }]]);
    const playlists = new Map([[2, { id: 2, name: 'set' }]]);

    service.saveManifest(usbRoot, tracks, playlists);
    const loaded = service.loadManifest(usbRoot);

    expect(loaded.tracks.get(1)).toEqual({ id: 1, title: 'one' });
    expect(loaded.playlists.get(2)).toEqual({ id: 2, name: 'set' });
  });

  it('treats a missing or broken manifest as empty instead of throwing', () => {
    const usbRoot = tempDir();
    expect(service.loadManifest(usbRoot).tracks.size).toBe(0);

    fs.mkdirSync(path.join(usbRoot, 'PIONEER', 'rekordbox'), { recursive: true });
    fs.writeFileSync(service.getManifestPath(usbRoot), '{not json', 'utf8');
    expect(service.loadManifest(usbRoot).tracks.size).toBe(0);
  });
});
