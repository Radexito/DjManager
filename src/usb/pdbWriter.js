/**
 * pdbWriter.js — Pure-JS Rekordbox DeviceSQL PDB writer
 *
 * Ports the rex Go library (github.com/ambientsound/rex) to Node.js.
 * Produces a PIONEER/rekordbox/export.pdb file readable by CDJ/XDJ hardware.
 *
 * Binary format: all values little-endian, page size = 4096 bytes.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, basename, extname } from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 4096;
const PAGE_HEADER_SIZE = 32; // Common header (Magic+PageIndex+Type+NextPage+...)
const DATA_HEADER_SIZE = 8; // DataPageHeader (Unknown5-7 u16 fields)
const DATA_HEADER_TOTAL = PAGE_HEADER_SIZE + DATA_HEADER_SIZE; // 40
const HEAP_SIZE = PAGE_SIZE - DATA_HEADER_TOTAL; // 4056
const INDEX_EXTRA_SIZE = 28; // IndexHeader fields
const INDEX_HEADER_TOTAL = PAGE_HEADER_SIZE + INDEX_EXTRA_SIZE; // 60
const ROWSET_SIZE = 36; // 16×u16 positions + u16 ActiveRows + u16 LastWrittenRows
const MAX_ROWS_PER_ROWSET = 16;
const EMPTY_TABLE_SENTINEL = 0x03ffffff;

export const TABLE_TYPES = {
  Tracks: 0,
  Genres: 1,
  Artists: 2,
  Albums: 3,
  Labels: 4,
  Keys: 5,
  Colors: 6,
  PlaylistTree: 7,
  PlaylistEntries: 8,
  Unknown9: 9,
  Unknown10: 10,
  HistoryPlaylists: 11,
  HistoryEntries: 12,
  Artwork: 13,
  Unknown14: 14,
  Unknown15: 15,
  Columns: 16,
  Unknown17: 17,
  Unknown18: 18,
  History: 19,
};

// Matches rex pdb.TableOrder exactly — order in file header matters
export const TABLE_ORDER = [
  TABLE_TYPES.Tracks,
  TABLE_TYPES.Genres,
  TABLE_TYPES.Artists,
  TABLE_TYPES.Albums,
  TABLE_TYPES.Labels,
  TABLE_TYPES.Keys,
  TABLE_TYPES.Colors,
  TABLE_TYPES.PlaylistTree,
  TABLE_TYPES.PlaylistEntries,
  TABLE_TYPES.Unknown9,
  TABLE_TYPES.Unknown10,
  TABLE_TYPES.HistoryPlaylists,
  TABLE_TYPES.HistoryEntries,
  TABLE_TYPES.Artwork,
  TABLE_TYPES.Unknown14,
  TABLE_TYPES.Unknown15,
  TABLE_TYPES.Columns,
  TABLE_TYPES.Unknown17,
  TABLE_TYPES.Unknown18,
  TABLE_TYPES.History,
];

// ── Static datasets (from rex color/column/unknown17/unknown18 packages) ──────

const COLOR_DATASET = [
  { Unknown1: 0, Unknown2: 1, ID: 1, Unknown3: 0, Name: 'Pink' },
  { Unknown1: 0, Unknown2: 2, ID: 2, Unknown3: 0, Name: 'Red' },
  { Unknown1: 0, Unknown2: 3, ID: 3, Unknown3: 0, Name: 'Orange' },
  { Unknown1: 0, Unknown2: 4, ID: 4, Unknown3: 0, Name: 'Yellow' },
  { Unknown1: 0, Unknown2: 5, ID: 5, Unknown3: 0, Name: 'Green' },
  { Unknown1: 0, Unknown2: 6, ID: 6, Unknown3: 0, Name: 'Aqua' },
  { Unknown1: 0, Unknown2: 7, ID: 7, Unknown3: 0, Name: 'Blue' },
  { Unknown1: 0, Unknown2: 8, ID: 8, Unknown3: 0, Name: 'Purple' },
];

const COLUMN_DATASET = [
  { ID: 0x01, Unknown1: 0x80, Name: '\ufffaGENRE\ufffb' },
  { ID: 0x02, Unknown1: 0x81, Name: '\ufffaARTIST\ufffb' },
  { ID: 0x03, Unknown1: 0x82, Name: '\ufffaALBUM\ufffb' },
  { ID: 0x04, Unknown1: 0x83, Name: '\ufffaTRACK\ufffb' },
  { ID: 0x05, Unknown1: 0x85, Name: '\ufffaBPM\ufffb' },
  { ID: 0x06, Unknown1: 0x86, Name: '\ufffaRATING\ufffb' },
  { ID: 0x07, Unknown1: 0x87, Name: '\ufffaYEAR\ufffb' },
  { ID: 0x08, Unknown1: 0x88, Name: '\ufffaREMIXER\ufffb' },
  { ID: 0x09, Unknown1: 0x89, Name: '\ufffaLABEL\ufffb' },
  { ID: 0x0a, Unknown1: 0x8a, Name: '\ufffaORIGINAL ARTIST\ufffb' },
  { ID: 0x0b, Unknown1: 0x8b, Name: '\ufffaKEY\ufffb' },
  { ID: 0x0c, Unknown1: 0x8d, Name: '\ufffaCUE\ufffb' },
  { ID: 0x0d, Unknown1: 0x8e, Name: '\ufffaCOLOR\ufffb' },
  { ID: 0x0e, Unknown1: 0x92, Name: '\ufffaTIME\ufffb' },
  { ID: 0x0f, Unknown1: 0x93, Name: '\ufffaBITRATE\ufffb' },
  { ID: 0x10, Unknown1: 0x94, Name: '\ufffaFILE NAME\ufffb' },
  { ID: 0x11, Unknown1: 0x84, Name: '\ufffaPLAYLIST\ufffb' },
  { ID: 0x12, Unknown1: 0x98, Name: '\ufffaHOT CUE BANK\ufffb' },
  { ID: 0x13, Unknown1: 0x95, Name: '\ufffaHISTORY\ufffb' },
  { ID: 0x14, Unknown1: 0x91, Name: '\ufffaSEARCH\ufffb' },
  { ID: 0x15, Unknown1: 0x96, Name: '\ufffaCOMMENTS\ufffb' },
  { ID: 0x16, Unknown1: 0x8c, Name: '\ufffaDATE ADDED\ufffb' },
  { ID: 0x17, Unknown1: 0x97, Name: '\ufffaDJ PLAY COUNT\ufffb' },
  { ID: 0x18, Unknown1: 0x90, Name: '\ufffaFOLDER\ufffb' },
  { ID: 0x19, Unknown1: 0xa1, Name: '\ufffaDEFAULT\ufffb' },
  { ID: 0x1a, Unknown1: 0xa2, Name: '\ufffaALPHABET\ufffb' },
  { ID: 0x1b, Unknown1: 0xaa, Name: '\ufffaMATCHING\ufffb' },
];

const UNKNOWN17_DATASET = [
  { Unknown1: 0x01, Unknown2: 0x01, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x05, Unknown2: 0x06, Unknown3: 0x105, Unknown4: 0x00 },
  { Unknown1: 0x06, Unknown2: 0x07, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x07, Unknown2: 0x08, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x08, Unknown2: 0x09, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x09, Unknown2: 0x0a, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x0a, Unknown2: 0x0b, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x0d, Unknown2: 0x0f, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x0e, Unknown2: 0x13, Unknown3: 0x104, Unknown4: 0x00 },
  { Unknown1: 0x0f, Unknown2: 0x14, Unknown3: 0x106, Unknown4: 0x00 },
  { Unknown1: 0x10, Unknown2: 0x15, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x12, Unknown2: 0x17, Unknown3: 0x163, Unknown4: 0x00 },
  { Unknown1: 0x02, Unknown2: 0x02, Unknown3: 0x02, Unknown4: 0x01 },
  { Unknown1: 0x03, Unknown2: 0x03, Unknown3: 0x03, Unknown4: 0x02 },
  { Unknown1: 0x04, Unknown2: 0x04, Unknown3: 0x01, Unknown4: 0x03 },
  { Unknown1: 0x0b, Unknown2: 0x0c, Unknown3: 0x63, Unknown4: 0x04 },
  { Unknown1: 0x11, Unknown2: 0x05, Unknown3: 0x63, Unknown4: 0x05 },
  { Unknown1: 0x13, Unknown2: 0x16, Unknown3: 0x63, Unknown4: 0x06 },
  { Unknown1: 0x14, Unknown2: 0x12, Unknown3: 0x63, Unknown4: 0x07 },
  { Unknown1: 0x1b, Unknown2: 0x1a, Unknown3: 0x263, Unknown4: 0x08 },
  { Unknown1: 0x18, Unknown2: 0x11, Unknown3: 0x63, Unknown4: 0x09 },
  { Unknown1: 0x16, Unknown2: 0x1b, Unknown3: 0x63, Unknown4: 0x0a },
];

const UNKNOWN18_DATASET = [
  { Unknown1: 0x01, Unknown2: 0x06, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x15, Unknown2: 0x07, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x0e, Unknown2: 0x08, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x08, Unknown2: 0x09, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x09, Unknown2: 0x0a, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x0a, Unknown2: 0x0b, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x0f, Unknown2: 0x0d, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x0d, Unknown2: 0x0f, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x17, Unknown2: 0x10, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x16, Unknown2: 0x11, Unknown3: 0x01, Unknown4: 0x00 },
  { Unknown1: 0x19, Unknown2: 0x00, Unknown3: 0x100, Unknown4: 0x00 },
  { Unknown1: 0x1a, Unknown2: 0x01, Unknown3: 0x200, Unknown4: 0x00 },
  { Unknown1: 0x02, Unknown2: 0x02, Unknown3: 0x302, Unknown4: 0x00 },
  { Unknown1: 0x03, Unknown2: 0x03, Unknown3: 0x400, Unknown4: 0x00 },
  { Unknown1: 0x05, Unknown2: 0x04, Unknown3: 0x500, Unknown4: 0x00 },
  { Unknown1: 0x06, Unknown2: 0x05, Unknown3: 0x600, Unknown4: 0x00 },
  { Unknown1: 0x0b, Unknown2: 0x0c, Unknown3: 0x700, Unknown4: 0x00 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function alignTo4(n) {
  const rem = n % 4;
  return rem === 0 ? n : n + (4 - rem);
}

/** Star rating: 0=0, 1=51, 2=102, 3=153, 4=204, 5=255 */
export function encodeRating(stars) {
  return Math.min(5, Math.max(0, stars)) * 51;
}

