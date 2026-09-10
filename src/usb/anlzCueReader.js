import fs from 'fs';
import path from 'path';
import { getAnlzFolder, PIONEER_PALETTE, PIONEER_PCP2_MAP } from '../audio/anlzWriter.js';

// #259 — read the cue points a CDJ (or a rekordbox export) left on a USB stick.
//
// The writer in audio/anlzWriter.js documents both on-disk layouts; this module
// parses them back:
//   PCOB (DAT + EXT) — entries are fixed 56-byte PCPT sub-tags.
//   PCO2 (EXT)       — entries are variable-length PCP2 sub-tags that also
//                      carry the cue label.
// Cue numbers follow Pioneer: 0 = memory cue, 1 = hot cue A, 2 = B, …

// Inverse of the writer's palettes: Pioneer colour code → hex.
const PCPT_CODE_TO_HEX = new Map();
for (const [hex, code] of PIONEER_PALETTE) {
  if (code && !PCPT_CODE_TO_HEX.has(code)) PCPT_CODE_TO_HEX.set(code, hex);
}
const PCP2_CODE_TO_HEX = new Map();
for (const [hex, entry] of PIONEER_PCP2_MAP) {
  if (entry && !PCP2_CODE_TO_HEX.has(entry.code)) PCP2_CODE_TO_HEX.set(entry.code, hex);
}

const NO_LOOP = 0xffffffff;
const ANLZ_FILE_RE = /^ANLZ\d+\.(DAT|EXT|2EX)$/i;

function cueFromParts({ hotCueNumber, positionMs, loopTimeMs, type, label, color }) {
  return {
    hotCueNumber,
    // DB convention: <0 = memory cue, >=0 = hot cue (0 = A, 1 = B, …)
    hotCueIndex: hotCueNumber > 0 ? hotCueNumber - 1 : -1,
    positionMs,
    loopTimeMs:
      loopTimeMs === null || loopTimeMs === undefined || loopTimeMs === NO_LOOP ? null : loopTimeMs,
    type: type === 2 ? 'loop' : 'cue',
    label: label || '',
    color: color || null,
  };
}

/** Parse every PCOB section (56-byte PCPT entries) in one ANLZ buffer. */
function parsePcobSections(buffer) {
  const cues = [];
  const fourcc = Buffer.from('PCOB', 'ascii');
  for (let off = buffer.indexOf(fourcc); off !== -1; off = buffer.indexOf(fourcc, off + 4)) {
    if (off + 24 > buffer.length) continue;
    const lenTag = buffer.readUInt32BE(off + 8);
    const numCues = buffer.readUInt16BE(off + 18);
    if (lenTag < 24 || off + lenTag > buffer.length || numCues === 0) continue;
    for (let i = 0; i < numCues; i++) {
      const e = off + 24 + i * 56;
      if (e + 56 > off + lenTag || buffer.toString('ascii', e, e + 4) !== 'PCPT') break;
      const hotCueNumber = buffer.readUInt32BE(e + 12);
      const colorCode = buffer[e + 40];
      cues.push(
        cueFromParts({
          hotCueNumber,
          positionMs: buffer.readUInt32BE(e + 32),
          loopTimeMs: buffer.readUInt32BE(e + 36),
          type: buffer[e + 28],
          label: '',
          color: PCPT_CODE_TO_HEX.get(colorCode) || null,
        })
      );
    }
  }
  return cues;
}

/** Parse every PCO2 section (variable-length PCP2 entries, labels included). */
function parsePco2Sections(buffer) {
  const cues = [];
  const fourcc = Buffer.from('PCO2', 'ascii');
  for (let off = buffer.indexOf(fourcc); off !== -1; off = buffer.indexOf(fourcc, off + 4)) {
    if (off + 20 > buffer.length) continue;
    const lenTag = buffer.readUInt32BE(off + 8);
    const numCues = buffer.readUInt16BE(off + 16);
    if (lenTag < 20 || off + lenTag > buffer.length || numCues === 0) continue;
    let e = off + 20;
    for (let i = 0; i < numCues; i++) {
      if (e + 44 > off + lenTag || buffer.toString('ascii', e, e + 4) !== 'PCP2') break;
      const entryLen = buffer.readUInt32BE(e + 8);
      if (entryLen < 44 || e + entryLen > off + lenTag) break;
      const commentBytes = buffer.readUInt32BE(e + 40);
      let label = '';
      if (commentBytes >= 2) {
        // the writer emits UTF-16BE byte-swapped into a LE buffer; decode back
        const raw = Buffer.from(buffer.subarray(e + 44, e + 44 + commentBytes - 2));
        for (let j = 0; j + 1 < raw.length; j += 2) {
          const tmp = raw[j];
          raw[j] = raw[j + 1];
          raw[j + 1] = tmp;
        }
        label = raw.toString('utf16le').replace(/\0+$/, '');
      }
      const colorOff = e + 44 + commentBytes;
      const colorCode = colorOff < e + entryLen ? buffer[colorOff] : 0;
      cues.push(
        cueFromParts({
          hotCueNumber: buffer.readUInt32BE(e + 12),
          positionMs: buffer.readUInt32BE(e + 20),
          loopTimeMs: buffer.readUInt32BE(e + 24),
          type: buffer[e + 16],
          label,
          color: PCP2_CODE_TO_HEX.get(colorCode) || null,
        })
      );
      e += entryLen;
    }
  }
  return cues;
}

