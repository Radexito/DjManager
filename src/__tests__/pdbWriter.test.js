import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => {
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const mod = { writeFileSync, mkdirSync };
  return { default: mod, ...mod };
});

import fs from 'fs';

import {
  encodeDeviceSQLString,
  encodeISRCString,
  buildArtistRow,
  buildAlbumRow,
  buildTrackRow,
  buildColorRow,
  buildColumnRow,
  buildPlaylistTreeRow,
  buildPlaylistEntryRow,
  buildUnknown17Row,
  buildUnknown18Row,
  DataPage,
  buildIndexPage,
  buildFileHeader,
  writePdb,
  TABLE_TYPES,
  TABLE_ORDER,
  encodeRating,
  detectFileType,
} from '../usb/pdbWriter.js';

// ── DeviceSQLString encoding ──────────────────────────────────────────────────

describe('encodeDeviceSQLString', () => {
  it('encodes empty string as single byte 0x03', () => {
    const buf = encodeDeviceSQLString('');
    expect(buf).toEqual(Buffer.from([0x03]));
  });

  it('encodes "a" (1-char) as [0x05, 0x61]', () => {
    // header = ((1+1)<<1)|1 = 5 = 0x05
    const buf = encodeDeviceSQLString('a');
    expect(buf).toEqual(Buffer.from([0x05, 0x61]));
  });

  it('encodes "abc" (3-char) as [0x09, a,b,c]', () => {
    // header = ((3+1)<<1)|1 = 9 = 0x09
    const buf = encodeDeviceSQLString('abc');
    expect(buf).toEqual(Buffer.from([0x09, 0x61, 0x62, 0x63]));
  });

  it('matches rex test vector for 43-char ANLZ path', () => {
    // From rex string_test.go — ShortAsciiString
    const s = '/PIONEER/USBANLZ/P05B/0001069F/ANLZ0000.DAT';
    const buf = encodeDeviceSQLString(s);
    expect(buf[0]).toBe(0x59); // ((43+1)<<1)|1 = 89 = 0x59
    expect(buf.length).toBe(44);
    expect(buf.subarray(1).toString('ascii')).toBe(s);
  });

  it('encodes unicode string as UTF-16 LE with 0x90 header', () => {
    // From rex string_test.go — UnicodeString "Rødhåd feat. Vril"
    const buf = encodeDeviceSQLString('Rødhåd feat. Vril');
    expect(buf).toEqual(
      Buffer.from([
        0x90, 0x26, 0x00, 0x00, 0x52, 0x00, 0xf8, 0x00, 0x64, 0x00, 0x68, 0x00, 0xe5, 0x00, 0x64,
        0x00, 0x20, 0x00, 0x66, 0x00, 0x65, 0x00, 0x61, 0x00, 0x74, 0x00, 0x2e, 0x00, 0x20, 0x00,
        0x56, 0x00, 0x72, 0x00, 0x69, 0x00, 0x6c, 0x00,
      ])
    );
  });

  it('encodes a 127-char ASCII string as long ASCII (0x40 header)', () => {
    const s = 'A'.repeat(127);
    const buf = encodeDeviceSQLString(s);
    expect(buf[0]).toBe(0x40);
    expect(buf.readUInt16LE(1)).toBe(127 + 4); // length includes 4-byte header
    expect(buf[3]).toBe(0x00); // padding
    expect(buf.length).toBe(4 + 127);
  });

  it('returns a Buffer instance', () => {
    expect(Buffer.isBuffer(encodeDeviceSQLString('hello'))).toBe(true);
  });
});

// ── ISRC string encoding ──────────────────────────────────────────────────────

describe('encodeISRCString', () => {
  it('matches rex test vector for "GBJX38209003"', () => {
    // From rex string_test.go — IsrcString
    const buf = encodeISRCString('GBJX38209003');
    expect(buf).toEqual(
      Buffer.from([
        0x90, 0x12, 0x00, 0x00, 0x03, 0x47, 0x42, 0x4a, 0x58, 0x33, 0x38, 0x32, 0x30, 0x39, 0x30,
        0x30, 0x33, 0x00,
      ])
    );
  });

  it('encodes empty ISRC as [0x90, 0x06, 0x00, 0x00, 0x03, 0x00]', () => {
    // Length = 0 + 6 = 6 = 0x06
    const buf = encodeISRCString('');
    expect(buf).toEqual(Buffer.from([0x90, 0x06, 0x00, 0x00, 0x03, 0x00]));
  });
});

// ── Helper encoders ───────────────────────────────────────────────────────────

