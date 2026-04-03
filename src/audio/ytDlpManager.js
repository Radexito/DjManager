/**
 * yt-dlp download manager.
 * Spawns yt-dlp to extract audio from a URL and reports progress.
 * Supports single tracks and playlists — returns an array of file results.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getYtDlpRuntimePath, getFfmpegRuntimePath } from '../deps.js';

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus']);

// yt-dlp does not support LibreWolf directly. LibreWolf stores cookies in
// Firefox-compatible format, so we resolve it to `firefox:/path/to/profile`.
// We search the known base directories for a profiles.ini and extract the default
// profile path, then pass it explicitly to avoid yt-dlp searching Firefox locations.

const LIBREWOLF_BASE_DIRS = [
  // Native / AUR install
  `${process.env.HOME}/.librewolf`,
  // Flatpak (most common on Linux desktops)
  `${process.env.HOME}/.var/app/io.gitlab.librewolf-community/.librewolf`,
];

function findLibreWolfProfile() {
  for (const baseDir of LIBREWOLF_BASE_DIRS) {
    if (!fs.existsSync(baseDir)) continue;
    const iniPath = path.join(baseDir, 'profiles.ini');
    if (!fs.existsSync(iniPath)) continue;

    try {
      const ini = fs.readFileSync(iniPath, 'utf8');

      // Prefer the profile referenced by [Install…] Default= (last-used install default)
      const installMatch = ini.match(/^\[Install[^\]]*\][^[]*Default=(.+)$/m);
      if (installMatch) {
        const candidate = path.join(baseDir, installMatch[1].trim());
        if (fs.existsSync(candidate)) return candidate;
      }

      // Fallback: first [ProfileN] section with Default=1
      const blocks = ini.split(/(?=\[Profile\d)/);
      for (const block of blocks) {
        if (!/Default\s*=\s*1/i.test(block)) continue;
        const pathMatch = block.match(/^Path=(.+)$/m);
        const isRelative = /IsRelative\s*=\s*1/i.test(block);
        if (pathMatch) {
          const profilePath = isRelative
            ? path.join(baseDir, pathMatch[1].trim())
            : pathMatch[1].trim();
          if (fs.existsSync(profilePath)) return profilePath;
        }
      }

      // Last resort: first directory that looks like a profile
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      const dir = entries.find(
        (e) => e.isDirectory() && (e.name.includes('default') || e.name.includes('.'))
      );
      if (dir) {
        const p = path.join(baseDir, dir.name);
        if (fs.existsSync(path.join(p, 'cookies.sqlite'))) return p;
      }
    } catch {
      // malformed ini or permission error — try next base dir
    }
  }
  return null;
}

function resolveBrowser(name) {
  if (name?.toLowerCase() === 'librewolf') {
    const profile = findLibreWolfProfile();
    if (profile) {
      console.log('[ytdlp] LibreWolf profile resolved to:', profile);
      return `firefox:${profile}`;
    }
    console.warn('[ytdlp] LibreWolf profile not found, falling back to firefox');
    return 'firefox';
  }
  return name;
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
/** Returns true when yt-dlp fails because no format matched (EJS/cookie issue). */
function isFormatUnavailableError(err) {
  return err?.message?.includes('Requested format is not available');
}

export async function fetchPlaylistInfo(url, options = {}) {
  try {
    const info = await _fetchPlaylistInfoOnce(url, options);
    // For YouTube playlists, do a fast parallel oEmbed availability check so
    // unavailable/private/deleted videos are flagged before the selection screen.
    if (detectPlatform(url) === 'youtube' && info.type === 'playlist') {
      await checkYouTubeAvailability(info.entries);
    }
    return info;
  } catch (err) {
    if (isFormatUnavailableError(err) && options.cookiesBrowser) {
      console.warn(
        '[ytdlp] fetchPlaylistInfo: format unavailable with cookies (EJS solver), retrying without cookies'
      );
      return _fetchPlaylistInfoOnce(url, { ...options, cookiesBrowser: null });
    }
    throw err;
  }
}

const YTDLP_CHECK_CONCURRENCY = 16;
const YTDLP_CHECK_TIMEOUT_MS = 15000;
// Availability values from yt-dlp that mean the video cannot be downloaded
const UNAVAILABLE_STATUSES = new Set(['private', 'premium_only', 'subscriber_only', 'needs_auth']);

/**
 * Batch-check YouTube video availability by running yt-dlp --print availability
 * for each entry. This is the most reliable approach since it uses the exact same
 * mechanism as the actual download. Mutates entries in-place.
 */
async function checkYouTubeAvailability(entries) {
  const toCheck = entries.filter((e) => !e.unavailable && e.id);
  if (toCheck.length === 0) return;

  const ytDlp = getYtDlpRuntimePath();
  if (!fs.existsSync(ytDlp)) return; // binary not ready yet — skip check

  console.log(`[ytdlp] availability check for ${toCheck.length} entries via yt-dlp…`);

  async function checkOne(entry) {
    return new Promise((resolve) => {
      const args = [
        '--no-playlist',
        '--print',
        'availability',
        '--no-warnings',
        '--extractor-args',
        'youtube:player_client=web',
        `https://www.youtube.com/watch?v=${entry.id}`,
      ];
      const proc = spawn(ytDlp, args);
      let stdout = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        resolve(); // timeout → assume available
      }, YTDLP_CHECK_TIMEOUT_MS);

      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        const availability = stdout.trim().toLowerCase();
        console.log(`[ytdlp] ${entry.id} availability=${availability || '(exit ' + code + ')'}`);
        if (
          code !== 0 ||
          UNAVAILABLE_STATUSES.has(availability) ||
          availability === 'unavailable'
        ) {
          entry.unavailable = true;
          entry.unavailableReason =
            availability === 'private'
              ? 'Private video'
              : availability === 'premium_only'
                ? 'YouTube Premium only'
                : 'Video unavailable';
        }
        resolve();
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(); // spawn error → assume available
      });
    });
  }

  const queue = [...toCheck];

  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift();
      await checkOne(entry);
    }
  }

  await Promise.allSettled(Array.from({ length: YTDLP_CHECK_CONCURRENCY }, worker));
  const unavailCount = entries.filter((e) => e.unavailable).length;
  console.log(`[ytdlp] availability check done — ${unavailCount}/${entries.length} unavailable`);
}

