import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ARTWORK_THUMB_SIZE, looksLikeJpeg, writeArtworkFiles } from '../usb/pioneer/artwork.js';
import { planArtwork } from '../usb/pioneer/formats/pdb.js';

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwork-'));
  tmpDirs.push(dir);
  return dir;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function writeCover(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** A stand-in for ffmpeg: writes `body` to the last argument, or nothing. */
function stubDecoder(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nfor last; do :; done\n${body}\n`, { mode: 0o755 });
  return file;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('writeArtworkFiles', () => {
  it('copies a JPEG byte for byte and makes the small twin', async () => {
    const dir = tmpDir();
    const cover = writeCover(dir, 'cover.jpg', JPEG);
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
      expect(fs.readFileSync(path.join(root, ...rel.split('/')))).toEqual(JPEG);
    }
  });

  it('reads the bytes, not the name: PNG under a .jpg name is converted', async () => {
    const dir = tmpDir();
    const cover = writeCover(dir, 'cover.jpg', PNG);
    const root = path.join(dir, 'stick');
    const plan = planArtwork([{ id: 1, artwork_path: cover }]);
    const decoder = stubDecoder(dir, 'ffmpeg-ok', 'printf "\\377\\330\\377\\331" > "$last"');
    if (process.platform === 'win32') return;

    const result = await writeArtworkFiles(root, plan, { ffmpegPath: decoder });

    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    const dest = fs.readFileSync(path.join(root, 'PIONEER', 'Artwork', '00001', 'a1.jpg'));
    expect(looksLikeJpeg(dest)).toBe(true);
  });

  it('reports a cover the decoder could not turn into JPEG, and publishes none of it', async () => {
    const dir = tmpDir();
    const cover = writeCover(dir, 'cover.png', PNG);
    const root = path.join(dir, 'stick');
    const plan = planArtwork([{ id: 1, artwork_path: cover }]);
    const decoder = stubDecoder(dir, 'ffmpeg-silent', 'exit 0');
    if (process.platform === 'win32') return;

    const result = await writeArtworkFiles(root, plan, { ffmpegPath: decoder });

    expect(result.files).toEqual([]);
    expect(result.failed).toEqual([
      { relPath: 'PIONEER/Artwork/00001/a1.jpg', reason: 'the decoder produced no JPEG' },
    ]);
    expect(fs.existsSync(path.join(root, 'PIONEER', 'Artwork', '00001', 'a1.jpg'))).toBe(false);
  });

  it('skips a missing cover instead of publishing a broken path', async () => {
    const dir = tmpDir();
    const root = path.join(dir, 'stick');
    const plan = planArtwork([{ id: 1, artwork_path: path.join(dir, 'gone.jpg') }]);

    const result = await writeArtworkFiles(root, plan, { ffmpegPath: null });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      { relPath: 'PIONEER/Artwork/00001/a1.jpg', reason: 'the cover file is gone' },
    ]);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('skips a non-JPEG when no decoder is installed', async () => {
    const dir = tmpDir();
    const cover = writeCover(dir, 'cover.png', PNG);
    const root = path.join(dir, 'stick');
    const plan = planArtwork([{ id: 1, artwork_path: cover }]);

    const result = await writeArtworkFiles(root, plan, { ffmpegPath: null });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      { relPath: 'PIONEER/Artwork/00001/a1.jpg', reason: 'not a JPEG and no decoder is installed' },
    ]);
  });

  it('uses a 240 pixel square twin, like rekordbox', () => {
    expect(ARTWORK_THUMB_SIZE).toBe(240);
  });
});
