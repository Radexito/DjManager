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

/**
 * Copy srcPath to destPath via ffmpeg, optionally applying a gain adjustment.
 * destPath is always overwritten (-y). Parent directory must already exist.
 */
export function convertAudio(srcPath, destPath, { gainDb = 0, sourceBitrateKbps = null } = {}) {
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
  // Copy video/artwork stream unchanged; re-encode audio only when gain is applied
  if (gainDb === 0) {
    args.push('-c', 'copy');
  } else {
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
