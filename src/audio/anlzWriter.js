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

function buildSection(fourcc, bodyBuf) {
  const header = Buffer.alloc(12);
  header.write(fourcc, 0, 4, 'ascii');
  header.writeUInt32BE(8, 4); // len_header (always 8 in PMAI sections)
  header.writeUInt32BE(bodyBuf.length + 12, 8); // len_tag = header(12) + body
  return Buffer.concat([header, bodyBuf]);
}

function buildPathTag(usbFilePath) {
  const encoded = stringToUTF16BE(usbFilePath);
  const body = Buffer.concat([u32BE(encoded.length), encoded]);
  return buildSection('PPTH', body);
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
function buildBeatGrid(beatgridJson, bpm) {
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

  if (beats.length === 0) {
    // Empty beat grid — write minimal valid header
    const header = Buffer.alloc(12);
    header.writeUInt32BE(0, 0);
    header.writeUInt32BE(0x80000, 4);
    header.writeUInt32BE(0, 8);
    return buildSection('PQTZ', header);
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

  return buildSection('PQTZ', Buffer.concat([header, ...beatEntries]));
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

// ─── PMAI file header ──────────────────────────────────────────────────────────

function buildFileHeader(totalSize) {
  const buf = Buffer.alloc(28); // 0x1C
  buf.write('PMAI', 0, 4, 'ascii');
  buf.writeUInt32BE(0x1c, 4); // len_header
  buf.writeUInt32BE(totalSize, 8); // len_file
  // bytes 12–27: padding (zeros)
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
  header.writeUInt32BE(0x960000, 8);
  return buildSectionWithBigHeader('PWV5', header, pwv5Data);
}

/**
 * Builds a PWAV section (monochrome preview waveform for touch strip).
 * Fixed 400 columns, same byte encoding as PWV3: (whiteness << 5) | height.
 * The unknown u32 field always has value 0x00010000 per crate-digger spec.
 */
function buildPwavSection(pwavData) {
  // PWAV body: lenData(u4) + unknown(u4, always 0x00010000) + data bytes
  const body = Buffer.alloc(8 + pwavData.length);
  body.writeUInt32BE(pwavData.length, 0);
  body.writeUInt32BE(0x00010000, 4);
  pwavData.copy(body, 8);
  return buildSection('PWAV', body);
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
  return buildSection('PWV2', body);
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
  header.writeUInt32BE(0x960000, 8);
  return buildSectionWithBigHeader('PWV4', header, pwv4Data);
}

// Sections with a 24-byte header (12 standard + 12 section-specific)
function buildSectionWithBigHeader(fourcc, specificHeader, data) {
  const hdr = Buffer.alloc(24);
  hdr.write(fourcc, 0, 4, 'ascii');
  hdr.writeUInt32BE(24, 4); // len_header
  hdr.writeUInt32BE(24 + specificHeader.length + data.length, 8); // len_tag
  specificHeader.copy(hdr, 12);
  return Buffer.concat([hdr, data]);
}

/**
 * Writes ANLZ0000.DAT and ANLZ0000.EXT for a single track.
 * Includes real waveforms generated from the source audio via ffmpeg.
 *
 * @param {object} opts
 * @param {string}  opts.usbFilePath   - USB-relative path e.g. "/music/Artist - Title.mp3"
 * @param {string}  opts.sourceFilePath - Absolute path to original audio on disk
 * @param {string|null} opts.beatgrid  - JSON string from DB (mixxx-analyzer output)
 * @param {number}  opts.bpm           - BPM value from DB
 * @param {string}  opts.usbRoot       - Absolute path to USB root on disk
 */
export async function writeAnlz(opts) {
  const { usbFilePath, sourceFilePath, beatgrid, bpm, usbRoot } = opts;

  const folderHash = getFolderName(usbFilePath);
  const anlzDir = path.join(usbRoot, 'PIONEER', 'USBANLZ', folderHash);
  fs.mkdirSync(anlzDir, { recursive: true });

  // Generate real waveform data from source audio
  let waveforms = null;
  if (sourceFilePath) {
    try {
      waveforms = await generateWaveform(sourceFilePath);
    } catch (err) {
      console.warn(`Waveform generation failed for ${path.basename(sourceFilePath)}:`, err.message);
    }
  }

  // ── ANLZ0000.DAT (beat grid + preview waveforms) ─────────────────────────
  const datSections = [buildPathTag(usbFilePath), buildBeatGrid(beatgrid, bpm)];
  if (waveforms) {
    datSections.push(buildPwavSection(waveforms.pwav));
    datSections.push(buildPwv2Section(waveforms.pwv2));
  }
  const datSize = 28 + datSections.reduce((s, b) => s + b.length, 0);
  const datBuffer = Buffer.concat([buildFileHeader(datSize), ...datSections]);
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0000.DAT'), datBuffer);

  // ── ANLZ0000.EXT (scrolling waveforms + colour overview) ─────────────────
  const extSections = [buildPathTag(usbFilePath)];
  if (waveforms) {
    extSections.push(buildPwv3Section(waveforms.pwv3));
    extSections.push(buildPwv4Section(waveforms.pwv4));
    extSections.push(buildPwv5Section(waveforms.pwv5));
  } else {
    // Fallback flat placeholder so CDJ shows something
    const flat = Buffer.alloc(600, 0x41); // 6 seconds worth of dim columns
    extSections.push(buildPwv3Section(flat));
  }
  const extSize = 28 + extSections.reduce((s, b) => s + b.length, 0);
  const extBuffer = Buffer.concat([buildFileHeader(extSize), ...extSections]);
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0000.EXT'), extBuffer);

  return path.join(anlzDir, 'ANLZ0000.DAT');
}

/**
 * Returns the PIONEER/USBANLZ folder path for a given USB file path.
 * Useful for looking up where ANLZ files will be written.
 */
export function getAnlzFolder(usbFilePath) {
  return path.join('PIONEER', 'USBANLZ', getFolderName(usbFilePath));
}
