import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDbPath, setDbPath } from '../db/dbLocation.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj_db_location_test_'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('dbLocation — default (no pointer file)', () => {
  it('defaults to userData/library.db when no pointer file exists', () => {
    expect(getDbPath(tmpDir)).toBe(path.join(tmpDir, 'library.db'));
  });
});

describe('dbLocation — after setDbPath', () => {
  it('returns the relocated path once set', () => {
    const newPath = path.join(tmpDir, 'elsewhere', 'library.db');
    setDbPath(tmpDir, newPath);
    expect(getDbPath(tmpDir)).toBe(newPath);
  });

  it('persists the pointer to disk so it survives a restart', () => {
    const newPath = path.join(tmpDir, 'elsewhere', 'library.db');
    setDbPath(tmpDir, newPath);
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'db-location.json'), 'utf8'));
    expect(onDisk.path).toBe(newPath);
  });
});

describe('dbLocation — corrupt pointer file recovery', () => {
  it('falls back to the default path if the pointer file is corrupt', () => {
    fs.writeFileSync(path.join(tmpDir, 'db-location.json'), '{ not valid json');
    expect(getDbPath(tmpDir)).toBe(path.join(tmpDir, 'library.db'));
  });
});
