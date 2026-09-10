/**
 * tidal-dl-ng download manager.
 * Wraps the `tdn` CLI (from the tidal-dl-ng Python package).
 * Authentication uses TIDAL's OAuth device-link flow.
 */
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';

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

// Embedded Python script for searching TIDAL via tidalapi's session search.
// Same approach as FETCH_INFO_SCRIPT above — no upstream `tdn` CLI changes
// needed since tidalapi is already a direct dependency of this fork.
const SEARCH_SCRIPT = `
import sys, json
try:
    import tidalapi
except ImportError:
    print(json.dumps({'ok': False, 'error': 'tidalapi not installed'}))
    sys.exit(1)

if len(sys.argv) < 3:
    print(json.dumps({'ok': False, 'error': 'Usage: script.py <query> <token_path> [types] [limit]'}))
    sys.exit(1)

query = sys.argv[1]
token_path = sys.argv[2]
types_arg = sys.argv[3] if len(sys.argv) > 3 else 'track'
limit = int(sys.argv[4]) if len(sys.argv) > 4 else 20

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

type_map = {
    'track': tidalapi.media.Track,
    'album': tidalapi.album.Album,
    'playlist': tidalapi.playlist.Playlist,
}
requested_types = [t.strip() for t in types_arg.split(',') if t.strip() in type_map]
models = [type_map[t] for t in requested_types] if requested_types else None

try:
    results = session.search(query, models=models, limit=limit)
    out = []
    for t in (results.get('tracks') or []):
        out.append({
            'type': 'track',
            'id': str(t.id),
            'title': t.name,
            'artist': t.artist.name if t.artist else '',
            'album': t.album.name if t.album else '',
            'duration': t.duration,
            'quality': getattr(t, 'audio_quality', None) or '',
            'url': f'https://tidal.com/browse/track/{t.id}',
        })
    for a in (results.get('albums') or []):
        out.append({
            'type': 'album',
            'id': str(a.id),
            'title': a.name,
            'artist': a.artist.name if a.artist else '',
            'album': a.name,
            'duration': getattr(a, 'duration', None),
            'numTracks': getattr(a, 'num_tracks', None),
            'quality': getattr(a, 'audio_quality', None) or '',
            'url': f'https://tidal.com/browse/album/{a.id}',
        })
    for p in (results.get('playlists') or []):
        out.append({
            'type': 'playlist',
            'id': str(p.id),
            'title': p.name,
            'artist': '',
            'album': '',
            'duration': getattr(p, 'duration', None),
            'numTracks': getattr(p, 'num_tracks', None),
            'quality': '',
            'url': f'https://tidal.com/browse/playlist/{p.id}',
        })
    print(json.dumps({'ok': True, 'results': out}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
    sys.exit(1)
`;

const PREVIEW_URL_SCRIPT = `
import sys, json, re
try:
    import tidalapi
except ImportError:
    print(json.dumps({'ok': False, 'error': 'tidalapi not installed'}))
    sys.exit(1)

def parse_track_id(url):
    m = re.search(r'/track/(\\d+)', url)
    return m.group(1) if m else None

if len(sys.argv) < 3:
    print(json.dumps({'ok': False, 'error': 'Usage: script.py <track_url> <token_path>'}))
    sys.exit(1)

url = sys.argv[1]
token_path = sys.argv[2]
track_id = parse_track_id(url)
if not track_id:
    print(json.dumps({'ok': False, 'error': 'Inline preview is only available for TIDAL track results'}))
    sys.exit(1)

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
    track = session.track(int(track_id))
    stream = track.get_stream()
    manifest = stream.get_stream_manifest()
    urls = manifest.get_urls()
    preview_url = urls[0] if urls else None
    if not preview_url:
        print(json.dumps({'ok': False, 'error': 'No preview stream URL returned by TIDAL'}))
        sys.exit(1)
    print(json.dumps({'ok': True, 'url': preview_url}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
    sys.exit(1)
`;

