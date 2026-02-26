import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import { getFfmpegRuntimePath, getFfprobeRuntimePath } from '../deps.js';

export function getFfmpegPath() {
  const p = getFfmpegRuntimePath();
  if (!fs.existsSync(p)) throw new Error(`FFmpeg not found at ${p} — still downloading?`);
  return p;
}

export function ffprobe(filePath) {
  const ffprobePath = getFfprobeRuntimePath();
  if (!fs.existsSync(ffprobePath)) throw new Error(`ffprobe not found at ${ffprobePath} — still downloading?`);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);

    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);

    proc.on('close', code => {
      if (code !== 0) reject(new Error(err));
      else resolve(JSON.parse(out));
    });
  });
}
