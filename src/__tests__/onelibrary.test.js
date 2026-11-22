import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ONELIBRARY_FILE,
  checkConsistency,
  openLibrary,
  readLibrary,
  resolveLibraryKey,
  writeLibrary,
} from '../usb/pioneer/onelibrary/index.js';

const KEY = 'test-only-key-0123456789';
let roots = [];

function dir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-onelibrary-'));
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
    artist: 'Artist One',
    album: 'Album',
    bpm: 124.4,
    duration: 180.6,
    key_raw: '8A',
    rating: 5,
    year: 2026,
    bitrate: 320000,
    sample_rate: 44100,
    bit_depth: 16,
    file_path: '/Contents/opening.mp3',
    analyzePath: '/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT',
  },
  {
    id: 2,
    title: 'Closer',
    artist: 'Artist Two',
    album: '',
    bpm: 126,
    duration: 200,
    key_raw: '9A',
    rating: 3,
    year: '',
    bitrate: 1411200,
    sample_rate: 48000,
    bit_depth: 24,
    file_path: '/Contents/closer.wav',
    analyzePath: '',
  },
];

const playlists = [{ id: 7, name: 'Set', track_ids: [1, 2] }];

describe('device library (exportLibrary.db)', () => {
  it('writes an encrypted database that reads back with the same rows', () => {
    const file = path.join(dir(), ONELIBRARY_FILE);
    const result = writeLibrary(file, { key: KEY, tracks, playlists });

    expect(result).toMatchObject({ trackCount: 2, playlistCount: 1, artistCount: 2, keyCount: 2 });
    // SQLCipher replaces the SQLite header with a random salt.
    expect(fs.readFileSync(file).subarray(0, 16).toString('utf8')).not.toBe('SQLite format 3\0');

    const library = readLibrary(file, { key: KEY });
    expect(library.content).toHaveLength(2);
    expect(library.playlists).toEqual([
      expect.objectContaining({ playlist_id: 1, name: 'Set', sequenceNo: 0 }),
    ]);
    expect(
      library.membership.map((row) => [row.playlist_id, row.content_id, row.sequenceNo])
    ).toEqual([
      [1, 1, 1],
      [1, 2, 2],
    ]);
    // Tags are the user's data: nothing is invented when the caller has none.
    expect(library.myTags).toEqual([]);
  });

  it('maps the fields rekordbox and the PDB agree on', () => {
    const file = path.join(dir(), ONELIBRARY_FILE);
    writeLibrary(file, { key: KEY, tracks, playlists });
    const [first, second] = readLibrary(file, { key: KEY }).content;

    expect(first).toMatchObject({
      title: 'Opening',
      bpmx100: 12440,
      length: 181,
      path: '/Contents/opening.mp3',
      fileName: 'opening.mp3',
      fileType: 1,
      bitrate: 320,
      bitDepth: 16,
      samplingRate: 44100,
      rating: 5,
      releaseYear: 2026,
      analysisDataFilePath: '/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT',
    });
    // A wav keeps the PDB's file type code, and a 0..255 rating is normalised.
    expect(second).toMatchObject({ fileType: 11, bitrate: 1411, rating: 3 });
  });

  it('fills the dictionaries rekordbox writes into every device library', () => {
    const file = path.join(dir(), ONELIBRARY_FILE);
    writeLibrary(file, { key: KEY, tracks, playlists });
    const db = openLibrary(file, { key: KEY, readonly: true });
    try {
      const count = (table) => db.prepare(`select count(*) as n from ${table}`).get().n;
      expect([count('category'), count('color'), count('menuItem'), count('sort')]).toEqual([
        22, 8, 27, 17,
      ]);
    } finally {
      db.close();
    }
  });

  it('writes the My Tags tree, its assignments and the property row', () => {
    const file = path.join(dir(), ONELIBRARY_FILE);
    const myTags = [
      { id: 11, name: 'Genre', parentId: 0, sequenceNo: 0, attribute: 1 },
      { id: 12, name: 'House', parentId: 11, sequenceNo: 0, attribute: 0 },
    ];
    const masterTagId = 123456;

    writeLibrary(file, {
      key: KEY,
      tracks,
      playlists,
      myTags,
      tagAssignments: [{ trackId: 1, tagId: 12 }],
      masterTagId,
    });

    const library = readLibrary(file, { key: KEY });
    expect(library.myTags.map((tag) => [tag.myTag_id, tag.name, tag.myTag_id_parent])).toEqual([
      [11, 'Genre', 0],
      [12, 'House', 11],
    ]);
    expect(library.property).toEqual([
      expect.objectContaining({
        dbVersion: '10000',
        numberOfContents: 2,
        myTagMasterDBID: masterTagId,
      }),
    ]);

    const db = openLibrary(file, { key: KEY, readonly: true });
    try {
      expect(db.prepare('select count(*) as n from myTag_content').get().n).toBe(1);
    } finally {
      db.close();
    }

    expect(
      checkConsistency({ library, pdbTrackCount: 2, pdbPlaylistCount: 1, masterTagId })
    ).toEqual({ ok: true, problems: [] });
    expect(
      checkConsistency({ library, pdbTrackCount: 2, pdbPlaylistCount: 1, masterTagId: 99 }).problems
    ).toEqual(['tag master id is 123456, expected 99']);
  });

  it('refuses a wrong key', () => {
    const file = path.join(dir(), ONELIBRARY_FILE);
    writeLibrary(file, { key: KEY, tracks, playlists });
    expect(() => readLibrary(file, { key: 'not-the-key' })).toThrow(/not a database/i);
  });

  it('checks the library against the pdb counts', () => {
    const file = path.join(dir(), ONELIBRARY_FILE);
    writeLibrary(file, { key: KEY, tracks, playlists });
    const library = readLibrary(file, { key: KEY });

    expect(checkConsistency({ library, pdbTrackCount: 2, pdbPlaylistCount: 1 })).toEqual({
      ok: true,
      problems: [],
    });
    expect(checkConsistency({ library, pdbTrackCount: 3, pdbPlaylistCount: 1 }).problems).toEqual([
      'library has 2 tracks, pdb has 3',
    ]);
  });
});

describe('library key resolution', () => {
  it('prefers the environment and falls back to settings', () => {
    expect(resolveLibraryKey({ env: { REKORDBOX_LIBRARY_KEY: ' 1234 ' } })).toBe('1234');
    expect(
      resolveLibraryKey({
        env: {},
        getSetting: (name) => (name === 'rekordbox_library_key' ? 'abcd' : ''),
      })
    ).toBe('abcd');
    expect(resolveLibraryKey({ env: {}, getSetting: () => '' })).toBeNull();
  });
});
