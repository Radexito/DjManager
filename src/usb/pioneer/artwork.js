import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Covers on a Pioneer medium.
 *
 * rekordbox writes two renditions of every cover, and their names are the
 * opposite of what they look like: `a<id>.jpg` is the 80x80 copy and
 * `a<id>_m.jpg` is the 240x240 one. Both were measured on a live rekordbox
 * 7.2.19 export (2026-11-22), and they match the `artwork_s.jpg` (80x80) and
 * `artwork_m.jpg` (240x240) renditions rekordbox keeps in its own share folder.
 *
 * The PDB points only at `a<id>.jpg` (`/PIONEER/Artwork/00001/a1.jpg`); the `_m`
 * name is a convention the player follows on its own, so both have to exist.
 *
 * A deck decodes JPEG and nothing else, and the extension lies: a cover fetched
 * from the web can be PNG bytes under a `.jpg` name, and a FLAC picture is often
 * PNG. Detection therefore reads the first bytes, every cover goes through
 * ffmpeg to the two sizes, and the result is checked for the JPEG signature
 * before it counts as written. A cover that cannot be turned into JPEG is
 * reported, not published as a file the player would show as a black box.
 *
 * Both renditions are cut from the source cover, each in a single step. The
 * 240 px copy must not be an enlargement of the 80 px one: that produces a file
 * with the right dimensions and no detail beyond 80 px (measured on one cover,
 * edge energy 0.017 against 0.062 for the same 240 px cut from the source).
 */

/** Edge of `a<id>.jpg`, the copy rekordbox calls `artwork_s`. */
export const ARTWORK_SIZE = 80;

/** Edge of `a<id>_m.jpg`, the copy rekordbox calls `artwork_m`. */
export const ARTWORK_THUMB_SIZE = 240;

/** @param {Buffer} head first bytes of a file */
export function looksLikeJpeg(head) {
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

function readHead(filePath, bytes = 16) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function readJpegOrNull(filePath) {
  try {
    if (!fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0) return null;
    return looksLikeJpeg(readHead(filePath)) ? filePath : null;
  } catch {
    return null;
  }
}

async function ffmpeg(ffmpegPath, args) {
  await execFileAsync(ffmpegPath, args, { windowsHide: true, timeout: 60_000 });
}

/** Scale and centre-crop to a square of `size` pixels. */
function squareArgs(source, size, dest) {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    source,
    '-vf',
    `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`,
    '-q:v',
    size <= ARTWORK_SIZE ? '3' : '4',
    dest,
  ];
}

/**
 * Write the covers of one export into `root` (a staging folder or a medium).
 *
 * @param {string} root folder the relative paths are resolved against
 * @param {Array<{id: number, sourcePath: string, relPath: string}>} plan from `planArtwork`
 * @param {{ffmpegPath?: string|null}} options
 * @returns {Promise<{files: string[], skipped: Array<{relPath: string, reason: string}>, failed: Array<{relPath: string, reason: string}>, notes: string[]}>}
 *   `files` are the relative paths that now exist under `root`, 80 px and 240 px
 */
export async function writeArtworkFiles(root, plan = [], { ffmpegPath = null } = {}) {
  const files = [];
  const skipped = [];
  const failed = [];
  const notes = [];

  for (const cover of plan) {
    const relPath = String(cover.relPath || '').replace(/^\/+/, '');
    if (!relPath) continue;
    const smallRel = relPath;
    const thumbRel = relPath.replace(/\.jpg$/, '_m.jpg');
    const small = path.join(root, ...smallRel.split('/'));
    const thumb = path.join(root, ...thumbRel.split('/'));

    const source = cover.sourcePath && fs.existsSync(cover.sourcePath) ? cover.sourcePath : null;
    if (!source) {
      skipped.push({ relPath, reason: 'the cover file is gone' });
      continue;
    }

    try {
      const isJpegSource = looksLikeJpeg(readHead(source));
      fs.mkdirSync(path.dirname(small), { recursive: true });

      if (!ffmpegPath) {
        // Without a decoder nothing can be resized. A JPEG can still be copied:
        // the deck scales it, the sizes just do not match rekordbox. A PNG has
        // no chance at all, and publishing one would be a black box on the deck.
        if (!isJpegSource) {
          skipped.push({ relPath, reason: 'not a JPEG and no decoder is installed' });
          continue;
        }
        fs.copyFileSync(source, small);
        fs.copyFileSync(source, thumb);
        files.push(smallRel, thumbRel);
        notes.push(`${relPath}: written at the source size, not 80/240 (no decoder)`);
        continue;
      }

      await ffmpeg(ffmpegPath, squareArgs(source, ARTWORK_SIZE, small));
      if (!readJpegOrNull(small)) {
        fs.rmSync(small, { force: true });
        failed.push({ relPath, reason: 'the decoder produced no JPEG' });
        continue;
      }
      files.push(smallRel);

      try {
        await ffmpeg(ffmpegPath, squareArgs(source, ARTWORK_THUMB_SIZE, thumb));
      } catch {
        // handled by the check below
      }
      if (!readJpegOrNull(thumb)) {
        // A small twin that is a copy of the 80 px file still loads, and a
        // missing `_m` would leave the player's list blank.
        fs.copyFileSync(small, thumb);
        notes.push(`${thumbRel}: copied from the 80 px file (the 240 px rendition failed)`);
      }
      files.push(thumbRel);
    } catch (err) {
      failed.push({ relPath, reason: err.message });
    }
  }

  return { files, skipped, failed, notes };
}
