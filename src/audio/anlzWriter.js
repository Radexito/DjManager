import fs from 'fs';
import path from 'path';
import { generateWaveform } from './waveformGenerator.js';

// ─── Path hashing (ported from beirbox-gui/ANLZ/ANLZ.go) ──────────────────────
// Pioneer CDJs store ANLZ files at PIONEER/USBANLZ/{hash}/ANLZ0000.DAT
// The hash is derived from the USB-relative file path.

function getFolderName(filename) {
  // Normalise to forward slashes and ensure leading slash
  filename = filename.replace(/\\/g, '/');
  if (!filename.startsWith('/')) filename = '/' + filename;

  let hash = 0;
  for (let i = 0; i < filename.length; i++) {
    const c = filename.charCodeAt(i);
    // Simulate uint32 overflow using >>> 0
    hash = (Math.imul(hash, 0x34f5501d) + Math.imul(c, 0x93b6)) >>> 0;
  }

  const part2 = hash % 0x30d43;
  // Bit-manipulation to derive directory index (part1)
  const part1 =
    ((((((((((part2 >> 2) & 0x4000) | (part2 & 0x2000)) >> 3) | (part2 & 0x200)) >> 1) |
      (part2 & 0xc0)) >>
      3) |
      (part2 & 0x4)) >>
      1) |
    (part2 & 0x1);

  return `P${part1.toString(16).toUpperCase().padStart(3, '0')}/${part2.toString(16).toUpperCase().padStart(8, '0')}`;
}

// ─── Low-level binary helpers ──────────────────────────────────────────────────

function u32BE(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0);
  return b;
}

function _u16BE(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value & 0xffff);
  return b;
}

function stringToUTF16BE(str) {
  const buf = Buffer.alloc(str.length * 2 + 2); // +2 for null terminator
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  // last 2 bytes remain 0x0000 (null terminator)
  return buf;
}

// ─── Section builders ──────────────────────────────────────────────────────────

function buildSection(fourcc, bodyBuf, lenHeader) {
  const header = Buffer.alloc(12);
  header.write(fourcc, 0, 4, 'ascii');
  header.writeUInt32BE(lenHeader, 4); // len_header (offset where payload begins)
  header.writeUInt32BE(bodyBuf.length + 12, 8); // len_tag = header(12) + body
  return Buffer.concat([header, bodyBuf]);
}

function buildPathTag(usbFilePath) {
  const encoded = stringToUTF16BE(usbFilePath);
  // len_path = byte count of path string INCLUDING the 2-byte null terminator.
  // Confirmed from native Rekordbox output: a path of 85 chars produces len_path=172
  // (85*2+2=172), i.e. the null terminator IS counted.
  const body = Buffer.concat([u32BE(encoded.length), encoded]);
  // len_header=16: 12 common + 4 for len_path field (confirmed from real CDJ files)
  return buildSection('PPTH', body, 16);
}

/**
 * Builds a PQTZ beat grid section from beat data.
 *
 * beatgrid from mixxx-analyzer is stored as JSON in the DB.
 * Supported formats:
 *   - Array of numbers (beat positions in seconds): [0.5, 0.97, 1.44, ...]
 *   - Array of objects with 'position' or 'time' keys: [{position: 0.5}, ...]
 *   - Fallback: generate mathematically from bpm
 *
 * Pioneer beat entry: beatNumber (1-4), tempo (BPM * 100), time (ms, u32)
 */
function computeBeats(beatgridJson, bpm) {
  let beats = [];

  try {
    if (beatgridJson) {
      const raw = typeof beatgridJson === 'string' ? JSON.parse(beatgridJson) : beatgridJson;

      if (Array.isArray(raw) && raw.length > 0) {
        if (typeof raw[0] === 'number') {
          // Array of beat positions in seconds
          beats = raw.map((t, i) => ({ time: Math.round(t * 1000), beatNumber: (i % 4) + 1 }));
        } else if (typeof raw[0] === 'object') {
          // Array of objects — try common field names
          beats = raw.map((b, i) => ({
            time: Math.round((b.position ?? b.time ?? b.offset ?? 0) * 1000),
            beatNumber: (i % 4) + 1,
          }));
        }
      }
    }
  } catch {}

  // Fall back to mathematical generation from BPM
  if (beats.length === 0 && bpm > 0) {
    beats = generateBeatsFromBpm(bpm, 600); // 600 seconds max
  }

  return beats;
}

