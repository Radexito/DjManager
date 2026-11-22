import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Covers on a Pioneer medium.
 *
 * rekordbox writes every cover twice: `a<id>.jpg` is what the deck shows on its
 * display, `a<id>_m.jpg` is the small copy its lists use. The PDB only points
 * at the large one (`/.PIONEER/Artwork/00001/a1.jpg`), the `_m` name is a
 * convention the player follows on its own, so both have to exist.
 *
 * Only JPEG is written: a PNG cover is converted first, because a deck does not
 * decode PNG. When ffmpeg is missing the cover is skipped rather than published
 * as a file the player cannot read.
 */

/**
 * Edge of the small copy, in pixels. rekordbox keeps 240x240 and 80x80 copies
 * of every cover in its own share folder (`artwork_m.jpg`, `artwork_s.jpg`);
 * the medium takes the 240 one, square.
 */
export const ARTWORK_THUMB_SIZE = 240;

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

function isJpeg(filePath) {
  return JPEG_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function ffmpeg(ffmpegPath, args) {
  await execFileAsync(ffmpegPath, args, { windowsHide: true, timeout: 60_000 });
}

/**
 * Write the covers of one export into `root` (a staging folder or a medium).
 *
 * @param {string} root folder the relative paths are resolved against
 * @param {Array<{id: number, sourcePath: string, relPath: string}>} plan from `planArtwork`
 * @param {{ffmpegPath?: string|null}} options
 * @returns {Promise<{files: string[], skipped: string[], failed: Array<{relPath: string, reason: string}>}>}
 *   `files` are the relative paths that now exist under `root`, large and small
 */
export async function writeArtworkFiles(root, plan = [], { ffmpegPath = null } = {}) {
  const files = [];
  const skipped = [];
  const failed = [];

  for (const cover of plan) {
    const relPath = String(cover.relPath || '').replace(/^\/+/, '');
    if (!relPath) continue;
    const dest = path.join(root, ...relPath.split('/'));
    const thumbRel = relPath.replace(/\.jpg$/, '_m.jpg');
    const thumb = path.join(root, ...thumbRel.split('/'));

    let source = null;
    try {
      source = cover.sourcePath && fs.statSync(cover.sourcePath).isFile() ? cover.sourcePath : null;
    } catch {
      source = null;
    }
    if (!source) {
      skipped.push(relPath);
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (isJpeg(source)) {
        fs.copyFileSync(source, dest);
      } else if (ffmpegPath) {
        await ffmpeg(ffmpegPath, ['-y', '-loglevel', 'error', '-i', source, '-q:v', '2', dest]);
      } else {
        // No decoder for PNG/TIFF covers: better no image than one the deck
        // shows as a black box.
        skipped.push(relPath);
        continue;
      }
      files.push(relPath);

      if (ffmpegPath) {
        await ffmpeg(ffmpegPath, [
          '-y',
          '-loglevel',
          'error',
          '-i',
          dest,
          '-vf',
          `scale=${ARTWORK_THUMB_SIZE}:${ARTWORK_THUMB_SIZE}:force_original_aspect_ratio=increase,crop=${ARTWORK_THUMB_SIZE}:${ARTWORK_THUMB_SIZE}`,
          '-q:v',
          '4',
          thumb,
        ]);
      } else {
        fs.copyFileSync(dest, thumb);
      }
      files.push(thumbRel);
    } catch (err) {
      failed.push({ relPath, reason: err.message });
    }
  }

  return { files, skipped, failed };
}