/** Map file extension → Pioneer FileType u16 */
export function detectFileType(filePath) {
  const ext = extname(filePath).toLowerCase().replace('.', '');
  switch (ext) {
    case 'mp3':
      return 0x01;
    case 'm4a':
    case 'aac':
      return 0x04;
    case 'flac':
      return 0x05;
    case 'wav':
      return 0x0b;
    default:
      return 0x01; // default mp3
  }
}

// ── DeviceSQL string encoding ─────────────────────────────────────────────────

function isASCII(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Encode a string as a DeviceSQL string (DeviceSQLString).
 *
 * Short ASCII (len < 127): 1 header byte = ((len+1)<<1)|1, then ASCII bytes.
 * Long ASCII (len >= 127): [0x40, u16LE(len+4), 0x00, ASCII bytes].
 * Unicode: [0x90, u16LE(byte_len+4), 0x00, UTF-16LE bytes].
 */
export function encodeDeviceSQLString(str) {
  if (isASCII(str)) {
    if (str.length < 127) {
      // Short ASCII
      const buf = Buffer.allocUnsafe(1 + str.length);
      buf[0] = ((str.length + 1) << 1) | 1;
      buf.write(str, 1, 'ascii');
      return buf;
    } else {
      // Long ASCII
      const buf = Buffer.allocUnsafe(4 + str.length);
      buf[0] = 0x40;
      buf.writeUInt16LE(str.length + 4, 1);
      buf[3] = 0x00;
      buf.write(str, 4, 'ascii');
      return buf;
    }
  } else {
    // Unicode UTF-16 LE
    const encoded = Buffer.from(str, 'utf16le');
    const buf = Buffer.allocUnsafe(4 + encoded.length);
    buf[0] = 0x90;
    buf.writeUInt16LE(encoded.length + 4, 1);
    buf[3] = 0x00;
    encoded.copy(buf, 4);
    return buf;
  }
}

/**
 * Encode an ISRC string.
 * Format: [0x90, u16LE(len+6), 0x00, 0x03, ASCII bytes, 0x00]
 */
export function encodeISRCString(str) {
  const len = str.length;
  const buf = Buffer.allocUnsafe(6 + len);
  buf[0] = 0x90;
  buf.writeUInt16LE(len + 6, 1);
  buf[3] = 0x00;
  buf[4] = 0x03;
  buf.write(str, 5, 'ascii');
  buf[5 + len] = 0x00;
  return buf;
}

// ── Row builders ──────────────────────────────────────────────────────────────

/**
 * Artist row: Subtype(u16=0x60) + IndexShift(u16) + Id(u32) +
 *             Unnamed3(u8=0x03) + OfsNameNear(u8=0x0A) + dstring(name)
 */
export function buildArtistRow(id, name) {
  const nameEnc = encodeDeviceSQLString(name);
  const buf = Buffer.alloc(10 + nameEnc.length);
  buf.writeUInt16LE(0x60, 0); // Subtype
  buf.writeUInt16LE(0, 2); // IndexShift (set by DataPage.insertRow)
  buf.writeUInt32LE(id, 4); // Id
  buf[8] = 0x03; // Unnamed3
  buf[9] = 0x0a; // OfsNameNear
  nameEnc.copy(buf, 10);
  return buf;
}

/**
 * Album row: Unnamed1(u16=0x80) + IndexShift(u16) + Unnamed2(u32=0) +
 *            ArtistId(u32) + Id(u32) + Unnamed3(u32=0) +
 *            Unnamed4(u8=0x03) + OfsName(u8=22) + dstring(name)
 */
export function buildAlbumRow(id, artistId, name) {
  const nameEnc = encodeDeviceSQLString(name);
  const buf = Buffer.alloc(22 + nameEnc.length);
  buf.writeUInt16LE(0x80, 0); // Unnamed1
  buf.writeUInt16LE(0, 2); // IndexShift
  buf.writeUInt32LE(0, 4); // Unnamed2
  buf.writeUInt32LE(artistId, 8); // ArtistId
  buf.writeUInt32LE(id, 12); // Id
  buf.writeUInt32LE(0, 16); // Unnamed3
  buf[20] = 0x03; // Unnamed4
  buf[21] = 22; // OfsName (static: name is always at offset 22)
  nameEnc.copy(buf, 22);
  return buf;
}

/**
 * Track row — the most complex row type.
 *
 * Layout (all LE):
 *   Header (94 bytes): Unnamed0(u16=0x24) + IndexShift(u16) + Bitmask(u32=0xC0700)
 *     + SampleRate(u32) + ComposerId(u32) + FileSize(u32) + Checksum(u32)
 *     + Unnamed7(u16=0x758a) + Unnamed8(u16=0x57a2) + ArtworkId(u32) + KeyId(u32)
 *     + OriginalArtistId(u32) + LabelId(u32) + RemixerId(u32) + Bitrate(u32)
 *     + TrackNumber(u32) + Tempo(u32) + GenreId(u32) + AlbumId(u32) + ArtistId(u32)
 *     + Id(u32) + DiscNumber(u16) + PlayCount(u16) + Year(u16) + SampleDepth(u16)
 *     + Duration(u16) + Unnamed26(u16=0x29) + ColorId(u8) + Rating(u8)
 *     + FileType(u16) + Unnamed30(u16=0x03)
 *   StringOffsets (42 bytes): 21 × u16LE absolute offsets into string heap
 *   String heap: DeviceSQLString values for each string field
 */
export function buildTrackRow(params) {
  const {
    id,
    artistId = 0,
    albumId = 0,
    genreId = 0,
    labelId = 0,
    keyId = 0,
    artworkId = 0,
    colorId = 0,
    remixerId = 0,
    composerId = 0,
    originalArtistId = 0,
    title = '',
    filePath = '',
    filename = '',
    sampleRate = 44100,
    fileSize = 0,
    checksum = 0,
    bitrate = 320,
    trackNumber = 0,
    tempo = 0,
    year = 0,
    sampleDepth = 16,
    duration = 0,
    discNumber = 0,
    playCount = 0,
    fileType = 0x01,
    rating = 0,
    comment = '',
    isrc = '',
    composer = '',
    mixName = '',
    message = '',
    releaseDate = '',
    dateAdded = '',
    analyzeDate = '',
    analyzePath = '',
    kuvoPublic = '',
    unknownStr4 = '',
    unknownStr5 = '',
    unknownStr6 = '',
    unknownStr7 = '',
    unknownStr8 = '',
  } = params;

  // String encoding order matches rex track.go StringOffsets struct and MarshalBinary
  const strBufs = [
    encodeISRCString(isrc), // [0]  Isrc
    encodeDeviceSQLString(composer), // [1]  Composer
    encodeDeviceSQLString('1'), // [2]  Num1 = KeyAnalyzed (always "1")
    encodeDeviceSQLString('1'), // [3]  Num2 = PhraseAnalyzed (always "1")
    encodeDeviceSQLString(unknownStr4), // [4]  UnknownString4
    encodeDeviceSQLString(message), // [5]  Message
    encodeDeviceSQLString(kuvoPublic), // [6]  KuvoPublic
    encodeDeviceSQLString('ON'), // [7]  AutoloadHotcues (always "ON")
    encodeDeviceSQLString(unknownStr5), // [8]  UnknownString5
    encodeDeviceSQLString(unknownStr6), // [9]  UnknownString6
    encodeDeviceSQLString(dateAdded), // [10] DateAdded
    encodeDeviceSQLString(releaseDate), // [11] ReleaseDate
    encodeDeviceSQLString(mixName), // [12] MixName
    encodeDeviceSQLString(unknownStr7), // [13] UnknownString7
    encodeDeviceSQLString(analyzePath), // [14] AnalyzePath
    encodeDeviceSQLString(analyzeDate), // [15] AnalyzeDate
    encodeDeviceSQLString(comment), // [16] Comment
    encodeDeviceSQLString(title), // [17] Title
    encodeDeviceSQLString(unknownStr8), // [18] UnknownString8
    encodeDeviceSQLString(filename), // [19] Filename
    encodeDeviceSQLString(filePath), // [20] FilePath
  ];

  const HEADER_BYTES = 94;
  const STRING_OFFSETS_BYTES = 42; // 21 × u16
  const RECORD_LEN = HEADER_BYTES + STRING_OFFSETS_BYTES; // 136

  // Compute string heap offsets (absolute = heap_relative + RECORD_LEN)
  const absOffsets = [];
  let heapPos = 0;
  for (const sbuf of strBufs) {
    absOffsets.push(heapPos + RECORD_LEN);
    heapPos += sbuf.length;
  }

  const totalSize = RECORD_LEN + heapPos;
  const result = Buffer.alloc(totalSize);
  let pos = 0;

  // ── Header (94 bytes) ──
  result.writeUInt16LE(0x24, pos);
  pos += 2; // Unnamed0
  result.writeUInt16LE(0, pos);
  pos += 2; // IndexShift (set by DataPage)
  result.writeUInt32LE(0xc0700, pos);
  pos += 4; // Bitmask
  result.writeUInt32LE(sampleRate, pos);
  pos += 4; // SampleRate
  result.writeUInt32LE(composerId, pos);
  pos += 4; // ComposerId
  result.writeUInt32LE(fileSize, pos);
  pos += 4; // FileSize
  result.writeUInt32LE(checksum, pos);
  pos += 4; // Checksum
  result.writeUInt16LE(0x758a, pos);
  pos += 2; // Unnamed7
  result.writeUInt16LE(0x57a2, pos);
  pos += 2; // Unnamed8
  result.writeUInt32LE(artworkId, pos);
  pos += 4; // ArtworkId
  result.writeUInt32LE(keyId, pos);
  pos += 4; // KeyId
  result.writeUInt32LE(originalArtistId, pos);
  pos += 4; // OriginalArtistId
  result.writeUInt32LE(labelId, pos);
  pos += 4; // LabelId
  result.writeUInt32LE(remixerId, pos);
  pos += 4; // RemixerId
  result.writeUInt32LE(bitrate, pos);
  pos += 4; // Bitrate      @48
  result.writeUInt32LE(trackNumber, pos);
  pos += 4; // TrackNumber  @52
  result.writeUInt32LE(tempo, pos);
  pos += 4; // Tempo        @56
  result.writeUInt32LE(genreId, pos);
  pos += 4; // GenreId      @60
  result.writeUInt32LE(albumId, pos);
  pos += 4; // AlbumId      @64
  result.writeUInt32LE(artistId, pos);
  pos += 4; // ArtistId     @68
  result.writeUInt32LE(id, pos);
  pos += 4; // Id           @72
  result.writeUInt16LE(discNumber, pos);
  pos += 2; // DiscNumber   @76
  result.writeUInt16LE(playCount, pos);
  pos += 2; // PlayCount    @78
  result.writeUInt16LE(year, pos);
  pos += 2; // Year         @80
  result.writeUInt16LE(sampleDepth, pos);
  pos += 2; // SampleDepth  @82
  result.writeUInt16LE(duration, pos);
  pos += 2; // Duration     @84
  result.writeUInt16LE(0x29, pos);
  pos += 2; // Unnamed26    @86
  result[pos++] = colorId; // ColorId      @88
  result[pos++] = rating; // Rating       @89
  result.writeUInt16LE(fileType, pos);
  pos += 2; // FileType     @90
  result.writeUInt16LE(0x03, pos);
  pos += 2; // Unnamed30    @92
  // pos == 94

  // ── StringOffsets (42 bytes = 21 × u16LE) ──
  for (const off of absOffsets) {
    result.writeUInt16LE(off, pos);
    pos += 2;
  }
  // pos == 136

  // ── String heap ──
  for (const sbuf of strBufs) {
    sbuf.copy(result, pos);
    pos += sbuf.length;
  }

  return result;
}

/**
 * Normalize a key name from mixxx-analyzer format to Rekordbox abbreviated format.
 *
 * mixxx-analyzer outputs: "G major", "Eb minor", "C# major", etc.
 * Rekordbox native format: "G", "Ebm", "C#", etc.
 *   - Major keys: drop " major"           ("G major" → "G")
 *   - Minor keys: replace " minor" with "m" ("Eb minor" → "Ebm")
 *
 * Returns the string unchanged if it doesn't match the expected pattern
 * (e.g. already abbreviated, or empty string).
 */
export function normalizeKeyName(key) {
  if (!key) return key;
  if (key.endsWith(' major')) return key.slice(0, -6);
  if (key.endsWith(' minor')) return key.slice(0, -6) + 'm';
  return key;
}

/**
 * Key row: SmallId(u16) + IndexShift(u16=0) + Id(u32) + dstring(name)
 *
 * Confirmed from native Rekordbox PDB binary: each key row is 8 bytes of header
 * followed by a DeviceSQL-encoded key name string (e.g. "Em", "Gm", "Ebm").
 * SmallId equals the ID value. hasIndexShift is false for Keys table, so the
 * IndexShift u16 at bytes 2-3 is never rewritten by DataPage and stays 0.
 */
export function buildKeyRow(id, name) {
  const nameEnc = encodeDeviceSQLString(name);
  const buf = Buffer.alloc(8 + nameEnc.length);
  buf.writeUInt16LE(id, 0); // SmallId (equals Id — observed in native files)
  buf.writeUInt16LE(0, 2); // IndexShift placeholder (stays 0)
  buf.writeUInt32LE(id, 4); // Id
  nameEnc.copy(buf, 8);
  return buf;
}

/** Color row: Unknown1(u32) + Unknown2(u8) + ID(u16) + Unknown3(u8) + dstring(Name) */
export function buildColorRow({ Unknown1, Unknown2, ID, Unknown3, Name }) {
  const nameEnc = encodeDeviceSQLString(Name);
  const buf = Buffer.alloc(8 + nameEnc.length);
  buf.writeUInt32LE(Unknown1, 0);
  buf[4] = Unknown2;
  buf.writeUInt16LE(ID, 5);
  buf[7] = Unknown3;
  nameEnc.copy(buf, 8);
  return buf;
}

/** Column row: ID(u16) + Unknown1(u16) + dstring(Name) */
export function buildColumnRow({ ID, Unknown1, Name }) {
  const nameEnc = encodeDeviceSQLString(Name);
  const buf = Buffer.alloc(4 + nameEnc.length);
  buf.writeUInt16LE(ID, 0);
  buf.writeUInt16LE(Unknown1, 2);
  nameEnc.copy(buf, 4);
  return buf;
}

/** PlaylistTree row: ParentId(u32) + Unknown1(u32=0) + SortOrder(u32) + Id(u32) + RawIsFolder(u32) + dstring(name) */
export function buildPlaylistTreeRow({ id, parentId = 0, sortOrder = 0, isFolder = false, name }) {
  const nameEnc = encodeDeviceSQLString(name);
  const buf = Buffer.alloc(20 + nameEnc.length);
  buf.writeUInt32LE(parentId, 0);
  buf.writeUInt32LE(0, 4); // Unknown1
  buf.writeUInt32LE(sortOrder, 8);
  buf.writeUInt32LE(id, 12);
  buf.writeUInt32LE(isFolder ? 1 : 0, 16);
  nameEnc.copy(buf, 20);
  return buf;
}

/** PlaylistEntry row: EntryIndex(u32) + TrackID(u32) + PlaylistID(u32) */
export function buildPlaylistEntryRow(entryIndex, trackId, playlistId) {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(entryIndex, 0);
  buf.writeUInt32LE(trackId, 4);
  buf.writeUInt32LE(playlistId, 8);
  return buf;
}

/** Unknown17 row: 4 × u16 LE */
export function buildUnknown17Row({ Unknown1, Unknown2, Unknown3, Unknown4 }) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(Unknown1, 0);
  buf.writeUInt16LE(Unknown2, 2);
  buf.writeUInt16LE(Unknown3, 4);
  buf.writeUInt16LE(Unknown4, 6);
  return buf;
}