// Embedded Python script for listing the logged-in account's collections
// (playlists, mixes & radio, favorites) via tidalapi. Uses the same OAuth
// session/token as every other script here, so no second login is needed.
export const COLLECTIONS_SCRIPT = `
import sys, json
try:
    import tidalapi
except ImportError:
    print(json.dumps({'ok': False, 'error': 'tidalapi not installed'}))
    sys.exit(1)

if len(sys.argv) < 2:
    print(json.dumps({'ok': False, 'error': 'Usage: script.py <token_path>'}))
    sys.exit(1)

token_path = sys.argv[1]

try:
    with open(token_path) as f:
        token = json.load(f)
except Exception as e:
    print(json.dumps({'ok': False, 'error': 'Token error: ' + str(e)}))
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
    print(json.dumps({'ok': False, 'error': 'Session error: ' + str(e)}))
    sys.exit(1)

collections = []
warnings = []

def add(cid, ctype, title, group, parent_id='', subtitle='', count=0, mix_type=''):
    cid = str(cid or '')
    if not cid or not ctype:
        return
    collections.append({
        'id': cid,
        'type': ctype,
        'title': title or cid,
        'group': group,
        'parentId': parent_id or '',
        'subtitle': subtitle or '',
        'count': int(count or 0),
        'mixType': mix_type or '',
    })

def safe(label, func, fallback):
    try:
        return func()
    except Exception as e:
        warnings.append(label + ': ' + str(e))
        return fallback

def paginate(func, page=100, cap=2000):
    out = []
    offset = 0
    while len(out) < cap:
        batch = func(limit=page, offset=offset)
        if not batch:
            break
        out.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return out

# -- Playlists: created and favorited, mirroring the tdn GUI "Playlists" node --
def load_playlists():
    found = {}

    def absorb(func):
        for pl in safe('playlists', func, []) or []:
            pid = str(getattr(pl, 'id', '') or '')
            if pid and pid not in found:
                found[pid] = pl

    absorb(lambda: session.user.favorites.playlists_paginated())
    absorb(lambda: paginate(session.user.playlist_and_favorite_playlists, page=50))
    return list(found.values())

for pl in load_playlists():
    count = (getattr(pl, 'num_tracks', 0) or 0) + (getattr(pl, 'num_videos', 0) or 0)
    add(
        getattr(pl, 'id', ''),
        'playlist',
        getattr(pl, 'name', ''),
        'playlists',
        count=count,
    )

# -- Mixes & radio: My Mix 1-8, My Daily Discovery, My Video Mix 1-6 ----------
def load_mixes():
    out = []
    page = session.mixes()
    for category in getattr(page, 'categories', None) or []:
        out.extend(list(getattr(category, 'items', None) or []))
    if out:
        return out
    return list(session.user.favorites.mixes() or [])

seen_mixes = set()
for mx in safe('mixes', load_mixes, []) or []:
    mix_id = str(getattr(mx, 'id', '') or '')
    if not mix_id or mix_id in seen_mixes:
        continue
    seen_mixes.add(mix_id)
    mix_type = getattr(mx, 'mix_type', None)
    if mix_type is not None and hasattr(mix_type, 'value'):
        mix_type = mix_type.value
    subtitle = getattr(mx, 'sub_title', '') or getattr(mx, 'short_subtitle', '') or ''
    add(mix_id, 'mix', getattr(mx, 'title', ''), 'mixes', subtitle=subtitle, mix_type=mix_type or '')

# -- Favorites: tracks / albums / artists / videos / mixes -------------------
fav = getattr(session.user, 'favorites', None)

FAVORITE_KINDS = [
    ('tracks', 'Favorite tracks', 'get_tracks_count'),
    ('albums', 'Favorite albums', 'get_albums_count'),
    ('artists', 'Favorite artists', 'get_artists_count'),
    ('videos', 'Favorite videos', 'get_videos_count'),
    ('mixes', 'Favorite mixes & radio', ''),
]

def favorite_count(method_name):
    if fav is None or not method_name:
        return 0
    count_method = getattr(fav, method_name, None)
    if count_method is None:
        return 0
    return safe('favorites', count_method, 0) or 0

if fav is not None:
    for kind, label, count_method in FAVORITE_KINDS:
        add(kind, 'favorites', label, 'favorites', count=favorite_count(count_method))

    # Individual favorite artists, nested under the "Favorite artists" node.
    fav_artists = safe('favorite artists', lambda: fav.artists_paginated(), []) or []
    for artist in fav_artists[:200]:
        add(
            getattr(artist, 'id', ''),
            'artist',
            getattr(artist, 'name', ''),
            'favorites',
            parent_id='artists',
        )

print(json.dumps({'ok': True, 'collections': collections, 'warnings': warnings}))
`;

