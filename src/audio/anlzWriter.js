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
function computeBeats(beatgridJson, bpm, beatgridOffset = 0) {
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

  // Apply beatgrid offset (ms) — shifts the entire grid left/right; clamp to ≥ 0
  if (beatgridOffset) {
    beats = beats.map((b) => ({ ...b, time: b.time + beatgridOffset })).filter((b) => b.time >= 0);
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
// PCOB header (24 bytes): fourcc + len_header(24) + len_tag + list_kind(u4) + count(u4) + 0xffffffff
//   list_kind: 1 = hot cue list, 0 = memory cue list (capture 42 puts the memory cue in the 0 list).
//   count is the number of PCPT records in the section, as a u32 whose top bytes are always 0.
//   The trailing 0xffffffff is what every captured hot cue list carries; capture 42's populated
//   a populated memory list carries 0x00000000 there instead, which is what buildPcobSlot now
//   writes; an empty one carries 0xffffffff (captures 40 and 42).
// PCPT sub-tag (56 bytes, fixed) — verified byte for byte against native Rekordbox USB exports
// (captures 40, 41, 42, 46, 47):
//   [0-11]:  standard header  fourcc='PCPT', len_header=28, len_tag=56
//   [12-15]: cue slot (u4): 0=memory cue, 1=A, 2=B, …
//   [16-19]: status (u4): 0 — native Rekordbox writes 0 here; KSY label "disabled" is misleading
//   [20-23]: 0x00010000 (constant)
//   [24-27]: 0xFFFFFFFF (constant)
//   [28]:    type (u1): 1=cue_point, 2=loop
//   [29-31]: 00 03 e8 (constant)
//   [32-35]: start time, ms (u32BE)
//   [36-39]: loop end, ms (u32BE, absolute), or 0xffffffff when not a loop
//   [40-55]: 16 zero bytes in every captured record, coloured cues included
//
// PCOB split (verified against a native Rekordbox export with 16 hot cues,
// "page 2" being hot cues 9-16 continuing the same numbering — there is no
// separate page marker in the format, paging is purely a Rekordbox/CDJ UI concept):
//   hot_cue numbers 1-3   (A-C)  → DAT PCOB list 1
//   hot_cue numbers 4-16+ (D-P…) → EXT PCOB list 1
//   memory cues (slot 0)         → DAT PCOB list 0, and EXT PCO2 list 0 (not EXT PCOB)
//
// PCO2 header (20 bytes): fourcc + len_header(20) + len_tag + list_kind(u4) + count(u2) + pad(u2)
// PCP2 sub-tag (variable) — verified byte for byte against native Rekordbox USB exports:
//   [0-11]:  standard header  fourcc='PCP2', len_header=16, len_tag=variable
//   [12-15]: cue slot (u4): 0=memory, 1=A, 2=B, …
//   [16]:    type (u1): 1=cue_point, 2=loop
//   [17-18]: 00 03 e8 (constant)
//   [19-22]: start time, ms
//   [23-26]: loop end, ms (absolute), 0xffffffff when not a loop
//   [27]:    00, [28]: 01 (constants)
//   [29-39]: zeros — rekordbox stores the loop length in beats at [36-39]; we leave it 0
//   [40-43]: len_comment (u4): label byte count INCLUDING the null terminator, 0 = no label
//   [44+]:   UTF-16BE label (null-terminated)
//   then:    colour block: hue code (u1) + R + G + B
//   then:    40 trailing zeros
//   Record length = 16 + 72 + labelByteLen exactly (capture 44/P062: a 10-byte label gives
//   98 bytes, a 12-byte label 100 — there is no minimum length for short labels).
//
// PCPT (DAT/EXT PCOB sections) color palette — read by CDJ hardware.
// Codes 1–8 are Pioneer's per-slot palette: 1=orange-red(A)…8=violet(H).
//   ✓ = confirmed from native Rekordbox USB hex-diff   ○ = inferred
export const PIONEER_PALETTE = new Map([
  ['#ff6b35', 1], // orange-red ○
  ['#ff0000', 2], // red        ○
  ['#ff9900', 3], // orange     ✓
  ['#ffff00', 4], // yellow     ○
  ['#00ff00', 5], // green      ○
  ['#00b4d8', 6], // cyan       ✓
  ['#0080ff', 7], // blue       ○
  ['#cc00ff', 8], // violet     ○
]);

// NOTE (#574): PIONEER_PALETTE is no longer written into PCPT records. In every
// captured rekordbox record the 16 bytes at PCPT+40 are zero, coloured hot cues
// included, and the DAT/EXT cue record carries no packed colour at all — the
// colour lives only in the EXT PCP2 entries below. The map stays exported
// because anlzCueReader uses it to name colours read back from PCPT data.

// PCP2 (EXT PCO2 section) uses a DIFFERENT color encoding: a hue code byte followed by the
// R, G, B triple — four bytes in total, written at PCP2+44+len_comment (#574).
// The hue codes are NOT the PCPT 1-8 numbering. Every entry below marked ✓ was read straight
// out of a rekordbox capture in this repo with all eight palette slots in use
// (reverse-engineering/captures/43-hot-cue-colors and 44-labled-cue/P062):
//   slot 1 red    `00 ff 00 17`   slot 5 cyan   `09 00 e0 ff`
//   slot 2 orange `26 ff 5e 00`   slot 6 blue   `01 00 00 ff`
//   slot 3 yellow `20 ff e8 00`   slot 7 violet `38 b3 00 ff`
//   slot 4 green  `16 1a ff 00`   slot 8 pink   `31 ff 00 a1`
//   ✓ = confirmed byte for byte from those captures   ~ = still inferred, not in any capture
export const PIONEER_PCP2_MAP = new Map([
  ['#ff6b35', { code: 0x27, r: 0xff, g: 0x46, b: 0x00 }], // orange-red  ~ no capture for this hue
  ['#ff0000', { code: 0x00, r: 0xff, g: 0x00, b: 0x17 }], // red         ✓ capture 43 slot 1
  ['#ff9900', { code: 0x26, r: 0xff, g: 0x5e, b: 0x00 }], // orange      ✓ capture 43 slot 2
  ['#ffff00', { code: 0x20, r: 0xff, g: 0xe8, b: 0x00 }], // yellow      ✓ capture 43 slot 3
  ['#00ff00', { code: 0x16, r: 0x1a, g: 0xff, b: 0x00 }], // green       ✓ capture 43 slot 4
  ['#00b4d8', { code: 0x09, r: 0x00, g: 0xe0, b: 0xff }], // cyan        ✓ capture 43 slot 5
  ['#0080ff', { code: 0x01, r: 0x00, g: 0x00, b: 0xff }], // blue        ✓ capture 43 slot 6
  ['#cc00ff', { code: 0x38, r: 0xb3, g: 0x00, b: 0xff }], // violet      ✓ capture 43 slot 7
  ['#ff00a1', { code: 0x31, r: 0xff, g: 0x00, b: 0xa1 }], // pink        ✓ capture 43 slot 8
]);

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
 * Works out whether a cue row describes a plain cue point or a loop, and the
 * loop's ABSOLUTE end position in ms (not a length).
 *
 * Cue rows come from the `cue_points` table, which has no loop column yet, so
 * the end position is optional: a row that carries one is written as a loop.
 * Recognised fields, in priority order:
 *   cue.loop_end_ms   absolute ms (natural name for DB rows / future column)
 *   cue.end_ms        alias
 *   cue.loopTimeMs    the field anlzCueReader produces when cues are read back
 *                     out of an existing ANLZ file, so a loop survives a round trip
 *
 * A null / 0xFFFFFFFF / missing end means "not a loop": the record is a cue
 * point and gets the 0xFFFFFFFF end sentinel (captures 40, 41).
 *
 * @returns {{type: number, endMs: number|null}} type 1 = cue point, 2 = loop
 */
export function resolveCueSpan(cue) {
  const raw = cue?.loop_end_ms ?? cue?.end_ms ?? cue?.loopTimeMs ?? null;
  if (raw === null || raw === undefined) return { type: 1, endMs: null };
  const endMs = Math.round(Number(raw));
  if (!Number.isFinite(endMs) || endMs < 0 || endMs === 0xffffffff) {
    return { type: 1, endMs: null };
  }
  return { type: 2, endMs };
}

/**
 * Builds a single PCPT sub-tag entry (56 bytes, fixed size).
 *
 * Layout confirmed byte for byte against real rekordbox 6 output in
 * reverse-engineering/captures/{40,41,42,46,47}:
 *   [0-11]:  standard header: fourcc='PCPT', len_header=28, len_tag=56
 *   [12-15]: cue slot: 0 = memory cue (capture 42), 1..8 = hot cue A..H (capture 41)
 *   [16-19]: 0 — native rekordbox writes 0 (the crate-digger "disabled" label is a misnomer)
 *   [20-23]: 0x00010000 constant
 *   [24-27]: 0xFFFFFFFF constant
 *   [28]:    type: 1 = cue point, 2 = loop
 *   [29-31]: 00 03 e8 constant
 *   [32-35]: start time, ms
 *   [36-39]: loop end (absolute ms) for a loop, 0xFFFFFFFF otherwise
 *            (capture 46: start 0x0000ef81, end 0x0000f595; capture 47: four loops,
 *             every record type 02 with a real end)
 *   [40-55]: 16 zero bytes in EVERY captured record, coloured cues included
 *
 * @param {number} slot                       cue slot: 0 = memory cue, 1..8 = A..H
 * @param {number} positionMs                 start time in ms
 * @param {{type: number, endMs: number|null}} span  cue kind + loop end (see resolveCueSpan)
 */
function buildPcptEntry(slot, positionMs, { type = 1, endMs = null } = {}) {
  const buf = Buffer.alloc(56, 0);
  buf.write('PCPT', 0, 'ascii');
  buf.writeUInt32BE(28, 4); // len_header = 28
  buf.writeUInt32BE(56, 8); // len_tag = 56
  buf.writeUInt32BE(slot, 12); // slot: 0=memory, 1=A, 2=B, …
  // [16-19]: status = 0 — native Rekordbox writes 0 here (KSY "disabled" is a misnomer)
  buf.writeUInt32BE(0x00010000, 20); // constant observed in all native Rekordbox files
  buf.writeUInt32BE(0xffffffff, 24); // order_first/order_last: 0xFFFFFFFF in every capture
  buf[28] = type === 2 ? 2 : 1; // capture 46/47: a loop is type 2
  buf.writeUInt16BE(0x03e8, 30); // constant
  buf.writeUInt32BE(positionMs >>> 0, 32); // start time ms
  buf.writeUInt32BE(type === 2 && endMs !== null ? endMs >>> 0 : 0xffffffff, 36); // loop end
  // [40-55]: zeros — no packed colour in a DAT/EXT cue record (#574)
  return buf;
}

/**
 * Builds one populated PCOB section.
 * @param {number} listKind 1 = hot cue list, 0 = memory cue list
 * @param {Array<{position_ms, hot_cue_index, [loop_end_ms]}>} cues
 */
function buildPcobSlot(listKind, cues) {
  if (cues.length === 0) return listKind === 1 ? EMPTY_PCOB_1 : EMPTY_PCOB_2;
  const headerSize = 24;
  const tagLen = headerSize + cues.length * 56;
  const buf = Buffer.alloc(tagLen, 0);
  buf.write('PCOB', 0, 'ascii');
  buf.writeUInt32BE(headerSize, 4); // len_header = 24
  buf.writeUInt32BE(tagLen, 8); // len_tag
  buf.writeUInt32BE(listKind, 12); // 1 = hot cue list, 0 = memory cue list
  buf.writeUInt32BE(cues.length, 16); // entry count (u32; the high bytes are always 0)
  // +0x14 is 0xFFFFFFFF normally, but a POPULATED memory cue list carries 0 here,
  // which reads as a head index into that list; an empty one carries 0xFFFFFFFF
  // (captures 40 and 42). Hot lists always carry 0xFFFFFFFF.
  buf.writeUInt32BE(listKind === 0 && cues.length > 0 ? 0 : 0xffffffff, 20);
  cues.forEach((cue, i) => {
    // DB hot_cue_index: <0 = memory cue, >=0 = hot cue (0=A, 1=B, …)
    // Pioneer format: 0=memory, 1=A, 2=B, …
    const slot = cue.hot_cue_index >= 0 ? cue.hot_cue_index + 1 : 0;
    buildPcptEntry(slot, Math.round(cue.position_ms), resolveCueSpan(cue)).copy(
      buf,
      headerSize + i * 56
    );
  });
  return buf;
}

/**
 * Build PCOB buffers for the DAT file [hot cue list, memory cue list].
 * Verified split from native Rekordbox: hot_cue numbers 1-3 (A,B,C) go in DAT
 * PCOB1. Cues D-H (hot_cue numbers 4-8) go in the EXT PCOB1 — see
 * buildExtPcobSections().
 *
 * Memory cues are real cue records with slot 0 in the SECOND PCOB section, whose
 * list kind is 0 — not a stub (capture 42-momory_cue: one entry, slot 00 at
 * +0x0C, type 01 at +0x1C, start 0x00010954, end FFFFFFFF).
 *
 * @param {Array<{position_ms, color, hot_cue_index, [loop_end_ms]}>} cuePoints
 * @returns {[Buffer, Buffer]}
 */
export function buildPcobSections(cuePoints) {
  if (!cuePoints || cuePoints.length === 0) return [EMPTY_PCOB_1, EMPTY_PCOB_2];
  // hot_cue_index 0,1,2 → hot_cue numbers 1,2,3 (A,B,C) — DAT only
  const datHotCues = cuePoints.filter((c) => c.hot_cue_index >= 0 && c.hot_cue_index <= 2);
  const memoryCues = cuePoints.filter((c) => c.hot_cue_index < 0);
  return [buildPcobSlot(1, datHotCues), buildPcobSlot(0, memoryCues)];
}

/**
 * Build PCOB buffers for the EXT file [hot cue list, memory cue list].
 * Verified split: hot_cue numbers 4 and up (D, E, …, "page 2" hot cues 9-16+,
 * hot_cue_index 3 and up) go in EXT PCOB1. Confirmed against a native Rekordbox
 * export with 16 hot cues (EXT PCOB1 held hot_cue numbers 4-16 in one flat list
 * — Rekordbox has no page marker in the format, paging is purely a UI concept).
 *
 * The EXT memory cue list stays the empty stub on purpose: capture 42 has a
 * memory cue and its EXT PCOB list kind 0 is still empty. Memory cues live in
 * the DAT PCOB memory list and in the EXT PCO2 memory list.
 *
 * @param {Array<{position_ms, color, hot_cue_index, [loop_end_ms]}>} cuePoints
 * @returns {[Buffer, Buffer]}
 */
export function buildExtPcobSections(cuePoints) {
  if (!cuePoints || cuePoints.length === 0) return [EMPTY_PCOB_1, EMPTY_PCOB_2];
  // hot_cue_index 3 and up → hot_cue numbers 4, 5, 6, … (D, E, F, … including
  // "page 2" cues 9-16) — EXT only
  const extHotCues = cuePoints.filter((c) => c.hot_cue_index >= 3);
  return [buildPcobSlot(1, extHotCues), EMPTY_PCOB_2];
}

/**
 * Builds a single PCP2 sub-tag entry (variable length).
 *
 * Layout confirmed against real rekordbox 6 output in
 * reverse-engineering/captures/{40,41,42,44/P062,45,46,47}; offsets are from the
 * start of the PCP2 record. Re-measured 2026-10-05 with a byte dumper over
 * captures 41/42/43/46; an earlier revision of this comment listed the start and
 * end fields one byte low and the [28] constant wrong — the writer below was
 * always correct, the prose was not:
 *   [0-11]:  standard header: fourcc='PCP2', len_header=16, len_tag=<record length>
 *   [12-15]: cue slot: 0 = memory cue (capture 42), 1..8 = hot cue A..H
 *   [16]:    type: 1 = cue point, 2 = loop
 *   [17-19]: 00 03 e8 constant
 *   [20-23]: start time, ms
 *   [24-27]: loop end (absolute ms) for a loop, 0xFFFFFFFF otherwise
 *   [28-31]: 00 01 00 00 constant (0x00010000)
 *   [32-35]: zeros
 *   [36-39]: loop length in BEATS + 0x0001 — rekordbox writes 0x0004_0001 for a
 *            4-beat loop (captures 46, 47). We do not write it: it needs the beat
 *            interval at cue-build time and no local capture tells us what a
 *            player does with a stored zero. Left as zeros.
 *   [40-43]: len_comment: byte count of the label INCLUDING its null terminator.
 *            Capture 44: `00 00 00 0c` for "Break" (5 chars + NUL = 12 bytes) —
 *            this is the `00 0c` u16 length of #574, written as a u32 whose top
 *            two bytes are always zero.
 *   [44..]:  label as UTF-16BE, null-terminated, len_comment bytes in total
 *   then:    colour block at 44+len_comment: hue code byte + R, G, B
 *            (capture 43 slot 1 `00 ff 00 17`, slot 3 `20 ff e8 00`,
 *             slot 5 `09 00 e0 ff`, slot 8 `31 ff 00 a1`)
 *   then:    40 trailing zero bytes
 *
 * Record length = 16 + 72 + labelByteLen, exactly. Capture 44/P062 proves there
 * is no minimum length for a short label: "Drop" (10-byte label) gives a
 * 98-byte record and "Break" (12-byte label) a 100-byte one.
 *
 * @param {number} slot        cue slot: 0 = memory cue, 1..8 = hot cue A..H
 * @param {number} positionMs  start time in ms
 * @param {string} label       label text ('' for none)
 * @param {string|null} color  hex colour to map through PIONEER_PCP2_MAP
 * @param {{type: number, endMs: number|null}} span  cue kind + loop end
 */
function buildPcp2Entry(slot, positionMs, label, color, { type = 1, endMs = null } = {}) {
  const labelStr = label ?? '';
  const labelByteLen = labelStr.length > 0 ? (labelStr.length + 1) * 2 : 0; // UTF-16BE + null terminator
  // 28 fixed bytes + label + 4 colour bytes + 40 trailing zeros = 72 + labelByteLen.
  const bodySize = 72 + labelByteLen;
  const lenTag = 16 + bodySize;

  const buf = Buffer.alloc(lenTag, 0);
  buf.write('PCP2', 0, 'ascii');
  buf.writeUInt32BE(16, 4); // len_header = 16
  buf.writeUInt32BE(lenTag, 8); // len_tag
  buf.writeUInt32BE(slot, 12); // slot: 0=memory, 1=A, 2=B, … (same numbering as PCPT)

  // body at offset 16:
  buf[16] = type === 2 ? 2 : 1; // type: 1=cue_point, 2=loop (capture 46/47)
  // [17] = 0x00
  buf.writeUInt16BE(0x03e8, 18); // constant (verified in native)
  buf.writeUInt32BE(positionMs >>> 0, 20); // start time ms
  buf.writeUInt32BE(type === 2 && endMs !== null ? endMs >>> 0 : 0xffffffff, 24); // loop end
  // [28] = 0x00, [29] = 0x01 — constants (verified in native)
  buf[29] = 0x01;
  // [30-39]: zeros (see the beat-count note above)
  buf.writeUInt32BE(labelByteLen, 40); // len_comment (byte count incl null terminator)

  if (labelStr.length > 0) {
    buf.write(labelStr, 44, 'utf16le'); // write LE then byte-swap to BE
    for (let j = 44; j < 44 + labelStr.length * 2; j += 2) {
      const tmp = buf[j];
      buf[j] = buf[j + 1];
      buf[j + 1] = tmp;
    }
    // null terminator bytes remain 0x00 0x00
  }

  // Colour at [44+len_comment]: hue code(u1) + R + G + B (4 bytes — the
  // "three colour bytes" of #574 are the RGB triple, the hue code sits in front).
  // PCP2 colour codes come from PIONEER_PCP2_MAP — NOT the PCPT 1-8 palette.
  const colorOff = 44 + labelByteLen;
  const pcp2Color = color ? PIONEER_PCP2_MAP.get(color.toLowerCase()) : null;
  if (pcp2Color) {
    buf[colorOff] = pcp2Color.code;
    buf[colorOff + 1] = pcp2Color.r;
    buf[colorOff + 2] = pcp2Color.g;
    buf[colorOff + 3] = pcp2Color.b;
  }
  // else: bytes remain 0x00 (no color / use Rekordbox default per-slot color)
  // trailing 40 zeros already set by Buffer.alloc

  return buf;
}

/**
 * Builds one populated PCO2 section.
 * @param {number} listKind 1 = hot cue list, 0 = memory cue list
 * @param {Array<{position_ms, label, color, hot_cue_index, [loop_end_ms]}>} cues
 */
function buildPco2Slot(listKind, cues) {
  if (cues.length === 0) return listKind === 1 ? EMPTY_PCO2_1 : EMPTY_PCO2_2;
  const headerSize = 20;
  const entries = cues.map((cue) => {
    const slot = cue.hot_cue_index >= 0 ? cue.hot_cue_index + 1 : 0;
    return buildPcp2Entry(
      slot,
      Math.round(cue.position_ms),
      cue.label,
      cue.color,
      resolveCueSpan(cue)
    );
  });
  const bodyLen = entries.reduce((s, e) => s + e.length, 0);
  const tagLen = headerSize + bodyLen;

  const header = Buffer.alloc(headerSize, 0);
  header.write('PCO2', 0, 'ascii');
  header.writeUInt32BE(headerSize, 4); // len_header = 20
  header.writeUInt32BE(tagLen, 8); // len_tag
  header.writeUInt32BE(listKind, 12); // 1 = hot cue list, 0 = memory cue list
  header.writeUInt16BE(cues.length, 16); // entry count (u16BE)
  // [18-19]: padding = 0

  return Buffer.concat([header, ...entries]);
}

/**
 * Build populated PCO2 section buffers [hot cue list, memory cue list] (EXT file only).
 * List 1 (kind=1) contains ALL hot cues in one flat list, including "page 2"
 * cues (hot_cue numbers 9-16+) — confirmed against a native Rekordbox export
 * with 16 hot cues (PCO2 list 1 held all 16 entries, hot_cue 1-16).
 * List 2 (kind=0) holds the memory cues as real records with slot 0
 * (capture 42-momory_cue: one PCP2 entry, slot 00, type 01).
 *
 * @param {Array<{position_ms, label, color, hot_cue_index, [loop_end_ms]}>} cuePoints
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
 * @param {string|null} opts.beatgrid       - JSON string from DB (mixxx-analyzer output)
 * @param {number}  opts.bpm                - BPM value from DB (already bpm_override ?? bpm)
 * @param {number}  [opts.beatgridOffset=0] - Grid shift in ms (beatgrid_offset from DB)
 * @param {string}  opts.usbRoot            - Absolute path to USB root on disk
 * @param {Array}   [opts.cuePoints]        - Cue point rows from cue_points table
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
  const beats = computeBeats(beatgrid, bpm, beatgridOffset);

  // ── PVBR seek table ───────────────────────────────────────────────────────────
  // Native Rekordbox always includes PVBR between PPTH and PQTZ in the DAT file.
  let audioFileSize = 0;
  if (sourceFilePath) {
    try {
      audioFileSize = fs.statSync(sourceFilePath).size;
    } catch {}
  }
  const pvbrSection = buildPvbrSection(audioFileSize);

  // ── Build cue sections ──────────────────────────────────────────────────────
  // DAT PCOB: hot cues A,B,C (hot_cue numbers 1-3) in list 1, memory cues (slot 0)
  // in list 0 (capture 42 — a real record, not a stub)
  const [pcob1, pcob2] = buildPcobSections(cuePoints ?? []);
  // EXT PCOB: hot cues D-H (hot_cue numbers 4-8) only; its memory list stays empty
  // (capture 42 keeps the EXT PCOB memory list empty even with a memory cue)
  const [extPcob1, extPcob2] = buildExtPcobSections(cuePoints ?? []);
  // EXT PCO2: list 1 = every hot cue with labels/colours, list 0 = memory cues
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
  // EXT PCOB1: hot cues D-H (numbers 4-8); EXT PCOB2 stays empty, as in capture 42
  // (memory cues are not duplicated into the EXT PCOB — they go to DAT PCOB list 0
  // and EXT PCO2 list 0 below).
  // PCO2 list 1 carries all hot cues with labels/colors; PCO2 list 0 carries the
  // memory cues (capture 42).
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