/** Unknown18 row: 4 × u16 LE */
export function buildUnknown18Row({ Unknown1, Unknown2, Unknown3, Unknown4 }) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(Unknown1, 0);
  buf.writeUInt16LE(Unknown2, 2);
  buf.writeUInt16LE(Unknown3, 4);
  buf.writeUInt16LE(Unknown4, 6);
  return buf;
}

// ── DataPage ──────────────────────────────────────────────────────────────────

/**
 * Represents a single 4096-byte data page in the PDB file.
 *
 * Rows are packed from the top of the heap; RowSets grow backwards from the
 * bottom (mirroring rex's heap implementation). Rows are 4-byte aligned.
 *
 * RowSet layout (reversed positions, per rex page/row.go):
 *   [pos[15], pos[14], ..., pos[1], pos[0], ActiveRows, LastWrittenRows]
 */
export class DataPage {
  constructor(pageType) {
    this.pageType = pageType;
    this._topBufs = []; // row buffer chunks (aligned)
    this._topSize = 0; // total bytes in heap top
    this._rowsets = []; // RowSet objects
    this.numRows = 0;
  }

  /**
   * Insert a row buffer into this page.
   * @param {Buffer} rowBuf - serialized row
   * @param {boolean} hasIndexShift - if true, writes IndexShift at offset 2 of the row
   * @returns {boolean} true on success, false if page is full
   */
  insertRow(rowBuf, hasIndexShift = false) {
    const alignedSize = alignTo4(rowBuf.length);
    const requiredRowsetBytes = Math.ceil((this.numRows + 1) / MAX_ROWS_PER_ROWSET) * ROWSET_SIZE;

    if (this._topSize + alignedSize + requiredRowsetBytes > HEAP_SIZE) {
      return false;
    }

    const heapPosition = this._topSize;

    // Build aligned buffer (copy with zero padding)
    const aligned = Buffer.alloc(alignedSize);
    rowBuf.copy(aligned);

    // Apply IndexShift at bytes 2-3 (for Track, Artist, Album rows)
    if (hasIndexShift) {
      aligned.writeUInt16LE((this.numRows * 0x20) & 0xffff, 2);
    }

    this._topBufs.push(aligned);
    this._topSize += alignedSize;

    // RowSet management
    const bitIndex = this.numRows % MAX_ROWS_PER_ROWSET;
    if (bitIndex === 0) {
      this._rowsets.push({
        positions: new Array(MAX_ROWS_PER_ROWSET).fill(0),
        activeRows: 0,
        lastWrittenRows: 0,
      });
    }

    const rs = this._rowsets[this._rowsets.length - 1];
    rs.positions[bitIndex] = heapPosition;
    rs.activeRows |= 1 << bitIndex;
    rs.lastWrittenRows = 1 << bitIndex;

    this.numRows++;
    return true;
  }