function buildBeatGrid(beats, bpm) {
  if (beats.length === 0) {
    // Empty beat grid — write minimal valid header
    const header = Buffer.alloc(12);
    header.writeUInt32BE(0, 0);
    header.writeUInt32BE(0x80000, 4);
    header.writeUInt32BE(0, 8);
    // len_header=24: 12 common + 12 fixed fields (confirmed from real CDJ files)
    return buildSection('PQTZ', header, 24);
  }

  const tempoU16 = Math.round((bpm || 128) * 100) & 0xffff;

  const header = Buffer.alloc(12);
  header.writeUInt32BE(0, 0);
  header.writeUInt32BE(0x80000, 4);
  header.writeUInt32BE(beats.length, 8);

  const beatEntries = beats.map(({ beatNumber, time }) => {
    const entry = Buffer.alloc(8);
    entry.writeUInt16BE(beatNumber, 0);
    entry.writeUInt16BE(tempoU16, 2);
    entry.writeUInt32BE(time >>> 0, 4);
    return entry;
  });

  // len_header=24: 12 common + 12 fixed fields (confirmed from real CDJ files)
  return buildSection('PQTZ', Buffer.concat([header, ...beatEntries]), 24);
}

/**
 * Builds a PQT2 section (extended beatgrid for Rekordbox 6+).
 * lh=56: 12 standard header + 44 bytes of section-specific fields.
 * Reverse-engineered from native Rekordbox ANLZ files.
 *
 * Header fields (after the 12-byte standard header):
 *   [12-15]: 0x00000000
 *   [16-19]: 0x01000002 (constant observed in all native files)
 *   [20-23]: 0x00000000
 *   [24-31]: first beat anchor: beat_num(u16) + tempo_centiBPM(u16) + time_ms(u32)
 *   [32-39]: last beat anchor:  beat_num(u16) + tempo_centiBPM(u16) + time_ms(u32)
 *   [40-43]: entry_count
 *   [44-47]: unknown (set to 0)
 *   [48-55]: reserved zeros
 * Body: entry_count × u16 BE entries.
 *   Native values use a Bresenham-style accumulation (exact format TBD).
 *   We approximate: V[i] = beat_time_ms[i] mod 1000.
 *   Rekordbox 6 requires entry_count > 0 to display the beatgrid;
 *   approximate body values are sufficient for correct display.
 */
function buildPqt2Section(beats, bpm) {
  const ec = beats.length;
  const bodyLen = ec * 2;

  const hdr = Buffer.alloc(56);
  hdr.write('PQT2', 0, 4, 'ascii');
  hdr.writeUInt32BE(56, 4); // len_header
  hdr.writeUInt32BE(56 + bodyLen, 8); // len_tag = header + body

  hdr.writeUInt32BE(0x01000002, 16); // constant

  const tempoU16 = Math.round((bpm || 128) * 100) & 0xffff;

  if (ec > 0) {
    const first = beats[0];
    hdr.writeUInt16BE(first.beatNumber, 24);
    hdr.writeUInt16BE(tempoU16, 26);
    hdr.writeUInt32BE(first.time >>> 0, 28);

    const last = beats[ec - 1];
    hdr.writeUInt16BE(last.beatNumber, 32);
    hdr.writeUInt16BE(tempoU16, 34);
    hdr.writeUInt32BE(last.time >>> 0, 36);
  }

  hdr.writeUInt32BE(ec, 40); // entry_count

  // Body: one u16 per beat. Approximate: beat_time_ms mod 1000.
  // This satisfies Rekordbox 6's requirement for ec > 0.
  const body = Buffer.alloc(bodyLen);
  for (let i = 0; i < ec; i++) {
    body.writeUInt16BE(beats[i].time % 1000, i * 2);
  }

  return Buffer.concat([hdr, body]);
}

function generateBeatsFromBpm(bpm, maxSeconds = 600) {
  const intervalMs = 60000 / bpm;
  const maxBeats = Math.floor((maxSeconds * 1000) / intervalMs);
  const beats = [];
  for (let i = 0; i < maxBeats; i++) {
    beats.push({
      beatNumber: (i % 4) + 1,
      time: Math.round(i * intervalMs),
    });
  }
  return beats;
}

