/**
 * yt-dlp download manager.
 * Spawns yt-dlp to extract audio from a URL and reports progress.
 * Supports single tracks and playlists — returns an array of file results.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { app } from 'electron';
import { getYtDlpRuntimePath, getFfmpegRuntimePath } from '../deps.js';

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus']);

const LIBREWOLF_BASE_DIRS = [
  `${process.env.HOME}/.config/librewolf`,
  `${process.env.HOME}/.config/librewolf/librewolf`,
  `${process.env.HOME}/.librewolf`,
  `${process.env.HOME}/.var/app/io.gitlab.librewolf-community/.librewolf`,
];

/**
 * Locate LibreWolf's cookie profile: the Default= entry of profiles.ini, else the
 * profile marked default, else the first folder that holds a cookies.sqlite.
 * @returns {string|null} profile directory, or null when LibreWolf is not installed
 */
function findLibreWolfProfile() {
  for (const baseDir of LIBREWOLF_BASE_DIRS) {
    if (!fs.existsSync(baseDir)) continue;
    const iniPath = path.join(baseDir, 'profiles.ini');
    if (!fs.existsSync(iniPath)) continue;

    try {
      const ini = fs.readFileSync(iniPath, 'utf8');

      const installMatch = ini.match(/^\[Install[^\]]*\][^[]*Default=(.+)$/m);
      if (installMatch) {
        const candidate = path.join(baseDir, installMatch[1].trim());
        if (fs.existsSync(candidate)) return candidate;
      }

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

      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      const dir = entries.find(
        (e) => e.isDirectory() && (e.name.includes('default') || e.name.includes('.'))
      );
      if (dir) {
        const p = path.join(baseDir, dir.name);
        if (fs.existsSync(path.join(p, 'cookies.sqlite'))) return p;
      }
    } catch {}
  }
  return null;
}

/**
 * Turn a browser preference into the value yt-dlp's --cookies-from-browser takes,
 * expanding LibreWolf to its profile path because yt-dlp does not know the name.
 * @param {string|null} name - browser name from the settings
 * @returns {string} e.g. "firefox:/home/user/.librewolf/abc.default"
 */
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
  console.log('[ytdlp] resolveBrowser:', name, '->', name);
  return name;
}

/** Encoding forced on the yt-dlp child's stdio, so accented titles survive the pipe. */
const YTDLP_TEXT_ENCODING = 'utf-8';

const YTDLP_UTF8_ENV = {
  PYTHONUNBUFFERED: '1',
  PYTHONUTF8: '1',
  PYTHONIOENCODING: YTDLP_TEXT_ENCODING,
};

/**
 * Spawn yt-dlp with UTF-8 text output enforced (see the note above).
 * @param {string} ytDlp resolved binary path
 * @param {string[]} args yt-dlp arguments (the URL must stay last)
 * @param {import('child_process').SpawnOptions} [options]
 */
function spawnYtDlp(ytDlp, args, options = {}) {
  return spawn(ytDlp, ['--encoding', YTDLP_TEXT_ENCODING, ...args], {
    ...options,
    env: { ...process.env, ...YTDLP_UTF8_ENV },
  });
}

/**
 * Streaming line reader for a child-process pipe: decodes UTF-8 across chunk
 * boundaries and only emits complete lines, so a marker/progress line that is
 * split between two chunks is not lost or half-parsed. Call `flush()` on close.
 * @param {(line: string) => void} onLine receives each trimmed line
 */
function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const feed = (text) => {
    carry += text;
    const parts = carry.split(/\r\n|\r|\n/);
    carry = parts.pop();
    for (const line of parts) onLine(line.trim());
  };
  return {
    write(chunk) {
      feed(decoder.write(chunk));
    },
    flush() {
      feed(decoder.end());
      const rest = carry.trim();
      carry = '';
      if (rest) onLine(rest);
    },
  };
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
  } catch {}
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
  const msg = err?.message ?? '';
  if (/requested format is not available/i.test(msg)) return false;
  return /format.*not available/i.test(msg);
}

/**
 * Read a URL's entries with yt-dlp without downloading anything, then check what
 * of it is really playable on YouTube. If the format lookup fails because of the
 * cookie-based solver, the read is retried without cookies.
 * @param {string} url
 * @param {object} [options] - cookiesBrowser, playlistItems, and the onCheck* callbacks
 * @returns {Promise<object>} type, id, title and the entries
 */
