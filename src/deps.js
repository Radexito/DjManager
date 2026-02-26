/**
 * Runtime dependency downloader.
 * Downloads FFmpeg into userData/bin/ on first launch if not already present.
 */
import path from 'path';
import fs from 'fs';
import https from 'https';
import { createWriteStream } from 'fs';
import { app } from 'electron';
import { pipeline } from 'stream/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function getBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

export function getFfmpegRuntimePath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getBinDir(), `ffmpeg${ext}`);
}

export function getFfprobeRuntimePath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getBinDir(), `ffprobe${ext}`);
}

export function areDepsReady() {
  return fs.existsSync(getFfmpegRuntimePath()) && fs.existsSync(getFfprobeRuntimePath());
}

async function downloadFile(url, dest, onProgress) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'djman-dep-downloader' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const out = createWriteStream(dest);
        res.on('data', (chunk) => { received += chunk.length; onProgress?.(received, total); });
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

function getLatestRelease(owner, repo) {
  return new Promise((resolve, reject) => {
    https.get(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      { headers: { 'User-Agent': 'djman-dep-downloader', Accept: 'application/vnd.github+json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
        res.on('error', reject);
      }
    ).on('error', reject);
  });
}

async function extractTarXz(archive, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  await execAsync(`tar -xJf "${archive}" -C "${destDir}"`);
}

async function extractZip(archive, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await execAsync(`powershell -Command "Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force"`);
  } else {
    await execAsync(`unzip -q -o "${archive}" -d "${destDir}"`);
  }
}

async function findFile(dir, name) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findFile(full, name).catch(() => null);
      if (found) return found;
    } else if (e.name === name || e.name === name + '.exe') {
      return full;
    }
  }
  return null;
}

export async function ensureDeps(onProgress) {
  if (areDepsReady()) return;

  const binDir = getBinDir();
  await fs.promises.mkdir(binDir, { recursive: true });
  const tmp = path.join(app.getPath('temp'), 'djman-deps');
  await fs.promises.mkdir(tmp, { recursive: true });

  const platform = process.platform;
  const ext = platform === 'win32' ? '.exe' : '';

  onProgress?.('Downloading FFmpeg...');

  try {
    if (platform === 'linux') {
      const archive = path.join(tmp, 'ffmpeg.tar.xz');
      await downloadFile(
        'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
        archive
      );
      const extractDir = path.join(tmp, 'ffmpeg-extracted');
      await extractTarXz(archive, extractDir);
      const ffmpeg = await findFile(extractDir, 'ffmpeg');
      const ffprobe = await findFile(extractDir, 'ffprobe');
      fs.copyFileSync(ffmpeg, getFfmpegRuntimePath());
      fs.copyFileSync(ffprobe, getFfprobeRuntimePath());
      fs.chmodSync(getFfmpegRuntimePath(), 0o755);
      fs.chmodSync(getFfprobeRuntimePath(), 0o755);

    } else if (platform === 'win32') {
      const release = await getLatestRelease('BtbN', 'FFmpeg-Builds');
      const asset = release.assets.find(a => a.name.includes('win64-gpl.zip') && a.name.includes('latest'));
      const archive = path.join(tmp, 'ffmpeg-win.zip');
      await downloadFile(asset.browser_download_url, archive);
      const extractDir = path.join(tmp, 'ffmpeg-win-extracted');
      await extractZip(archive, extractDir);
      const ffmpeg = await findFile(extractDir, 'ffmpeg.exe');
      const ffprobe = await findFile(extractDir, 'ffprobe.exe');
      fs.copyFileSync(ffmpeg, getFfmpegRuntimePath());
      fs.copyFileSync(ffprobe, getFfprobeRuntimePath());

    } else if (platform === 'darwin') {
      // macOS: download from evermeet.cx static builds
      const ffmpegUrl  = 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip';
      const ffprobeUrl = 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip';
      const ffmpegZip  = path.join(tmp, 'ffmpeg-mac.zip');
      const ffprobeZip = path.join(tmp, 'ffprobe-mac.zip');
      await downloadFile(ffmpegUrl, ffmpegZip);
      await downloadFile(ffprobeUrl, ffprobeZip);
      await extractZip(ffmpegZip,  path.join(tmp, 'ffmpeg-mac'));
      await extractZip(ffprobeZip, path.join(tmp, 'ffprobe-mac'));
      const ffmpeg  = await findFile(path.join(tmp, 'ffmpeg-mac'),  'ffmpeg');
      const ffprobe = await findFile(path.join(tmp, 'ffprobe-mac'), 'ffprobe');
      fs.copyFileSync(ffmpeg,  getFfmpegRuntimePath());
      fs.copyFileSync(ffprobe, getFfprobeRuntimePath());
      fs.chmodSync(getFfmpegRuntimePath(),  0o755);
      fs.chmodSync(getFfprobeRuntimePath(), 0o755);
    }

    onProgress?.('FFmpeg ready.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