/**
 * Builds a PVBR (Variable Bit Rate seek index) section.
 * Required by Rekordbox in every ANLZ0000.DAT file.
 * Body: 4-byte unknown + 400 × u32BE byte-offsets for equal-time seek positions.
 * @param {number} fileSize  Total byte size of the source audio file (0 = unknown)
 */
function buildPvbrSection(fileSize) {
  const ENTRIES = 400;
  const body = Buffer.alloc(4 + ENTRIES * 4); // 1604 bytes
  // First 4 bytes: unknown; native Rekordbox writes the ID3 header size here.
  // Use 0 when unknown — Rekordbox accepts this.
  body.writeUInt32BE(0, 0);
  // Generate linear seek table: entry[i] = byte position at (i/ENTRIES) of the file.
  const size = fileSize > 0 ? fileSize : 0;
  for (let i = 0; i < ENTRIES; i++) {
    body.writeUInt32BE(Math.floor((i * size) / ENTRIES), 4 + i * 4);
  }
  return buildSection('PVBR', body, 16);
}

// ─── Cue point sections (PCOB / PCO2) ─────────────────────────────────────────
//
// Rekordbox 6+ / CDJ-3000 format uses sub-tagged entries inside PCOB and PCO2.
// Each PCOB entry is wrapped in a PCPT sub-tag (56 bytes fixed).
// Each PCO2 entry is wrapped in a PCP2 sub-tag (variable, min 104 bytes).
//
// Confirmed by hex-comparing native Rekordbox USB exports.
// The older flat-entry format (documented in crate-digger for early CDJ firmware)
// causes Rekordbox to reject the entire ANLZ file, silently dropping waveforms
// and beatgrids even though those sections precede PCOB in the stream.
//
// PCOB header (24 bytes): fourcc + len_header(24) + len_tag + count + memory_count + unk(0xffffffff)
// PCPT sub-tag (56 bytes, fixed):
//   [0-11]:  standard header  fourcc='PCPT', len_header=28, len_tag=56
//   [12-15]: entry order (1-based)
//   [16-19]: 0x00000000
//   [20-21]: 0x0001 (active)
//   [22-23]: 0x0000
//   [24-27]: 0xffffffff
//   [28]:    hot_cue_index (0-7=A-H, 0xff=memory cue)
//   [29]:    0x00
//   [30-31]: 0x03e8 (constant observed in all native files)
//   [32-35]: position_ms (u32BE)
//   [36-39]: loop_time (u32BE, 0xffffffff=none)
//   [40]:    color_index
//   [41-55]: zeros
//
// PCO2 header (20 bytes): fourcc + len_header(20) + len_tag + count + memory_count(u16BE) + u16(0)
// PCP2 sub-tag (variable, min 104 bytes):
//   [0-11]:  standard header  fourcc='PCP2', len_header=16, len_tag=variable
//   [12-15]: entry order (1-based)
//   body at [16+]:
//     [0]:    hot_cue_index
//     [1]:    0x00
//     [2-3]:  0x03e8 (constant)
//     [4-7]:  position_ms (u32BE)
//     [8-11]: loop_time (u32BE)
//     [12-13]: 0x0001 (status)
//     [14-23]: zeros
//     [24-27]: label_length (bytes incl null terminator, 0=no label)
//     [28+]:  UTF-16BE label (null-terminated)
//     [28+labelByteLen]:   color_index
//     [28+labelByteLen+1]: 0xff (unk, constant in native files)
//     [28+labelByteLen+2-3]: 0x0017 (unk, constant in native files)
//     rest: zeros to reach min body size of 88 bytes
//
// Rekordbox color palette (hot cue / memory cue color index):
const REKORDBOX_COLORS = [
  '#ff6b35', // 0  orange-red  (hot cue A default)
  '#ff0000', // 1  red
  '#ff9900', // 2  orange
  '#ffff00', // 3  yellow
  '#00ff00', // 4  green
  '#00b4d8', // 5  cyan
  '#0080ff', // 6  blue
  '#cc00ff', // 7  violet
];

function hexToRekordboxColor(hex) {
  if (!hex) return 5; // default cyan
  const norm = hex.toLowerCase();
  const idx = REKORDBOX_COLORS.indexOf(norm);
  return idx >= 0 ? idx : 5;
}