const UNAVAILABLE_TITLE_RE = /^\[(Private|Deleted|Unavailable|Removed)\s*(video|track)?\]$/i;

const UNAVAILABLE_AVAILABILITY = new Set([
  'private',
  'premium_only',
  'subscriber_only',
  'needs_auth',
  'exclusive_content',
]);

function isEntryUnavailable(entry) {
  if (UNAVAILABLE_AVAILABILITY.has(entry.availability)) return true;
  if (entry.title && UNAVAILABLE_TITLE_RE.test(entry.title.trim())) return true;
  return false;
}

function describeUnavailability(entry) {
  if (entry.availability === 'private') return 'Private video';
  if (entry.availability === 'premium_only') return 'YouTube Premium only';
  if (entry.availability === 'subscriber_only') return 'Channel members only';
  if (entry.availability === 'needs_auth') return 'Sign-in required';
  if (entry.availability === 'exclusive_content') return 'Exclusive content';
  if (entry.title && UNAVAILABLE_TITLE_RE.test(entry.title.trim())) {
    const m = entry.title.match(UNAVAILABLE_TITLE_RE);
    return `${m[1]} video`;
  }
  return 'Unavailable';
}

function _fetchPlaylistInfoOnce(url, options = {}) {
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
            entries: entries.map((e, i) => {
              const unavailable = isEntryUnavailable(e);
              return {
                index: i,
                id: e.id || String(i),
                title: e.title || `Track ${i + 1}`,
                url: e.url || e.webpage_url || url,
                duration: e.duration ?? null,
                unavailable,
                unavailableReason: unavailable ? describeUnavailability(e) : null,
              };
            }),
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
  try {
    return await _downloadUrlOnce(url, onProgress, options);
  } catch (err) {
    if (isFormatUnavailableError(err) && options.cookiesBrowser) {
      console.warn(
        '[ytdlp] downloadUrl: format unavailable with cookies (EJS solver), retrying without cookies'
      );
      return _downloadUrlOnce(url, onProgress, { ...options, cookiesBrowser: null });
    }
    throw err;
  }
}

async function _downloadUrlOnce(url, onProgress, options = {}) {
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
    // Prefer m4a (returned by android_vr client), then webm/opus, then any audio-only,
    // then fall back to best available so we never get "Requested format is not available".
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
    '--extract-audio',
    '--audio-format',
    audioFormat,
    '--audio-quality',
    '0',
    '--no-warnings',
    '--newline',
    '--ignore-errors', // skip unavailable/deleted/restricted videos instead of aborting
    '--progress-template',
    'download:[download] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s',
    // --print after_move gives us the definitive final filepath after all post-processors
    // (audio extraction, remux, etc.) have run. This is our primary file detection mechanism.
    '--print',
    `after_move:${FILE_MARKER}%(filepath)s`,
    '-o',
    outTemplate,
  ];

  // Tell yt-dlp where to find the bundled ffmpeg so post-processing works
  args.push('--ffmpeg-location', path.dirname(getFfmpegRuntimePath()));

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

    let unavailableCount = 0;

    proc.on('close', async (code) => {
      // Parse unavailable/error videos from stderr and fire callbacks.
      // With --ignore-errors, yt-dlp may emit these as WARNING: lines instead of ERROR:.
      const unavailablePattern = /(?:ERROR|WARNING): \[[\w:]+\] ([^:\s][^:]*): (.+)/g;
      let match;
      while ((match = unavailablePattern.exec(stderr)) !== null) {
        const videoId = match[1].trim();
        const reason = match[2].trim();
        // Only fire for actual unavailability reasons, not generic yt-dlp messages
        if (
          reason.toLowerCase().includes('unavailable') ||
          reason.toLowerCase().includes('private') ||
          reason.toLowerCase().includes('deleted') ||
          reason.toLowerCase().includes('removed') ||
          reason.toLowerCase().includes('not available')
        ) {
          console.warn(`[ytdlp] unavailable: ${videoId} — ${reason}`);
          options.onTrackUnavailable?.({ videoId, reason });
          unavailableCount++;
        }
      }

      // Secondary heuristic: if stderr mentions unavailability but regex found nothing,
      // treat it as an all-unavailable run so we don't show a raw error.
      const stderrHasUnavailable =
        unavailableCount === 0 &&
        (stderr.includes('Video unavailable') ||
          stderr.includes('Private video') ||
          stderr.includes('Deleted video') ||
          stderr.includes('This video is not available'));
      if (stderrHasUnavailable) unavailableCount = 1; // sentinel — at least one unavailable

      // Exit code 1 with --ignore-errors means some videos failed. If ALL failures were
      // unavailability errors (already reported via onTrackUnavailable), resolve gracefully
      // so the UI can show per-track ✗ marks rather than a raw error string.
      if (code !== 0 && destinationFiles.length === 0 && unavailableCount === 0) {
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

      if (destinationFiles.length === 0 && unavailableCount === 0) {
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
        unavailableCount,
      });
    });

    proc.on('error', reject);
  });
}
