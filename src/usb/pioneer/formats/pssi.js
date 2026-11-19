/**
 * PSSI (phrase) section codec.
 *
 * A PSSI section is a 32-byte header followed by one 24-byte record per phrase,
 * each record being 12 big-endian u16 fields:
 *
 *   index, start beat, type, f3, f4, f5, f6, f7, f8, f9, f10, f11
 *
 * rekordbox writes the same records in two forms:
 *
 *   'plain' - the bytes as they are, used by the desktop share/ cache
 *   'stick' - the payload XORed with a 19-byte mask that is shifted by the
 *             phrase count: key[i] = (MASK[i % 19] + count) & 0xFF
 *
 * The XOR covers only the payload. The header tail (0x12..0x1f) is not reliable
 * in the stick form, so totalBeats must not be read back from it.
 *
 * Both forms were measured on real exports: for 32 tracks present in the cache
 * and on a stick, encrypting the cache payload reproduced the stick payload byte
 * for byte, and decrypting all 75 stick files yielded valid tables.
 */

import { getPhraseMask } from '../../../audio/phraseMask.js';

export const PSSI_TAG = 'PSSI';
/**
 * The twelve u16 of a record, in the order the encoder writes them.
 *
 * The order is not a guess: it is the order of the reads in the encoder
 * (FUN_141284420), which copies each value out of a 26 byte phrase record that
 * lives on an analyzer::AnalyzeJobResult. The names for the last nine come from
 * the analysis result struct (moriage is the build-up, aori the hype move, and
 * fill_in carries its own start position), and that naming is a hypothesis
 * supported by measurements taken on real rekordbox exports.
 */
export const PSSI_FIELDS = [
  'index',
  'startBeat',
  'type',
  'flag3',
  'flag4',
  'position5',
  'position6',
  'position7',
  'position8',
  'flag9',
  'flag10',
  'position11',
];

/** Bytes of PSSI header before the first phrase record. */
export const PSSI_HEADER_SIZE = 32;
/** Bytes per phrase record: twelve big-endian u16. */
export const PSSI_ENTRY_SIZE = 24;
/** u16 fields per phrase record, the length of PSSI_FIELDS. */
export const PSSI_FIELD_COUNT = 12;

/** Error raised when masked phrase data is touched without an extracted table. */
export const PHRASE_MASK_UNAVAILABLE =
  'PSSI phrases are masked and the phrase table has not been extracted yet: it is read ' +
  'from the installed rekordbox when the app starts, so install rekordbox once, then restart';

/**
 * The mask of this process, derived from the table phraseMask.js extracted.
 * @returns {Buffer} 19 bytes
 */
function requireMask() {
  const mask = getPhraseMask();
  if (!mask) throw new Error(PHRASE_MASK_UNAVAILABLE);
  return mask;
}

/**
 * Phrase labels per mood. The header field at 0x12 (mood) selects the table and
 * the phrase record carries the index into it, so the same code means different
 * things in different tracks.
 *
 * Measured: of 73 real phrase tables in the desktop cache, 69 carry mood 1, three
 * carry mood 2 and one carries mood 3, and every mood-1 table stays within codes
 * 1..6 while every mood-2 and mood-3 table uses codes 8, 9 and 10.
 */
export const MOOD_PHRASE_NAMES = {
  1: {
    1: 'INTRO',
    2: 'UP',
    3: 'DOWN',
    5: 'CHORUS',
    6: 'OUTRO',
  },
  2: {
    1: 'INTRO',
    2: 'VERSE 1',
    3: 'VERSE 2',
    4: 'VERSE 3',
    5: 'VERSE 4',
    6: 'VERSE 5',
    7: 'VERSE 6',
    8: 'BRIDGE',
    9: 'CHORUS',
    10: 'OUTRO',
  },
  3: {
    1: 'INTRO',
    2: 'VERSE 1',
    3: 'VERSE 1',
    4: 'VERSE 1',
    5: 'VERSE 2',
    6: 'VERSE 2',
    7: 'VERSE 2',
    8: 'BRIDGE',
    9: 'CHORUS',
    10: 'OUTRO',
  },
};

export const MOOD_NAMES = { 1: 'high', 2: 'mid', 3: 'low' };

