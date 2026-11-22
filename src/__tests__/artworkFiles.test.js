import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ARTWORK_THUMB_SIZE, writeArtworkFiles } from '../usb/pioneer/artwork.js';
import { planArtwork } from '../usb/pioneer/formats/pdb.js';

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwork-'));
  tmpDirs.push(dir);
  return dir;
}

function writeCover(dir, name, bytes = 'cover-bytes') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('writeArtworkFiles', () => {
  it('copies a JPEG and its small twin under PIONEER/Artwork', async () => {
    const dir = tmpDir();
    const cover = writeCover(dir, 'cover.jpg');
    const root = path.join(dir, 'stick');
    const plan = planArtwork([{ id: 1, artwork_path: cover }]);

    const result = await writeArtworkFiles(root, plan, { ffmpegPath: null });

    expect(result.files).toEqual([
      'PIONEER/Artwork/00001/a1.jpg',
      'PIONEER/Artwork/00001/a1_m.jpg',
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    for (const rel of result.files) {
      expect(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')).toBe('cover-bytes');
    }
  });

  it('skips a missing cover instead of publishing a broken path', async () => {
    const dir = tmpDir();
    const root = path.join(dir, 'stick');
    const plan = planArtwork([{ id: 1, artwork_path: path.join(dir, 'gone.jpg') }]);

    const result = await writeArtworkFiles(root, plan, { ffmpegPath: null });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(['PIONEER/Artwork/00001/a1.jpg']);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('skips a PNG when no decoder is available', async () => {
    const dir = tmpDir();
    const cover = writeCover(dir, 'cover.png');
    const root = path.join(dir, 'stick');
    const plan = planArtwork([{ id: 1, artwork_path: cover }]);

    const result = await writeArtworkFiles(root, plan, { ffmpegPath: null });

    expect(result.files).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it('uses a 240 pixel square twin, like rekordbox', () => {
    expect(ARTWORK_THUMB_SIZE).toBe(240);
  });
});