  /**
   * Serialize the page to a 4096-byte Buffer.
   * @param {number} pageIndex - this page's index in the file
   * @param {number} nextPage - next page index (chain; or nextUnusedPage)
   * @param {number} transaction - sequence/commit number
   */
  toBuffer(pageIndex, nextPage, transaction) {
    const buf = Buffer.alloc(PAGE_SIZE); // all zeros by default

    const bottomSize = this._rowsets.length * ROWSET_SIZE;
    const freeSize = HEAP_SIZE - this._topSize - bottomSize;

    // ── Page Header (32 bytes) ──
    buf.writeUInt32LE(0, 0); // Magic
    buf.writeUInt32LE(pageIndex, 4); // PageIndex
    buf.writeUInt32LE(this.pageType, 8); // Type
    buf.writeUInt32LE(nextPage, 12); // NextPage
    buf.writeUInt32LE(transaction, 16); // Transaction
    buf.writeUInt32LE(0, 20); // Unknown2
    buf[24] = this.numRows & 0xff; // NumRowsSmall
    buf[25] = (this.numRows * 0x20) & 0xff; // Unknown3
    buf[26] = 0; // Unknown4
    buf[27] = 0x34; // PageFlags (data page)
    buf.writeUInt16LE(freeSize, 28); // FreeSize
    buf.writeUInt16LE(this._topSize, 30); // NextHeapWriteOffset

    // ── Data Page Header (8 bytes at offset 32) ──
    buf.writeUInt16LE(1, 32); // Unknown5
    buf.writeUInt16LE(0, 34); // NumRowsLarge
    buf.writeUInt16LE(0, 36); // Unknown6
    buf.writeUInt16LE(0, 38); // Unknown7

    // ── Row data at offset 40 ──
    let writePos = DATA_HEADER_TOTAL;
    for (const chunk of this._topBufs) {
      chunk.copy(buf, writePos);
      writePos += chunk.length;
    }

    // ── RowSets at end of heap (reversed order: last RowSet first) ──
    // Rex writeRowsets() prepends each RowSet to the bottom buffer, so RowSet[N-1]
    // ends up at the lowest bottom address, and RowSet[0] at the highest (very end).
    let rsOffset = PAGE_SIZE - ROWSET_SIZE;
    for (let i = 0; i < this._rowsets.length; i++) {
      this._serializeRowset(this._rowsets[i], buf, rsOffset);
      rsOffset -= ROWSET_SIZE;
    }

    return buf;
  }

