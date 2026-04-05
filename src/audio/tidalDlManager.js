/**
 * tidal-dl-ng download manager.
 * Wraps the `tdn` CLI (from the tidal-dl-ng Python package).
 * Authentication uses TIDAL's OAuth device-link flow.
 */
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus']);

// Strip ANSI escape codes from terminal output
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHFABCDST]/g, '');
}

/**
 * Find the `tdn` binary in common locations.
 * @returns {string|null}
 */
export function findTidalDlPath() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'tdn'),
    path.join(os.homedir(), '.local', 'bin', 'tidal-dl-ng'),
    '/usr/local/bin/tdn',
    '/usr/bin/tdn',
  ];

  if (process.platform === 'win32') {
    candidates.push(
      path.join(os.homedir(), '.local', 'bin', 'tdn.exe'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'Python', 'Scripts', 'tdn.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Scripts', 'tdn.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Python', '3.12', 'bin', 'tdn'),
      path.join(os.homedir(), 'Library', 'Python', '3.11', 'bin', 'tdn'),
      '/opt/homebrew/bin/tdn'
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Try PATH resolution
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${which} tdn`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (result) return result.split('\n')[0].trim();
  } catch {
    /* not in PATH */
  }

  return null;
}

/**
 * Path to the tidal-dl-ng settings file (platformdirs user_config_dir).
 */
function getConfigPath() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'tidal_dl_ng', 'settings.json');
  } else if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'tidal_dl_ng',
      'settings.json'
    );
  }
  return path.join(os.homedir(), '.config', 'tidal_dl_ng', 'settings.json');
}

/**
 * Path to the tidal-dl-ng OAuth token file.
 */
function getTokenPath() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'tidal_dl_ng', 'token.json');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'tidal_dl_ng', 'token.json');
  }
  return path.join(os.homedir(), '.config', 'tidal_dl_ng', 'token.json');
}

function readTidalConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeTidalConfig(cfg) {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

/**
 * Path to the tidal-dl-ng download history file.
 * tdn skips tracks listed here — we clear it before each download
 * so all requested tracks are always fetched. The library's SHA-1
 * dedup prevents re-importing tracks that are already in the library.
 */
function getHistoryPath() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'tidal_dl_ng', 'downloaded_history.json');
  } else if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'tidal_dl_ng',
      'downloaded_history.json'
    );
  }
  return path.join(os.homedir(), '.config', 'tidal_dl_ng', 'downloaded_history.json');
}

function clearDownloadHistory() {
  try {
    const p = getHistoryPath();
    if (fs.existsSync(p)) {
      fs.writeFileSync(p, '[]');
    }
  } catch (e) {
    console.warn('[tidal-dl] failed to clear download history:', e.message);
  }
}

/**
 * Install tidal-dl-ng via pip, streaming output to onProgress.
 * Tries pip3 → pip → python3 -m pip → python -m pip in order.
 * @param {(line: string) => void} onProgress
 * @returns {Promise<void>}
 */
export function installTidalDlNg(onProgress) {
  const candidates =
    process.platform === 'win32'
      ? [
          ['pip', ['install', 'tidal-dl-ng']],
          ['python', ['-m', 'pip', 'install', 'tidal-dl-ng']],
        ]
      : [
          ['pip3', ['install', 'tidal-dl-ng']],
          ['pip', ['install', 'tidal-dl-ng']],
          ['python3', ['-m', 'pip', 'install', 'tidal-dl-ng']],
          ['python', ['-m', 'pip', 'install', 'tidal-dl-ng']],
        ];

  function tryNext(index) {
    if (index >= candidates.length) {
      return Promise.reject(
        new Error('Could not find pip or python. Please install Python 3.12+ and try again.')
      );
    }
    const [cmd, args] = candidates[index];
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          const t = line.trim();
          if (t) onProgress(t);
        }
      });
      proc.stderr.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          const t = line.trim();
          if (t) onProgress(t);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}`));
      });
      proc.on('error', () => {
        // This candidate not available — try the next one
        reject(new Error(`spawn ${cmd} failed`));
      });
    }).catch((err) => {
      console.warn(`[tidal-install] ${err.message} — trying next candidate`);
      return tryNext(index + 1);
    });
  }

  return tryNext(0);
}

