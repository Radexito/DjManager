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

// Embedded Python script for fetching TIDAL track listings via tidalapi.
// Written to a temp file and executed with the uv-managed Python interpreter.
const FETCH_INFO_SCRIPT = `
import sys, json, re
try:
    import tidalapi
except ImportError:
    print(json.dumps({'ok': False, 'error': 'tidalapi not installed'}))
    sys.exit(1)

def parse_url(url):
    patterns = [
        (r'/album/(\\d+)', 'album'),
        (r'/playlist/([0-9a-f-]{36})', 'playlist'),
        (r'/mix/([a-zA-Z0-9_-]+)', 'mix'),
        (r'/track/(\\d+)', 'track'),
    ]
    for pattern, rtype in patterns:
        m = re.search(pattern, url)
        if m:
            return rtype, m.group(1)
    return None, None

if len(sys.argv) < 3:
    print(json.dumps({'ok': False, 'error': 'Usage: script.py <url> <token_path>'}))
    sys.exit(1)

url = sys.argv[1]
token_path = sys.argv[2]

try:
    with open(token_path) as f:
        token = json.load(f)
except Exception as e:
    print(json.dumps({'ok': False, 'error': f'Token error: {str(e)}'}))
    sys.exit(1)

try:
    session = tidalapi.Session()
    session.load_oauth_session(
        token.get('token_type', 'Bearer'),
        token['access_token'],
        token.get('refresh_token')
    )
    if not session.check_login():
        print(json.dumps({'ok': False, 'error': 'Not logged in to TIDAL'}))
        sys.exit(1)
except Exception as e:
    print(json.dumps({'ok': False, 'error': f'Session error: {str(e)}'}))
    sys.exit(1)

rtype, rid = parse_url(url)
if not rtype:
    print(json.dumps({'ok': False, 'error': 'Could not parse TIDAL URL. Use tidal.com/browse/album/123, /track/123, or /playlist/uuid'}))
    sys.exit(1)

def track_to_entry(t, idx, entry_url=None):
    return {
        'index': idx,
        'id': str(t.id),
        'title': t.name,
        'artist': t.artist.name if t.artist else '',
        'duration': t.duration,
        'url': entry_url or f'https://tidal.com/browse/track/{t.id}',
    }

try:
    if rtype == 'track':
        t = session.track(int(rid))
        entries = [track_to_entry(t, 0, url)]
        title = ((t.artist.name + ' - ') if t.artist else '') + t.name
    elif rtype == 'album':
        a = session.album(int(rid))
        tracks = list(a.tracks())
        title = a.name
        entries = [track_to_entry(t, i) for i, t in enumerate(tracks)]
    elif rtype == 'playlist':
        pl = session.playlist(rid)
        tracks = list(pl.tracks())
        title = pl.name
        entries = [track_to_entry(t, i) for i, t in enumerate(tracks)]
    elif rtype == 'mix':
        print(json.dumps({'ok': True, 'type': 'mix', 'title': 'TIDAL Mix', 'entries': []}))
        sys.exit(0)
    else:
        print(json.dumps({'ok': False, 'error': f'Unsupported type: {rtype}'}))
        sys.exit(1)
    print(json.dumps({'ok': True, 'type': rtype, 'title': title, 'entries': entries}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
    sys.exit(1)
`;

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
 * Find the Python interpreter bundled with the uv-managed tidal-dl-ng-for-dj environment.
 * Falls back to system Python if the uv env is not found.
 * @returns {string|null}
 */