  /** Write a RowSet at `offset` in buf with positions in reversed order. */
  _serializeRowset(rs, buf, offset) {
    // Reversed: write pos[15] first, pos[0] last (per rex row.go MarshalBinary)
    for (let i = MAX_ROWS_PER_ROWSET - 1; i >= 0; i--) {
      buf.writeUInt16LE(rs.positions[i], offset);
      offset += 2;
    }
    buf.writeUInt16LE(rs.activeRows, offset);
    offset += 2;
    buf.writeUInt16LE(rs.lastWrittenRows, offset);
  }
}

// ── Index page ────────────────────────────────────────────────────────────────

/**
 * Build a 4096-byte index page for a table.
 *
 * Index pages have PageFlags=0x64 and a heap mostly filled with 0x1ffffff8
 * sentinel values, followed by 20 zero bytes at the very end.
 *
 * @param {number} pageType
 * @param {number} pageIndex
 * @param {number} firstDataPage - first data page index for this table (or EMPTY_TABLE_SENTINEL)
 * @param {number} transaction
 */
export function buildIndexPage(pageType, pageIndex, firstDataPage, transaction) {
  const buf = Buffer.alloc(PAGE_SIZE);

  // ── Page Header (32 bytes) ──
  buf.writeUInt32LE(0, 0); // Magic
  buf.writeUInt32LE(pageIndex, 4); // PageIndex
  buf.writeUInt32LE(pageType, 8); // Type
  buf.writeUInt32LE(pageIndex + 1, 12); // NextPage (first data page slot = pageIndex+1)
  buf.writeUInt32LE(transaction, 16); // Transaction (always 1 for index pages)
  buf.writeUInt32LE(0, 20); // Unknown2
  buf[24] = 0; // NumRowsSmall
  buf[25] = 0; // Unknown3
  buf[26] = 0; // Unknown4
  buf[27] = 0x64; // PageFlags = index page
  buf.writeUInt16LE(0, 28); // FreeSize
  buf.writeUInt16LE(0, 30); // NextHeapWriteOffset

  // ── Index Header (28 bytes at offset 32) ──
  buf.writeUInt16LE(0x1fff, 32); // Unknown1
  buf.writeUInt16LE(0x1fff, 34); // Unknown2
  buf.writeUInt16LE(0x03ec, 36); // Unknown3
  buf.writeUInt16LE(0, 38); // NextOffset
  buf.writeUInt32LE(pageIndex, 40); // IndexHeader.PageIndex (mirrors header)
  buf.writeUInt32LE(EMPTY_TABLE_SENTINEL, 44); // IndexHeader.NextPage (no data initially)
  buf.writeUInt32LE(0x03ffffff, 48); // Unknown5
  buf.writeUInt32LE(0, 52); // Unknown6
  buf.writeUInt16LE(0, 56); // NumEntries
  buf.writeUInt16LE(0x1fff, 58); // FirstEmptyEntry

  // ── Heap: fill with 0x1ffffff8 sentinel, last 20 bytes stay zero ──
  // heap size = PAGE_SIZE - INDEX_HEADER_TOTAL = 4036
  // fill = (4036 - 20) / 4 = 1004 u32 entries
  const fillEnd = PAGE_SIZE - 20;
  for (let off = INDEX_HEADER_TOTAL; off < fillEnd; off += 4) {
    buf.writeUInt32LE(0x1ffffff8, off);
  }
  // Last 20 bytes remain zero from Buffer.alloc()

  return buf;
}