/**
 * Bar colours sampled from rekordbox's own phrase bar, per mood. Mood 1 was
 * measured on two tracks, mood 2 on five and mood 3 on one. Colour follows the
 * label, which is why mood 3 gives the same colour to codes 2..4 and to 5..7:
 * those are the collapsed verses.
 */
export const MOOD_PHRASE_COLOURS = {
  1: {
    1: '#c80000',
    2: '#8c32ff',
    3: '#9b732d',
    5: '#0faa00',
    6: '#5087c3',
  },
  2: {
    1: '#e14646',
    2: '#506eff',
    3: '#5055ff',
    4: '#6450ff',
    5: '#7850ff',
    6: '#8c50ff',
    7: '#a050ff',
    8: '#e1d741',
    9: '#78c37d',
    10: '#738296',
  },
  3: {
    1: '#ffaab4',
    2: '#a5a0ff',
    3: '#a5a0ff',
    4: '#a5a0ff',
    5: '#bea0ff',
    6: '#bea0ff',
    7: '#bea0ff',
    8: '#fffaa5',
    9: '#b9e1b9',
    10: '#91a0b4',
  },
};

/**
 * Build the XOR key for one section.
 * @param {number} count number of phrases (record count)
 * @param {number} length payload length in bytes
 * @returns {Buffer}
 */
export function maskKey(count, length) {
  const mask = requireMask();
  const key = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    key[i] = (mask[i % mask.length] + count) & 0xff;
  }
  return key;
}

/**
 * XOR a payload with the stick mask. The operation is its own inverse.
 * @param {Buffer} payload
 * @param {number} count
 * @returns {Buffer}
 */
export function applyMask(payload, count) {
  const key = maskKey(count, payload.length);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ key[i];
  return out;
}

/**
 * Decode records out of a payload.
 * @param {Buffer} payload
 * @param {number} count
 * @returns {number[][]} 12 numbers per phrase
 */
export function decodeRecords(payload, count) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const record = [];
    for (let f = 0; f < PSSI_FIELD_COUNT; f += 1) {
      record.push(payload.readUInt16BE(i * PSSI_ENTRY_SIZE + f * 2));
    }
    records.push(record);
  }
  return records;
}

/**
 * Serialise records into a payload.
 * @param {number[][]} records
 * @returns {Buffer}
 */
export function encodeRecords(records) {
  const payload = Buffer.alloc(records.length * PSSI_ENTRY_SIZE);
  records.forEach((record, i) => {
    for (let f = 0; f < PSSI_FIELD_COUNT; f += 1) {
      payload.writeUInt16BE((record[f] ?? 0) & 0xffff, i * PSSI_ENTRY_SIZE + f * 2);
    }
  });
  return payload;
}

/**
 * A table is believable when indexes run 1..N, start beats increase and every
 * type code is one the analyser actually produces.
 * @param {number[][]} records
 * @returns {boolean}
 */
export function looksValid(records) {
  if (!records.length) return false;
  for (let i = 0; i < records.length; i += 1) {
    if (records[i][0] !== i + 1) return false;
    if (records[i][2] < 1 || records[i][2] > 10) return false;
    if (i > 0 && records[i][1] <= records[i - 1][1]) return false;
  }
  return true;
}

/**
 * Locate the PSSI section by walking the ANLZ section list, which is safer than
 * searching for the tag: waveform data can contain the same four bytes.
 * @param {Buffer} buffer
 * @returns {{offset: number, length: number}|null}
 */
export function findPssiSection(buffer) {
  let offset = 28;
  while (offset + 12 <= buffer.length) {
    const tag = buffer.toString('latin1', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(tag)) return null;
    const lenHeader = buffer.readUInt32BE(offset + 4);
    const lenTag = buffer.readUInt32BE(offset + 8);
    if (lenTag < 12 || offset + lenTag > buffer.length) return null;
    if (tag === PSSI_TAG) {
      return { offset, length: lenTag, lenHeader };
    }
    offset += lenTag;
  }
  return null;
}

/**
 * Parse a PSSI section.
 * @param {Buffer} section bytes starting at the PSSI tag
 * @param {{form?: 'auto'|'plain'|'stick'}} [options]
 * @returns {{form: string, count: number, mood: number|null, totalBeats: number|null, records: number[][]}}
 */
