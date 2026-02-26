import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import { getFfmpegRuntimePath, getFfprobeRuntimePath } from '../deps.js';

const ext = process.platform === 'win32' ? '.exe' : '';

function resolveFFmpeg() {
  // Dev: prefer project-local ffmpeg/ dir
  if (!app.isPackaged) {
    const dev = path.join(process.cwd(), 'ffmpeg', `ffmpeg${ext}`);
    if (fs.existsSync(dev)) return dev;
  }
  return getFfmpegRuntimePath();
}

function resolveFFprobe() {
  if (!app.isPackaged) {
    const dev = path.join(process.cwd(), 'ffmpeg', `ffprobe${ext}`);
    if (fs.existsSync(dev)) return dev;
  }
  return getFfprobeRuntimePath();
}

export function getFfmpegPath() {
  const p = resolveFFmpeg();
  if (!fs.existsSync(p)) throw new Error(`FFmpeg not found at ${p}`);
  return p;
}

export function ffprobe(filePath) {
  const ffprobePath = resolveFFprobe();
  if (!fs.existsSync(ffprobePath)) throw new Error(`ffprobe not found at ${ffprobePath}`);
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