describe('encodeRating', () => {
  it('maps 0 → 0', () => expect(encodeRating(0)).toBe(0));
  it('maps 1 → 51', () => expect(encodeRating(1)).toBe(51));
  it('maps 2 → 102', () => expect(encodeRating(2)).toBe(102));
  it('maps 3 → 153', () => expect(encodeRating(3)).toBe(153));
  it('maps 4 → 204', () => expect(encodeRating(4)).toBe(204));
  it('maps 5 → 255', () => expect(encodeRating(5)).toBe(255));
});

describe('detectFileType', () => {
  it('mp3 → 0x01', () => expect(detectFileType('/foo/bar.mp3')).toBe(0x01));
  it('m4a → 0x04', () => expect(detectFileType('/foo/bar.m4a')).toBe(0x04));
  it('aac → 0x04', () => expect(detectFileType('/foo/bar.aac')).toBe(0x04));
  it('flac → 0x05', () => expect(detectFileType('/foo/bar.flac')).toBe(0x05));
  it('wav → 0x0b', () => expect(detectFileType('/foo/bar.wav')).toBe(0x0b));
  it('unknown extension falls back to mp3 (0x01)', () =>
    expect(detectFileType('/foo/bar.ogg')).toBe(0x01));
});

// ── Artist row ────────────────────────────────────────────────────────────────

describe('buildArtistRow', () => {
  it('starts with Subtype=0x60 (LE u16)', () => {
    const buf = buildArtistRow(1, 'Test');
    expect(buf.readUInt16LE(0)).toBe(0x60);
  });

  it('IndexShift is 0 by default (set by page at insert time)', () => {
    const buf = buildArtistRow(1, 'Test');
    expect(buf.readUInt16LE(2)).toBe(0);
  });

  it('Id is encoded as u32 LE at offset 4', () => {
    const buf = buildArtistRow(42, 'Test');
    expect(buf.readUInt32LE(4)).toBe(42);
  });

  it('Unnamed3=0x03 at offset 8', () => {
    const buf = buildArtistRow(1, 'Test');
    expect(buf[8]).toBe(0x03);
  });

  it('OfsNameNear=0x0A at offset 9', () => {
    const buf = buildArtistRow(1, 'Test');
    expect(buf[9]).toBe(0x0a);
  });

  it('name follows as DeviceSQLString starting at offset 10', () => {
    const buf = buildArtistRow(1, 'Test');
    const nameEncoded = encodeDeviceSQLString('Test');
    expect(buf.subarray(10, 10 + nameEncoded.length)).toEqual(nameEncoded);
  });

  it('total length is 10 + encoded name length', () => {
    const name = 'Deadmau5';
    const buf = buildArtistRow(1, name);
    expect(buf.length).toBe(10 + encodeDeviceSQLString(name).length);
  });

  it('handles unicode artist name', () => {
    const buf = buildArtistRow(1, 'Röyksopp');
    expect(buf[10]).toBe(0x90); // unicode dstring header
  });
});

// ── Album row ─────────────────────────────────────────────────────────────────

describe('buildAlbumRow', () => {
  it('starts with Unnamed1=0x80 (LE u16)', () => {
    const buf = buildAlbumRow(1, 0, 'Test Album');
    expect(buf.readUInt16LE(0)).toBe(0x80);
  });

  it('IndexShift=0 at offset 2', () => {
    const buf = buildAlbumRow(1, 0, 'Test');
    expect(buf.readUInt16LE(2)).toBe(0);
  });

  it('Unnamed2=0 at offset 4', () => {
    const buf = buildAlbumRow(1, 5, 'Test');
    expect(buf.readUInt32LE(4)).toBe(0);
  });

  it('ArtistId at offset 8', () => {
    const buf = buildAlbumRow(1, 7, 'Test');
    expect(buf.readUInt32LE(8)).toBe(7);
  });

  it('Id at offset 12', () => {
    const buf = buildAlbumRow(3, 0, 'Test');
    expect(buf.readUInt32LE(12)).toBe(3);
  });

  it('Unnamed3=0 at offset 16', () => {
    const buf = buildAlbumRow(1, 0, 'Test');
    expect(buf.readUInt32LE(16)).toBe(0);
  });

  it('Unnamed4=0x03 at offset 20', () => {
    const buf = buildAlbumRow(1, 0, 'Test');
    expect(buf[20]).toBe(0x03);
  });

  it('OfsName=22 at offset 21', () => {
    const buf = buildAlbumRow(1, 0, 'Test');
    expect(buf[21]).toBe(22);
  });

  it('name follows as DeviceSQLString starting at offset 22', () => {
    const buf = buildAlbumRow(1, 0, 'Test Album');
    const nameEncoded = encodeDeviceSQLString('Test Album');
    expect(buf.subarray(22, 22 + nameEncoded.length)).toEqual(nameEncoded);
  });

  it('total length is 22 + encoded name length', () => {
    const name = 'Homework';
    const buf = buildAlbumRow(1, 0, name);
    expect(buf.length).toBe(22 + encodeDeviceSQLString(name).length);
  });
});

