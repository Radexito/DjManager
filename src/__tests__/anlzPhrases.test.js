import { describe, it, expect } from 'vitest';
import { buildPssi, readPhrasesFromAnlz } from '../usb/pioneer/formats/pssi.js';

/** Wraps the given sections in a PMAI container whose header accounts for their total length. */
function container(...sections) {
  const head = Buffer.alloc(28);
  head.write('PMAI', 0, 4, 'ascii');
  head.writeUInt32BE(28, 4);
  head.writeUInt32BE(28 + sections.reduce((s, b) => s + b.length, 0), 8);
  return Buffer.concat([head, ...sections]);
}

const MOOD2_RECORDS = [
  [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 33, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [3, 65, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [4, 97, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];

describe('readPhrasesFromAnlz', () => {
  it('reads a plain table and names the codes by the mood in the header', () => {
    const anlz = container(buildPssi(MOOD2_RECORDS, { form: 'plain', mood: 2 }));
    const read = readPhrasesFromAnlz(anlz);
    expect(read).not.toBeNull();
    expect(read.form).toBe('plain');
    expect(read.mood).toBe(2);
    expect(read.phrases.map((p) => p.label)).toEqual(['INTRO', 'VERSE 1', 'CHORUS', 'OUTRO']);
    expect(read.phrases.map((p) => p.beat)).toEqual([1, 33, 65, 97]);
    expect(read.phrases[2].colour).toBe('#78c37d');
  });

  it('names the same codes differently in mood 1', () => {
    const records = [
      [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [2, 33, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [3, 65, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    ];
    const anlz = container(buildPssi(records, { form: 'plain', mood: 1 }));
    const read = readPhrasesFromAnlz(anlz);
    expect(read.mood).toBe(1);
    expect(read.phrases.map((p) => p.label)).toEqual(['INTRO', 'UP', 'CHORUS 1']);
    expect(read.phrases[2].colour).toBe('#0faa00');
  });

  it('reads the masked form a stick carries and infers the mood from the codes', () => {
    const anlz = container(buildPssi(MOOD2_RECORDS, { form: 'stick', mood: 2 }));
    const read = readPhrasesFromAnlz(anlz);
    expect(read.form).toBe('stick');
    expect(read.mood).toBeNull();
    expect(read.inferredMood).toBe(2);
    expect(read.phrases.map((p) => p.label)).toEqual(['INTRO', 'VERSE 1', 'CHORUS', 'OUTRO']);
  });

  it('returns null for a file without a phrase table', () => {
    const head = Buffer.alloc(28);
    head.write('PMAI', 0, 4, 'ascii');
    head.writeUInt32BE(28, 4);
    head.writeUInt32BE(28, 8);
    expect(readPhrasesFromAnlz(head)).toBeNull();
    expect(readPhrasesFromAnlz(null)).toBeNull();
  });

  it('throws on a corrupt table so the caller can decide what to do', () => {
    const broken = Buffer.alloc(200);
    broken.write('PSSI', 0, 'ascii');
    broken.writeUInt32BE(32, 4);
    broken.writeUInt32BE(200, 8);
    broken.writeUInt16BE(24, 0x0e);
    broken.writeUInt16BE(3, 0x10);
    expect(() => readPhrasesFromAnlz(container(broken))).toThrow(/length/);
  });
});