/**
 * Check if tdn is installed and the user is logged in.
 * @returns {{ installed: boolean, loggedIn: boolean, path: string|null }}
 */
export function checkTidalSetup() {
  const binPath = findTidalDlPath();
  if (!binPath) return { installed: false, loggedIn: false, path: null };

  try {
    const tokenPath = getTokenPath();
    if (!fs.existsSync(tokenPath)) return { installed: true, loggedIn: false, path: binPath };
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (!token.access_token) return { installed: true, loggedIn: false, path: binPath };
    // Treat as logged in even if expiry is close — tidalapi handles token refresh
    return { installed: true, loggedIn: true, path: binPath };
  } catch {
    return { installed: true, loggedIn: false, path: binPath };
  }
}

/**
 * Start the TIDAL OAuth login flow.
 * Spawns `tdn login`, parses the device-link URL from stdout/stderr,
 * and calls onUrl once the URL is available.
 * Resolves when login completes (process exits 0).
 *
 * @param {(url: string) => void} onUrl
 * @returns {Promise<void>}
 */
export function startLogin(onUrl) {
  const binPath = findTidalDlPath();
  if (!binPath) {
    return Promise.reject(
      new Error('tidal-dl-ng not found. Install it with: pip install tidal-dl-ng')
    );
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, ['login'], {
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let urlSent = false;

    function scanForUrl(text) {
      if (urlSent) return;
      // Match TIDAL device-link URLs
      const match = text.match(/https?:\/\/[^\s]*(link\.tidal\.com|tidal\.com)[^\s]*/i);
      if (match) {
        urlSent = true;
        onUrl(match[0].replace(/[.,;!?]+$/, ''));
      }
    }

    proc.stdout.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      console.log('[tidal-login] stdout:', text.trim());
      scanForUrl(text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      console.log('[tidal-login] stderr:', text.trim());
      scanForUrl(text);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tdn login exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

/**
 * Recursively scan a directory for audio files newer than a given timestamp.
 */
async function scanForAudioFiles(dir, sinceMs) {
  const results = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.mtimeMs >= sinceMs - 5000) results.push(full);
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(dir);
  return results;
}

/**
 * Download a TIDAL URL using `tdn dl`.
 * Temporarily sets download_base_path to outputDir, restores after.
 *
 * @param {string} url
 * @param {string} outputDir  Directory to download into
 * @param {(msg: string) => void} onProgress
 * @returns {Promise<string[]>}  Paths of downloaded audio files
 */
export async function downloadTidal(url, outputDir, onProgress) {
  const binPath = findTidalDlPath();
  if (!binPath) {
    throw new Error('tidal-dl-ng not found. Install it with: pip install tidal-dl-ng');
  }

  await fs.promises.mkdir(outputDir, { recursive: true });

  // Save + set download config
  const originalCfg = readTidalConfig();
  const patchedCfg = {
    ...originalCfg,
    download_base_path: outputDir,
    // Prefer lossless for DJs; fall back gracefully if subscription doesn't allow
    quality_audio: originalCfg.quality_audio ?? 'HiRes_Lossless',
    extract_flac: originalCfg.extract_flac ?? true,
    skip_existing: false,
    cover_album_file: false,
  };
  writeTidalConfig(patchedCfg);

  // Clear download history so tdn never skips tracks.
  // Library-level SHA-1 dedup prevents re-importing existing tracks.
  clearDownloadHistory();

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, ['dl', url], {
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t) {
          console.log('[tidal-dl] stdout:', t);
          onProgress(t);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      stderr += text;
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t) console.log('[tidal-dl] stderr:', t);
      }
    });

    proc.on('close', async (code) => {
      // Restore original config
      try {
        writeTidalConfig(originalCfg);
      } catch (e) {
        console.warn('[tidal-dl] failed to restore config:', e.message);
      }

      if (code !== 0) {
        reject(new Error(`tidal-dl-ng exited with code ${code}: ${stderr.trim().slice(0, 400)}`));
        return;
      }

      const files = await scanForAudioFiles(outputDir, startTime);
      resolve(files);
    });

    proc.on('error', (err) => {
      try {
        writeTidalConfig(originalCfg);
      } catch {
        /* ignore */
      }
      reject(err);
    });
  });
}
