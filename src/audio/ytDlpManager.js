/**
 * yt-dlp download manager.
 * Spawns yt-dlp to extract audio from a URL and reports progress.
 * Supports single tracks and playlists — returns an array of file results.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getYtDlpRuntimePath } from '../deps.js';

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus']);

// yt-dlp does not support LibreWolf directly; it stores cookies in Firefox-compatible
// format, so we map it to 'firefox' when building --cookies-from-browser arguments.
const BROWSER_ALIASES = { librewolf: 'firefox' };
function resolveBrowser(name) {
  return BROWSER_ALIASES[name?.toLowerCase()] ?? name;
}

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
 * Returns the best audio format for a platform.
 * Bandcamp can serve lossless → FLAC preserves it.
 * YouTube/SoundCloud are always lossy → MP3 at VBR best is smaller with no extra quality loss.
 * @param {'youtube'|'soundcloud'|'bandcamp'|'other'} platform
 * @returns {'mp3'|'flac'}
 */
function preferredAudioFormat(platform) {
  return platform === 'bandcamp' ? 'flac' : 'mp3';
}

/**
 * Extract a human-readable title from a yt-dlp output filename.
 * Example: "/tmp/djman-ytdlp/My Song [dQw4w9WgXcQ].mp3" → "My Song"
 */
function extractTitleFromFilename(filePath) {
  const base = path.basename(filePath);
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.replace(/\s*\[[^\]]{6,20}\]\s*$/, '').trim() || noExt;
}

/**
 * Fetch playlist / track metadata without downloading anything.
 * Uses --flat-playlist --dump-single-json so yt-dlp reads only the playlist
 * index page, not individual track pages — fast even for 100+ item playlists.
 *
 * @param {string} url
 * @param {{ cookiesBrowser?: string|null }} [options]
 * @returns {Promise<{ type: 'playlist'|'single', title: string|null, entries: Array<{index,id,title,url,duration}> }>}
 */