// ── File header ───────────────────────────────────────────────────────────────

/**
 * Build the 4096-byte file header page (page 0).
 *
 * @param {Map<number, {indexPageIndex, emptyCandidate, firstPage, lastPage}>} tableStates
 * @param {number} nextUnusedPage
 * @param {number} sequence
 */
export function buildFileHeader(tableStates, nextUnusedPage, sequence) {
  const numTables = TABLE_ORDER.length; // 20
  const buf = Buffer.alloc(PAGE_SIZE);

  // FileHeader
  buf.writeUInt32LE(0, 0); // Magic
  buf.writeUInt32LE(PAGE_SIZE, 4); // LenPage = 4096
  buf.writeUInt32LE(numTables, 8); // NumTables
  buf.writeUInt32LE(nextUnusedPage, 12); // NextUnusedPage
  buf.writeUInt32LE(0x05, 16); // Unknown1
  buf.writeUInt32LE(sequence, 20); // Sequence
  buf.writeUInt32LE(0, 24); // Gap (always 0)

  // TablePointers (16 bytes each, in TABLE_ORDER)
  let offset = 28;
  for (const type of TABLE_ORDER) {
    const st = tableStates.get(type);
    buf.writeUInt32LE(type, offset); // Type
    buf.writeUInt32LE(st.emptyCandidate, offset + 4); // EmptyCandidate
    buf.writeUInt32LE(st.firstPage, offset + 8); // FirstPage
    buf.writeUInt32LE(st.lastPage, offset + 12); // LastPage
    offset += 16;
  }

  return buf;
}