// Embedded Python script that resolves one collection (by type + id) into the
// individual track/video entries the download path needs. Same session/token
// handling as every other script in this file.
export const COLLECTION_TRACKS_SCRIPT = `
import sys, json
try:
    import tidalapi
except ImportError:
    print(json.dumps({'ok': False, 'error': 'tidalapi not installed'}))
    sys.exit(1)

if len(sys.argv) < 4:
    print(json.dumps({'ok': False, 'error': 'Usage: script.py <type> <id> <token_path> [limit]'}))
    sys.exit(1)

ctype = sys.argv[1]
cid = sys.argv[2]
token_path = sys.argv[3]
limit = int(sys.argv[4]) if len(sys.argv) > 4 else 500

try:
    with open(token_path) as f:
        token = json.load(f)
except Exception as e:
    print(json.dumps({'ok': False, 'error': 'Token error: ' + str(e)}))
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
    print(json.dumps({'ok': False, 'error': 'Session error: ' + str(e)}))
    sys.exit(1)

def is_video(media):
    video_class = getattr(tidalapi, 'Video', None)
    return isinstance(media, video_class) if isinstance(video_class, type) else False

def paginate(func, page=100, cap=5000):
    out = []
    offset = 0
    while len(out) < cap:
        batch = func(limit=page, offset=offset)
        if not batch:
            break
        out.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return out

def media_title(media):
    return getattr(media, 'name', None) or getattr(media, 'title', None) or str(getattr(media, 'id', ''))

def media_artist(media):
    artist = getattr(media, 'artist', None)
    name = getattr(artist, 'name', '') if artist is not None else ''
    if name:
        return name
    artists = getattr(media, 'artists', None) or []
    names = [n for n in (getattr(a, 'name', '') for a in artists) if n]
    return ', '.join(names)

def media_url(media):
    url = getattr(media, 'share_url', '') or ''
    if url:
        return url
    mid = str(getattr(media, 'id', ''))
    if is_video(media):
        return 'https://tidal.com/browse/video/' + mid
    return 'https://tidal.com/browse/track/' + mid

def to_entry(media, idx):
    return {
        'index': idx,
        'id': str(getattr(media, 'id', '')),
        'title': media_title(media),
        'artist': media_artist(media),
        'duration': int(getattr(media, 'duration', 0) or 0),
        'url': media_url(media),
        'mediaType': 'video' if is_video(media) else 'track',
    }

def resolve():
    if ctype == 'track':
        media = session.track(int(cid))
        artist = media_artist(media)
        title = (artist + ' - ' + media_title(media)) if artist else media_title(media)
        return title, [media]
    if ctype == 'video':
        media = session.video(int(cid))
        return media_title(media), [media]
    if ctype == 'album':
        media = session.album(int(cid))
        return media.name, list(media.tracks())
    if ctype == 'playlist':
        media = session.playlist(cid)
        return media.name, paginate(media.items)
    if ctype == 'mix':
        media = session.mix(cid)
        return (getattr(media, 'title', '') or 'TIDAL Mix'), list(media.items())
    if ctype == 'artist':
        media = session.artist(int(cid))
        return media.name, list(media.get_top_tracks(limit=50))
    if ctype == 'favorites':
        fav = session.user.favorites
        if cid == 'tracks':
            return 'Favorite tracks', list(fav.tracks_paginated())
        if cid == 'videos':
            return 'Favorite videos', list(fav.videos_paginated())
        if cid == 'albums':
            out = []
            for album in fav.albums_paginated():
                out.extend(list(album.tracks()))
            return 'Favorite albums', out
        if cid == 'artists':
            out = []
            for artist in fav.artists_paginated():
                out.extend(list(artist.get_top_tracks(limit=10)))
            return 'Favorite artists', out
        if cid == 'mixes':
            out = []
            for mix in fav.mixes():
                mix_id = str(getattr(mix, 'id', '') or '')
                if not mix_id:
                    continue
                try:
                    # Favorite mixes come back as MixV2 placeholders without
                    # their items - resolve each one through session.mix().
                    out.extend(list(session.mix(mix_id).items()))
                except Exception:
                    continue
            return 'Favorite mixes & radio', out
        raise ValueError('Unknown favorites collection: ' + cid)
    raise ValueError('Unsupported collection type: ' + ctype)

try:
    title, media_items = resolve()
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
    sys.exit(1)

total = len(media_items)
truncated = total > limit
entries = [to_entry(m, i) for i, m in enumerate(media_items[:limit])]

print(json.dumps({
    'ok': True,
    'type': ctype,
    'id': cid,
    'title': title,
    'entries': entries,
    'total': total,
    'truncated': truncated,
    'videoCount': sum(1 for e in entries if e['mediaType'] == 'video'),
}))
`;