export async function fetchPlaylistInfo(url, options = {}) {
  const ytDlp = getYtDlpRuntimePath();
  if (!fs.existsSync(ytDlp)) throw new Error('yt-dlp binary not found. Please reinstall deps.');

  const platform = detectPlatform(url);
  const args = ['--flat-playlist', '--dump-single-json', '--no-warnings'];

  if (platform === 'youtube') {
    args.push('--extractor-args', 'youtube:player_client=android_vr,web');
  }
  if (options.cookiesBrowser) {
    args.push('--cookies-from-browser', resolveBrowser(options.cookiesBrowser));
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    console.log('[fetchPlaylistInfo] spawning yt-dlp with args:', args.join(' '));
    let stdout = '';
    let stderr = '';
    const proc = spawn(ytDlp, args);
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Log stderr lines to help diagnose issues
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t) console.log('[fetchPlaylistInfo] stderr:', t);
      }
    });
    proc.on('close', (code) => {
      console.log(`[fetchPlaylistInfo] process closed code=${code} stdout_len=${stdout.length}`);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      try {
        const data = JSON.parse(stdout.trim());
        const entries = Array.isArray(data.entries) ? data.entries.filter(Boolean) : null;
        if (entries && entries.length > 0) {
          resolve({
            type: 'playlist',
            title: data.title || data.playlist_title || null,
            entries: entries.map((e, i) => ({
              index: i,
              id: e.id || String(i),
              title: e.title || `Track ${i + 1}`,
              url: e.url || e.webpage_url || url,
              duration: e.duration ?? null,
            })),
          });
        } else {
          resolve({
            type: 'single',
            title: data.title || null,
            entries: [
              {
                index: 0,
                id: data.id || '0',
                title: data.title || 'Unknown Track',
                url: data.webpage_url || url,
                duration: data.duration ?? null,
              },
            ],
          });
        }
      } catch (e) {
        reject(new Error(`Failed to parse yt-dlp output: ${e.message}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Download audio from a URL using yt-dlp.
 * Supports both single tracks and playlists — always resolves with an array of file results.
 *
 * @param {string} url - The URL to download
 * @param {(data: object) => void} [onProgress] - Progress callback, receives { msg, pct, trackPct, overallCurrent, overallTotal }
 * @param {{
 *   cookiesBrowser?: string|null,
 *   onFileReady?: (file: { filePath, originalUrl, trackUrl, platform, quality, title, index }) => void,
 *   onPlaylistDetected?: (info: { name: string|null, total: number }) => void,
 *   onTrackMeta?: (info: { index: number, title: string }) => void,
 * }} [options]
 * @returns {Promise<Array<{ filePath, originalUrl, trackUrl, platform, quality, title }>>}
 */
export async function downloadUrl(url, onProgress, options = {}) {
  const ytDlp = getYtDlpRuntimePath();
  if (!fs.existsSync(ytDlp)) throw new Error('yt-dlp binary not found. Please reinstall deps.');

  const tmpDir = path.join(app.getPath('temp'), 'djman-ytdlp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  // Include video ID/index in filename to ensure uniqueness across playlist items
  const outTemplate = path.join(tmpDir, '%(title)s [%(id)s].%(ext)s');

  const platform = detectPlatform(url);
  const audioFormat = preferredAudioFormat(platform);

  // Unique marker so we can reliably identify --print output lines among other stdout noise
  const FILE_MARKER = '__YTDLP_FILE__:';

  const args = [
    '-f',
    'bestaudio/best',
    '--extract-audio',
    '--audio-format',
    audioFormat,
    '--audio-quality',
    '0',
    '--no-warnings',
    '--newline',
    '--progress-template',
    'download:[download] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s',
    // --print after_move gives us the definitive final filepath after all post-processors
    // (audio extraction, remux, etc.) have run. This is our primary file detection mechanism.
    '--print',
    `after_move:${FILE_MARKER}%(filepath)s`,
    '-o',
    outTemplate,
  ];

  if (platform === 'youtube') {
    args.push('--extractor-args', 'youtube:player_client=android_vr,web');
  }
  if (options.cookiesBrowser) {
    args.push('--cookies-from-browser', resolveBrowser(options.cookiesBrowser));
  }
  if (options.playlistItems) {
    args.push('--playlist-items', options.playlistItems);
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlp, args);
    const startTime = Date.now();

    let currentQuality = 'unknown';
    let playlistTotal = null;
    let playlistCurrent = 0;
    let playlistName = null;
    let currentTrackUrl = null;
    let currentTrackPct = 0;
    let playlistDetectedFired = false;
    let currentTrackTitle = null;
    let stderr = '';

    const destinationFiles = [];

    const fireFileReady = (filePath) => {
      if (destinationFiles.includes(filePath)) return;
      destinationFiles.push(filePath);
      const title = currentTrackTitle || extractTitleFromFilename(filePath);
      options.onFileReady?.({
        filePath,
        originalUrl: url,
        trackUrl: currentTrackUrl || url,
        platform,
        quality: currentQuality,
        title,
        index: destinationFiles.length - 1,
      });
      // Reset per-track state for the next item
      currentTrackTitle = null;
      currentTrackUrl = null;
    };

    /**
     * Process a single output line from yt-dlp (stdout or stderr).
     */
    const processLine = (trimmed) => {
      if (!trimmed) return;

      // Primary file detection: --print after_move emits FILE_MARKER:<final_path>
      if (trimmed.startsWith(FILE_MARKER)) {
        const f = trimmed.slice(FILE_MARKER.length).trim();
        if (f) fireFileReady(f);
        return;
      }

      // Download progress: [download] 42.5% of 5.20MiB at 1.20MiB/s
      const pctMatch = trimmed.match(/\[download\]\s+([\d.]+)%/);
      if (pctMatch) {
        currentTrackPct = Math.round(parseFloat(pctMatch[1]));
        const total = playlistTotal ?? 1;
        const current = playlistCurrent || 1;
        const overallPct =
          total > 1 ? Math.round(((current - 1) * 100 + currentTrackPct) / total) : currentTrackPct;
        onProgress?.({
          msg: trimmed
            .replace(/^download:/, '')
            .replace('[download] ', '')
            .trim(),
          pct: overallPct,
          trackPct: currentTrackPct,
          overallCurrent: current,
          overallTotal: total,
        });
        return;
      }

      // Playlist item counter — yt-dlp says "item" on most sites, "video" on some
      const itemMatch = trimmed.match(/Downloading (?:item|video) (\d+) of (\d+)/);
      if (itemMatch) {
        playlistCurrent = parseInt(itemMatch[1], 10);
        playlistTotal = parseInt(itemMatch[2], 10);
        currentTrackPct = 0;

        if (!playlistDetectedFired && playlistTotal > 1) {
          playlistDetectedFired = true;
          options.onPlaylistDetected?.({ name: playlistName, total: playlistTotal });
        }

        onProgress?.({
          msg: `Track ${playlistCurrent} / ${playlistTotal}`,
          pct: Math.round(((playlistCurrent - 1) / playlistTotal) * 100),
          trackPct: 0,
          overallCurrent: playlistCurrent,
          overallTotal: playlistTotal,
        });
        return;
      }

      // Playlist name
      const nameMatch = trimmed.match(/\[download\] Downloading playlist: (.+)/);
      if (nameMatch) {
        playlistName = nameMatch[1].trim();
        return;
      }

      // Individual track URL
      const extractMatch = trimmed.match(/Extracting URL: (.+)/);
      if (extractMatch) {
        currentTrackUrl = extractMatch[1].trim();
        return;
      }

      // Any Destination: line — extract title early (even from .webm), don't use for file detection
      const destMatch = trimmed.match(/\[[^\]]+\] Destination: (.+)/);
      if (destMatch) {
        const title = extractTitleFromFilename(destMatch[1].trim());
        if (!currentTrackTitle) {
          currentTrackTitle = title;
          const index = playlistCurrent > 0 ? playlistCurrent - 1 : 0;
          options.onTrackMeta?.({ index, title });
        }
        return;
      }

      // Quality info
      const qualityMatch = trimmed.match(/(\d+k(?:bps)?)/i);
      if (qualityMatch) currentQuality = qualityMatch[1];
    };

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) processLine(line.trim());
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Also scan stderr — some yt-dlp builds emit info lines there
      for (const line of text.split('\n')) processLine(line.trim());
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}:\n${stderr}`));
        return;
      }

      // Fallback A: scan tmpDir for audio files created during this session.
      // Covers yt-dlp versions that don't support --print after_move.
      if (destinationFiles.length === 0) {
        try {
          const entries = await fs.promises.readdir(tmpDir);
          for (const entry of entries) {
            const full = path.join(tmpDir, entry);
            const ext = path.extname(entry).toLowerCase();
            if (AUDIO_EXTS.has(ext) && fs.statSync(full).mtimeMs >= startTime - 5000) {
              fireFileReady(full);
            }
          }
        } catch {
          /* ignore */
        }
      }

      // Fallback B: if still nothing, try ANY file in tmpDir newer than session start
      // (catches unusual audio extensions or unconverted files).
      if (destinationFiles.length === 0) {
        try {
          const entries = await fs.promises.readdir(tmpDir);
          for (const entry of entries) {
            const full = path.join(tmpDir, entry);
            if (
              !entry.endsWith('.part') &&
              !entry.endsWith('.ytdl') &&
              fs.statSync(full).mtimeMs >= startTime - 5000
            ) {
              fireFileReady(full);
            }
          }
        } catch {
          /* ignore */
        }
      }

      if (destinationFiles.length === 0) {
        reject(new Error('yt-dlp finished but no output file found'));
        return;
      }

      resolve({
        files: destinationFiles
          .filter((f) => fs.existsSync(f))
          .map((filePath, i) => ({
            filePath,
            originalUrl: url,
            trackUrl: url,
            platform,
            quality: currentQuality,
            title: extractTitleFromFilename(filePath),
            index: i,
          })),
        playlistName: playlistName || null,
      });
    });

    proc.on('error', reject);
  });
}
