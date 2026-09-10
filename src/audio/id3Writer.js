import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { getFfmpegRuntimePath } from '../deps.js';
import { ffprobe as runFfprobe } from './ffmpeg.js';
import { supportsMp4Tags, readMp4Tags, writeMp4Tags } from './mp4Tags.js';

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

// #474 — containers that accept plain, widely readable BPM/key tag names.
//   MP3          → ID3v2 frames TBPM (tempo) / TKEY (initial key)
//   FLAC/OGG/Opus → Vorbis comments BPM / KEY (Picard / Mixed In Key convention)
// M4A/WAV/AIFF are deliberately NOT supported: they have no interoperable slot
// (ffmpeg would write a non-standard atom other apps ignore), and rewriting a
// WAV/AIFF header for tags is not worth the risk.
const BPM_KEY_FIELDS = {
  '.mp3': { bpm: 'TBPM', key: 'TKEY' },
  '.flac': { bpm: 'BPM', key: 'KEY' },
  '.ogg': { bpm: 'BPM', key: 'KEY' },
  '.oga': { bpm: 'BPM', key: 'KEY' },
  '.opus': { bpm: 'BPM', key: 'KEY' },
};

// Tag names seen in the wild for BPM/key, across ID3 + Vorbis conventions.
const BPM_TAG_NAMES = ['bpm', 'BPM', 'TBPM', 'tbpm'];
const KEY_TAG_NAMES = ['key', 'KEY', 'initialkey', 'INITIALKEY', 'TKEY', 'tkey'];

/** True when the file's container can carry BPM/key tags (#474). */
export function supportsBpmKeyTags(filePath) {
  // MP4 goes through the atom writer, not ffmpeg, but it is supported.
  if (supportsMp4Tags(filePath)) return true;
  return Boolean(BPM_KEY_FIELDS[path.extname(filePath ?? '').toLowerCase()]);
}

