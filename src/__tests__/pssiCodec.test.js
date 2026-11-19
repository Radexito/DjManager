import { describe, it, expect } from 'vitest';
import {
  PSSI_FIELDS,
  PSSI_FIELD_COUNT,
  readPhrasesFromAnlz,
  validateRecords,
  MOOD_PHRASE_COLOURS,
  MOOD_PHRASE_NAMES,
  applyMask,
  buildPssi,
  decodeRecords,
  encodeRecords,
  findPssiSection,
  inferMood,
  looksValid,
  maskKey,
  parsePssi,
  phraseLabel,
} from '../usb/pioneer/formats/pssi.js';
import { clearPhraseMask, setPhraseMask } from '../audio/phraseMask.js';
import { TEST_PHRASE_TABLE } from './phraseSetup.js';

/*
 * Real payload taken from one track, as rekordbox keeps it in its own share/
 * cache (plain). The masked form is not stored: a plain/stick pair would give
 * the mask away by XOR, so it is produced here with the test table instead.
 */
const PLAIN_HEX =
  '00010001000100000000000000000000000000000000000000020020000200000000000000000000000000010001005e' +
  '00030060000200000001000000600000000000000001007c000400800005000000000000000000000000000000000000' +
  '000500a000050000000000000000000000000000000100be000600c000020000000000000000000000000000000100dc' +
  '000700e000050000000000000000000000000000000100fe000801000005000000000000000000000000000000000000' +
  '000901200003000000000000000000000000000000000000000a01280002000000000000000000000000000100000000' +
  '000b01600002000000000000000000000000000000000000000c01900003000000000000000000000000000000000000' +
  '000d01c000020000000000000000000000000000000101dc000e01e0000500010000000000000000000000000001021d' +
  '000f02200005000100000000000000000000000000000000001002600006000000000000000000000000000000000000';

const PLAIN = Buffer.from(PLAIN_HEX, 'hex');
/** Number of phrase records the two fixture buffers encode. */
const COUNT = 16;

describe('PSSI_FIELDS', () => {
  it('names all twelve u16 in the order the encoder writes them', () => {
    expect(PSSI_FIELDS).toHaveLength(PSSI_FIELD_COUNT);
    expect(PSSI_FIELDS.slice(0, 3)).toEqual(['index', 'startBeat', 'type']);
  });

  it('matches the width of the records the codec decodes', () => {
    const records = decodeRecords(PLAIN, COUNT);
    expect(records[0]).toHaveLength(PSSI_FIELDS.length);
    expect(records[0][PSSI_FIELDS.indexOf('startBeat')]).toBe(1);
    expect(records[1][PSSI_FIELDS.indexOf('type')]).toBe(2);
  });
});

describe('validateRecords', () => {
  const good = () => [
    [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [2, 33, 2, 0, 0, 0, 0, 0, 0, 0, 1, 94],
    [3, 97, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  ];

  it('accepts a table that follows the rules the writer keeps', () => {
    const result = validateRecords(good());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an index that does not run from one', () => {
    const records = good();
    records[1][0] = 7;
    const result = validateRecords(records);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/index is 7, expected 2/);
  });

  it('rejects start beats that go backwards', () => {
    const records = good();
    records[2][1] = 20;
    expect(validateRecords(records).errors[0]).toMatch(/not after/);
  });

  it('rejects a record of the wrong width', () => {
    expect(validateRecords([[1, 2, 3]]).errors[0]).toMatch(/expected 12 fields/);
  });

  it('warns, but does not fail, when the flag and its position disagree', () => {
    const records = good();
    records[1][10] = 1;
    records[1][11] = 0;
    const result = validateRecords(records);
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toMatch(/flag10 and position11 disagree/);
  });

  it('warns about a type that the mood does not know', () => {
    const records = good();
    records[2][2] = 9;
    const result = validateRecords(records, { mood: 1 });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/type 9 does not exist in mood 1/);
  });

  it('notices an empty table', () => {
    expect(validateRecords([])).toEqual({ ok: true, errors: [], warnings: ['no phrases'] });
  });
});

