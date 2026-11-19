import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_TABLE_SENTINEL,
  PAGE_SIZE,
  decodeDeviceSQLString,
  groupPlaylistEntries,
  readHeader,
  readLibrary,
  readPage,
  readPdb,
  readTableRows,
} from '../usb/pioneer/formats/pdbRead.js';
import { encodeDeviceSQLString, writePdb } from '../usb/pioneer/formats/pdb.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'djman-pdb-'));
}

/** A payload the writer accepts, small enough to read at a glance. */
function payload() {
  return {
    tracks: [
      {
        id: 1,
        title: 'First Track',
        artist: 'Some Artist',
        album: '',
        file_path: '/Contents/Some Artist - First Track.mp3',
        filename: 'Some Artist - First Track.mp3',
        duration: 180,
        bpm: 128,
        genres: [],
        track_number: 1,
        year: '',
        label: '',
        comments: '',
        rating: 0,
        file_size: 4096,
        bitrate: 320,
        sample_rate: 44100,
        bit_depth: 16,
      },
      {
        id: 2,
        title: 'Second Track',
        artist: 'Some Artist',
        album: '',
        file_path: '/Contents/Some Artist - Second Track.mp3',
        filename: 'Some Artist - Second Track.mp3',
        duration: 240,
        bpm: 124,
        genres: [],
        track_number: 2,
        year: '',
        label: '',
        comments: '',
        rating: 0,
        file_size: 8192,
        bitrate: 320,
        sample_rate: 44100,
        bit_depth: 16,
      },
    ],
    playlists: [{ id: 10, name: 'Warm Up', track_ids: [1, 2] }],
  };
}

describe('readHeader', () => {
  it('reads the page size, the table count and every table index', () => {
    const file = path.join(tempDir(), 'export.pdb');
    writePdb(payload(), file);
    const header = readHeader(fs.readFileSync(file));

    expect(header.pageSize).toBe(PAGE_SIZE);
    expect(header.numTables).toBe(20);
    expect(header.tables[0].type).toBe(0);
    expect(header.tables).toHaveLength(20);
  });

  it('refuses a file shorter than one page', () => {
    expect(() => readHeader(Buffer.alloc(16))).toThrow(/smaller than one page/);
  });

  it('refuses a page size it does not know', () => {
    const buffer = Buffer.alloc(PAGE_SIZE);
    buffer.writeUInt32LE(8192, 4);
    buffer.writeUInt32LE(20, 8);
    expect(() => readHeader(buffer)).toThrow(/unsupported page size/);
  });
});

describe('readPdb', () => {
  it('reads back what the writer put in', () => {
    const file = path.join(tempDir(), 'export.pdb');
    writePdb(payload(), file);
    const db = readPdb(fs.readFileSync(file));

    const tracks = db.tables.get(0);
    expect(tracks.length).toBeGreaterThanOrEqual(2);
    expect(db.pageCount).toBeGreaterThan(1);
    expect(db.tables.size).toBe(20);
  });

  it('gives every page a type and a row count', () => {
    const file = path.join(tempDir(), 'export.pdb');
    writePdb(payload(), file);
    const buffer = fs.readFileSync(file);
    const page = readPage(buffer, 1);

    expect(page.index).toBe(1);
    expect(page.rows.length).toBe(page.numRows);
  });

  it('returns nothing for a table that points at the empty sentinel', () => {
    const buffer = Buffer.alloc(PAGE_SIZE * 2);
    expect(readTableRows(buffer, EMPTY_TABLE_SENTINEL)).toEqual([]);
  });
});

describe('decodeDeviceSQLString', () => {
  it('reads the short ASCII form back', () => {
    const encoded = encodeDeviceSQLString('House');
    expect(decodeDeviceSQLString(encoded, 0)).toEqual({ value: 'House', length: 6, next: 6 });
  });

  it('reads the long ASCII form back', () => {
    const long = 'x'.repeat(200);
    const encoded = encodeDeviceSQLString(long);
    expect(decodeDeviceSQLString(encoded, 0).value).toBe(long);
  });

  it('reads the UTF-16 form back', () => {
    const encoded = encodeDeviceSQLString('Beyoncé');
    expect(decodeDeviceSQLString(encoded, 0).value).toBe('Beyoncé');
  });

  it('reports a header it cannot decode instead of guessing', () => {
    expect(() => decodeDeviceSQLString(Buffer.from([0x00, 0x01]), 0)).toThrow(
      /unsupported string header/
    );
  });

  it('reads a string that sits at an offset inside a row', () => {
    const encoded = encodeDeviceSQLString('Outro');
    const row = Buffer.concat([Buffer.from([1, 2, 3, 4]), encoded]);
    expect(decodeDeviceSQLString(row, 4).value).toBe('Outro');
  });
});

describe('readLibrary', () => {
  /** Write the fixture to disk and read it back as a library. */
  function roundTrip() {
    const file = path.join(tempDir(), 'export.pdb');
    writePdb(payload(), file);
    return readLibrary(fs.readFileSync(file));
  }

  it('returns tracks with the fields the writer stored', () => {
    const lib = roundTrip();
    expect(lib.tracks.map((t) => t.title).sort()).toEqual(['First Track', 'Second Track']);

    const first = lib.tracks.find((t) => t.title === 'First Track');
    expect(first.filePath).toBe('/Contents/Some Artist - First Track.mp3');
    expect(first.filename).toBe('Some Artist - First Track.mp3');
    expect(first.bpm).toBe(128);
    expect(first.duration).toBe(180);
    expect(first.bitrate).toBe(320);
    expect(first.sampleRate).toBe(44100);
    expect(first.sampleDepth).toBe(16);
    expect(first.trackNumber).toBe(1);
    expect(first.fileSize).toBe(4096);
  });

  it('returns the artists and albums the tracks point at', () => {
    const lib = roundTrip();
    expect(lib.artists.map((a) => a.name)).toContain('Some Artist');
    expect(lib.tracks[0].artistId).toBeGreaterThan(0);
  });

  it('returns playlists with their tracks in order', () => {
    const lib = roundTrip();
    const playlist = lib.playlists.find((p) => p.name === 'Warm Up');
    expect(playlist).toBeDefined();
    expect(playlist.isFolder).toBe(false);

    const trackIds = lib.tracksByPlaylist.get(playlist.id);
    const titles = trackIds.map((id) => lib.tracks.find((t) => t.id === id)?.title);
    expect(titles).toEqual(['First Track', 'Second Track']);
  });

  it('keeps the header it read', () => {
    const lib = roundTrip();
    expect(lib.header.pageSize).toBe(PAGE_SIZE);
    expect(lib.header.tables).toHaveLength(20);
  });
});

describe('groupPlaylistEntries', () => {
  it('orders entries by their index inside each playlist', () => {
    const grouped = groupPlaylistEntries([
      { entryIndex: 1, trackId: 7, playlistId: 100 },
      { entryIndex: 0, trackId: 5, playlistId: 100 },
      { entryIndex: 0, trackId: 9, playlistId: 200 },
    ]);
    expect(grouped.get(100)).toEqual([5, 7]);
    expect(grouped.get(200)).toEqual([9]);
  });
});
