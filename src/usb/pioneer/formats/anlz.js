import fs from 'fs';
import path from 'path';
import { generateWaveform } from '../../../audio/waveformGenerator.js';
import { readPhrasesFromAnlz } from './pssi.js';

/**
 * Hash a USB file path into the `P000/00000000` folder name rekordbox uses
 * below PIONEER/USBANLZ, so a track always lands in the same place.
 * @param {string} filename - USB-relative path, e.g. "/Contents/Artist - Title.mp3"
 * @returns {string} two-level folder name, e.g. "P123/0000F3C1"
 */
function getFolderName(filename) {
  filename = filename.replace(/\\/g, '/');
  if (!filename.startsWith('/')) filename = '/' + filename;

  let hash = 0;
  for (let i = 0; i < filename.length; i++) {
    const c = filename.charCodeAt(i);
    hash = (Math.imul(hash, 0x34f5501d) + Math.imul(c, 0x93b6)) >>> 0;
  }

  const part2 = hash % 0x30d43;
  const part1 =
    ((((((((((part2 >> 2) & 0x4000) | (part2 & 0x2000)) >> 3) | (part2 & 0x200)) >> 1) |
      (part2 & 0xc0)) >>
      3) |
      (part2 & 0x4)) >>
      1) |
    (part2 & 0x1);

  return `P${part1.toString(16).toUpperCase().padStart(3, '0')}/${part2.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Encode a number as a 4-byte big-endian buffer, wrapping to 32 bits. */
function u32BE(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0);
  return b;
}

/** Encode the low 16 bits of a number as a 2-byte big-endian buffer. */
function _u16BE(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value & 0xffff);
  return b;
}

/**
 * Encode a string as UTF-16BE with a trailing NUL, the form Pioneer stores its
 * PPTH paths and PCP2 labels in.
 * @param {string} str
 * @returns {Buffer} 2 bytes per character plus the terminator
 */
function stringToUTF16BE(str) {
  const buf = Buffer.alloc(str.length * 2 + 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  return buf;
}

/**
 * Wrap a body in the 12-byte section header shared by every ANLZ section:
 * fourcc, the section's own header length, then the total section length.
 * @param {string} fourcc - 4 character tag, e.g. "PQTZ"
 * @param {Buffer} bodyBuf
 * @param {number} lenHeader - length of the fourcc-specific header inside the body
 * @returns {Buffer}
 */
function buildSection(fourcc, bodyBuf, lenHeader) {
  const header = Buffer.alloc(12);
  header.write(fourcc, 0, 4, 'ascii');
  header.writeUInt32BE(lenHeader, 4);
  header.writeUInt32BE(bodyBuf.length + 12, 8);
  return Buffer.concat([header, bodyBuf]);
}

const CRC8_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    table[i] = crc;
  }
  return table;
})();

/**
 * CRC-8 (polynomial 0x07) over [start, end), the checksum a FLAC frame header
 * ends with — used to tell real frame headers from the same bytes in audio data.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {number} the checksum byte
 */
function crc8(buf, start, end) {
  let crc = 0;
  for (let i = start; i < end; i++) crc = CRC8_TABLE[crc ^ buf[i]];
  return crc;
}

const FLAC_BLOCK_SIZES = {
  1: 192,
  2: 576,
  3: 1152,
  4: 2304,
  5: 4608,
  8: 256,
  9: 512,
  10: 1024,
  11: 2048,
  12: 4096,
  13: 8192,
  14: 16384,
  15: 32768,
};

/** Decode the UTF-8 style integer FLAC puts in a frame header. */
function readFlacNumber(buf, pos) {
  const first = buf[pos];
  if (first < 0x80) return { value: first, next: pos + 1 };
  let length = 1;
  let mask = 0x40;
  while (first & mask) {
    length += 1;
    mask >>= 1;
  }
  let value = first & (mask - 1);
  for (let k = 1; k < length; k++) value = (value << 6) | (buf[pos + k] & 0x3f);
  return { value, next: pos + length };
}

/**
 * Collect every valid FLAC frame from `start`: offset, block size and the frame
 * number. A candidate is only accepted when its header CRC-8 matches, which is
 * what separates real frames from the same byte pattern inside audio data.
 */
export function parseFlacFrames(buf, start) {
  const frames = [];
  let pos = start;
  while (pos < buf.length - 6) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xfe) !== 0xf8) {
      pos += 1;
      continue;
    }
    const blockCode = buf[pos + 2] >> 4;
    const rateCode = buf[pos + 2] & 0x0f;
    let number;
    let next;
    try {
      ({ value: number, next } = readFlacNumber(buf, pos + 4));
    } catch {
      pos += 1;
      continue;
    }
    let blockSize;
    if (blockCode === 6) {
      blockSize = buf[next] + 1;
      next += 1;
    } else if (blockCode === 7) {
      blockSize = buf.readUInt16BE(next) + 1;
      next += 2;
    } else {
      blockSize = FLAC_BLOCK_SIZES[blockCode];
    }
    if (!blockSize) {
      pos += 1;
      continue;
    }
    if (rateCode === 12) next += 1;
    else if (rateCode === 13 || rateCode === 14) next += 2;
    if (next >= buf.length) break;
    if (crc8(buf, pos, next) !== buf[next]) {
      pos += 1;
      continue;
    }
    frames.push({ offset: pos, blockSize, number });
    pos = next + 1;
  }
  return frames;
}

/** Read what a PVB2 section needs from a FLAC file. Returns null for non-FLAC. */
export function readPvb2Info(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;

  let pos = 4;
  let blockSize = 0;
  let totalSamples = 0;
  let audioStart = 0;
  while (pos + 4 <= buf.length) {
    const header = buf[pos];
    const length = buf.readUIntBE(pos + 1, 3);
    if ((header & 0x7f) === 0) {
      blockSize = buf.readUInt16BE(pos + 6);
      totalSamples = Number(buf.readBigUInt64BE(pos + 14) & 0xfffffffffn);
      audioStart = pos + 4 + length;
      break;
    }
    pos += 4 + length;
  }
  if (!blockSize || !totalSamples) return null;

  const frames = parseFlacFrames(buf, audioStart);
  if (frames.length === 0) return null;
  return { blockSize, totalSamples, frames };
}

/** Build the PVB2 section from what readPvb2Info returned. */
export function buildPvb2Section(info) {
  const { blockSize, totalSamples, frames } = info;
  const count = Math.min(400, Math.floor(totalSamples / blockSize));
  if (count < 1) return null;
  const step = Math.floor(totalSamples / count);
  const first = frames[0].offset;
  const body = Buffer.alloc(count * 20);
  for (let k = 0; k < count; k++) {
    let index = Math.floor((k * step) / blockSize);
    if (index >= frames.length) index = frames.length - 1;
    body.writeBigUInt64BE(BigInt(index * blockSize), k * 20);
    body.writeBigUInt64BE(BigInt(frames[index].offset - first), k * 20 + 8);
    body.writeUInt32BE(frames[index].blockSize, k * 20 + 16);
  }
  const header = Buffer.alloc(12);
  header.write('PVB2', 0, 4, 'ascii');
  header.writeUInt32BE(0x20, 4);
  header.writeUInt32BE(0x20 + body.length, 8);
  const fields = Buffer.alloc(20);
  fields.writeUInt32BE(0, 0);
  fields.writeBigUInt64BE(BigInt(totalSamples), 4);
  fields.writeUInt32BE(count, 12);
  fields.writeUInt32BE(0x14, 16);
  return Buffer.concat([header, fields, body]);
}

/** Bytes of the PMAI file header (fourcc, len_header, total size, version fields) every ANLZ file opens with. */
const ANLZ_CONTAINER_HEADER = 28;

/**
 * Walks an existing ANLZ file and returns its sections in file order.
 *
 * The container is a flat list of sections, each `tag(4) + len_header(u4) +
 * len_tag(u4) + payload`, so a file can be walked without understanding any of
 * the tags. Walking stops at the first header that does not look like a section,
 * which keeps a truncated or foreign file from producing garbage.
 */
export function parseAnlzSections(buffer) {
  const sections = [];
  if (!buffer || buffer.length < ANLZ_CONTAINER_HEADER) return sections;
  let off = ANLZ_CONTAINER_HEADER;
  while (off + 12 <= buffer.length) {
    const tag = buffer.toString('ascii', off, off + 4);
    if (!/^[A-Z0-9]{4}$/.test(tag)) break;
    const lenHeader = buffer.readUInt32BE(off + 4);
    const lenTag = buffer.readUInt32BE(off + 8);
    if (lenTag < 12 || off + lenTag > buffer.length) break;
    sections.push({ tag, lenHeader, lenTag, raw: Buffer.from(buffer.subarray(off, off + lenTag)) });
    off += lenTag;
  }
  return sections;
}

/**
 * Raw sections of an existing ANLZ file that this writer does not produce.
 *
 * Rekordbox writes sections we cannot generate yet (PSSI phrases, PVDI vocal
 * detection, and anything a newer version adds). Rebuilding a file from scratch
 * silently drops them, and a dropped PSSI costs the deck its phrase view, so
 * they are carried over byte for byte. A section with a length that does not
 * match its own header is skipped rather than copied blindly.
 */
export function preservedSections(existing, producedTags) {
  if (!existing) return [];
  const produced = new Set(producedTags);
  return parseAnlzSections(existing)
    .filter((section) => !produced.has(section.tag))
    .filter((section) => section.lenTag >= section.lenHeader)
    .map((section) => section.raw);
}

/** Tags of the sections an array of built buffers will contain. */
function sectionTags(buffers) {
  return buffers.map((buf) => buf.toString('ascii', 0, 4));
}

/** Reads a file if it exists, returns null otherwise. */
function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Build the PPTH section: the track's USB-relative path as a length-prefixed
 * UTF-16BE string. The decks use it to match an audio file to its ANLZ.
 * @param {string} usbFilePath
 * @returns {Buffer}
 */
function buildPathTag(usbFilePath) {
  const encoded = stringToUTF16BE(usbFilePath);
  const body = Buffer.concat([u32BE(encoded.length), encoded]);
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
function computeBeats(beatgridJson, bpm, beatgridOffset = 0) {
  let beats = [];

  try {
    if (beatgridJson) {
      const raw = typeof beatgridJson === 'string' ? JSON.parse(beatgridJson) : beatgridJson;

      if (Array.isArray(raw) && raw.length > 0) {
        if (typeof raw[0] === 'number') {
          beats = raw.map((t, i) => ({ time: Math.round(t * 1000), beatNumber: (i % 4) + 1 }));
        } else if (typeof raw[0] === 'object') {
          beats = raw.map((b, i) => ({
            time: Math.round((b.position ?? b.time ?? b.offset ?? 0) * 1000),
            beatNumber: (i % 4) + 1,
          }));
        }
      }
    }
  } catch {}

  if (beats.length === 0 && bpm > 0) {
    beats = generateBeatsFromBpm(bpm, 600);
  }

  if (beatgridOffset) {
    beats = beats.map((b) => ({ ...b, time: b.time + beatgridOffset })).filter((b) => b.time >= 0);
  }

  return beats;
}

/**
 * Build the PQTZ section from computed beats: an 8-byte entry per beat (beat
 * number 1-4, tempo in centi-BPM, time in ms). An empty grid becomes the
 * header-only section rekordbox accepts for an unanalysed track.
 * @param {Array<{beatNumber: number, time: number}>} beats
 * @param {number} bpm
 * @returns {Buffer}
 */
function buildBeatGrid(beats, bpm) {
  if (beats.length === 0) {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(0, 0);
    header.writeUInt32BE(0x80000, 4);
    header.writeUInt32BE(0, 8);
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
  hdr.writeUInt32BE(56, 4);
  hdr.writeUInt32BE(56 + bodyLen, 8);

  hdr.writeUInt32BE(0x01000002, 16);

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

  hdr.writeUInt32BE(ec, 40);

  const body = Buffer.alloc(bodyLen);
  for (let i = 0; i < ec; i++) {
    body.writeUInt16BE(beats[i].time % 1000, i * 2);
  }

  return Buffer.concat([hdr, body]);
}

/**
 * Lay out beats mathematically at 60/bpm seconds apart, numbered 1-4, when the
 * track has no analysed beat grid.
 * @param {number} bpm
 * @param {number} [maxSeconds=600] - how far into the track to generate
 * @returns {Array<{beatNumber: number, time: number}>} times in ms
 */
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
 * Builds a PVBR (VBR seek index) section.
 *
 * Measured against rekordbox 7.2.19's own export of the same audio, and against
 * a player-written stick: rekordbox does NOT fill a seek table. Its payload is
 * 1608 bytes, 400 zeroed u32 slots followed by an 8-byte trailer whose last u32
 * carries the decoded sample count (a PC export has 3 non-zero bytes in the
 * whole payload, a device stick has 0). This writer used to emit a linear
 * byte-offset table instead, which is not what the section carries; rekordbox
 * then treated the analysis as unusable and re-analysed the track, so the stick
 * showed no waveform and no beat grid until it did.
 *
 * @param {number} totalSamples  decoded sample count of the audio (0 = unknown,
 *                               written as an all-zero payload like a device does)
 */
export function buildPvbrSection(totalSamples = 0) {
  const ENTRIES = 400;
  const body = Buffer.alloc(ENTRIES * 4 + 8);
  const samples = Math.max(0, Math.round(totalSamples) || 0);
  body.writeUInt32BE(samples, ENTRIES * 4 + 4);
  return buildSection('PVBR', body, 16);
}

export const PIONEER_PALETTE = new Map([
  ['#ff6b35', 1],
  ['#ff0000', 2],
  ['#ff9900', 3],
  ['#ffff00', 4],
  ['#00ff00', 5],
  ['#00b4d8', 6],
  ['#0080ff', 7],
  ['#cc00ff', 8],
]);

/**
 * Look up the PCPT colour code for a hex colour. Unknown or missing colours get
 * 0, which the format reads as "no colour".
 * @param {string|null} hex
 * @returns {number}
 */
function hexToPioneerCode(hex) {
  if (!hex) return 0;
  return PIONEER_PALETTE.get(hex.toLowerCase()) ?? 0;
}

export const PIONEER_PCP2_MAP = new Map([
  ['#ff6b35', { code: 0x27, r: 0xff, g: 0x46, b: 0x00 }],
  ['#ff0000', { code: 0x2a, r: 0xff, g: 0x00, b: 0x00 }],
  ['#ff9900', { code: 0x23, r: 0xff, g: 0xa2, b: 0x00 }],
  ['#ffff00', { code: 0x1f, r: 0xf3, g: 0xf4, b: 0x00 }],
  ['#00ff00', { code: 0x16, r: 0x1a, g: 0xff, b: 0x00 }],
  ['#00b4d8', { code: 0x09, r: 0x00, g: 0xe0, b: 0xff }],
  ['#0080ff', { code: 0x05, r: 0x00, g: 0x70, b: 0xff }],
  ['#cc00ff', { code: 0x38, r: 0xb3, g: 0x00, b: 0xff }],
]);

const EMPTY_PCOB_1 = Buffer.from([
  0x50, 0x43, 0x4f, 0x42, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
]);
const EMPTY_PCOB_2 = Buffer.from([
  0x50, 0x43, 0x4f, 0x42, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
]);
const EMPTY_PCO2_1 = Buffer.from([
  0x50, 0x43, 0x4f, 0x32, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00,
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
  buf.writeUInt32BE(28, 4);
  buf.writeUInt32BE(56, 8);
  buf.writeUInt32BE(hotCueNum, 12);
  buf.writeUInt32BE(0x00010000, 20);
  buf.writeUInt16BE(0xffff, 24);
  buf.writeUInt16BE(0xffff, 26);
  buf[28] = 1;
  buf.writeUInt16BE(0x03e8, 30);
  buf.writeUInt32BE(positionMs, 32);
  buf.writeUInt32BE(0xffffffff, 36);
  buf[40] = hexToPioneerCode(color);
  return buf;
}

/**
 * Build one PCOB section: a 24-byte header followed by one fixed 56-byte PCPT
 * entry per cue. An empty slot returns the canned stub for that slot type.
 * @param {number} slotType - 1 for hot cues, 0 for memory cues
 * @param {Array<{position_ms: number, color: string, hot_cue_index: number}>} cues
 * @returns {Buffer}
 */
function buildPcobSlot(slotType, cues) {
  if (cues.length === 0) return slotType === 1 ? EMPTY_PCOB_1 : EMPTY_PCOB_2;
  const headerSize = 24;
  const tagLen = headerSize + cues.length * 56;
  const buf = Buffer.alloc(tagLen, 0);
  buf.write('PCOB', 0, 'ascii');
  buf.writeUInt32BE(headerSize, 4);
  buf.writeUInt32BE(tagLen, 8);
  buf.writeUInt32BE(slotType, 12);
  buf.writeUInt16BE(cues.length, 18);
  buf.writeUInt32BE(0xffffffff, 20);
  cues.forEach((cue, i) => {
    const hotCueNum = cue.hot_cue_index >= 0 ? cue.hot_cue_index + 1 : 0;
    buildPcptEntry(hotCueNum, Math.round(cue.position_ms), cue.color).copy(
      buf,
      headerSize + i * 56
    );
  });
  return buf;
}

/**
 * Build PCOB buffers for the DAT file [slot1, slot2].
 * Verified split from native Rekordbox: hot_cue numbers 1-3 (A,B,C) go in DAT PCOB1.
 * Cues D-P… (hot_cue numbers 4-16 and up, i.e. "page 2" of hot cues) go in EXT
 * PCOB1 — see buildExtPcobSections().
 * PCOB2 (memory cues): the byte layout was verified via hex-diff against native
 * Rekordbox (issue #208), but real-world testing showed memory cues are unreliable
 * in practice, so writing them is disabled for now — see "Known Issues" in
 * CLAUDE.md. PCOB2 is always the empty stub until re-enabled.
 *
 * @param {Array<{position_ms, color, hot_cue_index}>} cuePoints
 * @returns {[Buffer, Buffer]}
 */
export function buildPcobSections(cuePoints) {
  if (!cuePoints || cuePoints.length === 0) return [EMPTY_PCOB_1, EMPTY_PCOB_2];
  const datHotCues = cuePoints.filter((c) => c.hot_cue_index >= 0 && c.hot_cue_index <= 2);
  return [buildPcobSlot(1, datHotCues), EMPTY_PCOB_2];
}

/**
 * Build PCOB buffers for the EXT file [slot1, slot2].
 * Verified split: hot_cue numbers 4 and up (D, E, …, "page 2" hot cues 9-16+,
 * hot_cue_index 3 and up) go in EXT PCOB1. Confirmed against a native Rekordbox
 * export with 16 hot cues (EXT PCOB1 held hot_cue numbers 4-16 in one flat list
 * — Rekordbox has no page marker in the format, paging is purely a UI concept).
 *
 * @param {Array<{position_ms, color, hot_cue_index}>} cuePoints
 * @returns {[Buffer, Buffer]}
 */
export function buildExtPcobSections(cuePoints) {
  if (!cuePoints || cuePoints.length === 0) return [EMPTY_PCOB_1, EMPTY_PCOB_2];
  const extHotCues = cuePoints.filter((c) => c.hot_cue_index >= 3);
  return [buildPcobSlot(1, extHotCues), EMPTY_PCOB_2];
}

/**
 * Builds a single PCP2 sub-tag entry.
 * Verified against native Rekordbox USB exports (issue #208 hex-diff):
 *   - No-label entry: len_tag=88 (body=72)
 *   - 16-byte label entry: len_tag=104 (body=88)
 *   - Formula: body = 28 + labelByteLen + 44  (28 fixed + label + 4 color + 40 zeros)
 *   - Color: color_code(u1, Pioneer palette 1-8, via hexToPioneerCode()) + R + G + B
 */
function buildPcp2Entry(hotCueNum, positionMs, label, color) {
  const labelStr = label ?? '';
  const labelByteLen = labelStr.length > 0 ? (labelStr.length + 1) * 2 : 0;
  const bodySize = labelStr.length > 0 ? Math.max(88, 28 + labelByteLen + 44) : 72;
  const lenTag = 16 + bodySize;

  const buf = Buffer.alloc(lenTag, 0);
  buf.write('PCP2', 0, 'ascii');
  buf.writeUInt32BE(16, 4);
  buf.writeUInt32BE(lenTag, 8);
  buf.writeUInt32BE(hotCueNum, 12);

  buf[16] = 1;
  buf.writeUInt16BE(0x03e8, 18);
  buf.writeUInt32BE(positionMs, 20);
  buf.writeUInt32BE(0xffffffff, 24);
  buf[29] = 0x01;
  buf.writeUInt32BE(labelByteLen, 40);

  if (labelStr.length > 0) {
    buf.write(labelStr, 44, 'utf16le');
    for (let j = 44; j < 44 + labelStr.length * 2; j += 2) {
      const tmp = buf[j];
      buf[j] = buf[j + 1];
      buf[j + 1] = tmp;
    }
  }

  const colorOff = 44 + labelByteLen;
  const pcp2Color = color ? PIONEER_PCP2_MAP.get(color.toLowerCase()) : null;
  if (pcp2Color) {
    buf[colorOff] = pcp2Color.code;
    buf[colorOff + 1] = pcp2Color.r;
    buf[colorOff + 2] = pcp2Color.g;
    buf[colorOff + 3] = pcp2Color.b;
  }

  return buf;
}

/**
 * Build one PCO2 section: a 20-byte header followed by variable-length PCP2
 * entries, which — unlike PCPT — carry the cue's label. Empty slots return the
 * canned stub for that slot type.
 * @param {number} slotType - 1 for hot cues, 0 for memory cues
 * @param {Array<{position_ms: number, label: string, color: string, hot_cue_index: number}>} cues
 * @returns {Buffer}
 */
function buildPco2Slot(slotType, cues) {
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
  header.writeUInt32BE(headerSize, 4);
  header.writeUInt32BE(tagLen, 8);
  header.writeUInt32BE(slotType, 12);
  header.writeUInt16BE(cues.length, 16);

  return Buffer.concat([header, ...entries]);
}

/**
 * Build populated PCO2 section buffers [slot1, slot2] (EXT file only).
 * Slot 1 (type=1) contains ALL hot cues in one flat list, including "page 2"
 * cues (hot_cue numbers 9-16+) — confirmed against a native Rekordbox export
 * with 16 hot cues (PCO2 slot 1 held all 16 entries, hot_cue 1-16).
 * Slot 2 (type=0, memory cues) is disabled for now — see "Known Issues" in
 * CLAUDE.md — and always written as the empty stub.
 *
 * @param {Array<{position_ms, label, color, hot_cue_index}>} cuePoints
 * @returns {[Buffer, Buffer]}
 */
export function buildPco2Sections(cuePoints) {
  if (!cuePoints || cuePoints.length === 0) return [EMPTY_PCO2_1, EMPTY_PCO2_2];
  const hotCues = cuePoints.filter((c) => c.hot_cue_index >= 0);
  return [buildPco2Slot(1, hotCues), EMPTY_PCO2_2];
}

/**
 * Build the 28-byte PMAI header an ANLZ file starts with, carrying the total
 * file size and the format version fields rekordbox writes.
 * @param {number} totalSize - complete file size in bytes, header included
 * @returns {Buffer}
 */
function buildFileHeader(totalSize) {
  const buf = Buffer.alloc(28);
  buf.write('PMAI', 0, 4, 'ascii');
  buf.writeUInt32BE(0x1c, 4);
  buf.writeUInt32BE(totalSize, 8);
  buf.writeUInt32BE(0x00000001, 12);
  buf.writeUInt32BE(0x00010000, 16);
  buf.writeUInt32BE(0x00010000, 20);
  buf.writeUInt32BE(0x00000000, 24);
  return buf;
}

/**
 * Builds a PWV3 section (monochrome scrolling waveform, 10ms/column, 1 byte each).
 * Byte encoding: (whiteness[0-7] << 5) | height[0-31]
 */
function buildPwv3Section(pwv3Data) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(pwv3Data.length, 4);
  header.writeUInt32BE(0x960000, 8);
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
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(numEntries, 4);
  header.writeUInt32BE(0x00960305, 8);
  return buildSectionWithBigHeader('PWV5', header, pwv5Data);
}

/**
 * Builds a PWAV section (monochrome preview waveform for touch strip).
 * Fixed 400 columns, same byte encoding as PWV3: (whiteness << 5) | height.
 * The unknown u32 field always has value 0x00010000 per crate-digger spec.
 */
function buildPwavSection(pwavData) {
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
  header.writeUInt32BE(6, 0);
  header.writeUInt32BE(numEntries, 4);
  header.writeUInt32BE(0x00000000, 8);
  return buildSectionWithBigHeader('PWV4', header, pwv4Data);
}

/**
 * Builds a PWV7 section (3-byte/col colour scroll waveform for CDJ-3000 / .2EX).
 * Each column: [treble(0-255), mid(0-255), bass(0-255)]
 * Header: type=3, numCols, unk=0x00960000 (same as PWV3, confirmed from native .2EX)
 */
function buildPwv7Section(pwv7Data, numCols) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(3, 0);
  header.writeUInt32BE(numCols, 4);
  header.writeUInt32BE(0x00960000, 8);
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
  hdr.writeUInt32BE(20, 4);
  hdr.writeUInt32BE(20 + pwv6Data.length, 8);
  hdr.writeUInt32BE(3, 12);
  hdr.writeUInt32BE(1200, 16);
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
  buf.writeUInt32BE(14, 4);
  buf.writeUInt32BE(20, 8);
  buf.writeUInt16BE(0x0064, 14);
  buf.writeUInt16BE(0x0068, 16);
  buf.writeUInt16BE(0x00c5, 18);
  return buf;
}

/**
 * Wrap a body in the 24-byte header the PWV sections use: the standard fourcc
 * and lengths, then 12 bytes of section-specific fields.
 * @param {string} fourcc
 * @param {Buffer} specificHeader - 12 bytes written at offset 12
 * @param {Buffer} data
 * @returns {Buffer}
 */
function buildSectionWithBigHeader(fourcc, specificHeader, data) {
  const hdr = Buffer.alloc(24);
  hdr.write(fourcc, 0, 4, 'ascii');
  hdr.writeUInt32BE(24, 4);
  hdr.writeUInt32BE(24 + data.length, 8);
  specificHeader.copy(hdr, 12);
  return Buffer.concat([hdr, data]);
}

/**
 * Writes ANLZ0000.DAT and ANLZ0000.EXT for a single track.
 * Includes real waveforms generated from the source audio via ffmpeg.
 *
 * @param {object} opts
 * @param {string}  opts.usbFilePath    - USB-relative path e.g. "/Contents/Artist - Title.mp3"
 * @param {string}  opts.sourceFilePath - Absolute path to original audio on disk
 * @param {string|null} opts.beatgrid       - JSON string from DB (mixxx-analyzer output)
 * @param {number}  opts.bpm                - BPM value from DB (already bpm_override ?? bpm)
 * @param {number}  [opts.beatgridOffset=0] - Grid shift in ms (beatgrid_offset from DB)
 * @param {string}  opts.usbRoot            - Absolute path to USB root on disk
 * @param {Array}   [opts.cuePoints]        - Cue point rows from cue_points table
 */

/**
 * The writer copies the PSSI section through when the target already has one, and
 * a silent regression there costs the deck its phrase display. Read the table out
 * of the file before and after the write on every export and say so out loud.
 * @param {{phrases: unknown[], mood: number|null, inferredMood: number}|null} before
 * @param {{phrases: unknown[], mood: number|null, inferredMood: number}|null} after
 */
function readPhrasesSafely(buffer) {
  try {
    return readPhrasesFromAnlz(buffer);
  } catch {
    return null;
  }
}

/**
 * Say out loud whether the PSSI phrase table survived a rewrite: how many
 * phrases the file had before, how many it has now, and why the new table is
 * invalid when it is. Silent when the file never had phrases.
 * @param {{phrases: unknown[], mood: number|null, validation: object}|null} before
 * @param {{phrases: unknown[], mood: number|null, validation: object}|null} after
 */
function reportPhrases(before, after) {
  const had = before?.phrases.length ?? 0;
  const has = after?.phrases.length ?? 0;
  if (!had) return;
  const problems = after?.validation?.errors?.length ?? 0;
  if (problems) {
    console.error(`[anlz] PHRASES INVALID: ${after.validation.errors[0]}`);
  }
  if (had === has) {
    const mood = before.mood ?? `inferred ${before.inferredMood}`;
    console.log(`[anlz] phrases kept: ${has} (mood ${mood}${problems ? ', invalid' : ''})`);
    return;
  }
  console.error(`[anlz] PHRASES LOST: the existing EXT had ${had}, the written file has ${has}`);
}

/**
 * Write ANLZ0000.DAT, .EXT and (when the waveforms could be generated) .2EX for
 * one track. Sections this writer does not produce are carried over from the
 * files already on the stick, and the PSSI table is read back afterwards so a
 * lost phrase table is reported instead of passing unnoticed.
 *
 * @param {object} opts
 * @param {string} opts.usbFilePath            USB-relative path of the audio file
 * @param {string} [opts.sourceFilePath]       audio file on disk, for the waveforms
 * @param {string|null} [opts.beatgrid]        mixxx-analyzer beat grid, JSON from the DB
 * @param {number} [opts.bpm]                  BPM written into the beat grid
 * @param {number} [opts.beatgridOffset]       grid shift in ms (beatgrid_offset from the DB)
 * @param {string} opts.usbRoot                absolute path of the mounted stick
 * @param {string} [opts.ffmpegPath]           ffmpeg binary for the waveform pass
 * @param {Array} [opts.cuePoints]             cue point rows (position_ms, color, hot_cue_index)
 * @returns {Promise<string>} path of the written ANLZ0000.DAT
 */
export async function writeAnlz(opts) {
  const {
    usbFilePath,
    sourceFilePath,
    beatgrid,
    bpm,
    beatgridOffset = 0,
    usbRoot,
    ffmpegPath,
    cuePoints,
  } = opts;

  const folderHash = getFolderName(usbFilePath);
  const anlzDir = path.join(usbRoot, 'PIONEER', 'USBANLZ', folderHash);
  fs.mkdirSync(anlzDir, { recursive: true });

  let waveforms = null;
  if (sourceFilePath) {
    try {
      waveforms = await generateWaveform(sourceFilePath, ffmpegPath || 'ffmpeg');
    } catch (err) {
      console.warn('[anlz] waveform generation failed, skipping:', err.message);
    }
  }

  const beats = computeBeats(beatgrid, bpm, beatgridOffset);

  // PVBR carries the decoded sample count, not a byte seek table (see
  // buildPvbrSection). The waveform pass has already decoded the audio, so take
  // the exact count from it; if it did not run, write the all-zero payload a
  // player writes.
  const pvbrSection = buildPvbrSection(waveforms?.totalSamples ?? 0);

  const [pcob1, pcob2] = buildPcobSections(cuePoints ?? []);
  const [extPcob1, extPcob2] = buildExtPcobSections(cuePoints ?? []);
  const [pco2_1, pco2_2] = buildPco2Sections(cuePoints ?? []);

  const datSections = [buildPathTag(usbFilePath), pvbrSection, buildBeatGrid(beats, bpm)];
  if (waveforms) {
    datSections.push(buildPwavSection(waveforms.pwav));
    datSections.push(buildPwv2Section(waveforms.pwv2));
  }
  datSections.push(pcob1, pcob2);
  const datPath = path.join(anlzDir, 'ANLZ0000.DAT');
  const datPreserved = preservedSections(readIfExists(datPath), sectionTags(datSections));
  if (datPreserved.length) {
    console.log(
      '[anlz] preserving sections from the existing DAT:',
      datPreserved.map((b) => b.toString('ascii', 0, 4)).join(', ')
    );
    datSections.push(...datPreserved);
  }
  const datSize = 28 + datSections.reduce((s, b) => s + b.length, 0);
  const datBuffer = Buffer.concat([buildFileHeader(datSize), ...datSections]);
  fs.writeFileSync(datPath, datBuffer);

  const extSections = [buildPathTag(usbFilePath)];
  if (waveforms) {
    extSections.push(buildPwv3Section(waveforms.pwv3));
  }
  extSections.push(extPcob1, extPcob2, pco2_1, pco2_2);
  extSections.push(buildPqt2Section(beats, bpm));
  if (waveforms) {
    extSections.push(buildPwv5Section(waveforms.pwv5));
    extSections.push(buildPwv4Section(waveforms.pwv4));
  }
  let pvb2Section = null;
  if (sourceFilePath) {
    try {
      const pvb2Info = readPvb2Info(sourceFilePath);
      if (pvb2Info) pvb2Section = buildPvb2Section(pvb2Info);
    } catch (err) {
      console.warn('[anlz] PVB2 generation failed, skipping:', err.message);
    }
  }
  if (pvb2Section) extSections.push(pvb2Section);

  const extPath = path.join(anlzDir, 'ANLZ0000.EXT');
  const extBefore = readIfExists(extPath);
  const extPhrasesBefore = readPhrasesSafely(extBefore);
  const extPreserved = preservedSections(extBefore, sectionTags(extSections));
  if (extPreserved.length) {
    console.log(
      '[anlz] preserving sections from the existing EXT:',
      extPreserved.map((b) => b.toString('ascii', 0, 4)).join(', ')
    );
    extSections.push(...extPreserved);
  }
  const extSize = 28 + extSections.reduce((s, b) => s + b.length, 0);
  const extBuffer = Buffer.concat([buildFileHeader(extSize), ...extSections]);
  fs.writeFileSync(extPath, extBuffer);
  reportPhrases(extPhrasesBefore, readPhrasesSafely(extBuffer));

  if (waveforms) {
    const exSections = [
      buildPathTag(usbFilePath),
      buildPwv7Section(waveforms.pwv7, waveforms.numCols),
      buildPwv6Section(waveforms.pwv6),
      buildPwvcSection(),
    ];
    const exPath = path.join(anlzDir, 'ANLZ0000.2EX');
    const exPreserved = preservedSections(readIfExists(exPath), sectionTags(exSections));
    if (exPreserved.length) {
      console.log(
        '[anlz] preserving sections from the existing 2EX:',
        exPreserved.map((b) => b.toString('ascii', 0, 4)).join(', ')
      );
      exSections.push(...exPreserved);
    }
    const exSize = 28 + exSections.reduce((s, b) => s + b.length, 0);
    const exBuffer = Buffer.concat([buildFileHeader(exSize), ...exSections]);
    fs.writeFileSync(exPath, exBuffer);
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
