import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getFfprobeRuntimePath, getFfmpegRuntimePath } from '../deps.js';

/**
 * Run the bundled ffprobe and return its JSON (format plus every stream).
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export function ffprobe(filePath) {
  const ffprobePath = getFfprobeRuntimePath();
  if (!fs.existsSync(ffprobePath))
    throw new Error(`ffprobe not found at ${ffprobePath} — still downloading?`);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    let out = '',
      err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));

    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(err));
      else resolve(JSON.parse(out));
    });
  });
}

/** ffmpeg codec args per output format, keyed by the extension resolveExportFormat() returns. */
const FORMAT_CODEC = {
  mp3: { args: ['-c:a', 'libmp3lame'], defaultBitrateKbps: 320, maxBitrateKbps: 320 },
  aac: { args: ['-c:a', 'aac'], defaultBitrateKbps: 256, maxBitrateKbps: 320 },
  flac: { args: ['-c:a', 'flac'] },
  wav: { args: ['-c:a', 'pcm_s16le'] },
  aiff: { args: ['-c:a', 'pcm_s16be'] },
};

/**
 * Copy srcPath to destPath via ffmpeg, optionally applying a gain adjustment,
 * a container/codec change and/or a trim range (#463, seconds).
 * destPath is always overwritten (-y). Parent directory must already exist.
 *
 * Trim uses input seeking (`-ss` before `-i`) plus an output duration cap, so
 * the copy branch stays a stream copy of the selected range (no re-encode, no
 * generation loss). Note ffmpeg disables `accurate_seek` when stream copying,
 * so a copied cut starts at the preceding packet/frame boundary (tens of
 * milliseconds for MP3/AAC) — the ANLZ data is generated from the resulting
 * file, so only the beat grid keeps the nominal trim start (#463).
 * `metadata` (optional) writes real tags into the output so the file is
 * self-describing for other software: { title, artist, album, bpm, key }.
 * BPM/key land in the container's own field (ID3 TBPM/TKEY for mp3, Vorbis
 * BPM/KEY for flac/ogg). MP4 output is handled by the caller, which edits the
 * ilst atoms directly (ffmpeg cannot write the key field there).
 *
 * Junk inherited from a container change is always dropped: a .m4a converted to
 * .mp3 used to carry `TXXX major_brand/minor_version/compatible_brands` (fields
 * of the MP4 container that mean nothing inside an MP3). Passing an empty value
 * makes ffmpeg delete the tag.
 */
const JUNK_CONTAINER_TAGS = ['major_brand', 'minor_version', 'compatible_brands'];

/**
 * Write `destPath` from `srcPath`: a stream copy whenever no gain and no format
 * change is asked for (a trim range alone is still copied), an encode otherwise.
 * @param {string} srcPath
 * @param {string} destPath - overwritten; its folder is created
 * @param {object} [opts]
 * @param {number} [opts.gainDb=0]                  gain in dB; positive gain is limited, not clipped
 * @param {number|null} [opts.sourceBitrateKbps]    bitrate cap for the encoded output
 * @param {string|null} [opts.format]               target extension: mp3, aac, flac, wav or aiff
 * @param {object|null} [opts.metadata]             title/artist/album/bpm/key to tag the output with
 * @param {number|null} [opts.trimStartSec]         seconds cut from the start
 * @param {number|null} [opts.trimEndSec]           seconds where the output ends
 * @returns {Promise<string>} destPath
 */
export function convertAudio(
  srcPath,
  destPath,
  {
    gainDb = 0,
    sourceBitrateKbps = null,
    format = null,
    metadata = null,
    trimStartSec = null,
    trimEndSec = null,
  } = {}
) {
  const ffmpegPath = getFfmpegRuntimePath();
  if (!fs.existsSync(ffmpegPath))
    throw new Error(`ffmpeg not found at ${ffmpegPath} — still downloading?`);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const start = Number.isFinite(trimStartSec) && trimStartSec > 0 ? trimStartSec : null;
  const end = Number.isFinite(trimEndSec) && trimEndSec > start ? trimEndSec : null;

  const args = ['-y'];
  if (start !== null) args.push('-ss', String(start));
  args.push('-i', srcPath);
  if (end !== null) args.push('-t', String(end - (start ?? 0)));

  if (gainDb !== 0) {
    const filter =
      gainDb > 0
        ? `volume=${gainDb.toFixed(2)}dB,alimiter=level_in=1:level_out=1:limit=1:attack=5:release=50:asc=1`
        : `volume=${gainDb.toFixed(2)}dB`;
    args.push('-filter:a', filter);
  }

  if (gainDb === 0 && !format) {
    args.push('-c', 'copy');
  } else if (format) {
    const codec = FORMAT_CODEC[format];
    if (!codec) throw new Error(`Unsupported export format: ${format}`);
    args.push('-map', '0:a:0', ...codec.args);
    if (codec.defaultBitrateKbps) {
      const bitrateKbps = Math.min(
        sourceBitrateKbps || codec.defaultBitrateKbps,
        codec.maxBitrateKbps
      );
      args.push('-b:a', `${Math.round(bitrateKbps)}k`);
    }
  } else {
    args.push('-c:v', 'copy');
    if (sourceBitrateKbps) args.push('-b:a', `${Math.round(sourceBitrateKbps)}k`);
  }

  for (const junk of JUNK_CONTAINER_TAGS) {
    args.push('-metadata', `${junk}=`);
  }

  if (metadata) {
    for (const [key, value] of Object.entries(bpmKeyMetadata(format, metadata))) {
      if (value !== null && value !== undefined && value !== '') {
        args.push('-metadata', `${key}=${value}`);
      }
    }
  }

  args.push(destPath);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim().split('\n').pop() || 'ffmpeg error'));
      else resolve(destPath);
    });
    proc.on('error', reject);
  });
}

/** ffmpeg metadata keys that carry a title/artist/album plus BPM/key per format. */
export function bpmKeyMetadata(format, { title, artist, album, bpm, key } = {}) {
  const out = {};
  if (title) out.title = title;
  if (artist) out.artist = artist;
  if (album) out.album = album;
  if (bpm == null && !key) return out;

  if (format === 'flac' || format === 'ogg' || format === 'opus') {
    if (bpm != null) out.BPM = String(Math.round(Number(bpm)));
    if (key) out.KEY = String(key);
  } else {
    if (bpm != null) out.TBPM = String(Math.round(Number(bpm)));
    if (key) out.TKEY = String(key);
  }
  return out;
}
