import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PHRASE_TABLE_LENGTH,
  PHRASE_TABLE_OFFSET,
  clearPhraseMask,
  deriveMask,
  ensurePhraseMask,
  extractPhraseTable,
  findPhraseTableIn,
  fingerprintOf,
  getPhraseMask,
  isPhraseTable,
  phraseMaskPath,
  readPhraseMask,
  rekordboxExecutables,
  setPhraseMask,
  writePhraseMask,
} from '../audio/phraseMask.js';
import { TEST_PHRASE_TABLE } from './phraseSetup.js';

/** Fingerprint of the synthetic table, so the scanner can be driven with it. */
const TEST_FINGERPRINT = fingerprintOf(TEST_PHRASE_TABLE);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'djman-mask-'));
}

beforeEach(() => {
  clearPhraseMask();
});

afterAll(() => {
  setPhraseMask(TEST_PHRASE_TABLE);
});

describe('deriveMask', () => {
  it('reads the table from the encoder offset and folds in 0x80', () => {
    const mask = deriveMask(TEST_PHRASE_TABLE);
    expect(mask).toHaveLength(PHRASE_TABLE_LENGTH);
    for (let i = 0; i < PHRASE_TABLE_LENGTH; i += 1) {
      const code = TEST_PHRASE_TABLE.charCodeAt((PHRASE_TABLE_OFFSET + i) % PHRASE_TABLE_LENGTH);
      expect(mask[i]).toBe((code - 0x80) & 0xff);
    }
  });

  it('rejects a table of the wrong length', () => {
    expect(() => deriveMask('too-short')).toThrow(/19 characters/);
    expect(() => deriveMask(undefined)).toThrow(/19 characters/);
  });
});

describe('fingerprintOf and isPhraseTable', () => {
  it('hashes the salted table', () => {
    const expected = crypto
      .createHash('sha256')
      .update(`djman-phrase-table:${TEST_PHRASE_TABLE}`)
      .digest('hex');
    expect(fingerprintOf(TEST_PHRASE_TABLE)).toBe(expected);
  });

  it('accepts only the table that matches the fingerprint', () => {
    expect(isPhraseTable(TEST_PHRASE_TABLE, TEST_FINGERPRINT)).toBe(true);
    expect(isPhraseTable(TEST_PHRASE_TABLE, 'deadbeef')).toBe(false);
    expect(isPhraseTable('short', TEST_FINGERPRINT)).toBe(false);
    expect(isPhraseTable(null, TEST_FINGERPRINT)).toBe(false);
  });
});

describe('findPhraseTableIn', () => {
  it('finds the table inside a narrow string table', () => {
    const buffer = Buffer.concat([
      Buffer.from('noise\u0000'),
      Buffer.from(`prefix${TEST_PHRASE_TABLE}suffix`),
      Buffer.from('\u0000tail'),
    ]);
    const hit = findPhraseTableIn(buffer, { fingerprint: TEST_FINGERPRINT });
    expect(hit?.table).toBe(TEST_PHRASE_TABLE);
    expect(hit?.candidates).toBeGreaterThan(0);
  });

  it('finds the table stored as UTF-16LE', () => {
    const buffer = Buffer.concat([
      Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
      Buffer.from(TEST_PHRASE_TABLE, 'utf16le'),
      Buffer.from([0, 0, 0, 0]),
    ]);
    expect(findPhraseTableIn(buffer, { fingerprint: TEST_FINGERPRINT })?.table).toBe(
      TEST_PHRASE_TABLE
    );
  });

  it('returns nothing when the table is absent', () => {
    const buffer = Buffer.from('a binary full of unrelated printable words, nothing else here');
    expect(findPhraseTableIn(buffer, { fingerprint: TEST_FINGERPRINT })).toBeNull();
  });

  it('stops walking once the candidate budget is spent', () => {
    const buffer = Buffer.from('x'.repeat(4000));
    const hit = findPhraseTableIn(buffer, { fingerprint: TEST_FINGERPRINT, maxCandidates: 5 });
    expect(hit).toBeNull();
  });
});

describe('extractPhraseTable', () => {
  it('scans every file until one matches', () => {
    const files = ['/missing', '/fake'];
    const readFile = (file) => {
      if (file === '/missing') throw new Error('nope');
      return Buffer.from(`junk${TEST_PHRASE_TABLE}junk`);
    };
    const hit = extractPhraseTable({ files, readFile, fingerprint: TEST_FINGERPRINT });
    expect(hit).toEqual({
      table: TEST_PHRASE_TABLE,
      source: '/fake',
      candidates: expect.any(Number),
    });
  });

  it('returns null when no file contains the table', () => {
    const hit = extractPhraseTable({
      files: ['/fake'],
      readFile: () => Buffer.from('nothing useful'),
      fingerprint: TEST_FINGERPRINT,
    });
    expect(hit).toBeNull();
  });
});