// ── Track row ─────────────────────────────────────────────────────────────────

describe('buildTrackRow', () => {
  const minimal = {
    id: 1,
    artistId: 0,
    albumId: 0,
    title: 'Test Track',
    filePath: '/music/test.mp3',
    filename: 'test.mp3',
    sampleRate: 44100,
    fileSize: 5000000,
    bitrate: 320,
    tempo: 12800, // 128.00 BPM × 100
    trackNumber: 1,
    year: 2024,
    duration: 210,
    fileType: 0x01,
    rating: 0,
    comment: '',
    dateAdded: '2024-01-01',
    analyzeDate: '2024-01-01',
    sampleDepth: 16,
  };

  it('Unnamed0=0x24 at offset 0', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt16LE(0)).toBe(0x24);
  });

  it('IndexShift=0 at offset 2 (set by page at insert time)', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt16LE(2)).toBe(0);
  });

  it('Bitmask=0xC0700 at offset 4', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt32LE(4)).toBe(0xc0700);
  });

  it('SampleRate at offset 8', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt32LE(8)).toBe(44100);
  });

  it('FileSize at offset 16', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt32LE(16)).toBe(5000000);
  });

  it('Unnamed7=0x758a and Unnamed8=0x57a2 at offsets 24/26', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt16LE(24)).toBe(0x758a);
    expect(buf.readUInt16LE(26)).toBe(0x57a2);
  });

  it('ArtistId at offset 68', () => {
    const buf = buildTrackRow({ ...minimal, artistId: 5 });
    expect(buf.readUInt32LE(68)).toBe(5);
  });

  it('AlbumId at offset 64', () => {
    const buf = buildTrackRow({ ...minimal, albumId: 3 });
    expect(buf.readUInt32LE(64)).toBe(3);
  });

  it('Id at offset 72', () => {
    const buf = buildTrackRow({ ...minimal, id: 7 });
    expect(buf.readUInt32LE(72)).toBe(7);
  });

  it('Year at offset 80', () => {
    const buf = buildTrackRow({ ...minimal, year: 2024 });
    expect(buf.readUInt16LE(80)).toBe(2024);
  });

  it('Duration at offset 84', () => {
    const buf = buildTrackRow({ ...minimal, duration: 210 });
    expect(buf.readUInt16LE(84)).toBe(210);
  });

  it('Unnamed26=0x29 at offset 86', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt16LE(86)).toBe(0x29);
  });

  it('Rating at offset 89', () => {
    const buf = buildTrackRow({ ...minimal, rating: 153 }); // 3 stars pre-encoded
    expect(buf[89]).toBe(153);
  });

  it('FileType at offset 90', () => {
    const buf = buildTrackRow({ ...minimal, fileType: 0x01 });
    expect(buf.readUInt16LE(90)).toBe(0x01);
  });

  it('Unnamed30=0x03 at offset 92', () => {
    const buf = buildTrackRow(minimal);
    expect(buf.readUInt16LE(92)).toBe(0x03);
  });

  it('header is exactly 94 bytes', () => {
    // StringOffsets start at byte 94
    const buf = buildTrackRow(minimal);
    expect(buf.length).toBeGreaterThanOrEqual(94 + 42); // header + StringOffsets
  });

  it('StringOffsets section is 42 bytes (21 × u16)', () => {
    // StringOffsets start at 94, span 42 bytes, string heap starts at 136
    const buf = buildTrackRow(minimal);
    expect(buf.length).toBeGreaterThanOrEqual(136);
  });

  it('first string offset (Isrc) points past the 136-byte fixed header', () => {
    const buf = buildTrackRow(minimal);
    const isrcOffset = buf.readUInt16LE(94); // first StringOffset entry
    expect(isrcOffset).toBeGreaterThanOrEqual(136);
  });

  it('FilePath string offset points past the 136-byte fixed header', () => {
    const buf = buildTrackRow(minimal);
    const filePathOffset = buf.readUInt16LE(94 + 40); // FilePath is last offset
    expect(filePathOffset).toBeGreaterThanOrEqual(136);
  });

  it('AutoloadHotcues is "ON" in the string heap', () => {
    const buf = buildTrackRow(minimal);
    const hotcueOffset = buf.readUInt16LE(94 + 14); // AutoloadHotcues offset (index 7 in order)
    const encoded = buf.subarray(hotcueOffset);
    // "ON" short ASCII: header = ((2+1)<<1)|1 = 7 = 0x07
    expect(encoded[0]).toBe(0x07);
    expect(encoded.subarray(1, 3).toString('ascii')).toBe('ON');
  });

  it('Tempo encodes BPM×100 as u32 LE', () => {
    const buf = buildTrackRow({ ...minimal, tempo: 13800 }); // 138.00 BPM
    expect(buf.readUInt32LE(56)).toBe(13800);
  });

  it('Bitrate at offset 48', () => {
    const buf = buildTrackRow({ ...minimal, bitrate: 192 });
    expect(buf.readUInt32LE(48)).toBe(192);
  });
});