// Strip ANSI escape codes from terminal output
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHFABCDST]/g, '');
}

/**
 * Find the `tdn` binary in common locations.
 * @returns {string|null}
 */
function getDjManagerTidalBinPath() {
  try {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(app.getPath('userData'), 'bin', `tdn${ext}`);
  } catch {
    return null;
  }
}

export function findTidalDlPath() {
  const managed = getDjManagerTidalBinPath();
  const candidates = [
    // DjManager-managed install takes priority
    ...(managed ? [managed] : []),
    // Legacy system locations (pre-existing installs)
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
 * Search TIDAL by keyword using tidalapi's session search.
 * @param {string} query
 * @param {{ types?: string[], limit?: number }} [opts]
 * @returns {Promise<{ ok: boolean, results?: Array, error?: string }>}
 */
export async function searchTidal(query, opts = {}) {
  const pythonPath = findTidalPython();
  if (!pythonPath) {
    return { ok: false, error: 'Python interpreter not found. Ensure tidal-dl-ng is installed.' };
  }

  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return { ok: false, error: 'Not logged in to TIDAL. Please connect your account first.' };
  }

  const scriptPath = path.join(os.tmpdir(), 'dj_manager_tidal_search.py');
  try {
    fs.writeFileSync(scriptPath, SEARCH_SCRIPT.trimStart());
  } catch (e) {
    return { ok: false, error: `Failed to write search script: ${e.message}` };
  }

  const types = opts.types?.length ? opts.types.join(',') : 'track';
  const limit = opts.limit ?? 20;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(pythonPath, [scriptPath, query, tokenPath, types, String(limit)], {
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
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ ok: false, error: stderr.trim() || stdout.trim() || 'Failed to parse response' });
      }
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

export async function getTidalPreviewUrl(url) {
  const pythonPath = findTidalPython();
  if (!pythonPath) {
    return { ok: false, error: 'Python interpreter not found. Ensure tidal-dl-ng is installed.' };
  }

  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return { ok: false, error: 'Not logged in to TIDAL. Please connect your account first.' };
  }

  const scriptPath = path.join(os.tmpdir(), 'dj_manager_tidal_preview.py');
  try {
    fs.writeFileSync(scriptPath, PREVIEW_URL_SCRIPT.trimStart());
  } catch (e) {
    return { ok: false, error: `Failed to write preview script: ${e.message}` };
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
        resolve(JSON.parse(stdout.trim()));
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
 * Argument vector for the collections-list script.
 * Exported so the argument building can be unit tested without spawning python.
 * @param {string} scriptPath
 * @param {string} tokenPath
 * @returns {string[]}
 */
export function buildCollectionsArgs(scriptPath, tokenPath) {
  return [scriptPath, tokenPath];
}

/**
 * Argument vector for the collection-tracks resolver script.
 * @param {string} scriptPath
 * @param {string} type  Collection type: playlist | mix | album | artist | favorites | track | video
 * @param {string} id    Collection id (for `favorites`: tracks | albums | artists | videos)
 * @param {string} tokenPath
 * @param {number} [limit]  Maximum number of entries to return (default 500)
 * @returns {string[]}
 */
export function buildCollectionTracksArgs(scriptPath, type, id, tokenPath, limit = 500) {
  return [scriptPath, String(type), String(id), tokenPath, String(limit)];
}

/**
 * Parse the JSON payload an embedded TIDAL script printed to stdout.
 * Falls back to an error object carrying stderr/stdout so callers never throw.
 * @param {string} stdout
 * @param {string} stderr
 * @returns {object}
 */
export function parseTidalScriptOutput(stdout, stderr) {
  const out = (stdout ?? '').trim();
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, error: (stderr ?? '').trim() || out || 'Failed to parse response' };
  }
}