export function parsePssi(section, options = {}) {
  const form = options.form ?? 'auto';
  if (section.length < PSSI_HEADER_SIZE || section.toString('latin1', 0, 4) !== PSSI_TAG) {
    throw new Error('not a PSSI section');
  }
  const lenHeader = section.readUInt32BE(4);
  const lenTag = section.readUInt32BE(8);
  const entrySize = section.readUInt16BE(0x0e);
  const count = section.readUInt16BE(0x10);
  if (lenHeader !== PSSI_HEADER_SIZE) throw new Error(`unexpected PSSI header size ${lenHeader}`);
  if (entrySize !== PSSI_ENTRY_SIZE) throw new Error(`unexpected PSSI entry size ${entrySize}`);
  if (lenTag !== PSSI_HEADER_SIZE + count * PSSI_ENTRY_SIZE) {
    throw new Error('PSSI length does not match the phrase count');
  }
  if (lenTag > section.length) {
    throw new Error(
      `PSSI section is shorter than its length field (${section.length} < ${lenTag})`
    );
  }
  const payload = section.subarray(lenHeader, lenTag);

  if (form === 'plain' || form === 'auto') {
    const plain = decodeRecords(payload, count);
    if (looksValid(plain) || form === 'plain') {
      return {
        form: 'plain',
        count,
        mood: section.readUInt16BE(0x12),
        totalBeats: section.readUInt16BE(0x1a),
        records: plain,
      };
    }
  }

  const records = decodeRecords(applyMask(payload, count), count);
  if (form === 'auto' && !looksValid(records)) {
    throw new Error('PSSI table is neither plain nor masked as expected');
  }
  return { form: 'stick', count, mood: null, totalBeats: null, records };
}

/**
 * Build a PSSI section.
 * @param {number[][]} records 12 fields per phrase
 * @param {object} [options]
 * @param {'plain'|'stick'} [options.form]
 * @param {number} [options.mood] 1, 2 or 3, written at 0x12
 * @param {number} [options.totalBeats]
 * @param {number} [options.byte0x1c]
 * @param {number} [options.byte0x1d]
 * @param {number} [options.byte0x1e]
 * @returns {Buffer}
 */
export function buildPssi(records, options = {}) {
  const form = options.form ?? 'plain';
  const count = records.length;
  const lenTag = PSSI_HEADER_SIZE + count * PSSI_ENTRY_SIZE;
  const header = Buffer.alloc(PSSI_HEADER_SIZE);
  header.write(PSSI_TAG, 0, 'latin1');
  header.writeUInt32BE(PSSI_HEADER_SIZE, 4);
  header.writeUInt32BE(lenTag, 8);
  header.writeUInt16BE(0, 0x0c);
  header.writeUInt16BE(PSSI_ENTRY_SIZE, 0x0e);
  header.writeUInt16BE(count, 0x10);
  header.writeUInt16BE(options.mood ?? 1, 0x12);
  header.writeUInt32BE(0, 0x14);
  header.writeUInt16BE(0, 0x18);
  header.writeUInt16BE(options.totalBeats ?? 0, 0x1a);
  header.writeUInt8(options.byte0x1c ?? 0, 0x1c);
  header.writeUInt8(options.byte0x1d ?? 0, 0x1d);
  header.writeUInt8(options.byte0x1e ?? 0, 0x1e);
  header.writeUInt8(0, 0x1f);

  let payload = encodeRecords(records);
  if (form === 'stick') payload = applyMask(payload, count);
  return Buffer.concat([header, payload]);
}

/**
 * Human label for a phrase record. The mood decides what the code means, and in
 * mood 1 the CHORUS sub-index comes from field f3.
 * @param {number[]} record
 * @param {1|2|3} [mood]
 * @returns {string}
 */
export function phraseLabel(record, mood = 1) {
  const names = MOOD_PHRASE_NAMES[mood] ?? MOOD_PHRASE_NAMES[1];
  const name = names[record[2]];
  if (!name) return `type ${record[2]}`;
  if (mood === 1 && record[2] === 5) return `CHORUS ${record[3] ? 1 : 2}`;
  return name;
}

/**
 * Best guess at the mood of a table whose header cannot be trusted (the stick
 * form). Codes above 7 only occur in moods 2 and 3, and those two cannot be told
 * apart without the header, so the answer is 1 or 2 and never 3.
 * @param {number[][]} records
 * @returns {1|2}
 */