// ── PDB builder ───────────────────────────────────────────────────────────────

/**
 * Build the complete PDB binary buffer from an input object.
 *
 * Ported from the rex Go library (github.com/ambientsound/rex):
 *  1. Create all 20 table index pages (nextUnusedPage starts at 1, increments by 2 per table)
 *  2. Insert row data into pages per table type
 *  3. Write file header page
 *
 * @param {{ tracks, playlists }} input
 * @returns {Buffer}
 */
function buildPdbBuffer(input) {
  const { tracks = [], playlists = [] } = input;

  // ── Step 1: Assign IDs and collect lookup maps ──
  const artistMap = new Map(); // name → pdbId (1-indexed)
  const albumMap = new Map();
  const keyMap = new Map(); // key name → pdbId (1-indexed)
  const trackPdbId = new Map(); // inputId → pdbId

  let artistIdCounter = 1;
  let albumIdCounter = 1;
  let keyIdCounter = 1;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    trackPdbId.set(t.id, i + 1);
    if (t.artist && !artistMap.has(t.artist)) artistMap.set(t.artist, artistIdCounter++);
    if (t.album && !albumMap.has(t.album)) albumMap.set(t.album, albumIdCounter++);
    const keyName = normalizeKeyName(t.key_raw);
    if (keyName && !keyMap.has(keyName)) keyMap.set(keyName, keyIdCounter++);
  }

  // ── Step 2: Build all row buffers grouped by table type ──
  const rowsByType = new Map();
  for (const type of TABLE_ORDER) rowsByType.set(type, []);

  const now = new Date().toISOString().slice(0, 10);

  // Track rows
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const pdbId = i + 1;
    const artistId = t.artist ? (artistMap.get(t.artist) ?? 0) : 0;
    const albumId = t.album ? (albumMap.get(t.album) ?? 0) : 0;
    const keyId = t.key_raw ? (keyMap.get(normalizeKeyName(t.key_raw)) ?? 0) : 0;

    rowsByType.get(TABLE_TYPES.Tracks).push(
      buildTrackRow({
        id: pdbId,
        artistId,
        albumId,
        keyId,
        title: t.title || '',
        filePath: t.file_path || '',
        filename: basename(t.file_path || ''),
        fileSize: t.file_size || 0,
        bitrate: t.bitrate || 320,
        tempo: Math.round((t.bpm || 0) * 100),
        trackNumber: t.track_number || 0,
        year: parseInt(t.year) || 0,
        duration: Math.round(t.duration || 0),
        fileType: detectFileType(t.file_path || ''),
        rating: encodeRating(t.rating || 0),
        comment: t.comments || '',
        analyzePath: t.analyzePath || '',
        dateAdded: now,
        analyzeDate: now,
        sampleRate: 44100,
        sampleDepth: 16,
      })
    );
  }

  // Artist rows
  for (const [name, id] of artistMap) {
    rowsByType.get(TABLE_TYPES.Artists).push(buildArtistRow(id, name));
  }

  // Album rows
  for (const [name, id] of albumMap) {
    rowsByType.get(TABLE_TYPES.Albums).push(buildAlbumRow(id, 0, name));
  }

  // Key rows
  for (const [name, id] of keyMap) {
    rowsByType.get(TABLE_TYPES.Keys).push(buildKeyRow(id, name));
  }

  // Playlist rows
  for (let i = 0; i < playlists.length; i++) {
    const pl = playlists[i];
    const plId = i + 1;
    rowsByType.get(TABLE_TYPES.PlaylistTree).push(
      buildPlaylistTreeRow({
        id: plId,
        parentId: 0,
        sortOrder: i,
        isFolder: false,
        name: pl.name,
      })
    );
    for (let j = 0; j < (pl.track_ids || []).length; j++) {
      const pdbTrackId = trackPdbId.get(pl.track_ids[j]);
      if (pdbTrackId === undefined) continue;
      rowsByType
        .get(TABLE_TYPES.PlaylistEntries)
        .push(buildPlaylistEntryRow(j + 1, pdbTrackId, plId));
    }
  }

  // Static datasets
  for (const r of COLOR_DATASET) rowsByType.get(TABLE_TYPES.Colors).push(buildColorRow(r));
  for (const r of COLUMN_DATASET) rowsByType.get(TABLE_TYPES.Columns).push(buildColumnRow(r));
  for (const r of UNKNOWN17_DATASET)
    rowsByType.get(TABLE_TYPES.Unknown17).push(buildUnknown17Row(r));
  for (const r of UNKNOWN18_DATASET)
    rowsByType.get(TABLE_TYPES.Unknown18).push(buildUnknown18Row(r));

  // ── Step 3: Database engine — assign page numbers ──
  const writtenPages = new Map(); // pageIndex → Buffer
  const tableStates = new Map();

  let nextUnusedPage = 1;
  let sequence = 2;

  // Create all 20 tables: write index pages, reserve emptyCandidate slots
  for (const type of TABLE_ORDER) {
    const indexPageIndex = nextUnusedPage;
    const emptyCandidate = indexPageIndex + 1;

    const indexBuf = buildIndexPage(type, indexPageIndex, EMPTY_TABLE_SENTINEL, 1);
    writtenPages.set(indexPageIndex, indexBuf);

    tableStates.set(type, {
      indexPageIndex,
      emptyCandidate,
      firstPage: indexPageIndex,
      lastPage: indexPageIndex,
    });

    nextUnusedPage += 2;
  }

  // Insert data pages for each non-empty table
  for (const type of TABLE_ORDER) {
    const rows = rowsByType.get(type);
    if (!rows || rows.length === 0) continue;

    const hasIndexShift =
      type === TABLE_TYPES.Tracks || type === TABLE_TYPES.Artists || type === TABLE_TYPES.Albums;

    let currentPage = new DataPage(type);
    const st = tableStates.get(type);

    // Track whether we've written the first data page (to update index's NextPage ref)
    let firstDataPageIndex = st.emptyCandidate;
    let currentPageIndex = st.emptyCandidate;

    for (const rowBuf of rows) {
      if (!currentPage.insertRow(rowBuf, hasIndexShift)) {
        // Page full — flush it
        const pageBuf = currentPage.toBuffer(currentPageIndex, nextUnusedPage, sequence);
        writtenPages.set(currentPageIndex, pageBuf);
        st.lastPage = currentPageIndex;
        st.emptyCandidate = nextUnusedPage;
        nextUnusedPage++;
        sequence++;

        currentPage = new DataPage(type);
        currentPageIndex = st.emptyCandidate;

        // Must succeed now (row is larger than a page would be an error)
        currentPage.insertRow(rowBuf, hasIndexShift);
      }
    }

    // Flush final page
    const finalNextPage = nextUnusedPage;
    const pageBuf = currentPage.toBuffer(currentPageIndex, finalNextPage, sequence);
    writtenPages.set(currentPageIndex, pageBuf);
    st.lastPage = currentPageIndex;
    st.emptyCandidate = finalNextPage;
    nextUnusedPage++;
    sequence++;

    // Update index page to point to first data page
    const updatedIndex = buildIndexPage(type, st.indexPageIndex, firstDataPageIndex, 1);
    writtenPages.set(st.indexPageIndex, updatedIndex);
    // But IndexHeader.NextPage in the index should be the first data page
    // We wrote EMPTY_TABLE_SENTINEL initially; now patch it
    updatedIndex.writeUInt32LE(firstDataPageIndex, 44);
    writtenPages.set(st.indexPageIndex, updatedIndex);
  }

  // ── Step 4: Build file buffer ──
  const maxPage = Math.max(...writtenPages.keys());
  const totalPages = maxPage + 1;
  const fileBuf = Buffer.alloc(totalPages * PAGE_SIZE);

  // Write file header at page 0
  const headerBuf = buildFileHeader(tableStates, nextUnusedPage, sequence);
  headerBuf.copy(fileBuf, 0);

  // Write all other pages
  for (const [pageIndex, pageBuf] of writtenPages) {
    pageBuf.copy(fileBuf, pageIndex * PAGE_SIZE);
  }

  return fileBuf;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write a Rekordbox PDB file to the given output path.
 *
 * @param {{ usbRoot?: string, tracks: object[], playlists: object[] }} input
 * @param {string} outputPath - absolute path including filename
 */
export function writePdb(input, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const buf = buildPdbBuffer(input);
  writeFileSync(outputPath, buf);
}