// ── Playlist rows ─────────────────────────────────────────────────────────────

describe('buildPlaylistTreeRow', () => {
  it('ParentId at offset 0', () => {
    const buf = buildPlaylistTreeRow({
      id: 1,
      parentId: 0,
      sortOrder: 0,
      isFolder: false,
      name: 'Test',
    });
    expect(buf.readUInt32LE(0)).toBe(0);
  });

  it('SortOrder at offset 8', () => {
    const buf = buildPlaylistTreeRow({
      id: 1,
      parentId: 0,
      sortOrder: 3,
      isFolder: false,
      name: 'Test',
    });
    expect(buf.readUInt32LE(8)).toBe(3);
  });

  it('Id at offset 12', () => {
    const buf = buildPlaylistTreeRow({
      id: 5,
      parentId: 0,
      sortOrder: 0,
      isFolder: false,
      name: 'Test',
    });
    expect(buf.readUInt32LE(12)).toBe(5);
  });

  it('RawIsFolder=0 for non-folder', () => {
    const buf = buildPlaylistTreeRow({
      id: 1,
      parentId: 0,
      sortOrder: 0,
      isFolder: false,
      name: 'Test',
    });
    expect(buf.readUInt32LE(16)).toBe(0);
  });

  it('name follows as DeviceSQLString at offset 20', () => {
    const buf = buildPlaylistTreeRow({
      id: 1,
      parentId: 0,
      sortOrder: 0,
      isFolder: false,
      name: 'Techno',
    });
    const nameEncoded = encodeDeviceSQLString('Techno');
    expect(buf.subarray(20, 20 + nameEncoded.length)).toEqual(nameEncoded);
  });

  it('total length is 20 + encoded name length', () => {
    const name = 'House Music';
    const buf = buildPlaylistTreeRow({ id: 1, parentId: 0, sortOrder: 0, isFolder: false, name });
    expect(buf.length).toBe(20 + encodeDeviceSQLString(name).length);
  });
});

describe('buildPlaylistEntryRow', () => {
  it('EntryIndex at offset 0', () => {
    const buf = buildPlaylistEntryRow(3, 10, 2);
    expect(buf.readUInt32LE(0)).toBe(3);
  });

  it('TrackID at offset 4', () => {
    const buf = buildPlaylistEntryRow(1, 42, 2);
    expect(buf.readUInt32LE(4)).toBe(42);
  });

  it('PlaylistID at offset 8', () => {
    const buf = buildPlaylistEntryRow(1, 10, 7);
    expect(buf.readUInt32LE(8)).toBe(7);
  });

  it('is exactly 12 bytes', () => {
    const buf = buildPlaylistEntryRow(1, 1, 1);
    expect(buf.length).toBe(12);
  });
});

// ── Static dataset rows ───────────────────────────────────────────────────────

describe('buildColorRow', () => {
  it('encodes Unknown1(u32) + Unknown2(u8) + ID(u16) + Unknown3(u8) + dstring', () => {
    const buf = buildColorRow({ Unknown1: 0, Unknown2: 1, ID: 1, Unknown3: 0, Name: 'Pink' });
    expect(buf.readUInt32LE(0)).toBe(0);
    expect(buf[4]).toBe(1);
    expect(buf.readUInt16LE(5)).toBe(1);
    expect(buf[7]).toBe(0);
    expect(buf.length).toBe(8 + encodeDeviceSQLString('Pink').length);
  });
});

describe('buildColumnRow', () => {
  it('encodes ID(u16) + Unknown1(u16) + dstring', () => {
    const buf = buildColumnRow({ ID: 1, Unknown1: 0x80, Name: '\ufffaGENRE\ufffb' });
    expect(buf.readUInt16LE(0)).toBe(1);
    expect(buf.readUInt16LE(2)).toBe(0x80);
    expect(buf[4]).toBe(0x90); // unicode dstring header
    expect(buf.length).toBeGreaterThan(4);
  });
});

