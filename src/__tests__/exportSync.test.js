import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import {
  applyTrackEdit,
  manifestEntryFor,
  usbRelativePath,
  writeTrackBackToExport,
} from '../explorer/exportSync.js';

const ROOT = '/run/media/usb/STICK';
const MANIFEST_PATH = path.join(ROOT, 'PIONEER', 'rekordbox', 'export-manifest.json');

const TRACK = {
  id: 199,
  file_path: `${ROOT}/music/The Third Invasion.mp3`,
  title: 'The Third Invasion',
  artist: 'AniMe',
  bpm: 174,
  bpm_override: 87,
  key_raw: 'F# minor',
  duration: 302.7,
  beatgrid: [{ position: 0, bpm: 87 }],
  beatgrid_offset: 12,
};

const MANIFEST = {
  version: 1,
  tracks: [
    {
      id: 199,
      title: 'The Third Invasion',
      artist: 'AniMe',
      bpm: 174,
      key_raw: 'F# minor',
      duration: 300,
      file_path: '/music/The Third Invasion.mp3',
      analyzePath: '/PIONEER/USBANLZ/P077/00016B47/ANLZ0000.DAT',
    },
  ],
  playlists: [{ id: 'pl-1', name: 'hhc', track_ids: [199] }],
};

/** An in-memory filesystem, so nothing is written during tests. */
function fakeFs(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFileSync: (p) => {
      if (!store.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return store.get(p);
    },
    writeFileSync: (p, data) => store.set(p, data),
    renameSync: (from, to) => {
      store.set(to, store.get(from));
      store.delete(from);
    },
  };
}

const fileUrl = (p) => (p.startsWith('file://') ? p : `file://${p}`);

describe('usbRelativePath', () => {
  it('spells a file the way an export does', () => {
    expect(usbRelativePath(ROOT, `${ROOT}/music/a.mp3`)).toBe('/music/a.mp3');
    expect(usbRelativePath(ROOT, `${ROOT}/music/nested/a b.mp3`)).toBe('/music/nested/a b.mp3');
  });

  it('refuses paths that are not inside the export', () => {
    expect(usbRelativePath(ROOT, '/home/radexito/music/a.mp3')).toBeNull();
    expect(usbRelativePath(ROOT, ROOT)).toBeNull();
    expect(usbRelativePath(null, '/music/a.mp3')).toBeNull();
    expect(usbRelativePath(ROOT, null)).toBeNull();
  });
});

describe('manifestEntryFor', () => {
  it('matches on the library id first', () => {
    expect(manifestEntryFor(MANIFEST, { id: 199 })?.file_path).toBe(
      '/music/The Third Invasion.mp3'
    );
  });

  it('falls back to the exported path', () => {
    const manifest = { tracks: [{ id: 1, file_path: '/music/other.mp3' }] };
    expect(manifestEntryFor(manifest, { id: 999, usbFilePath: '/music/other.mp3' })).toBe(
      manifest.tracks[0]
    );
  });

  it('returns null when the track is not in the export', () => {
    expect(manifestEntryFor(MANIFEST, { id: 42 })).toBeNull();
    expect(manifestEntryFor(null, { id: 1 })).toBeNull();
  });
});

describe('applyTrackEdit', () => {
  it('copies the edit onto the entry and leaves the rest alone', () => {
    const { manifest, changed } = applyTrackEdit(MANIFEST, MANIFEST.tracks[0], TRACK);

    expect(changed).toBe(true);
    expect(manifest.tracks[0]).toMatchObject({
      id: 199,
      bpm: 87,
      key_raw: 'F# minor',
      duration: 302.7,
      analyzePath: '/PIONEER/USBANLZ/P077/00016B47/ANLZ0000.DAT',
    });
    expect(manifest.playlists).toBe(MANIFEST.playlists);
    expect(MANIFEST.tracks[0].bpm).toBe(174); // the original manifest is untouched
  });

  it('reports no change when the values already match', () => {
    const { manifest, changed } = applyTrackEdit(MANIFEST, MANIFEST.tracks[0], {
      title: 'The Third Invasion',
      artist: 'AniMe',
      key_raw: 'F# minor',
    });
    expect(changed).toBe(false);
    expect(manifest).toBe(MANIFEST);
  });
});