export async function fetchPlaylistInfo(url, options = {}) {
  try {
    const info = await _fetchPlaylistInfoOnce(url, options);
    if (detectPlatform(url) === 'youtube' && info.type === 'playlist') {
      options.onBeforeCheck?.(info.entries);
      await checkYouTubeAvailability(
        info.entries,
        options.onCheckProgress,
        options.onEntryChecked,
        options
      );
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

/** Availability checks run at the same time; each one is its own yt-dlp process. */
const YTDLP_CHECK_CONCURRENCY = 16;
/** Give up on one availability check after this long, so a stuck process cannot hold the batch. */
const YTDLP_CHECK_TIMEOUT_MS = 15000;
const UNAVAILABLE_STATUSES = new Set(['private', 'premium_only', 'subscriber_only', 'needs_auth']);

/**
 * Batch-check YouTube video availability by running yt-dlp --print availability
 * for each entry. This is the most reliable approach since it uses the exact same
 * mechanism as the actual download. Mutates entries in-place.
 */
async function checkYouTubeAvailability(entries, onProgress, onEntryChecked, options = {}) {
  const toCheck = entries.filter((e) => !e.unavailable && e.id);
  if (toCheck.length === 0) return;

  const ytDlp = getYtDlpRuntimePath();
  if (!fs.existsSync(ytDlp)) return;

  const cookiesArg = options.cookiesBrowser ? resolveBrowser(options.cookiesBrowser) : null;
  if (cookiesArg) {
    console.log('[ytdlp] availability check using cookies from:', cookiesArg);
  }

  console.log(`[ytdlp] availability check for ${toCheck.length} entries via yt-dlp…`);

  async function checkOne(entry) {
    return new Promise((resolve) => {
      const args = [
        '--no-playlist',
        '--print',
        'availability',
        '--no-warnings',
        '--extractor-args',
        'youtube:player_client=android_vr,web',
      ];
      if (cookiesArg) {
        args.push('--cookies-from-browser', cookiesArg);
      }
      args.push(`https://www.youtube.com/watch?v=${entry.id}`);
      const proc = spawnYtDlp(ytDlp, args);
      const stdoutDecoder = new StringDecoder('utf8');
      let stdout = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        resolve();
      }, YTDLP_CHECK_TIMEOUT_MS);

      proc.stdout.on('data', (d) => (stdout += stdoutDecoder.write(d)));
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        const availability = stdout.trim().toLowerCase();
        console.log(`[ytdlp] ${entry.id} availability=${availability || '(exit ' + code + ')'}`);
        if (
          UNAVAILABLE_STATUSES.has(availability) ||
          availability === 'unavailable' ||
          availability === 'private'
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
        resolve();
      });
    });
  }

  let checked = 0;
  const total = toCheck.length;
  const queue = [...toCheck];

  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift();
      await checkOne(entry);
      checked++;
      onProgress?.({ checked, total });
      onEntryChecked?.({
        id: entry.id,
        index: entry.index,
        unavailable: entry.unavailable ?? false,
      });
    }
  }

  await Promise.allSettled(Array.from({ length: YTDLP_CHECK_CONCURRENCY }, worker));
  const unavailCount = entries.filter((e) => e.unavailable).length;
  console.log(`[ytdlp] availability check done — ${unavailCount}/${entries.length} unavailable`);
}

/** Titles YouTube uses for videos that are gone ("[Private video]", "[Deleted video]"…). */
const UNAVAILABLE_TITLE_RE = /^\[(Private|Deleted|Unavailable|Removed)\s*(video|track)?\]$/i;

const UNAVAILABLE_AVAILABILITY = new Set([
  'private',
  'premium_only',
  'subscriber_only',
  'needs_auth',
  'exclusive_content',
]);

/**
 * Say whether an entry cannot be downloaded, from the availability yt-dlp
 * reported or from the placeholder title it was given.
 * @param {{availability?: string, title?: string}} entry
 * @returns {boolean}
 */
function isEntryUnavailable(entry) {
  if (UNAVAILABLE_AVAILABILITY.has(entry.availability)) return true;
  if (entry.title && UNAVAILABLE_TITLE_RE.test(entry.title.trim())) return true;
  return false;
}

/**
 * Human-readable reason why an entry is not available, for the UI.
 * @param {{availability?: string, title?: string}} entry
 * @returns {string} e.g. "Private video", "Unavailable"
 */
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