export function inferMood(records) {
  return records.some((r) => r[2] >= 7) ? 2 : 1;
}

/**
 * Bar colour for one record. The table is keyed by code, except that mood 1 has
 * two chorus variants that differ only in field f3.
 * @param {number[]} record
 * @param {1|2|3} mood
 * @param {Record<number, string>} palette
 * @returns {string|null}
 */
function colourFor(record, mood, palette) {
  if (mood === 1 && record[2] === 5) return record[3] ? palette[5] : '#00aa7d';
  return palette[record[2]] ?? null;
}

/**
 * Read the phrases out of a whole ANLZ file, plain or as a stick stores it.
 * Returns null when the file has no PSSI section, which is the normal state for
 * a track rekordbox never analysed.
 * @param {Buffer|null} buffer
 * @param {{form?: 'auto'|'plain'|'stick'}} [options]
 * @returns {{mood: number|null, inferredMood: number, form: string, phrases: Array<{index: number, beat: number, code: number, label: string, colour: string|null}>}|null}
 */
/**
 * Check records against the invariants measured on real exports.
 *
 * The hard rules come from the writer itself: the index runs from 1 and the
 * start beats rise strictly, which held in 75 of 75 files. The soft rule is the
 * last flag and position pair: they move together in 1395 of 1400 records, so a
 * mismatch is a warning and not a failure.
 *
 * @param {number[][]} records
 * @param {{ mood?: number }} [options]
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateRecords(records, options = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(records)) {
    return { ok: false, errors: ['records is not an array'], warnings };
  }
  if (records.length === 0) {
    warnings.push('no phrases');
    return { ok: true, errors, warnings };
  }
  const field = (name) => PSSI_FIELDS.indexOf(name);
  records.forEach((record, i) => {
    if (!Array.isArray(record) || record.length !== PSSI_FIELD_COUNT) {
      errors.push(`record ${i}: expected ${PSSI_FIELD_COUNT} fields, got ${record?.length}`);
      return;
    }
    if (record[field('index')] !== i + 1) {
      errors.push(`record ${i}: index is ${record[field('index')]}, expected ${i + 1}`);
    }
    const type = record[field('type')];
    if (type < 1) errors.push(`record ${i}: type ${type} is not a phrase type`);
    if (options.mood) {
      const table = MOOD_PHRASE_NAMES[options.mood];
      if (table && !(type in table)) {
        warnings.push(`record ${i}: type ${type} does not exist in mood ${options.mood}`);
      }
    }
    if (i > 0) {
      const previous = records[i - 1]?.[field('startBeat')];
      if (Number.isFinite(previous) && record[field('startBeat')] <= previous) {
        errors.push(
          `record ${i}: start beat ${record[field('startBeat')]} is not after ${previous}`
        );
      }
    }
    const flag = record[field('flag10')];
    const position = record[field('position11')];
    if ((flag !== 0) !== (position !== 0)) {
      warnings.push(`record ${i}: flag10 and position11 disagree (${flag} / ${position})`);
    }
  });
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Read the phrase table out of an ANLZ file. The mood is taken from the header
 * when it carries one and inferred from the record codes otherwise.
 * @param {Buffer} buffer - whole ANLZ file
 * @param {object} [options] - passed through to parsePssi
 * @returns {{mood: number|null, inferredMood: number, form: string, validation: object,
 *            phrases: Array<{index: number, beat: number, code: number, label: string,
 *            colour: string|null}>}|null} null when the file has no PSSI section
 */
export function readPhrasesFromAnlz(buffer, options = {}) {
  if (!buffer || buffer.length < 40) return null;
  const found = findPssiSection(buffer);
  if (!found) return null;
  const parsed = parsePssi(buffer.subarray(found.offset, found.offset + found.length), options);
  const inferredMood = parsed.mood ?? inferMood(parsed.records);
  const palette = MOOD_PHRASE_COLOURS[inferredMood] ?? {};
  return {
    mood: parsed.mood,
    inferredMood,
    form: parsed.form,
    validation: validateRecords(parsed.records, { mood: inferredMood }),
    phrases: parsed.records.map((record) => ({
      index: record[0],
      beat: record[1],
      code: record[2],
      label: phraseLabel(record, inferredMood),
      colour: colourFor(record, inferredMood, palette),
    })),
  };
}