/**
 * Normalize the raw collections payload into a stable shape for the renderer.
 * @param {object} raw
 * @returns {{ ok: boolean, collections: Array, warnings: string[], error?: string }}
 */
export function normalizeTidalCollections(raw) {
  if (!raw || raw.ok !== true) {
    return {
      ok: false,
      error: raw?.error ?? 'Failed to list TIDAL collections',
      collections: [],
      warnings: [],
    };
  }
  const collections = (Array.isArray(raw.collections) ? raw.collections : [])
    .map((c) => ({
      id: c?.id !== undefined && c?.id !== null ? String(c.id).trim() : '',
      type: c?.type ? String(c.type).trim() : '',
      title: c?.title ? String(c.title) : '',
      group: c?.group ? String(c.group) : 'other',
      parentId: c?.parentId ? String(c.parentId) : null,
      subtitle: c?.subtitle ? String(c.subtitle) : '',
      mixType: c?.mixType ? String(c.mixType) : '',
      count: Number.isFinite(c?.count) ? c.count : 0,
    }))
    // A collection without an id or a type cannot be resolved for download.
    .filter((c) => c.id && c.type)
    .map((c) => ({ ...c, title: c.title || c.id }));
  return {
    ok: true,
    collections,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}

/**
 * Normalize the raw collection-tracks payload into download entries.
 * `mediaType` is 'track' or 'video' - tdn saves videos as .mp4/.ts, which the
 * DjManager audio importer cannot read, so the download path must drop them.
 * @param {object} raw
 * @returns {{ ok: boolean, entries: Array, title: string, type: string, truncated: boolean, total: number, error?: string }}
 */
export function normalizeTidalCollectionTracks(raw) {
  if (!raw || raw.ok !== true) {
    return {
      ok: false,
      error: raw?.error ?? 'Failed to load the TIDAL collection',
      entries: [],
      title: '',
      type: '',
      truncated: false,
      total: 0,
      videoCount: 0,
    };
  }
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map((e, i) => ({
      index: Number.isInteger(e?.index) ? e.index : i,
      id: e?.id !== undefined && e?.id !== null ? String(e.id) : '',
      title: e?.title ? String(e.title) : '',
      artist: e?.artist ? String(e.artist) : '',
      duration: Number.isFinite(e?.duration) ? e.duration : 0,
      url: e?.url ? String(e.url) : '',
      mediaType: e?.mediaType === 'video' ? 'video' : 'track',
    }))
    .filter((e) => e.id);
  return {
    ok: true,
    entries,
    title: raw.title ? String(raw.title) : '',
    type: raw.type ? String(raw.type) : '',
    truncated: raw.truncated === true,
    total: Number.isFinite(raw.total) ? raw.total : entries.length,
    videoCount: Number.isFinite(raw.videoCount)
      ? raw.videoCount
      : entries.filter((e) => e.mediaType === 'video').length,
  };
}

/**
 * Re-index entries from 0 in their current order.
 *
 * The download path reports progress positionally: the file reported by
 * `onFileReady` is matched to the entry at the same position, and the renderer
 * writes the Nth update into the Nth status row. Entry indices therefore must
 * be contiguous - a user-deselected selection (0, 2, 5) would otherwise leave
 * rows stuck on "pending" and overwrite the wrong titles.
 *
 * @param {Array} entries
 * @returns {Array}
 */
export function reindexTidalEntries(entries) {
  return (entries ?? []).map((entry, i) => ({ ...entry, index: i }));
}

/**
 * Split resolved collection entries into the audio tracks DjManager can import
 * and the video items it cannot (tdn saves videos as .mp4/.ts).
 *
 * The audio entries are RE-INDEXED from 0 for the same positional-mapping
 * reason as `reindexTidalEntries`.
 *
 * @param {Array} entries
 * @returns {{ tracks: Array, videoCount: number }}
 */
export function splitTidalCollectionEntries(entries) {
  const audio = [];
  let videoCount = 0;
  for (const entry of entries ?? []) {
    if (entry?.mediaType === 'video') videoCount += 1;
    else audio.push(entry);
  }
  return { tracks: reindexTidalEntries(audio), videoCount };
}

/**
 * List the logged-in TIDAL account's collections (playlists, mixes & radio,
 * favorites) using the existing tdn OAuth session/token.
 * @returns {Promise<{ ok: boolean, collections: Array, warnings: string[], error?: string }>}
 */
export async function fetchTidalCollections() {
  const pythonPath = findTidalPython();
  if (!pythonPath) {
    return {
      ok: false,
      error: 'Python interpreter not found. Ensure tidal-dl-ng is installed.',
      collections: [],
      warnings: [],
    };
  }

  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return {
      ok: false,
      error: 'Not logged in to TIDAL. Please connect your account first.',
      collections: [],
      warnings: [],
    };
  }

  const scriptPath = path.join(os.tmpdir(), 'dj_manager_tidal_collections.py');
  try {
    fs.writeFileSync(scriptPath, COLLECTIONS_SCRIPT.trimStart());
  } catch (e) {
    return {
      ok: false,
      error: `Failed to write collections script: ${e.message}`,
      collections: [],
      warnings: [],
    };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(pythonPath, buildCollectionsArgs(scriptPath, tokenPath), {
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
      resolve(normalizeTidalCollections(parseTidalScriptOutput(stdout, stderr)));
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message, collections: [], warnings: [] });
    });
  });
}