/** Pick the first present tag value from a tags object (case-tolerant). */
function pickTag(tags, names) {
  for (const name of names) {
    const value = tags?.[name];
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

/**
 * Read the BPM/key tags already present in a file.
 * @returns {Promise<{ bpm: string|null, key: string|null }>}
 */
export async function readBpmKeyTags(filePath) {
  const data = await runFfprobe(filePath);
  const tags = data?.format?.tags || {};
  return { bpm: pickTag(tags, BPM_TAG_NAMES), key: pickTag(tags, KEY_TAG_NAMES) };
}

/**
 * ffmpeg metadata write through a temp file + atomic rename. `-map_metadata 0`
 * keeps every existing tag; only the passed keys are overridden. The temp file
 * is always cleaned up, so a failure can never corrupt the original.
 *
 * MP4 container fields that leaked into the tag as `TXXX major_brand` /
 * `minor_version` / `compatible_brands` (they arrive whenever an m4a is turned
 * into an mp3) are deleted instead of copied forward: ffmpeg removes a tag when
 * it is given an empty value.
 */
const JUNK_CONTAINER_TAGS = ['major_brand', 'minor_version', 'compatible_brands'];

async function runMetadataWrite(filePath, metadataArgs) {
  const ffmpeg = getFfmpegRuntimePath();
  if (!fs.existsSync(ffmpeg)) throw new Error('ffmpeg binary not found');

  const ext = path.extname(filePath);
  const tmp = `${filePath}.id3tmp${ext}`;
  try {
    await execFileAsync(ffmpeg, [
      '-y',
      '-i',
      filePath,
      '-map_metadata',
      '0',
      ...JUNK_CONTAINER_TAGS.flatMap((tag) => ['-metadata', `${tag}=`]),
      ...metadataArgs,
      '-codec',
      'copy',
      tmp,
    ]);
    fs.renameSync(tmp, filePath);
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

/**
 * Write metadata tags back to the audio file using ffmpeg.
 * Uses a temp-file + atomic rename to avoid corrupting the original.
 * @param {string} filePath  Absolute path to the audio file.
 * @param {object} tags      Subset of DB track fields to write.
 */
export async function writeId3Tags(filePath, tags) {
  if (!filePath || !fs.existsSync(filePath)) return;

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

  try {
    await runMetadataWrite(filePath, metadataArgs);
  } catch (err) {
    console.error('[id3Writer] failed to write tags:', err.message);
  }
}

/**
 * #474 — write the analyzed BPM/key into the file's own tags.
 *
 * Only containers with interoperable slots are written (MP3, FLAC, OGG/Opus).
 * With `overwrite: false` a tag that is already present is left alone (fill
 * missing only); values identical to what is already there are never rewritten,
 * so re-analysis does not churn files.
 *
 * @param {string} filePath
 * @param {{ bpm?: number|string|null, key?: string|null, overwrite?: boolean }} opts
 * @returns {Promise<{ ok: boolean, reason?: string, wrote?: string[], error?: string }>}
 */
export async function writeBpmKeyTags(
  filePath,
  { bpm = null, key = null, overwrite = false } = {}
) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'missing-file' };

  const bpmValue =
    bpm == null || bpm === '' || !Number.isFinite(Number(bpm))
      ? null
      : String(Math.round(Number(bpm)));
  const keyValue = key == null || String(key).trim() === '' ? null : String(key).trim();
  if (bpmValue == null && keyValue == null) return { ok: false, reason: 'no-values' };

  // MP4 (.m4a/.mp4) has no ffmpeg-writable key field — edit the atoms ourselves.
  if (supportsMp4Tags(filePath)) {
    return writeMp4BpmKeyTags(filePath, { bpm: bpmValue, key: keyValue, overwrite });
  }

  const fields = BPM_KEY_FIELDS[path.extname(filePath).toLowerCase()];
  if (!fields) return { ok: false, reason: 'unsupported-format' };

  // Existing tags decide whether anything is left to do.
  let existing = { bpm: null, key: null };
  try {
    existing = await readBpmKeyTags(filePath);
  } catch (err) {
    // Unreadable tags: treat as absent (overwrite policy then applies).
    if (!overwrite) return { ok: false, reason: 'unreadable-tags', error: err.message };
  }

  const wantsBpm = bpmValue != null && !bpmTagIsCurrent(existing.bpm, bpmValue, overwrite);
  const wantsKey = keyValue != null && !keyTagIsCurrent(existing.key, keyValue, overwrite);
  if (!wantsBpm && !wantsKey) return { ok: true, reason: 'already-current', wrote: [] };

  const metadataArgs = [];
  const wrote = [];
  if (wantsBpm) {
    metadataArgs.push('-metadata', `${fields.bpm}=${bpmValue}`);
    wrote.push('bpm');
  }
  if (wantsKey) {
    metadataArgs.push('-metadata', `${fields.key}=${keyValue}`);
    wrote.push('key');
  }

  try {
    await runMetadataWrite(filePath, metadataArgs);
  } catch (err) {
    return { ok: false, reason: 'write-failed', error: err.message };
  }
  return { ok: true, wrote };
}

/** A BPM tag is left alone when present (fill-missing) or equal (overwrite). */
function bpmTagIsCurrent(existing, value, overwrite) {
  if (existing == null) return false;
  const a = Number(existing);
  const b = Number(value);
  const equal =
    Number.isFinite(a) && Number.isFinite(b)
      ? a === b
      : String(existing).trim() === String(value).trim();
  return overwrite ? equal : true;
}

/** A key tag is left alone when present (fill-missing) or equal (overwrite). */
function keyTagIsCurrent(existing, value, overwrite) {
  if (existing == null) return false;
  return overwrite ? String(existing).toLowerCase() === String(value).toLowerCase() : true;
}

/**
 * #474 — BPM/key into an .m4a/.mp4 by editing the `ilst` atoms ourselves
 * (`tmpo` + a freeform `INITIALKEY` item). Same fill-missing / overwrite policy
 * as the ffmpeg path; nothing else in the file is touched.
 *
 * @param {string} filePath
 * @param {{ bpm?: number|string|null, key?: string|null, overwrite?: boolean }} opts
 * @returns {{ ok: boolean, reason?: string, wrote?: string[], error?: string }}
 */
export function writeMp4BpmKeyTags(filePath, { bpm = null, key = null, overwrite = false } = {}) {
  let existing = { bpm: null, key: null };
  try {
    existing = readMp4Tags(fs.readFileSync(filePath));
  } catch (err) {
    if (!overwrite) return { ok: false, reason: 'unreadable-tags', error: err.message };
  }

  const wantsBpm = bpm != null && !bpmTagIsCurrent(existing.bpm, bpm, overwrite);
  const wantsKey = key != null && !keyTagIsCurrent(existing.key, key, overwrite);
  if (!wantsBpm && !wantsKey) return { ok: true, reason: 'already-current', wrote: [] };

  const res = writeMp4Tags(filePath, {
    bpm: wantsBpm ? Math.round(Number(bpm)) : null,
    key: wantsKey ? key : null,
  });
  if (!res.ok) return { ok: false, reason: res.reason, error: res.error };
  return { ok: true, wrote: [wantsBpm ? 'bpm' : null, wantsKey ? 'key' : null].filter(Boolean) };
}