describe('phrase mask cache', () => {
  it('writes and reads the table back', () => {
    const dir = tempDir();
    const file = writePhraseMask(dir, TEST_PHRASE_TABLE, 'unit-test');
    expect(file).toBe(phraseMaskPath(dir));

    const read = readPhraseMask(dir, { fingerprint: TEST_FINGERPRINT });
    expect(read?.table).toBe(TEST_PHRASE_TABLE);
    expect(read?.source).toBe('unit-test');
  });

  it('ignores a cached table that does not match the fingerprint', () => {
    const dir = tempDir();
    writePhraseMask(dir, TEST_PHRASE_TABLE, 'unit-test');
    expect(readPhraseMask(dir)).toBeNull();
  });

  it('returns null for a missing or broken file', () => {
    const dir = tempDir();
    expect(readPhraseMask(dir)).toBeNull();
    fs.writeFileSync(phraseMaskPath(dir), '{not json');
    expect(readPhraseMask(dir)).toBeNull();
  });
});

describe('ensurePhraseMask', () => {
  it('uses the cache before looking at any binary', () => {
    const dir = tempDir();
    writePhraseMask(dir, TEST_PHRASE_TABLE, 'cache');

    const result = ensurePhraseMask({ userDataPath: dir, fingerprint: TEST_FINGERPRINT });
    expect(result?.table).toBe(TEST_PHRASE_TABLE);
    expect(result?.source).toBe('cache');
    expect(getPhraseMask()).toHaveLength(PHRASE_TABLE_LENGTH);
  });

  it('extracts from a binary and caches the result', () => {
    const dir = tempDir();
    const binary = path.join(dir, 'rekordbox.exe');
    fs.writeFileSync(binary, Buffer.from(`xx${TEST_PHRASE_TABLE}xx`));

    const result = ensurePhraseMask({
      userDataPath: dir,
      files: [binary],
      fingerprint: TEST_FINGERPRINT,
    });
    expect(result?.table).toBe(TEST_PHRASE_TABLE);
    expect(result?.source).toBe(binary);
    expect(readPhraseMask(dir, { fingerprint: TEST_FINGERPRINT })?.table).toBe(TEST_PHRASE_TABLE);
  });

  it('returns null when there is no cache and no binary', () => {
    const dir = tempDir();
    const result = ensurePhraseMask({
      userDataPath: dir,
      files: [],
      fingerprint: TEST_FINGERPRINT,
    });
    expect(result).toBeNull();
    expect(getPhraseMask()).toBeNull();
  });

  it('runs at most once per process until the mask is cleared', () => {
    const dir = tempDir();
    expect(
      ensurePhraseMask({ userDataPath: dir, files: [], fingerprint: TEST_FINGERPRINT })
    ).toBeNull();
    const binary = path.join(dir, 'later.exe');
    fs.writeFileSync(binary, Buffer.from(TEST_PHRASE_TABLE));
    expect(
      ensurePhraseMask({ userDataPath: dir, files: [binary], fingerprint: TEST_FINGERPRINT })
    ).toBeNull();

    clearPhraseMask();
    expect(
      ensurePhraseMask({ userDataPath: dir, files: [binary], fingerprint: TEST_FINGERPRINT })?.table
    ).toBe(TEST_PHRASE_TABLE);
  });
});

describe('rekordboxExecutables', () => {
  it('looks inside rekordbox directories of the program files', () => {
    const dirs = {
      'C:\\Program Files': [
        { name: 'rekordbox', isDirectory: () => true },
        { name: 'Other', isDirectory: () => true },
      ],
      'C:\\Program Files\\rekordbox': [{ name: 'rekordbox 7.2.19', isDirectory: () => true }],
    };
    const found = rekordboxExecutables({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      readdir: (dir) => dirs[dir] ?? [],
      exists: (file) => file === 'C:\\Program Files\\rekordbox\\rekordbox 7.2.19\\rekordbox.exe',
    });
    expect(found).toEqual(['C:\\Program Files\\rekordbox\\rekordbox 7.2.19\\rekordbox.exe']);
  });

  it('reports nothing on a platform without rekordbox', () => {
    expect(
      rekordboxExecutables({ platform: 'linux', env: {}, readdir: () => [], exists: () => false })
    ).toEqual([]);
  });
});