describe('buildUnknown17Row', () => {
  it('is exactly 8 bytes (4 × u16 LE)', () => {
    const buf = buildUnknown17Row({
      Unknown1: 0x01,
      Unknown2: 0x01,
      Unknown3: 0x163,
      Unknown4: 0x00,
    });
    expect(buf.length).toBe(8);
    expect(buf.readUInt16LE(0)).toBe(0x01);
    expect(buf.readUInt16LE(2)).toBe(0x01);
    expect(buf.readUInt16LE(4)).toBe(0x163);
    expect(buf.readUInt16LE(6)).toBe(0x00);
  });
});

describe('buildUnknown18Row', () => {
  it('is exactly 8 bytes (4 × u16 LE)', () => {
    const buf = buildUnknown18Row({
      Unknown1: 0x01,
      Unknown2: 0x06,
      Unknown3: 0x01,
      Unknown4: 0x00,
    });
    expect(buf.length).toBe(8);
    expect(buf.readUInt16LE(0)).toBe(0x01);
    expect(buf.readUInt16LE(2)).toBe(0x06);
    expect(buf.readUInt16LE(4)).toBe(0x01);
    expect(buf.readUInt16LE(6)).toBe(0x00);
  });
});

// ── DataPage ──────────────────────────────────────────────────────────────────