describe('writeTrackBackToExport', () => {
  it('writes the ANLZ where the export put the track and refreshes the manifest', async () => {
    const fsImpl = fakeFs({ [MANIFEST_PATH]: JSON.stringify(MANIFEST) });
    const writeAnlz = vi.fn().mockResolvedValue(undefined);

    const result = await writeTrackBackToExport({
      exportRoot: ROOT,
      filePath: TRACK.file_path,
      track: TRACK,
      cuePoints: [{ positionMs: 0, hotCueIndex: 0 }],
      writeAnlz,
      ffmpegPath: 'ffmpeg',
      fsImpl,
    });

    expect(result).toEqual({
      ok: true,
      usbFilePath: '/music/The Third Invasion.mp3',
      manifestUpdated: true,
    });
    expect(writeAnlz).toHaveBeenCalledWith(
      expect.objectContaining({
        usbFilePath: '/music/The Third Invasion.mp3',
        sourceFilePath: TRACK.file_path,
        bpm: 87,
        beatgridOffset: 12,
        usbRoot: ROOT,
        cuePoints: [{ positionMs: 0, hotCueIndex: 0 }],
      })
    );

    const written = JSON.parse(fsImpl.store.get(MANIFEST_PATH));
    expect(written.tracks[0].bpm).toBe(87);
    expect(fsImpl.store.has(`${MANIFEST_PATH}.tmp`)).toBe(false);
  });

  it('uses the export path even when the library file is elsewhere', async () => {
    const fsImpl = fakeFs({ [MANIFEST_PATH]: JSON.stringify(MANIFEST) });
    const writeAnlz = vi.fn().mockResolvedValue(undefined);

    const result = await writeTrackBackToExport({
      exportRoot: ROOT,
      filePath: '/home/radexito/.config/dj_manager/audio/ab/abcdef.mp3',
      track: TRACK,
      writeAnlz,
      fsImpl,
    });

    expect(result.ok).toBe(true);
    expect(writeAnlz.mock.calls[0][0].usbFilePath).toBe('/music/The Third Invasion.mp3');
  });

  it('leaves a stick that has no manifest alone', async () => {
    const writeAnlz = vi.fn();
    const result = await writeTrackBackToExport({
      exportRoot: ROOT,
      filePath: TRACK.file_path,
      track: TRACK,
      writeAnlz,
      fsImpl: fakeFs(),
    });

    expect(result).toEqual({ ok: false, reason: 'no-manifest' });
    expect(writeAnlz).not.toHaveBeenCalled();
  });

  it('leaves an export that does not hold the track alone', async () => {
    const fsImpl = fakeFs({
      [MANIFEST_PATH]: JSON.stringify({ version: 1, tracks: [], playlists: [] }),
    });
    const writeAnlz = vi.fn();

    const result = await writeTrackBackToExport({
      exportRoot: ROOT,
      filePath: TRACK.file_path,
      track: TRACK,
      writeAnlz,
      fsImpl,
    });

    expect(result).toEqual({ ok: false, reason: 'not-in-export' });
    expect(writeAnlz).not.toHaveBeenCalled();
  });

  it('needs a root, a file and a track id', async () => {
    const writeAnlz = vi.fn();
    expect((await writeTrackBackToExport({ writeAnlz })).ok).toBe(false);
    expect(
      (await writeTrackBackToExport({ exportRoot: ROOT, filePath: null, track: TRACK, writeAnlz }))
        .ok
    ).toBe(false);
    expect(writeAnlz).not.toHaveBeenCalled();
  });
});
