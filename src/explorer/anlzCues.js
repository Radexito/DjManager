import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads cue points out of a Rekordbox export without a database row.
 *
 * Hot cues, memory cues and the labels and colours that go with them live in the
 * ANLZ files Rekordbox writes next to each track's audio: PCOB/PCPT entries in
 * ANLZ0000.DAT and .EXT, and PCO2/PCP2 entries (label + true colour) in the same
 * .EXT and in the .2EX. The writer in src/audio/anlzWriter.js is the reference
 * for the layout; this is its read side, so a stick can be inspected before
 * anything is imported.
 */

/** Pioneer's per-slot palette, as stored in a PCPT entry (codes 1-8). */
const PALETTE_COLORS = {
  1: '#ff6b35',
  2: '#ff0000',
  3: '#ff9900',
  4: '#ffff00',
  5: '#00ff00',
  6: '#00b4d8',
  7: '#0080ff',
  8: '#cc00ff',
};

export const CUE_LETTERS = 'ABCDEFGHIJKLMNOP';

/** The PMAI file header is 28 bytes; every section is fourcc + len_header + len_tag. */
export function readAnlzSections(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 28) return [];
  if (buffer.subarray(0, 4).toString('latin1') !== 'PMAI') return [];

  const sections = [];
  let offset = 28;
  while (offset + 12 <= buffer.length) {
    const tag = buffer.subarray(offset, offset + 4).toString('latin1');
    const lenHeader = buffer.readUInt32BE(offset + 4);
    const lenTag = buffer.readUInt32BE(offset + 8);
    if (
      !/^[A-Z0-9]{4}$/.test(tag) ||
      lenHeader < 12 ||
      lenTag < lenHeader ||
      offset + lenTag > buffer.length
    ) {
      break;
    }
    sections.push({ tag, body: buffer.subarray(offset + lenHeader, offset + lenTag) });
    offset += lenTag;
  }
  return sections;
}

function decodeUtf16Be(buffer) {
  let end = buffer.length;
  while (end >= 2 && buffer.readUInt16BE(end - 2) === 0) end -= 2;
  const bytes = buffer.subarray(0, end);
  const swapped = Buffer.from(bytes);
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const high = swapped[i];
    swapped[i] = swapped[i + 1];
    swapped[i + 1] = high;
  }
  return swapped.toString('utf16le');
}

function cueFrom(hotCueNum, type, positionMs, loopRaw, color, label) {
  return {
    hotCue: hotCueNum,
    letter: hotCueNum > 0 ? (CUE_LETTERS[hotCueNum - 1] ?? null) : null,
    memory: hotCueNum === 0,
    type: type === 2 ? 'loop' : 'cue',
    positionMs,
    loopMs: loopRaw === 0xffffffff ? 0 : loopRaw,
    color: color ?? null,
    label: label ?? '',
  };
}

/** PCPT sub-tags of a PCOB body: one per cue, 56 bytes each. */
function readPcptEntries(body) {
  const cues = [];
  for (let offset = 0; offset + 56 <= body.length; offset += 56) {
    if (body.subarray(offset, offset + 4).toString('latin1') !== 'PCPT') break;
    cues.push(
      cueFrom(
        body.readUInt32BE(offset + 12),
        body[offset + 28],
        body.readUInt32BE(offset + 32),
        body.readUInt32BE(offset + 36),
        PALETTE_COLORS[body[offset + 40]] ?? null,
        ''
      )
    );
  }
  return cues;
}

/** PCP2 sub-tags of a PCO2 body: variable length, they carry the label and RGB. */
function readPcp2Entries(body) {
  const cues = [];
  let offset = 0;
  while (offset + 16 <= body.length) {
    if (body.subarray(offset, offset + 4).toString('latin1') !== 'PCP2') break;
    const lenTag = body.readUInt32BE(offset + 8);
    if (lenTag < 16 || offset + lenTag > body.length) break;

    const entry = body.subarray(offset, offset + lenTag);
    const labelBytes = entry.length >= 44 ? entry.readUInt32BE(40) : 0;
    const label =
      labelBytes >= 2 && 44 + labelBytes <= entry.length
        ? decodeUtf16Be(entry.subarray(44, 44 + labelBytes))
        : '';

    let color = null;
    const colorOffset = 44 + labelBytes;
    if (colorOffset + 3 < entry.length) {
      const r = entry[colorOffset + 1];
      const g = entry[colorOffset + 2];
      const b = entry[colorOffset + 3];
      if (r || g || b) {
        color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      }
    }

    cues.push(
      cueFrom(
        entry.readUInt32BE(12),
        entry[16],
        entry.readUInt32BE(20),
        entry.readUInt32BE(24),
        color,
        label
      )
    );
    offset += lenTag;
  }
  return cues;
}

/**
 * Every cue in one ANLZ file, ordered by position.
 *
 * @param {Buffer} buffer
 * @returns {Array<{hotCue: number, letter: string|null, memory: boolean,
 *   type: 'cue'|'loop', positionMs: number, loopMs: number, color: string|null,
 *   label: string}>}
 */
export function parseAnlzCues(buffer) {
  const merged = new Map();

  for (const section of readAnlzSections(buffer)) {
    const entries =
      section.tag === 'PCOB'
        ? readPcptEntries(section.body)
        : section.tag === 'PCO2'
          ? readPcp2Entries(section.body)
          : [];

    for (const cue of entries) {
      const key = `${cue.hotCue}:${cue.positionMs}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, cue);
        continue;
      }
      // PCO2 knows the label and the true colour; PCPT only knows the palette slot.
      if (cue.label) existing.label = cue.label;
      if (cue.color) existing.color = cue.color;
      if (cue.type === 'loop') existing.type = 'loop';
      if (cue.loopMs) existing.loopMs = cue.loopMs;
    }
  }

  return [...merged.values()].sort((a, b) => a.positionMs - b.positionMs);
}

/**
 * The cues of one exported track: its PIONEER/USBANLZ folder holds the three
 * ANLZ files, and the cues are spread across them.
 *
 * @param {string} root export root (drive or mounted folder)
 * @param {string} analyzePath manifest `analyzePath` ('/PIONEER/USBANLZ/…/ANLZ0000.DAT')
 * @param {{readFileSync: Function}} [fsImpl] injectable filesystem
 */
export function readExportTrackCues(root, analyzePath, fsImpl = fs) {
  if (!root || !analyzePath) return [];
  const datPath = path.join(root, String(analyzePath).replace(/^[/\\]+/, ''));
  const base = datPath.replace(/ANLZ0000\.DAT$/i, 'ANLZ0000');

  const merged = new Map();
  for (const file of [`${base}.DAT`, `${base}.EXT`, `${base}.2EX`]) {
    let buffer;
    try {
      buffer = fsImpl.readFileSync(file);
    } catch {
      continue;
    }
    for (const cue of parseAnlzCues(buffer)) {
      const key = `${cue.hotCue}:${cue.positionMs}`;
      const existing = merged.get(key);
      merged.set(
        key,
        existing
          ? {
              ...existing,
              ...cue,
              label: cue.label || existing.label,
              color: cue.color || existing.color,
            }
          : cue
      );
    }
  }
  return [...merged.values()].sort((a, b) => a.positionMs - b.positionMs);
}

/** 'M' for a memory cue, the hot cue letter otherwise, for a compact readout. */
export function cueLabelOf(cue) {
  return cue.letter ?? 'M';
}