/** Parse all cue sections out of a single ANLZ file buffer. */
export function parseAnlzCues(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return [];
  const pco2 = parsePco2Sections(buffer);
  const pcob = parsePcobSections(buffer);
  // PCO2 entries are the richer ones (labels, extended colours) — when both
  // sections describe the same cue, keep the PCO2 variant.
  const seen = new Set(pco2.map((c) => c.hotCueIndex));
  return [...pco2, ...pcob.filter((c) => !seen.has(c.hotCueIndex))];
}

/** Collapse cues coming from several files (DAT/EXT/2EX) into one set. */
export function mergeCues(cueLists) {
  const byIndex = new Map();
  for (const cue of cueLists.flat()) {
    if (!cue || !Number.isFinite(cue.positionMs) || cue.positionMs < 0) continue;
    const existing = byIndex.get(cue.hotCueIndex);
    if (!existing) {
      byIndex.set(cue.hotCueIndex, cue);
      continue;
    }
    // prefer the entry that carries a label, then the one with a colour
    const score = (c) => (c.label ? 2 : 0) + (c.color ? 1 : 0);
    if (score(cue) > score(existing)) byIndex.set(cue.hotCueIndex, cue);
  }
  return [...byIndex.values()].sort((a, b) => a.positionMs - b.positionMs);
}

/** Read all cue points stored on the stick for one USB file path. */
export function readTrackCues(usbRoot, usbFilePath, { fsImpl = fs } = {}) {
  if (!usbRoot || !usbFilePath) return [];
  const dir = path.join(usbRoot, getAnlzFolder(usbFilePath));
  let files = [];
  try {
    files = fsImpl.readdirSync(dir).filter((f) => ANLZ_FILE_RE.test(f));
  } catch {
    return [];
  }
  const parsed = [];
  for (const file of files) {
    try {
      parsed.push(parseAnlzCues(fsImpl.readFileSync(path.join(dir, file))));
    } catch {
      // unreadable/partial ANLZ — ignore that file, keep the rest
    }
  }
  return mergeCues(parsed);
}

const POSITION_TOLERANCE_MS = 200;
const MEMORY_CUE_INDEX = -1;

/** Import modes offered in the UI. */
export const CUE_IMPORT_MODES = ['extend', 'replace'];

/**
 * Compare the cues on the stick with what the library already has.
 * Hardware is the source of truth for a given hot cue slot, so a slot that
 * moved on the CDJ is an update.
 *
 * Modes:
 *  - 'extend' (default): only adds and refreshes — nothing is ever deleted.
 *  - 'replace': the stick mirrors the library, so cues that exist only in the
 *    library are removed and the result matches the hardware exactly.
 *
 * @returns {{add: Array, update: Array, skip: Array, remove: Array, mode: string, conflicts: number}}
 */
export function buildCueImportPlan({ usbCues = [], existingCues = [], mode = 'extend' }) {
  const replace = mode === 'replace';
  const add = [];
  const update = [];
  const skip = [];
  const usedExisting = new Set();

  for (const cue of usbCues) {
    const candidates =
      cue.hotCueIndex >= 0
        ? existingCues.filter((e) => e.hot_cue_index === cue.hotCueIndex)
        : existingCues.filter(
            (e) =>
              e.hot_cue_index === MEMORY_CUE_INDEX &&
              Math.abs(Number(e.position_ms) - cue.positionMs) <= POSITION_TOLERANCE_MS
          );
    const match = candidates[0];
    if (!match) {
      add.push(cue);
      continue;
    }
    usedExisting.add(match.id);
    const samePosition =
      Math.abs(Number(match.position_ms) - cue.positionMs) <= POSITION_TOLERANCE_MS;
    if (samePosition) skip.push({ ...cue, existingId: match.id });
    else update.push({ ...cue, existingId: match.id });
  }

  // 'replace' drops whatever the stick does not carry, so the library ends up
  // as an exact copy of the hardware. 'extend' never removes anything.
  const remove = replace ? existingCues.filter((e) => !usedExisting.has(e.id)) : [];

  return {
    add,
    update,
    skip,
    remove,
    mode: replace ? 'replace' : 'extend',
    conflicts: update.length,
  };
}