export function findTidalPython() {
  const uvToolDir = path.join(os.homedir(), '.local', 'share', 'uv', 'tools', 'tidal-dl-ng-for-dj');
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(uvToolDir, 'Scripts', 'python.exe'),
          path.join(uvToolDir, 'Scripts', 'python3.exe'),
        ]
      : [path.join(uvToolDir, 'bin', 'python3'), path.join(uvToolDir, 'bin', 'python')];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Fall back to system Python
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const cmd of ['python3', 'python']) {
    try {
      const result = execSync(`${which} ${cmd}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {
      /* not in PATH */
    }
  }
  return null;
}

/**
 * Fetch TIDAL track/album/playlist info for a given URL using tidalapi.
 * Uses the uv-managed Python interpreter and the embedded fetch script.
 * @param {string} url
 * @returns {Promise<{ ok: boolean, type?: string, title?: string, entries?: Array, error?: string }>}
 */
export async function fetchTidalInfo(url) {
  const pythonPath = findTidalPython();
  if (!pythonPath) {
    return { ok: false, error: 'Python interpreter not found. Ensure tidal-dl-ng is installed.' };
  }

  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return { ok: false, error: 'Not logged in to TIDAL. Please connect your account first.' };
  }

  // Write the embedded script to a temp file
  const scriptPath = path.join(os.tmpdir(), 'dj_manager_tidal_fetch.py');
  try {
    fs.writeFileSync(scriptPath, FETCH_INFO_SCRIPT.trimStart());
  } catch (e) {
    return { ok: false, error: `Failed to write fetch script: ${e.message}` };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(pythonPath, [scriptPath, url, tokenPath], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', () => {
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch {
        resolve({ ok: false, error: stderr.trim() || stdout.trim() || 'Failed to parse response' });
      }
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * Return all possible tidal-dl-ng config directory base paths.
 * The fork may use 'tidal_dl_ng' or 'tidal_dl_ng-dev' depending on
 * how it was installed. We operate on every dir that exists.
 */
function getTidalConfigDirs() {
  let bases;
  if (process.platform === 'win32') {
    bases = [
      path.join(os.homedir(), 'AppData', 'Local', 'tidal_dl_ng'),
      path.join(os.homedir(), 'AppData', 'Local', 'tidal_dl_ng-dev'),
    ];
  } else if (process.platform === 'darwin') {
    bases = [
      path.join(os.homedir(), 'Library', 'Application Support', 'tidal_dl_ng'),
      path.join(os.homedir(), 'Library', 'Application Support', 'tidal_dl_ng-dev'),
    ];
  } else {
    bases = [
      path.join(os.homedir(), '.config', 'tidal_dl_ng'),
      path.join(os.homedir(), '.config', 'tidal_dl_ng-dev'),
    ];
  }
  return bases.filter((d) => fs.existsSync(d));
}

/**
 * Return the config dir that has a settings.json (prefer the one tdn
 * is currently writing to, identified by the most-recently-modified file).
 */
function getActiveConfigDir() {
  const dirs = getTidalConfigDirs();
  if (dirs.length === 0) return null;
  if (dirs.length === 1) return dirs[0];
  // Pick whichever settings.json was modified most recently
  let best = dirs[0];
  let bestMtime = 0;
  for (const d of dirs) {
    try {
      const mtime = fs.statSync(path.join(d, 'settings.json')).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = d;
      }
    } catch {
      /* no settings.json in this dir */
    }
  }
  return best;
}

function getTokenPath() {
  const dir = getActiveConfigDir();
  const base =
    dir ??
    (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'tidal_dl_ng')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'tidal_dl_ng')
        : path.join(os.homedir(), '.config', 'tidal_dl_ng'));
  return path.join(base, 'token.json');
}

/**
 * Clear the download history in ALL tidal config dirs before each download.
 * tdn skips tracks listed in downloaded_history.json — clearing it ensures
 * all requested tracks are fetched. The library's SHA-1 dedup prevents
 * re-importing tracks already in the library.
 *
 * The history schema is { _schema_version, settings, tracks: { id: {...} } }
 * — we preserve schema_version and set tracks to {} and preventDuplicates to false.
 */
function clearDownloadHistory() {
  for (const dir of getTidalConfigDirs()) {
    const p = path.join(dir, 'downloaded_history.json');
    try {
      let existing = {};
      try {
        existing = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* file missing or corrupt — start fresh */
      }
      const cleared = {
        _schema_version: existing._schema_version ?? 1,
        _last_updated: new Date().toISOString(),
        settings: { preventDuplicates: false },
        tracks: {},
      };
      fs.writeFileSync(p, JSON.stringify(cleared));
    } catch (e) {
      console.warn('[tidal-dl] failed to clear download history in', dir, ':', e.message);
    }
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
 * Download one or more TIDAL URLs using `tdn dl`.
 * Temporarily sets download_base_path to outputDir, restores after.
 *
 * When `onFileReady` is provided, it is called for each audio file as soon as
 * tdn signals "Downloaded item '...'." — enabling progressive library import.
 *
 * @param {string|string[]} urlOrUrls  Single URL or array of track URLs
 * @param {string} outputDir           Directory to download into
 * @param {(msg: string) => void} onProgress
 * @param {{ onFileReady?: (filePath: string) => void }} [opts]
 * @returns {Promise<string[]>}  Paths of all downloaded audio files
 */
export async function downloadTidal(urlOrUrls, outputDir, onProgress, { onFileReady } = {}) {
  const binPath = findTidalDlPath();
  if (!binPath) {
    throw new Error('tidal-dl-ng not found. Install it with: pip install tidal-dl-ng');
  }

  await fs.promises.mkdir(outputDir, { recursive: true });

  // Patch settings in ALL config dirs so whichever one tdn reads gets the right values.
  const allDirs = getTidalConfigDirs();
  const originalCfgs = new Map();
  for (const dir of allDirs) {
    const cfgPath = path.join(dir, 'settings.json');
    let original = {};
    try {
      original = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {
      /* missing — will create */
    }
    originalCfgs.set(cfgPath, original);
    const patched = {
      ...original,
      download_base_path: outputDir,
      quality_audio: original.quality_audio ?? 'HiRes_Lossless',
      extract_flac: original.extract_flac ?? true,
      skip_existing: false,
      cover_album_file: false,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(patched, null, 2));
    } catch (e) {
      console.warn('[tidal-dl] failed to patch config in', dir, ':', e.message);
    }
  }

  // Clear download history in all config dirs so tdn never skips tracks.
  // Library-level SHA-1 dedup prevents re-importing existing tracks.
  clearDownloadHistory();

  const startTime = Date.now();
  const urlArray = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  // Track which files we've already reported to onFileReady
  const seenFiles = new Set();

  function restore() {
    for (const [cfgPath, original] of originalCfgs) {
      try {
        fs.writeFileSync(cfgPath, JSON.stringify(original, null, 2));
      } catch (e) {
        console.warn('[tidal-dl] failed to restore config', cfgPath, ':', e.message);
      }
    }
  }

  /**
   * Scan outputDir for newly appeared audio files and call onFileReady for each.
   * Called after tdn logs "Downloaded item" so we detect files right after each track.
   */
  async function reportNewFiles() {
    if (!onFileReady) return;
    const allFiles = await scanForAudioFiles(outputDir, startTime);
    for (const f of allFiles) {
      if (!seenFiles.has(f)) {
        seenFiles.add(f);
        onFileReady(f);
      }
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, ['dl', ...urlArray], {
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        console.log('[tidal-dl] stdout:', t);
        onProgress(t);

        // tdn logs "Downloaded item 'Artist - Title'." right before it moves the file.
        // Wait 800ms for the shutil.move to complete, then pick up the new file.
        if (/Downloaded item '/i.test(t)) {
          setTimeout(() => reportNewFiles(), 800);
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
      restore();

      if (code !== 0) {
        reject(new Error(`tidal-dl-ng exited with code ${code}: ${stderr.trim().slice(0, 400)}`));
        return;
      }

      // Catch any files the progressive scan may have missed (e.g. fast downloads)
      await reportNewFiles();

      const allFiles = await scanForAudioFiles(outputDir, startTime);
      resolve(allFiles);
    });

    proc.on('error', (err) => {
      restore();
      reject(err);
    });
  });
}