const EMPTY_PCOB_1 = Buffer.from([
  0x50,
  0x43,
  0x4f,
  0x42, // 'PCOB'
  0x00,
  0x00,
  0x00,
  0x18, // len_header = 24
  0x00,
  0x00,
  0x00,
  0x18, // len_tag = 24 (no entries)
  0x00,
  0x00,
  0x00,
  0x01, // count_indicator = 1 (slot 1 header sentinel)
  0x00,
  0x00,
  0x00,
  0x00,
  0xff,
  0xff,
  0xff,
  0xff,
]);
const EMPTY_PCOB_2 = Buffer.from([
  0x50,
  0x43,
  0x4f,
  0x42,
  0x00,
  0x00,
  0x00,
  0x18,
  0x00,
  0x00,
  0x00,
  0x18,
  0x00,
  0x00,
  0x00,
  0x00, // count_indicator = 0 (slot 2)
  0x00,
  0x00,
  0x00,
  0x00,
  0xff,
  0xff,
  0xff,
  0xff,
]);
const EMPTY_PCO2_1 = Buffer.from([
  0x50,
  0x43,
  0x4f,
  0x32, // 'PCO2'
  0x00,
  0x00,
  0x00,
  0x14, // len_header = 20
  0x00,
  0x00,
  0x00,
  0x14, // len_tag = 20
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x00,
]);
const EMPTY_PCO2_2 = Buffer.from([
  0x50, 0x43, 0x4f, 0x32, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

/**
 * Builds a single PCPT sub-tag entry (56 bytes, fixed size).
 * Per crate-digger ksy: [12-15]=hot_cue number (0=memory,1=A,2=B…), [28]=type (1=point,2=loop).
 */
function buildPcptEntry(hotCueNum, positionMs, color) {
  const buf = Buffer.alloc(56, 0);
  buf.write('PCPT', 0, 'ascii');
  buf.writeUInt32BE(28, 4); // len_header = 28
  buf.writeUInt32BE(56, 8); // len_tag = 56
  buf.writeUInt32BE(hotCueNum, 12); // hot_cue: 0=memory, 1=A, 2=B, …
  // [16-19]: status = 0x00000000
  buf.writeUInt32BE(0x00010000, 20); // constant observed in all native Rekordbox files
  buf.writeUInt16BE(0xffff, 24); // order_first
  buf.writeUInt16BE(0xffff, 26); // order_last
  buf[28] = 1; // type: 1=point_cue (NOT hot_cue_index)
  // buf[29] = 0x00
  buf.writeUInt16BE(0x03e8, 30); // constant
  buf.writeUInt32BE(positionMs, 32); // time_ms
  buf.writeUInt32BE(0xffffffff, 36); // loop_time: none
  buf[40] = hexToRekordboxColor(color);
  return buf;
}

function buildPcobSlot(slotType, cues) {
  // slotType: 1=hot_cues (slot 1), 0=memory_cues (slot 2)
  if (cues.length === 0) return slotType === 1 ? EMPTY_PCOB_1 : EMPTY_PCOB_2;
  const headerSize = 24;
  const tagLen = headerSize + cues.length * 56;
  const buf = Buffer.alloc(tagLen, 0);
  buf.write('PCOB', 0, 'ascii');
  buf.writeUInt32BE(headerSize, 4); // len_header = 24
  buf.writeUInt32BE(tagLen, 8); // len_tag
  buf.writeUInt32BE(slotType, 12); // type: 1=hot_cues, 0=memory_cues
  // [16-17]: padding = 0
  buf.writeUInt16BE(cues.length, 18); // num_cues (u16BE)
  buf.writeUInt32BE(0xffffffff, 20); // memory_count sentinel
  cues.forEach((cue, i) => {
    // DB hot_cue_index: <0 = memory cue, >=0 = hot cue (0=A, 1=B, …)
    // Pioneer format: 0=memory, 1=A, 2=B, …
    const hotCueNum = cue.hot_cue_index >= 0 ? cue.hot_cue_index + 1 : 0;
    buildPcptEntry(hotCueNum, Math.round(cue.position_ms), cue.color).copy(
      buf,
      headerSize + i * 56
    );
  });
  return buf;
}

/**
 * Build populated PCOB section buffers [slot1, slot2].
 * Slot 1 (type=1) contains hot cues only. Slot 2 is ALWAYS the empty stub —
 * Rekordbox rejects the entire ANLZ file if PCOB2 contains any entries.
 * Memory cues are stored exclusively in EXT PCO2.
 *
 * @param {Array<{position_ms, color, hot_cue_index}>} cuePoints
 * @returns {[Buffer, Buffer]}
 */
export function buildPcobSections(cuePoints) {
  if (!cuePoints || cuePoints.length === 0) return [EMPTY_PCOB_1, EMPTY_PCOB_2];
  const hotCues = cuePoints.filter((c) => c.hot_cue_index >= 0);
  return [buildPcobSlot(1, hotCues), EMPTY_PCOB_2];
}

/**
 * Builds a single PCP2 sub-tag entry (variable size, min 104 bytes).
 * Per crate-digger ksy: [12-15]=hot_cue number, [16]=type (1=point_cue).
 */
function buildPcp2Entry(hotCueNum, positionMs, label, color) {
  const labelStr = label ?? '';
  const labelByteLen = labelStr.length > 0 ? (labelStr.length + 1) * 2 : 0; // UTF-16BE + null
  // body (starting at offset 16) is min 88 bytes
  const bodySize = Math.max(88, 28 + labelByteLen + 4);
  const lenTag = 16 + bodySize;

  const buf = Buffer.alloc(lenTag, 0);
  buf.write('PCP2', 0, 'ascii');
  buf.writeUInt32BE(16, 4); // len_header = 16
  buf.writeUInt32BE(lenTag, 8); // len_tag
  buf.writeUInt32BE(hotCueNum, 12); // hot_cue: 0=memory, 1=A, 2=B, …

  // body at offset 16:
  buf[16] = 1; // type: 1=point_cue (NOT hot_cue_index)
  // buf[17] = 0x00
  buf.writeUInt16BE(0x03e8, 18); // constant
  buf.writeUInt32BE(positionMs, 20); // time_ms
  buf.writeUInt32BE(0xffffffff, 24); // loop_time: none
  // buf[28] = 0x00 (color_id)
  buf[29] = 0x01; // undocumented constant observed in native Rekordbox files
  // [30-39]: zeros
  buf.writeUInt32BE(labelByteLen, 40); // len_comment

  if (labelStr.length > 0) {
    buf.write(labelStr, 44, 'utf16le'); // write LE then byte-swap to BE
    for (let j = 44; j < 44 + labelStr.length * 2; j += 2) {
      const tmp = buf[j];
      buf[j] = buf[j + 1];
      buf[j + 1] = tmp;
    }
    // null terminator bytes remain 0x00 0x00
  }

  const colorOff = 44 + labelByteLen;
  buf[colorOff] = hexToRekordboxColor(color);
  buf[colorOff + 1] = 0xff; // constant
  buf.writeUInt16BE(0x0017, colorOff + 2); // constant

  return buf;
}

function buildPco2Slot(slotType, cues) {
  // slotType: 1=hot_cues (slot 1), 0=memory_cues (slot 2)
  if (cues.length === 0) return slotType === 1 ? EMPTY_PCO2_1 : EMPTY_PCO2_2;
  const headerSize = 20;
  const entries = cues.map((cue) => {
    const hotCueNum = cue.hot_cue_index >= 0 ? cue.hot_cue_index + 1 : 0;
    return buildPcp2Entry(hotCueNum, Math.round(cue.position_ms), cue.label, cue.color);
  });
  const bodyLen = entries.reduce((s, e) => s + e.length, 0);
  const tagLen = headerSize + bodyLen;

  const header = Buffer.alloc(headerSize, 0);
  header.write('PCO2', 0, 'ascii');
  header.writeUInt32BE(headerSize, 4); // len_header = 20
  header.writeUInt32BE(tagLen, 8); // len_tag
  header.writeUInt32BE(slotType, 12); // type: 1=hot_cues, 0=memory_cues
  header.writeUInt16BE(cues.length, 16); // num_cues (u16BE)
  // [18-19]: padding = 0

  return Buffer.concat([header, ...entries]);
}

/**
 * Build populated PCO2 section buffers [slot1, slot2] (EXT file only).
 * Slot 1 (type=1) contains hot cues; slot 2 (type=0) contains memory cues.
 *
 * @param {Array<{position_ms, label, color, hot_cue_index}>} cuePoints
 * @returns {[Buffer, Buffer]}
 */
export function buildPco2Sections(cuePoints) {
  if (!cuePoints || cuePoints.length === 0) return [EMPTY_PCO2_1, EMPTY_PCO2_2];
  const hotCues = cuePoints.filter((c) => c.hot_cue_index >= 0);
  const memoryCues = cuePoints.filter((c) => c.hot_cue_index < 0);
  return [buildPco2Slot(1, hotCues), buildPco2Slot(0, memoryCues)];
}

// ─── PMAI file header ──────────────────────────────────────────────────────────

function buildFileHeader(totalSize) {
  const buf = Buffer.alloc(28); // 0x1C
  buf.write('PMAI', 0, 4, 'ascii');
  buf.writeUInt32BE(0x1c, 4); // len_header
  buf.writeUInt32BE(totalSize, 8); // len_file
  // bytes 12–27: observed constant in real CDJ/rekordbox ANLZ files
  buf.writeUInt32BE(0x00000001, 12);
  buf.writeUInt32BE(0x00010000, 16);
  buf.writeUInt32BE(0x00010000, 20);
  buf.writeUInt32BE(0x00000000, 24);
  return buf;
}

// ─── Waveform section builders ────────────────────────────────────────────────

/**
 * Builds a PWV3 section (monochrome scrolling waveform, 10ms/column, 1 byte each).
 * Byte encoding: (whiteness[0-7] << 5) | height[0-31]
 */
function buildPwv3Section(pwv3Data) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(1, 0); // lenEntryBytes
  header.writeUInt32BE(pwv3Data.length, 4); // lenEntries
  header.writeUInt32BE(0x960000, 8); // constant observed in beirbox reference files
  return buildSectionWithBigHeader('PWV3', header, pwv3Data);
}

/**
 * Builds a PWV5 section (2-byte colour scroll waveform for CDJ-3000, 10ms/column).
 * u16be per Pioneer/crate-digger spec:
 *   bits 15-13: red   (treble energy, 3 bits)
 *   bits 12-10: green (mid energy,    3 bits)
 *   bits  9- 7: blue  (bass energy,   3 bits)
 *   bits  6- 2: height               (5 bits)
 *   bits  1- 0: unused
 */
function buildPwv5Section(pwv5Data) {
  const numEntries = pwv5Data.length / 2;
  const header = Buffer.alloc(12);
  header.writeUInt32BE(2, 0); // lenEntryBytes
  header.writeUInt32BE(numEntries, 4); // lenEntries
  header.writeUInt32BE(0x00960305, 8); // confirmed from native Rekordbox EXT files
  return buildSectionWithBigHeader('PWV5', header, pwv5Data);
}

/**
 * Builds a PWAV section (monochrome preview waveform for touch strip).
 * Fixed 400 columns, same byte encoding as PWV3: (whiteness << 5) | height.
 * The unknown u32 field always has value 0x00010000 per crate-digger spec.
 */
function buildPwavSection(pwavData) {
  // PWAV body: lenData(u4) + unknown(u4, always 0x00010000) + data bytes
  // len_header=20: 12 common + 8 fixed fields (confirmed from real CDJ files)
  const body = Buffer.alloc(8 + pwavData.length);
  body.writeUInt32BE(pwavData.length, 0);
  body.writeUInt32BE(0x00010000, 4);
  pwavData.copy(body, 8);
  return buildSection('PWAV', body, 20);
}

/**
 * Builds a PWV2 section (tiny monochrome overview for CDJ-900).
 * Fixed 100 columns, 1 byte each: 4-bit height only (byte = height & 0x0F).
 */
function buildPwv2Section(pwv2Data) {
  // len_header=20: 12 common + 8 fixed fields (confirmed from real CDJ files)
  const body = Buffer.alloc(8 + pwv2Data.length);
  body.writeUInt32BE(pwv2Data.length, 0);
  body.writeUInt32BE(0x00010000, 4);
  pwv2Data.copy(body, 8);
  return buildSection('PWV2', body, 20);
}

/**
 * Builds a PWV4 section (colour preview waveform for CDJ-NXS2).
 * Fixed 1200 columns × 6 bytes each = 7200 bytes.
 * Per rekordcrate: [whiteness, whiteness, overall_rms, bass, mid, treble]
 */
function buildPwv4Section(pwv4Data) {
  const numEntries = pwv4Data.length / 6;
  const header = Buffer.alloc(12);
  header.writeUInt32BE(6, 0); // lenEntryBytes
  header.writeUInt32BE(numEntries, 4); // lenEntries
  header.writeUInt32BE(0x00000000, 8); // confirmed from native Rekordbox EXT files
  return buildSectionWithBigHeader('PWV4', header, pwv4Data);
}

/**
 * Builds a PWV7 section (3-byte/col colour scroll waveform for CDJ-3000 / .2EX).
 * Each column: [treble(0-255), mid(0-255), bass(0-255)]
 * Header: type=3, numCols, unk=0x00960000 (same as PWV3, confirmed from native .2EX)
 */
function buildPwv7Section(pwv7Data, numCols) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(3, 0); // type = 3 (bytes per col)
  header.writeUInt32BE(numCols, 4); // numCols
  header.writeUInt32BE(0x00960000, 8); // unk — confirmed from native .2EX
  return buildSectionWithBigHeader('PWV7', header, pwv7Data);
}