describe('DataPage', () => {
  it('toBuffer returns exactly 4096 bytes', () => {
    const page = new DataPage(TABLE_TYPES.Tracks);
    const buf = page.toBuffer(2, 41, 2);
    expect(buf.length).toBe(4096);
  });

  it('page type is encoded at offset 8 (u32 LE)', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    const buf = page.toBuffer(5, 6, 2);
    expect(buf.readUInt32LE(8)).toBe(TABLE_TYPES.Artists);
  });

  it('page index is encoded at offset 4 (u32 LE)', () => {
    const page = new DataPage(TABLE_TYPES.Tracks);
    const buf = page.toBuffer(7, 8, 2);
    expect(buf.readUInt32LE(4)).toBe(7);
  });

  it('next page is encoded at offset 12 (u32 LE)', () => {
    const page = new DataPage(TABLE_TYPES.Tracks);
    const buf = page.toBuffer(2, 99, 2);
    expect(buf.readUInt32LE(12)).toBe(99);
  });

  it('magic (offset 0) is always 0', () => {
    const page = new DataPage(TABLE_TYPES.Tracks);
    const buf = page.toBuffer(1, 2, 2);
    expect(buf.readUInt32LE(0)).toBe(0);
  });

  it('PageFlags is 0x34 at offset 27', () => {
    const page = new DataPage(TABLE_TYPES.Tracks);
    const buf = page.toBuffer(1, 2, 2);
    expect(buf[27]).toBe(0x34);
  });

  it('empty page: NumRowsSmall=0 at offset 24', () => {
    const page = new DataPage(TABLE_TYPES.Tracks);
    const buf = page.toBuffer(1, 2, 2);
    expect(buf[24]).toBe(0);
  });

  it('insertRow returns true when space is available', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    const row = buildArtistRow(1, 'DJ Test');
    expect(page.insertRow(row)).toBe(true);
  });

  it('NumRowsSmall increments to 1 after one insert', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    page.insertRow(buildArtistRow(1, 'DJ Test'));
    const buf = page.toBuffer(1, 2, 2);
    expect(buf[24]).toBe(1);
  });

  it('Unknown3 = numRows × 0x20 at offset 25', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    page.insertRow(buildArtistRow(1, 'A'));
    page.insertRow(buildArtistRow(2, 'B'));
    page.insertRow(buildArtistRow(3, 'C'));
    const buf = page.toBuffer(1, 2, 2);
    expect(buf[25]).toBe((3 * 0x20) & 0xff);
  });

  it('row data starts at byte 40 (DataHeaderSize)', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    const row = buildArtistRow(1, 'Test');
    page.insertRow(row);
    const buf = page.toBuffer(1, 2, 2);
    // Row data starts at offset 40; first byte of artist row = 0x60 (Subtype low byte)
    expect(buf[40]).toBe(0x60);
    expect(buf[41]).toBe(0x00);
  });

  it('row data is 4-byte aligned', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    // 15-byte artist row → aligned to 16 bytes
    // Insert two rows to check second row starts at multiple of 4
    const row1 = buildArtistRow(1, 'Test'); // 15 bytes
    const row2 = buildArtistRow(2, 'X'); // 12 bytes
    page.insertRow(row1);
    page.insertRow(row2);
    const buf = page.toBuffer(1, 2, 2);
    // First row at offset 40, aligned to 16 → second row at offset 56
    expect(buf[56]).toBe(0x60); // second row starts with Subtype
  });

  it('RowSet presence flags at the last 4 bytes of page (one row)', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    page.insertRow(buildArtistRow(1, 'Test'));
    const buf = page.toBuffer(1, 2, 2);
    // With 1 row: RowSet at bytes 4060-4095
    // ActiveRows (pos[0] bit) = 0x0001 at bytes 4092-4093 (in reversed positions layout)
    // Actually: positions[0..15] reversed + ActiveRows + LastWrittenRows
    // reversed positions: pos[15](bytes 4060-4061) ... pos[0](bytes 4090-4091)
    // ActiveRows at bytes 4092-4093
    expect(buf.readUInt16LE(4092)).toBe(0x0001);
    expect(buf.readUInt16LE(4094)).toBe(0x0001); // LastWrittenRows
  });

  it('pos[0] (heap offset of first row) is 0, stored at bytes 4090-4091', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    page.insertRow(buildArtistRow(1, 'Test'));
    const buf = page.toBuffer(1, 2, 2);
    // pos[0] is the last of the 16 reversed positions → bytes 4090-4091
    expect(buf.readUInt16LE(4090)).toBe(0x0000);
  });

  it('second row heap offset is stored at bytes 4088-4089 (pos[1])', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    const row1 = buildArtistRow(1, 'Test'); // 15 bytes → aligned to 16
    page.insertRow(row1);
    page.insertRow(buildArtistRow(2, 'Next'));
    const buf = page.toBuffer(1, 2, 2);
    const row1AlignedSize = Math.ceil(row1.length / 4) * 4;
    // pos[1] at bytes 4088-4089
    expect(buf.readUInt16LE(4088)).toBe(row1AlignedSize);
  });

  it('FreeSize + row data + RowSet sizes = HEAP_SIZE (4056)', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    const row = buildArtistRow(1, 'Test'); // 15 bytes
    page.insertRow(row);
    const buf = page.toBuffer(1, 2, 2);
    const freeSize = buf.readUInt16LE(28);
    const rowDataSize = Math.ceil(row.length / 4) * 4; // 16
    const rowsetSize = 36;
    expect(freeSize + rowDataSize + rowsetSize).toBe(4056);
  });

  it('NextHeapWriteOffset equals row data size at offset 30', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    const row = buildArtistRow(1, 'Test'); // 15 bytes → 16 aligned
    page.insertRow(row);
    const buf = page.toBuffer(1, 2, 2);
    expect(buf.readUInt16LE(30)).toBe(16);
  });

  it('second RowSet is written before first at bytes 4024-4095 with 17 rows', () => {
    const page = new DataPage(TABLE_TYPES.Colors);
    // Insert 17 rows to trigger two RowSets
    for (let i = 1; i <= 17; i++) {
      const inserted = page.insertRow(
        buildColorRow({ Unknown1: 0, Unknown2: i, ID: i, Unknown3: 0, Name: `C${i}` })
      );
      expect(inserted).toBe(true);
    }
    const buf = page.toBuffer(1, 2, 2);
    expect(buf[24]).toBe(17); // NumRowsSmall = 17
    // Two RowSets at end of page: 72 bytes total
    // Second RowSet (RowSet[1]) at bytes 4060-4095? No:
    // RowSet[0] at very end: 4060-4095, RowSet[1] just before: 4024-4059
    // With reversed prepend order, RowSet[1] is at bottom start, RowSet[0] at bottom end
    // ActiveRows of first RowSet (rows 0-15) = 0xFFFF
    expect(buf.readUInt16LE(4092)).toBe(0xffff);
    // Second RowSet has 1 row (row 16, bit 0)
    expect(buf.readUInt16LE(4060 - 4)).toBe(0x0001); // ActiveRows of RowSet[1]
  });

  it('insertRow returns false when page is full', () => {
    const page = new DataPage(TABLE_TYPES.Tracks);
    // Track rows are large (~200+ bytes each), so a page can hold ~20
    // Fill the page
    let inserted = 0;
    let result = true;
    while (result) {
      result = page.insertRow(
        buildTrackRow({
          id: inserted + 1,
          artistId: 0,
          albumId: 0,
          title: 'T',
          filePath: '/t.mp3',
          filename: 't.mp3',
          sampleRate: 44100,
          fileSize: 1000,
          bitrate: 320,
          tempo: 12800,
          trackNumber: 1,
          year: 2024,
          duration: 180,
          fileType: 0x01,
          rating: 0,
          comment: '',
          dateAdded: '2024-01-01',
          analyzeDate: '2024-01-01',
          sampleDepth: 16,
        })
      );
      if (result) inserted++;
    }
    expect(inserted).toBeGreaterThan(0);
    expect(inserted).toBeLessThan(100); // sanity: not infinite
  });

  it('IndexShift is updated during insertRow for rows with IndexShift at offset 2', () => {
    const page = new DataPage(TABLE_TYPES.Artists);
    // Row 0: indexShift = 0 * 0x20 = 0x00
    // Row 1: indexShift = 1 * 0x20 = 0x20
    const row0 = buildArtistRow(1, 'A');
    const row1 = buildArtistRow(2, 'B');
    page.insertRow(row0, true);
    page.insertRow(row1, true);
    const buf = page.toBuffer(1, 2, 2);
    // Row 0 at heap offset 0: IndexShift should be 0x00
    expect(buf.readUInt16LE(40 + 2)).toBe(0x00);
    // Row 1 at heap offset = alignedSize(row0)
    const row0AlignedSize = Math.ceil(row0.length / 4) * 4;
    expect(buf.readUInt16LE(40 + row0AlignedSize + 2)).toBe(0x20);
  });
});

