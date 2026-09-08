import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getFfprobeRuntimePath, getFfmpegRuntimePath } from '../deps.js';

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
 * Copy srcPath to destPath via ffmpeg, optionally applying a gain adjustment
 * and/or converting to a different output format/codec.
 * destPath is always overwritten (-y). Parent directory must already exist.
 */
export function convertAudio(
  srcPath,
  destPath,
  { gainDb = 0, sourceBitrateKbps = null, format = null } = {}
) {
  const ffmpegPath = getFfmpegRuntimePath();
  if (!fs.existsSync(ffmpegPath))
    throw new Error(`ffmpeg not found at ${ffmpegPath} — still downloading?`);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const args = ['-y', '-i', srcPath];
  if (gainDb !== 0) {
    // Positive gain can push peaks above 0 dBFS — chain a true-peak limiter to prevent
    // clipping in the output file. alimiter is a no-op when all peaks stay below the limit.
    const filter =
      gainDb > 0
        ? `volume=${gainDb.toFixed(2)}dB,alimiter=level_in=1:level_out=1:limit=1:attack=5:release=50:asc=1`
        : `volume=${gainDb.toFixed(2)}dB`;
    args.push('-filter:a', filter);
  }

  if (gainDb === 0 && !format) {
    // No gain change, no format change — byte-identical copy.
    args.push('-c', 'copy');
  } else if (format) {
    const codec = FORMAT_CODEC[format];
    if (!codec) throw new Error(`Unsupported export format: ${format}`);
    // Changing container/codec — only carry the primary audio stream. Embedded
    // artwork (an attached-pic video stream) isn't preserved across format conversion.
    args.push('-map', '0:a:0', ...codec.args);
    if (codec.defaultBitrateKbps) {
      const bitrateKbps = Math.min(
        sourceBitrateKbps || codec.defaultBitrateKbps,
        codec.maxBitrateKbps
      );
      args.push('-b:a', `${Math.round(bitrateKbps)}k`);
    }
  } else {
    // Gain change only — copy video/artwork stream unchanged, re-encode audio.
    args.push('-c:v', 'copy');
    // Preserve source bitrate to avoid silent quality downgrade (ffmpeg default is 128 kbps)
    if (sourceBitrateKbps) args.push('-b:a', `${Math.round(sourceBitrateKbps)}k`);
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