/**
 * Builds a PWV6 section (3-byte/col colour overview for CDJ-3000 / .2EX).
 * Fixed 1200 columns × 3 bytes = 3600 bytes.
 * Header len_header=20 (not 24 — confirmed from native .2EX).
 */
function buildPwv6Section(pwv6Data) {
  const hdr = Buffer.alloc(20);
  hdr.write('PWV6', 0, 4, 'ascii');
  hdr.writeUInt32BE(20, 4); // len_header
  hdr.writeUInt32BE(20 + pwv6Data.length, 8); // len_tag
  hdr.writeUInt32BE(3, 12); // type = 3
  hdr.writeUInt32BE(1200, 16); // numCols = 1200 (fixed)
  return Buffer.concat([hdr, pwv6Data]);
}

/**
 * Builds a PWVC section (colour waveform calibration — 6-byte body).
 * Static values `00 64 00 68 00 C5` observed in all native .2EX files.
 * len_header=14 (unusual — confirmed from native .2EX).
 */
function buildPwvcSection() {
  const buf = Buffer.alloc(20);
  buf.write('PWVC', 0, 4, 'ascii');
  buf.writeUInt32BE(14, 4); // len_header = 14
  buf.writeUInt32BE(20, 8); // len_tag = 20 (14 header + 6 body)
  // bytes 12-13: two padding zeros (already zero from alloc)
  // body at offset 14:
  buf.writeUInt16BE(0x0064, 14); // 100
  buf.writeUInt16BE(0x0068, 16); // 104
  buf.writeUInt16BE(0x00c5, 18); // 197
  return buf;
}

