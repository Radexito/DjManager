import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  artworkFolderFor,
  artworkPdbPath,
  artworkRelPath,
  buildArtworkRow,
  planArtwork,
  writePdb,
} from '../usb/pioneer/formats/pdb.js';
import { decodeDeviceSQLString, readLibrary } from '../usb/pioneer/formats/pdbRead.js';

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-artwork-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('artwork paths', () => {
  it('packs a thousand covers into one folder, five digits', () => {
    expect(artworkFolderFor(1)).toBe('00001');
    expect(artworkFolderFor(19)).toBe('00001');
    expect(artworkFolderFor(1000)).toBe('00001');
    expect(artworkFolderFor(1001)).toBe('00002');
    expect(artworkFolderFor(2000)).toBe('00002');
  });

  it('writes the path rekordbox writes, leading /. included', () => {
    // Verified against a real export.pdb: one song, one cover.
    expect(artworkPdbPath(1)).toBe('/.PIONEER/Artwork/00001/a1.jpg');
    expect(artworkRelPath(1)).toBe('PIONEER/Artwork/00001/a1.jpg');
  });
});

describe('planArtwork', () => {
  it('gives one id per distinct file, tracks sharing a cover sharing it', () => {
    const plan = planArtwork([
      { id: 1, artwork_path: '/covers/a.jpg' },
      { id: 2, artwork_path: '/covers/a.jpg' },
      { id: 3, artwork_path: '/covers/b.png' },
      { id: 4, artwork_path: null },
      { id: 5 },
    ]);
    expect(plan).toEqual([
      {
        id: 1,
        sourcePath: '/covers/a.jpg',
        pdbPath: '/.PIONEER/Artwork/00001/a1.jpg',
        relPath: 'PIONEER/Artwork/00001/a1.jpg',
      },
      {
        id: 2,
        sourcePath: '/covers/b.png',
        pdbPath: '/.PIONEER/Artwork/00001/a2.jpg',
        relPath: 'PIONEER/Artwork/00001/a2.jpg',
      },
    ]);
  });
});

describe('artwork rows in export.pdb', () => {
  it('encodes id and path, and leaves the string readable', () => {
    const row = buildArtworkRow(7, artworkPdbPath(7));
    expect(row.readUInt32LE(0)).toBe(7);
    expect(decodeDeviceSQLString(row, 4).value).toBe('/.PIONEER/Artwork/00001/a7.jpg');
    expect(row.length % 4).toBe(0);
  });

  it('round-trips through the reader, with the track pointing at the row', () => {
    const dir = tmpDir();
    const out = path.join(dir, 'PIONEER', 'rekordbox', 'export.pdb');
    const tracks = [
      { id: 1, title: 'One', file_path: '/Contents/one.mp3', artwork_path: '/covers/a.jpg' },
      { id: 2, title: 'Two', file_path: '/Contents/two.mp3', artwork_path: '/covers/a.jpg' },
      { id: 3, title: 'Three', file_path: '/Contents/three.mp3' },
    ];
    const plan = writePdb({ tracks, playlists: [] }, out);

    expect(plan).toHaveLength(1);
    const library = readLibrary(fs.readFileSync(out));
    expect(library.artwork).toEqual([{ id: 1, path: '/.PIONEER/Artwork/00001/a1.jpg' }]);
    expect(library.tracks.map((t) => t.artworkId)).toEqual([1, 1, 0]);
  });

  it('writes no artwork table rows when nothing has a cover', () => {
    const dir = tmpDir();
    const out = path.join(dir, 'export.pdb');
    const plan = writePdb(
      { tracks: [{ id: 1, title: 'One', file_path: '/Contents/one.mp3' }] },
      out
    );
    expect(plan).toEqual([]);
    expect(readLibrary(fs.readFileSync(out)).artwork).toEqual([]);
  });

  it('drops the reference of a cover that was not written', () => {
    const dir = tmpDir();
    const out = path.join(dir, 'export.pdb');
    const tracks = [
      { id: 1, title: 'One', file_path: '/Contents/one.mp3', artwork_path: '/covers/a.jpg' },
      { id: 2, title: 'Two', file_path: '/Contents/two.mp3', artwork_path: '/covers/b.png' },
    ];
    // b.png could not be decoded: the caller writes only the covers it managed,
    // so the second track keeps artwork_id 0 instead of pointing at nothing.
    const written = planArtwork(tracks).filter((cover) => cover.sourcePath === '/covers/a.jpg');
    writePdb({ tracks, playlists: [], artwork: written }, out);

    const library = readLibrary(fs.readFileSync(out));
    expect(library.artwork).toEqual([{ id: 1, path: '/.PIONEER/Artwork/00001/a1.jpg' }]);
    expect(library.tracks.map((t) => t.artworkId)).toEqual([1, 0]);
  });
});