describe('readPhrasesFromAnlz', () => {
  it('attaches the validation of the table it read', () => {
    const section = buildPssi(decodeRecords(PLAIN, COUNT), { form: 'plain' });
    const file = Buffer.concat([Buffer.alloc(28), section]);
    const read = readPhrasesFromAnlz(file);
    expect(read.phrases).toHaveLength(COUNT);
    expect(read.validation.ok).toBe(true);
    expect(read.validation.errors).toEqual([]);
  });
});

describe('pssiCodec', () => {
  it('masks a payload so that the same call restores it', () => {
    const masked = applyMask(PLAIN, COUNT);
    expect(masked.equals(PLAIN)).toBe(false);
    expect(applyMask(masked, COUNT).equals(PLAIN)).toBe(true);
  });

  it('reads the real plain payload into phrase records', () => {
    const records = decodeRecords(PLAIN, COUNT);
    expect(records).toHaveLength(COUNT);
    expect(records[0].slice(0, 3)).toEqual([1, 1, 1]);
    expect(records[0].slice(3)).toEqual(new Array(9).fill(0));
    expect(records[1].slice(0, 3)).toEqual([2, 32, 2]);
    expect(records[15].slice(0, 3)).toEqual([16, 608, 6]);
    expect(looksValid(records)).toBe(true);
  });

  it('builds a stick section from the same records', () => {
    const records = decodeRecords(PLAIN, COUNT);
    const section = buildPssi(records, { form: 'stick' });
    expect(section.subarray(32).equals(applyMask(PLAIN, COUNT))).toBe(true);
  });

  it('round-trips a plain section', () => {
    const records = decodeRecords(PLAIN, COUNT);
    const section = buildPssi(records, { form: 'plain', totalBeats: 673 });
    const parsed = parsePssi(section);
    expect(parsed.form).toBe('plain');
    expect(parsed.totalBeats).toBe(673);
    expect(parsed.records).toEqual(records);
  });

  it('round-trips a stick section and reports no total beats', () => {
    const records = decodeRecords(PLAIN, COUNT);
    const section = buildPssi(records, { form: 'stick' });
    const parsed = parsePssi(section);
    expect(parsed.form).toBe('stick');
    expect(parsed.totalBeats).toBeNull();
    expect(parsed.records).toEqual(records);
  });

  it('auto-detects which form a section is in', () => {
    const records = decodeRecords(PLAIN, COUNT);
    expect(parsePssi(buildPssi(records, { form: 'plain' })).form).toBe('plain');
    expect(parsePssi(buildPssi(records, { form: 'stick' })).form).toBe('stick');
  });

  it('shifts every key byte by the phrase count', () => {
    const base = maskKey(16, TEST_PHRASE_TABLE.length);
    const shifted = maskKey(24, TEST_PHRASE_TABLE.length);
    expect(base).toHaveLength(TEST_PHRASE_TABLE.length);
    for (let i = 0; i < base.length; i += 1) {
      expect(shifted[i]).toBe((base[i] + 8) & 0xff);
    }
    expect(maskKey(16, 4)).toHaveLength(4);
  });

  it('reports a missing phrase table instead of decoding garbage', () => {
    const records = decodeRecords(PLAIN, COUNT);
    const section = buildPssi(records, { form: 'stick' });
    clearPhraseMask();
    try {
      expect(() => parsePssi(section, { form: 'stick' })).toThrow(
        /phrase table has not been extracted/
      );
    } finally {
      setPhraseMask(TEST_PHRASE_TABLE);
    }
  });

  it('serialises records back to the same bytes', () => {
    const records = decodeRecords(PLAIN, COUNT);
    expect(encodeRecords(records).equals(PLAIN)).toBe(true);
  });

  it('rejects a table whose indexes do not run from 1', () => {
    const records = decodeRecords(PLAIN, COUNT);
    records[3][0] = 99;
    expect(looksValid(records)).toBe(false);
  });

  it('rejects a table whose start beats go backwards', () => {
    const records = decodeRecords(PLAIN, COUNT);
    records[5][1] = 1;
    expect(looksValid(records)).toBe(false);
  });

  it('rejects sections that do not match their declared size', () => {
    const records = decodeRecords(PLAIN, COUNT);
    const section = buildPssi(records, { form: 'plain' });
    const truncated = section.subarray(0, section.length - 8);
    expect(() => parsePssi(truncated)).toThrow(/length/);
  });

  it('refuses bytes that are not a PSSI section', () => {
    expect(() => parsePssi(Buffer.from('NOPE0000', 'latin1'))).toThrow();
  });

  it('finds PSSI by walking the section list, not by searching for the tag', () => {
    const fakePwv = Buffer.alloc(24 + 16);
    fakePwv.write('PWV4', 0, 'latin1');
    fakePwv.writeUInt32BE(24, 4);
    fakePwv.writeUInt32BE(24 + 16, 8);
    fakePwv.write('PSSI', 24, 'latin1');
    const header = Buffer.alloc(28);
    const section = buildPssi(decodeRecords(PLAIN, COUNT), { form: 'plain' });
    const file = Buffer.concat([header, fakePwv, section]);
    const found = findPssiSection(file);
    expect(found).not.toBeNull();
    expect(found.offset).toBe(28 + fakePwv.length);
    expect(parsePssi(file.subarray(found.offset, found.offset + found.length)).records).toEqual(
      decodeRecords(PLAIN, COUNT)
    );
  });

  it('labels phrases per mood, because the same code means different things', () => {
    const records = decodeRecords(PLAIN, COUNT);
    expect(inferMood(records)).toBe(1);
    expect(phraseLabel(records[0], 1)).toBe('INTRO');
    expect(phraseLabel(records[1], 1)).toBe('UP');
    expect(phraseLabel(records[8], 1)).toBe('DOWN');
    expect(phraseLabel(records[15], 1)).toBe('OUTRO');
    expect(phraseLabel(records[13], 1)).toBe('CHORUS 1');
    expect(phraseLabel(records[3], 1)).toBe('CHORUS 2');

    expect(phraseLabel([1, 1, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0], 2)).toBe('VERSE 6');
    expect(phraseLabel([1, 1, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0], 2)).toBe('BRIDGE');
    expect(phraseLabel([1, 1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0], 2)).toBe('CHORUS');
    expect(phraseLabel([1, 1, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0], 2)).toBe('OUTRO');

    expect(phraseLabel([1, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3)).toBe('VERSE 1');
    expect(phraseLabel([1, 1, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3)).toBe('VERSE 2');
    expect(phraseLabel([1, 1, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3)).toBe('VERSE 2');
  });

  it('infers the mood family of a table whose header cannot be trusted', () => {
    expect(inferMood([[1, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]])).toBe(1);
    expect(
      inferMood([
        [1, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [2, 33, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ])
    ).toBe(2);
  });

  it('carries the mood and the colours of each mood', () => {
    expect(MOOD_PHRASE_NAMES[1][2]).toBe('UP');
    expect(MOOD_PHRASE_NAMES[2][2]).toBe('VERSE 1');
    expect(MOOD_PHRASE_NAMES[3][2]).toBe('VERSE 1');
    expect(MOOD_PHRASE_COLOURS[1][1]).toBe('#c80000');
    expect(MOOD_PHRASE_COLOURS[2][9]).toBe('#78c37d');
    expect(MOOD_PHRASE_COLOURS[3][1]).toBe('#ffaab4');
    expect(MOOD_PHRASE_COLOURS[3][2]).toBe('#a5a0ff');
    expect(MOOD_PHRASE_COLOURS[3][3]).toBe(MOOD_PHRASE_COLOURS[3][2]);
    expect(MOOD_PHRASE_COLOURS[3][4]).toBe(MOOD_PHRASE_COLOURS[3][2]);
    expect(MOOD_PHRASE_COLOURS[3][5]).toBe('#bea0ff');
    expect(MOOD_PHRASE_COLOURS[3][7]).toBe(MOOD_PHRASE_COLOURS[3][5]);
    expect(MOOD_PHRASE_COLOURS[3][9]).toBe('#b9e1b9');
  });

  it('round-trips the mood through the header', () => {
    const records = decodeRecords(PLAIN, COUNT);
    for (const mood of [1, 2, 3]) {
      const section = buildPssi(records, { form: 'plain', mood, totalBeats: 673 });
      expect(parsePssi(section).mood).toBe(mood);
      expect(parsePssi(buildPssi(records, { form: 'stick', mood })).mood).toBeNull();
    }
  });
});
