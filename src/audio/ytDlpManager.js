/**
 * yt-dlp download manager.
 * Spawns yt-dlp to extract audio from a URL and reports progress.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getYtDlpRuntimePath } from '../deps.js';

/**
 * Detect the platform/service from a URL.
 * @param {string} url
 * @returns {'youtube'|'soundcloud'|'bandcamp'|'other'}
 */
export function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('soundcloud.com')) return 'soundcloud';
    if (host.includes('bandcamp.com')) return 'bandcamp';
  } catch {
    // invalid URL — fall through
  }
  return 'other';
}

/**
 * Download audio from a URL using yt-dlp.
 *
 * @param {string} url - The URL to download
 * @param {(msg: string, pct: number) => void} [onProgress] - Progress callback
 * @returns {Promise<{ filePath: string, originalUrl: string, platform: string, quality: string }>}
 */
export async function downloadUrl(url, onProgress) {
  const ytDlp = getYtDlpRuntimePath();
  if (!fs.existsSync(ytDlp)) throw new Error('yt-dlp binary not found. Please reinstall deps.');

  const tmpDir = path.join(app.getPath('temp'), 'djman-ytdlp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  // Use %(title)s.%(ext)s so yt-dlp names the file after the track title
  const outTemplate = path.join(tmpDir, '%(title)s.%(ext)s');

  const platform = detectPlatform(url);

  const args = [
    '--extract-audio',
    '--audio-format',
    'm4a',
    '--audio-quality',
    '0', // best quality
    '--no-playlist',
    '--no-warnings',
    '--newline', // one progress line per \n for easier parsing
    '--progress-template',
    'download:[download] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s',
    '-o',
    outTemplate,
    url,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlp, args);

    let lastFile = null;
    let quality = 'unknown';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse download progress: [download] 42.5% of 5.20MiB at 1.20MiB/s
        const pctMatch = trimmed.match(/\[download\]\s+([\d.]+)%/);
        if (pctMatch) {
          const pct = parseFloat(pctMatch[1]);
          onProgress?.(trimmed.replace('[download] ', ''), Math.round(pct));
        }

        // Capture destination filename written by yt-dlp
        const destMatch = trimmed.match(/\[(?:ExtractAudio|Merger|ffmpeg)\] Destination: (.+)/);
        if (destMatch) lastFile = destMatch[1].trim();

        // Capture audio bitrate/quality info
        const qualityMatch = trimmed.match(/(\d+k(?:bps)?)/i);
        if (qualityMatch) quality = qualityMatch[1];
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}:\n${stderr}`));
        return;
      }

      // If we didn't capture the destination via log, find the newest file in tmpDir
      if (!lastFile) {
        try {
          const entries = await fs.promises.readdir(tmpDir);
          const files = entries
            .map((f) => ({ name: f, mtime: fs.statSync(path.join(tmpDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length) lastFile = path.join(tmpDir, files[0].name);
        } catch {
          // ignore
        }
      }

      if (!lastFile || !fs.existsSync(lastFile)) {
        reject(new Error('yt-dlp finished but no output file found'));
        return;
      }

      resolve({
        filePath: lastFile,
        originalUrl: url,
        platform,
        quality,
      });
    });

    proc.on('error', reject);
  });
}