/**
 * Resolve one TIDAL collection into individual track/video entries.
 * @param {string} type   playlist | mix | album | artist | favorites | track | video
 * @param {string} id     Collection id (for `favorites`: tracks | albums | artists | videos)
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ ok: boolean, entries: Array, title: string, truncated: boolean, error?: string }>}
 */
export async function fetchTidalCollectionTracks(type, id, opts = {}) {
  const fallback = { entries: [], title: '', type: '', truncated: false, total: 0 };

  if (!type || id === undefined || id === null || id === '') {
    return { ok: false, error: 'Missing collection type or id', ...fallback };
  }

  const pythonPath = findTidalPython();
  if (!pythonPath) {
    return {
      ok: false,
      error: 'Python interpreter not found. Ensure tidal-dl-ng is installed.',
      ...fallback,
    };
  }

  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return {
      ok: false,
      error: 'Not logged in to TIDAL. Please connect your account first.',
      ...fallback,
    };
  }

  const scriptPath = path.join(os.tmpdir(), 'dj_manager_tidal_collection_tracks.py');
  try {
    fs.writeFileSync(scriptPath, COLLECTION_TRACKS_SCRIPT.trimStart());
  } catch (e) {
    return { ok: false, error: `Failed to write collection script: ${e.message}`, ...fallback };
  }

  const limit = opts.limit ?? 500;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(
      pythonPath,
      buildCollectionTracksArgs(scriptPath, type, id, tokenPath, limit),
      {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', () => {
      resolve(normalizeTidalCollectionTracks(parseTidalScriptOutput(stdout, stderr)));
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message, ...fallback });
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