/**
 * One flat-playlist read with yt-dlp and no availability checking; shared by the
 * first attempt and the cookie-less retry.
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<object>}
 */
function _fetchPlaylistInfoOnce(url, options = {}) {
  const ytDlp = getYtDlpRuntimePath();
  if (!fs.existsSync(ytDlp)) throw new Error('yt-dlp binary not found. Please reinstall deps.');

  const platform = detectPlatform(url);
  const args = ['--flat-playlist', '--dump-single-json', '--no-warnings'];

  if (platform === 'youtube') {
  }
  if (options.cookiesBrowser) {
    const resolved = resolveBrowser(options.cookiesBrowser);
    console.log(
      '[fetchPlaylistInfo] cookiesBrowser:',
      options.cookiesBrowser,
      '-> resolved:',
      resolved
    );
    if (resolved) {
      args.push('--cookies-from-browser', resolved);
    } else {
      console.warn(
        '[fetchPlaylistInfo] cookiesBrowser set but resolveBrowser returned empty — yt-dlp will run WITHOUT cookies'
      );
    }
  } else {
    console.log(
      '[fetchPlaylistInfo] no cookiesBrowser set — yt-dlp will run WITHOUT cookies (expect 403 bot-block from YouTube)'
    );
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    console.log('[fetchPlaylistInfo] yt-dlp binary:', ytDlp, 'exists:', fs.existsSync(ytDlp));
    console.log('[fetchPlaylistInfo] spawning yt-dlp with args:', JSON.stringify(args));
    let stdout = '';
    let stderr = '';
    const proc = spawnYtDlp(ytDlp, args);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    proc.stdout.on('data', (chunk) => {
      stdout += stdoutDecoder.write(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      const text = stderrDecoder.write(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t) console.log('[fetchPlaylistInfo] stderr:', t);
      }
    });
    proc.on('close', (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      console.log(`[fetchPlaylistInfo] process closed code=${code} stdout_len=${stdout.length}`);
      if (code !== 0) {
        console.error('[fetchPlaylistInfo] FAILED. Full stderr:\n' + stderr.trim());
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 600)}`));
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
 * Search YouTube by keyword using yt-dlp's `ytsearchN:` pseudo-URL support
 * (no extra binary/config needed — --flat-playlist already returns entries
 * for a search "playlist" the same way it does for a real one).
 *
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Array<{source:'youtube', type:'track', id, title, artist, album, durationSec, quality, url}>>}
 */
export async function searchYouTube(query, options = {}) {
  const limit = options.limit ?? 20;
  const info = await fetchPlaylistInfo(`ytsearch${limit}:${query}`, options);
  return info.entries
    .filter((e) => !e.unavailable)
    .map((e) => ({
      source: 'youtube',
      type: 'track',
      id: e.id,
      title: e.title,
      artist: '',
      album: '',
      durationSec: e.duration ?? null,
      quality: '',
      url: e.url,
    }));
}

/**
 * Spawn yt-dlp streaming a single audio track to stdout (-o -). The caller
 * pipes stdout to an HTTP response / file. Default client only: pinned
 * clients (ios/android_vr/tv) fail age-restricted tracks with "Requested
 * format is not available", and only the default client + cookies can solve
 * PO tokens for direct playback.
 * @returns {import('child_process').ChildProcessWithoutNullStreams}
 */
export function createPreviewAudioStream(url, options = {}) {
  const ytDlp = getYtDlpRuntimePath();
  const args = [
    '-f',
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
    '--no-warnings',
    '-o',
    '-',
  ];
  if (options.cookiesBrowser) {
    args.push('--cookies-from-browser', resolveBrowser(options.cookiesBrowser));
  }
  args.push(url);
  return spawnYtDlp(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Download audio from a URL using yt-dlp.
 * Supports both single tracks and playlists — always resolves with an array of file results.
 *
 * @param {string} url - The URL to download
 * @param {(data: object) => void} [onProgress] - Progress callback, receives { msg, pct, trackPct, overallCurrent, overallTotal }
 * @param {{
 *   cookiesBrowser?: string|null,
 *   onFileReady?: (file: { filePath, originalUrl, trackUrl, platform, quality, title, channel, index }) => void,
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

/**
 * One download attempt: fetch the best audio into a temp folder, convert it to
 * the platform's preferred format, and hand each finished file to
 * `options.onFileReady` as yt-dlp prints its marker lines.
 * @param {string} url
 * @param {Function} onProgress - called with {msg, pct} while the download runs
 * @param {object} [options] - cookiesBrowser, playlistItems, onFileReady, onPlaylistDetected
 * @returns {Promise<{files: Array<object>, playlistName: string|null, unavailableCount: number}>}
 */
async function _downloadUrlOnce(url, onProgress, options = {}) {
  const ytDlp = getYtDlpRuntimePath();
  if (!fs.existsSync(ytDlp)) throw new Error('yt-dlp binary not found. Please reinstall deps.');

  const tmpDir = path.join(app.getPath('temp'), 'djman-ytdlp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const outTemplate = path.join(tmpDir, '%(title)s [%(id)s].%(ext)s');

  const platform = detectPlatform(url);
  const audioFormat = preferredAudioFormat(platform);

  const FILE_MARKER = '__YTDLP_FILE__:';
  const TRACK_MARKER = '__YTDLP_TRACK__:';
  const CHANNEL_MARKER = '__YTDLP_CHANNEL__:';

  const args = [
    '-f',
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
    '--extract-audio',
    '--audio-format',
    audioFormat,
    '--audio-quality',
    '0',
    '--no-warnings',
    '--newline',
    '--no-colors',
    '--ignore-errors',
    '--print',
    `before_dl:${TRACK_MARKER}%(n_entries|1)s:%(title)s`,
    '--print',
    `before_dl:${CHANNEL_MARKER}%(channel|uploader|NA)s`,
    '--print',
    `after_move:${FILE_MARKER}%(filepath)s`,
    '-o',
    outTemplate,
  ];

  args.push('--ffmpeg-location', path.dirname(getFfmpegRuntimePath()));

  if (platform === 'youtube') {
  }
  if (options.cookiesBrowser) {
    args.push('--cookies-from-browser', resolveBrowser(options.cookiesBrowser));
  }
  if (options.playlistItems) {
    args.push('--playlist-items', options.playlistItems);
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    const proc = spawnYtDlp(ytDlp, args);
    const startTime = Date.now();

    let currentQuality = 'unknown';
    let playlistTotal = null;
    let playlistCurrent = 0;
    let trackStartCount = 0;
    let playlistName = null;
    let currentTrackUrl = null;
    let currentTrackPct = 0;
    let playlistDetectedFired = false;
    let currentTrackTitle = null;
    let currentTrackChannel = null;
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
        channel: currentTrackChannel || null,
        index: destinationFiles.length - 1,
      });
      currentTrackTitle = null;
      currentTrackChannel = null;
      currentTrackUrl = null;
    };

    /**
     * Process a single output line from yt-dlp (stdout or stderr).
     */
    let lastProgressSent = 0;
    const throttledProgress = (data) => {
      const now = Date.now();
      if (now - lastProgressSent >= 100) {
        lastProgressSent = now;
        onProgress?.(data);
      }
    };

    const processLine = (trimmed) => {
      if (!trimmed) return;

      if (trimmed.startsWith(FILE_MARKER)) {
        const f = trimmed.slice(FILE_MARKER.length).trim();
        if (f) fireFileReady(f);
        return;
      }

      if (trimmed.startsWith(CHANNEL_MARKER)) {
        const name = trimmed.slice(CHANNEL_MARKER.length).trim();
        currentTrackChannel = name && name !== 'NA' ? name : null;
        return;
      }

      if (trimmed.startsWith(TRACK_MARKER)) {
        const rest = trimmed.slice(TRACK_MARKER.length);
        const colonIdx = rest.indexOf(':');
        if (colonIdx !== -1) {
          const total = parseInt(rest.slice(0, colonIdx), 10);
          const title = rest.slice(colonIdx + 1).trim();
          if (!isNaN(total)) {
            trackStartCount++;
            const idx = trackStartCount;
            playlistCurrent = idx;
            playlistTotal = total;
            currentTrackPct = 0;
            currentTrackTitle = title || null;
            if (!playlistDetectedFired && total > 1) {
              playlistDetectedFired = true;
              options.onPlaylistDetected?.({ name: playlistName, total });
            }
            if (title) {
              options.onTrackMeta?.({ index: idx - 1, title });
            }
            onProgress?.({
              msg: title || `Track ${idx} / ${total}`,
              pct: Math.round(((idx - 1) / total) * 100),
              trackPct: 0,
              overallCurrent: idx,
              overallTotal: total,
            });
          }
        }
        return;
      }

      const pctMatch = trimmed.match(/\[download\]\s+([\d.]+)%/);
      if (pctMatch) {
        currentTrackPct = Math.round(parseFloat(pctMatch[1]));
        const total = playlistTotal ?? 1;
        const current = playlistCurrent || 1;
        const overallPct =
          total > 1 ? Math.round(((current - 1) * 100 + currentTrackPct) / total) : currentTrackPct;
        throttledProgress({
          msg: trimmed.replace(/^\[download\]\s+/, '').trim(),
          pct: overallPct,
          trackPct: currentTrackPct,
          overallCurrent: current,
          overallTotal: total,
        });
        return;
      }

      const unknownSizeMatch = trimmed.match(
        /\[download\]\s+([\d.]+\s*\w+iB)\s+at\s+([\d.]+\s*\w+iB\/s)/
      );
      if (unknownSizeMatch) {
        const total = playlistTotal ?? 1;
        const current = playlistCurrent || 1;
        throttledProgress({
          msg: `${unknownSizeMatch[1]} at ${unknownSizeMatch[2]}`,
          pct: total > 1 ? Math.round(((current - 1) / total) * 100) : 50,
          trackPct: 50,
          overallCurrent: current,
          overallTotal: total,
        });
        return;
      }

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

      const nameMatch = trimmed.match(/\[download\] Downloading playlist: (.+)/);
      if (nameMatch) {
        playlistName = nameMatch[1].trim();
        return;
      }

      const extractMatch = trimmed.match(/Extracting URL: (.+)/);
      if (extractMatch) {
        currentTrackUrl = extractMatch[1].trim();
        return;
      }

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

      const qualityMatch = trimmed.match(/(\d+k(?:bps)?)/i);
      if (qualityMatch) currentQuality = qualityMatch[1];
    };

    const stdoutLines = createLineReader(processLine);
    const stderrLines = createLineReader((line) => {
      stderr += line + '\n';
      processLine(line);
    });

    proc.stdout.on('data', (chunk) => stdoutLines.write(chunk));
    proc.stderr.on('data', (chunk) => stderrLines.write(chunk));

    let unavailableCount = 0;

    proc.on('close', async (code) => {
      stdoutLines.flush();
      stderrLines.flush();
      const unavailablePattern = /(?:ERROR|WARNING): \[[\w:]+\] ([^:\s][^:]*): (.+)/g;
      let match;
      while ((match = unavailablePattern.exec(stderr)) !== null) {
        const videoId = match[1].trim();
        const reason = match[2].trim();
        const isFormatSelectionWarning = /requested format is not available/i.test(reason);
        if (
          !isFormatSelectionWarning &&
          (reason.toLowerCase().includes('unavailable') ||
            reason.toLowerCase().includes('private') ||
            reason.toLowerCase().includes('deleted') ||
            reason.toLowerCase().includes('removed') ||
            reason.toLowerCase().includes('not available'))
        ) {
          console.warn(`[ytdlp] unavailable: ${videoId} — ${reason}`);
          options.onTrackUnavailable?.({ videoId, reason });
          unavailableCount++;
        }
      }

      const stderrHasUnavailable =
        unavailableCount === 0 &&
        (stderr.includes('Video unavailable') ||
          stderr.includes('Private video') ||
          stderr.includes('Deleted video') ||
          stderr.includes('This video is not available'));
      if (stderrHasUnavailable) unavailableCount = 1;

      if (code !== 0 && destinationFiles.length === 0 && unavailableCount === 0) {
        reject(new Error(`yt-dlp exited with code ${code}:\n${stderr}`));
        return;
      }

      const hasUsableFile = () => destinationFiles.some((f) => fs.existsSync(f));

      if (!hasUsableFile()) {
        try {
          const entries = await fs.promises.readdir(tmpDir);
          for (const entry of entries) {
            const full = path.join(tmpDir, entry);
            const ext = path.extname(entry).toLowerCase();
            if (AUDIO_EXTS.has(ext) && fs.statSync(full).mtimeMs >= startTime - 5000) {
              fireFileReady(full);
            }
          }
        } catch {}
      }

      if (!hasUsableFile()) {
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
        } catch {}
      }

      if (!hasUsableFile() && unavailableCount === 0) {
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
