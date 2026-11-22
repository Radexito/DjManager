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
 * A deck decodes JPEG and nothing else, and the extension lies: a cover fetched
 * from the web can be PNG bytes under a `.jpg` name, and a FLAC picture is often
 * PNG. Detection therefore reads the first bytes, every non-JPEG goes through
 * ffmpeg, and the result is checked for the JPEG signature before it counts as
 * written. A cover that cannot be turned into JPEG is reported, not published
 * as a file the player would show as a black box.
 */

/**
 * Edge of the small copy, in pixels. rekordbox keeps 240x240 and 80x80 copies
 * of every cover in its own share folder (`artwork_m.jpg`, `artwork_s.jpg`);
 * the medium takes the 240 one, square.
 */
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

/**
 * Write the covers of one export into `root` (a staging folder or a medium).
 *
 * @param {string} root folder the relative paths are resolved against
 * @param {Array<{id: number, sourcePath: string, relPath: string}>} plan from `planArtwork`
 * @param {{ffmpegPath?: string|null}} options
 * @returns {Promise<{files: string[], skipped: Array<{relPath: string, reason: string}>, failed: Array<{relPath: string, reason: string}>}>}
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

    const source = cover.sourcePath && fs.existsSync(cover.sourcePath) ? cover.sourcePath : null;
    if (!source) {
      skipped.push({ relPath, reason: 'the cover file is gone' });
      continue;
    }

    try {
      const isJpegSource = looksLikeJpeg(readHead(source));
      if (!isJpegSource && !ffmpegPath) {
        skipped.push({ relPath, reason: 'not a JPEG and no decoder is installed' });
        continue;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (isJpegSource) {
        fs.copyFileSync(source, dest);
      } else {
        await ffmpeg(ffmpegPath, ['-y', '-loglevel', 'error', '-i', source, '-q:v', '2', dest]);
        if (!readJpegOrNull(dest)) {
          fs.rmSync(dest, { force: true });
          failed.push({ relPath, reason: 'the decoder produced no JPEG' });
          continue;
        }
      }
      files.push(relPath);

      let thumbOk = false;
      if (ffmpegPath) {
        try {
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
          thumbOk = Boolean(readJpegOrNull(thumb));
        } catch {
          thumbOk = false;
        }
      }
      if (!thumbOk) {
        // A full-size twin still loads; a missing `_m` leaves the list blank.
        fs.copyFileSync(dest, thumb);
      }
      files.push(thumbRel);
    } catch (err) {
      failed.push({ relPath, reason: err.message });
    }
  }

  return { files, skipped, failed };
}