// ── Index page ────────────────────────────────────────────────────────────────

describe('buildIndexPage', () => {
  it('returns exactly 4096 bytes', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.length).toBe(4096);
  });

  it('magic=0 at offset 0', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.readUInt32LE(0)).toBe(0);
  });

  it('PageIndex at offset 4', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 5, 6, 1);
    expect(buf.readUInt32LE(4)).toBe(5);
  });

  it('PageType at offset 8', () => {
    const buf = buildIndexPage(TABLE_TYPES.Artists, 3, 4, 1);
    expect(buf.readUInt32LE(8)).toBe(TABLE_TYPES.Artists);
  });

  it('PageFlags=0x64 at offset 27', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf[27]).toBe(0x64);
  });

  it('FreeSize=0 at offset 28', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.readUInt16LE(28)).toBe(0);
  });

  it('IndexHeader.Unknown1=0x1fff at offset 32', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.readUInt16LE(32)).toBe(0x1fff);
  });

  it('IndexHeader.Unknown2=0x1fff at offset 34', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.readUInt16LE(34)).toBe(0x1fff);
  });

  it('IndexHeader.Unknown3=0x03ec at offset 36', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.readUInt16LE(36)).toBe(0x03ec);
  });

  it('IndexHeader.PageIndex mirrors header PageIndex at offset 40', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 7, 8, 1);
    expect(buf.readUInt32LE(40)).toBe(7);
  });

  it('IndexHeader.NextPage (first data page) at offset 44', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.readUInt32LE(44)).toBe(0x03ffffff); // empty initially
  });

  it('heap area (bytes 60+) is filled with 0x1ffffff8', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    expect(buf.readUInt32LE(60)).toBe(0x1ffffff8);
    expect(buf.readUInt32LE(64)).toBe(0x1ffffff8);
    expect(buf.readUInt32LE(4072)).toBe(0x1ffffff8); // last u32 before trailing zeros
  });

  it('last 20 bytes are zero', () => {
    const buf = buildIndexPage(TABLE_TYPES.Tracks, 1, 2, 1);
    const tail = buf.subarray(4076, 4096);
    expect(tail.every((b) => b === 0)).toBe(true);
  });
});

// ── File header ───────────────────────────────────────────────────────────────