// Sections with a 24-byte header (12 standard + 12 section-specific)
function buildSectionWithBigHeader(fourcc, specificHeader, data) {
  const hdr = Buffer.alloc(24);
  hdr.write(fourcc, 0, 4, 'ascii');
  hdr.writeUInt32BE(24, 4); // len_header
  // len_tag = total section size = 24-byte header + data length.
  // specificHeader (12 bytes) is already embedded inside hdr, not appended separately.
  hdr.writeUInt32BE(24 + data.length, 8); // len_tag
  specificHeader.copy(hdr, 12);
  return Buffer.concat([hdr, data]);
}

/**
 * Writes ANLZ0000.DAT and ANLZ0000.EXT for a single track.
 * Includes real waveforms generated from the source audio via ffmpeg.
 *
 * @param {object} opts
 * @param {string}  opts.usbFilePath    - USB-relative path e.g. "/music/Artist - Title.mp3"
 * @param {string}  opts.sourceFilePath - Absolute path to original audio on disk
 * @param {string|null} opts.beatgrid   - JSON string from DB (mixxx-analyzer output)
 * @param {number}  opts.bpm            - BPM value from DB
 * @param {string}  opts.usbRoot        - Absolute path to USB root on disk
 * @param {Array}   [opts.cuePoints]    - Cue point rows from cue_points table
 */
