import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { getFfmpegRuntimePath } from '../deps.js';

const execFileAsync = promisify(execFile);

// Map DB field names → ID3/Vorbis tag names used by ffmpeg
const TAG_MAP = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  year: 'date',
  label: 'label',
  comments: 'comment',
};

/**
 * Write metadata tags back to the audio file using ffmpeg.
 * Uses a temp-file + atomic rename to avoid corrupting the original.
 * @param {string} filePath  Absolute path to the audio file.
 * @param {object} tags      Subset of DB track fields to write.
 */
export async function writeId3Tags(filePath, tags) {
  if (!filePath || !fs.existsSync(filePath)) return;

  const ffmpeg = getFfmpegRuntimePath();
  if (!fs.existsSync(ffmpeg)) return; // deps not ready yet

  const metadataArgs = [];

  for (const [field, tagName] of Object.entries(TAG_MAP)) {
    if (tags[field] == null) continue;
    metadataArgs.push('-metadata', `${tagName}=${tags[field]}`);
  }

  // genres stored as JSON array → comma-separated string
  if (tags.genres != null) {
    try {
      const genreStr = JSON.parse(tags.genres).join(', ');
      metadataArgs.push('-metadata', `genre=${genreStr}`);
    } catch {
      metadataArgs.push('-metadata', `genre=${tags.genres}`);
    }
  }

  if (metadataArgs.length === 0) return;

  const ext = path.extname(filePath);
  const tmp = `${filePath}.id3tmp${ext}`;
  try {
    await execFileAsync(ffmpeg, [
      '-y',
      '-i',
      filePath,
      '-map_metadata',
      '0',
      ...metadataArgs,
      '-codec',
      'copy',
      tmp,
    ]);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[id3Writer] failed to write tags:', err.message);
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}