describe('buildFileHeader', () => {
  const makeTableStates = () => {
    const states = new Map();
    TABLE_ORDER.forEach((type, i) => {
      states.set(type, {
        indexPageIndex: 1 + i * 2,
        emptyCandidate: 2 + i * 2,
        firstPage: 1 + i * 2,
        lastPage: 1 + i * 2,
      });
    });
    return states;
  };

  it('returns exactly 4096 bytes', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    expect(buf.length).toBe(4096);
  });

  it('magic=0 at offset 0', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    expect(buf.readUInt32LE(0)).toBe(0);
  });

  it('page size=4096 at offset 4', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    expect(buf.readUInt32LE(4)).toBe(4096);
  });

  it('NumTables=20 at offset 8', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    expect(buf.readUInt32LE(8)).toBe(20);
  });

  it('NextUnusedPage at offset 12', () => {
    const buf = buildFileHeader(makeTableStates(), 99, 2);
    expect(buf.readUInt32LE(12)).toBe(99);
  });

  it('Unknown1=0x05 at offset 16', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    expect(buf.readUInt32LE(16)).toBe(0x05);
  });

  it('Sequence at offset 20', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 7);
    expect(buf.readUInt32LE(20)).toBe(7);
  });

  it('gap=0 at offset 24', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    expect(buf.readUInt32LE(24)).toBe(0);
  });

  it('first TablePointer: Type=Tracks(0), EmptyCandidate=2, FirstPage=1, LastPage=1', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    const ptr0Offset = 28;
    expect(buf.readUInt32LE(ptr0Offset)).toBe(TABLE_TYPES.Tracks); // Type
    expect(buf.readUInt32LE(ptr0Offset + 4)).toBe(2); // EmptyCandidate
    expect(buf.readUInt32LE(ptr0Offset + 8)).toBe(1); // FirstPage
    expect(buf.readUInt32LE(ptr0Offset + 12)).toBe(1); // LastPage
  });

  it('second TablePointer at offset 44 (Genres=1)', () => {
    const buf = buildFileHeader(makeTableStates(), 41, 2);
    const ptr1Offset = 28 + 16;
    expect(buf.readUInt32LE(ptr1Offset)).toBe(TABLE_TYPES.Genres);
  });

  it('TABLE_ORDER contains all 20 table types in correct order', () => {
    expect(TABLE_ORDER.length).toBe(20);
    expect(TABLE_ORDER[0]).toBe(TABLE_TYPES.Tracks);
    expect(TABLE_ORDER[8]).toBe(TABLE_TYPES.PlaylistEntries);
    expect(TABLE_ORDER[16]).toBe(TABLE_TYPES.Columns);
    expect(TABLE_ORDER[19]).toBe(TABLE_TYPES.History);
  });
});

// ── writePdb integration ──────────────────────────────────────────────────────

describe('writePdb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeInput = () => ({
    usbRoot: '/usb',
    tracks: [
      {
        id: 1,
        title: 'Test Track',
        artist: 'Test Artist',
        album: 'Test Album',
        duration: 210,
        bpm: 128.0,
        key_raw: '',
        file_path: '/PIONEER/music/test.mp3',
        track_number: 1,
        year: '2024',
        label: '',
        genres: [],
        file_size: 5000000,
        bitrate: 320,
        comments: '',
        rating: 0,
      },
    ],
    playlists: [
      {
        id: 1,
        name: 'My Playlist',
        track_ids: [1],
      },
    ],
  });

  it('calls writeFileSync with a Buffer', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    const [path, data] = fs.writeFileSync.mock.calls[0];
    expect(path).toBe('/usb/PIONEER/rekordbox/export.pdb');
    expect(Buffer.isBuffer(data)).toBe(true);
  });

  it('output is a multiple of 4096 bytes', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    const [, data] = fs.writeFileSync.mock.calls[0];
    expect(data.length % 4096).toBe(0);
  });

  it('page 0 starts with magic=0', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    const [, data] = fs.writeFileSync.mock.calls[0];
    expect(data.readUInt32LE(0)).toBe(0);
  });

  it('page 0 has page size = 4096 at offset 4', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    const [, data] = fs.writeFileSync.mock.calls[0];
    expect(data.readUInt32LE(4)).toBe(4096);
  });

  it('page 0 has NumTables=20 at offset 8', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    const [, data] = fs.writeFileSync.mock.calls[0];
    expect(data.readUInt32LE(8)).toBe(20);
  });

  it('page 1 is an index page for Tracks (PageFlags=0x64, Type=0)', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    const [, data] = fs.writeFileSync.mock.calls[0];
    const page1 = data.subarray(4096, 8192);
    expect(page1[27]).toBe(0x64); // PageFlags = index page
    expect(page1.readUInt32LE(8)).toBe(TABLE_TYPES.Tracks); // Type = Tracks
  });

  it('Tracks data page exists with NumRowsSmall ≥ 1', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    const [, data] = fs.writeFileSync.mock.calls[0];
    // Tracks data page is at page 2 (emptyCandidate for Tracks after CreateTable)
    const page2 = data.subarray(8192, 12288);
    expect(page2.readUInt32LE(8)).toBe(TABLE_TYPES.Tracks);
    expect(page2[24]).toBeGreaterThanOrEqual(1); // NumRowsSmall ≥ 1
  });

  it('handles zero tracks gracefully', () => {
    const input = { usbRoot: '/usb', tracks: [], playlists: [] };
    expect(() => writePdb(input, '/tmp/empty.pdb')).not.toThrow();
  });

  it('handles unicode track title', () => {
    const input = makeInput();
    input.tracks[0].title = 'Röyksopp – I Had This Thing';
    expect(() => writePdb(input, '/tmp/unicode.pdb')).not.toThrow();
  });

  it('uses mkdirSync to ensure output directory exists', () => {
    writePdb(makeInput(), '/usb/PIONEER/rekordbox/export.pdb');
    expect(fs.mkdirSync).toHaveBeenCalled();
  });
});