export async function writeAnlz(opts) {
  const { usbFilePath, sourceFilePath, beatgrid, bpm, usbRoot, ffmpegPath, cuePoints } = opts;

  const folderHash = getFolderName(usbFilePath);
  const anlzDir = path.join(usbRoot, 'PIONEER', 'USBANLZ', folderHash);
  fs.mkdirSync(anlzDir, { recursive: true });

  // ── Generate waveforms from source audio ─────────────────────────────────
  let waveforms = null;
  if (sourceFilePath) {
    try {
      waveforms = await generateWaveform(sourceFilePath, ffmpegPath || 'ffmpeg');
    } catch (err) {
      console.warn('[anlz] waveform generation failed, skipping:', err.message);
    }
  }

  // ── Compute beat array once — shared by PQTZ (DAT) and PQT2 (EXT) ──────────
  const beats = computeBeats(beatgrid, bpm);

  // ── PVBR seek table ───────────────────────────────────────────────────────────
  // Native Rekordbox always includes PVBR between PPTH and PQTZ in the DAT file.
  let audioFileSize = 0;
  if (sourceFilePath) {
    try {
      audioFileSize = fs.statSync(sourceFilePath).size;
    } catch {}
  }
  const pvbrSection = buildPvbrSection(audioFileSize);

  // ── Build cue sections once — shared by DAT and EXT ─────────────────────────
  const [pcob1, pcob2] = buildPcobSections(cuePoints ?? []);
  const [pco2_1, pco2_2] = buildPco2Sections(cuePoints ?? []);

  // ── ANLZ0000.DAT ─────────────────────────────────────────────────────────────
  // Section order confirmed from native Rekordbox: PPTH, PVBR, PQTZ, PWAV, PWV2, PCOB×2
  const datSections = [buildPathTag(usbFilePath), pvbrSection, buildBeatGrid(beats, bpm)];
  if (waveforms) {
    datSections.push(buildPwavSection(waveforms.pwav));
    datSections.push(buildPwv2Section(waveforms.pwv2));
  }
  datSections.push(pcob1, pcob2);
  const datSize = 28 + datSections.reduce((s, b) => s + b.length, 0);
  const datBuffer = Buffer.concat([buildFileHeader(datSize), ...datSections]);
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0000.DAT'), datBuffer);

  // ── ANLZ0000.EXT ─────────────────────────────────────────────────────────────
  // Section order confirmed from native Rekordbox: PPTH, PWV3, PCOB×2, PCO2×2, PQT2, PWV5, PWV4
  // EXT PCOB must always be empty stubs — cue data in EXT goes only in PCO2 (with PCP2 labels).
  // DAT PCOB carries the actual PCPT cue entries; EXT PCOB is always EMPTY_PCOB_1 + EMPTY_PCOB_2.
  const extSections = [buildPathTag(usbFilePath)];
  if (waveforms) {
    extSections.push(buildPwv3Section(waveforms.pwv3));
  }
  extSections.push(EMPTY_PCOB_1, EMPTY_PCOB_2, pco2_1, pco2_2);
  extSections.push(buildPqt2Section(beats, bpm));
  if (waveforms) {
    extSections.push(buildPwv5Section(waveforms.pwv5));
    extSections.push(buildPwv4Section(waveforms.pwv4));
  }
  const extSize = 28 + extSections.reduce((s, b) => s + b.length, 0);
  const extBuffer = Buffer.concat([buildFileHeader(extSize), ...extSections]);
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0000.EXT'), extBuffer);

  // ── ANLZ0000.2EX ─────────────────────────────────────────────────────────────
  // Required by Rekordbox 6 / CDJ-3000 for colour waveform display.
  // Section order: PPTH, PWV7 (colour scroll), PWV6 (colour overview), PWVC (calibration)
  if (waveforms) {
    const exSections = [
      buildPathTag(usbFilePath),
      buildPwv7Section(waveforms.pwv7, waveforms.numCols),
      buildPwv6Section(waveforms.pwv6),
      buildPwvcSection(),
    ];
    const exSize = 28 + exSections.reduce((s, b) => s + b.length, 0);
    const exBuffer = Buffer.concat([buildFileHeader(exSize), ...exSections]);
    fs.writeFileSync(path.join(anlzDir, 'ANLZ0000.2EX'), exBuffer);
  }

  return path.join(anlzDir, 'ANLZ0000.DAT');
}

/**
 * Returns the PIONEER/USBANLZ folder path for a given USB file path.
 * Useful for looking up where ANLZ files will be written.
 */
export function getAnlzFolder(usbFilePath) {
  return path.join('PIONEER', 'USBANLZ', getFolderName(usbFilePath));
}
