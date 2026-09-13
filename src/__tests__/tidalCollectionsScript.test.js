/**
 * Runs the embedded TIDAL collection Python scripts against a stub `tidalapi`
 * module, with a fake token file. No network and no real TIDAL account: the
 * stub stands in for tidalapi and records what the script asks of it.
 *
 * Skipped when no usable Python interpreter exists on the machine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { COLLECTIONS_SCRIPT, COLLECTION_TRACKS_SCRIPT } from '../audio/tidalDlManager.js';

function findPython() {
  for (const bin of ['python3', 'python']) {
    try {
      const out = execSync(`${bin} -c "import sys; print(sys.version_info[0])"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      }).trim();
      if (out === '3') return bin;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const PYTHON = findPython();

const STUB_TIDALAPI = `
class _Artist:
    def __init__(self, id, name, top=None):
        self.id = id
        self.name = name
        self._top = top or []

    def get_top_tracks(self, limit=None, offset=0):
        return self._top[offset:offset + (limit or len(self._top))]


class Track:
    def __init__(self, id, name, artist='Artist', duration=200):
        self.id = id
        self.name = name
        self.artist = _Artist('900', artist)
        self.duration = duration
        self.share_url = 'https://tidal.com/browse/track/' + str(id)


class Video:
    def __init__(self, id, name, artist='VidArtist', duration=120):
        self.id = id
        self.name = name
        self.artist = _Artist('901', artist)
        self.duration = duration
        self.share_url = 'https://tidal.com/browse/video/' + str(id)


class Playlist:
    def __init__(self, id, name, items=None):
        self.id = id
        self.name = name
        self._items = items or []
        self.num_tracks = len([i for i in self._items if not isinstance(i, Video)])
        self.num_videos = len([i for i in self._items if isinstance(i, Video)])
        self.share_url = 'https://tidal.com/browse/playlist/' + str(id)

    def items(self, limit=100, offset=0):
        return self._items[offset:offset + limit]

    def tracks(self, limit=None, offset=0):
        tracks = [i for i in self._items if not isinstance(i, Video)]
        return tracks[offset:offset + (limit or len(tracks))]


class Album:
    def __init__(self, id, name, tracks):
        self.id = id
        self.name = name
        self._tracks = tracks

    def tracks(self, limit=None, offset=0):
        return self._tracks[offset:offset + (limit or len(self._tracks))]


class Mix:
    def __init__(self, id, title, items):
        self.id = id
        self.title = title
        self.sub_title = 'Daily'
        self._items = items

    def items(self):
        return self._items


class MixV2:
    """Shape returned by Session.mixes().categories[0].items."""

    def __init__(self, id, title, sub_title='', items=None):
        self.id = id
        self.title = title
        self.sub_title = sub_title
        self.short_subtitle = sub_title
        self.mix_type = None
        self._items = items


class _Category:
    def __init__(self, items):
        self.items = items


class Page:
    def __init__(self, items):
        self.categories = [_Category(items)]


_TRACKS = [Track('111', 'One', 'A'), Track('222', 'Two', 'B')]
_VIDEOS = [Video('777', 'Video One')]
_ALBUM = Album('555', 'Album One', [Track('333', 'Album Track')])
_ARTIST = _Artist('521', 'Doja Cat', top=[Track('444', 'Top Track')])


class Favorites:
    def __init__(self):
        self._mixes = [Mix('mix-9', 'Favorite mix', [Track('666', 'Mix Track')])]

    def playlists_paginated(self, order=None, order_direction=None):
        return [Playlist('pl-1', 'Uptempo', _TRACKS)]

    def tracks_paginated(self, order=None, order_direction=None):
        return list(_TRACKS)

    def videos_paginated(self, order=None, order_direction=None):
        return list(_VIDEOS)

    def albums_paginated(self, order=None, order_direction=None):
        return [_ALBUM]

    def artists_paginated(self, order=None, order_direction=None):
        return [_ARTIST]

    def mixes(self, limit=50, offset=0):
        return list(self._mixes)

    def _count(self, items):
        return len(items)

    def get_tracks_count(self):
        return len(_TRACKS)

    def get_albums_count(self):
        return 1

    def get_artists_count(self):
        return 1

    def get_videos_count(self):
        return len(_VIDEOS)


class _User:
    def __init__(self):
        self.favorites = Favorites()

    def playlist_and_favorite_playlists(self, offset=0, limit=50):
        if offset > 0:
            return []
        return [Playlist('pl-2', 'Created by me', [Track('888', 'Own Track')])]


class Session:
    def __init__(self):
        self.user = _User()

    def load_oauth_session(self, token_type, access_token, refresh_token=None):
        assert access_token == 'stub-token', 'script must pass the token from the token file'
        return True

    def check_login(self):
        return True

    def mixes(self):
        return Page([
            MixV2('mix-1', 'My Mix 1', 'Mix'),
            MixV2('mix-2', 'My Daily Discovery', 'Daily'),
            MixV2('mix-3', 'My Video Mix 1', 'Video', items=_VIDEOS),
        ])

    def playlist(self, playlist_id):
        return Playlist(str(playlist_id), 'Playlist ' + str(playlist_id), _TRACKS + _VIDEOS)

    def mix(self, mix_id):
        items = {'mix-9': [Track('666', 'Mix Track')]}.get(str(mix_id), _TRACKS)
        return Mix(str(mix_id), 'Mix ' + str(mix_id), items)

    def album(self, album_id):
        return _ALBUM

    def artist(self, artist_id):
        return _ARTIST

    def track(self, track_id):
        return Track(str(track_id), 'Single Track', 'Solo')

    def video(self, video_id):
        return Video(str(video_id), 'Single Video')
`;

const TOKEN = { token_type: 'Bearer', access_token: 'stub-token', refresh_token: 'r' };

let tmpDir = null;
let collectionsScript = null;
let tracksScript = null;

const runScript = (script, args) => {
  const stdout = execFileSync(PYTHON ?? 'python3', [script, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PYTHONPATH: tmpDir + path.delimiter + (process.env.PYTHONPATH ?? ''),
      PYTHONIOENCODING: 'utf-8',
    },
  });
  return JSON.parse(stdout.trim());
};

describe.skipIf(!PYTHON)('embedded TIDAL collection scripts (stub tidalapi)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djm-tidal-stub-'));
    fs.writeFileSync(path.join(tmpDir, 'tidalapi.py'), STUB_TIDALAPI.trimStart());
    fs.writeFileSync(path.join(tmpDir, 'token.json'), JSON.stringify(TOKEN));
    // NOTE: never name these 'collections.py' - the script dir is on sys.path and
    // would shadow the stdlib collections module.
    collectionsScript = path.join(tmpDir, 'djm_collections.py');
    tracksScript = path.join(tmpDir, 'djm_collection_tracks.py');
    fs.writeFileSync(collectionsScript, COLLECTIONS_SCRIPT.trimStart());
    fs.writeFileSync(tracksScript, COLLECTION_TRACKS_SCRIPT.trimStart());
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('collections listing', () => {
    it('lists playlists (created + favorited), mixes & radio and every favorites node', () => {
      const res = runScript(collectionsScript, ['token.json']);

      expect(res.ok).toBe(true);
      expect(res.warnings).toEqual([]);

      const byType = {};
      for (const c of res.collections) {
        byType[c.type] = byType[c.type] ?? [];
        byType[c.type].push(c);
      }

      // Favorited playlists and the user's own playlists, deduplicated.
      expect(byType.playlist.map((c) => c.id)).toEqual(['pl-1', 'pl-2']);
      expect(byType.playlist[0].group).toBe('playlists');
      expect(byType.playlist[0].count).toBe(2);

      // My Mix 1-8 / My Daily Discovery / video mixes from session.mixes().
      expect(byType.mix.map((c) => c.id)).toEqual(['mix-1', 'mix-2', 'mix-3']);
      expect(byType.mix.map((c) => c.title)).toEqual([
        'My Mix 1',
        'My Daily Discovery',
        'My Video Mix 1',
      ]);
      expect(byType.mix[1].subtitle).toBe('Daily');

      // Favorites: tracks / albums / artists / videos / mixes.
      expect(byType.favorites.map((c) => c.id)).toEqual([
        'tracks',
        'albums',
        'artists',
        'videos',
        'mixes',
      ]);
      expect(byType.favorites[0].count).toBe(2);
      expect(byType.favorites[3].title).toBe('Favorite videos');

      // Favorite artists are nested under the "artists" node.
      expect(byType.artist).toEqual([
        expect.objectContaining({ id: '521', title: 'Doja Cat', parentId: 'artists' }),
      ]);
    });

    it('reports a session error instead of a collection list', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'bad-token.json'),
        JSON.stringify({ token_type: 'Bearer' })
      );
      let res;
      try {
        runScript(collectionsScript, ['bad-token.json']);
        throw new Error('script should have exited non-zero');
      } catch (err) {
        res = JSON.parse((err.stdout ?? '').toString().trim());
      }
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Session error/);
    });
  });

  describe('collection track resolution', () => {
    it('resolves favorited tracks as audio entries', () => {
      const res = runScript(tracksScript, ['favorites', 'tracks', 'token.json', '500']);

      expect(res.ok).toBe(true);
      expect(res.title).toBe('Favorite tracks');
      expect(res.total).toBe(2);
      expect(res.truncated).toBe(false);
      expect(res.videoCount).toBe(0);
      expect(res.entries).toEqual([
        {
          index: 0,
          id: '111',
          title: 'One',
          artist: 'A',
          duration: 200,
          url: 'https://tidal.com/browse/track/111',
          mediaType: 'track',
        },
        {
          index: 1,
          id: '222',
          title: 'Two',
          artist: 'B',
          duration: 200,
          url: 'https://tidal.com/browse/track/222',
          mediaType: 'track',
        },
      ]);
    });

    it('marks favorite videos as video entries', () => {
      const res = runScript(tracksScript, ['favorites', 'videos', 'token.json']);

      expect(res.ok).toBe(true);
      expect(res.videoCount).toBe(1);
      expect(res.entries[0].mediaType).toBe('video');
      expect(res.entries[0].url).toBe('https://tidal.com/browse/video/777');
    });

    it('flattens favorite albums and favorite artists into tracks', () => {
      const albums = runScript(tracksScript, ['favorites', 'albums', 'token.json']);
      expect(albums.entries.map((e) => e.id)).toEqual(['333']);

      const artists = runScript(tracksScript, ['favorites', 'artists', 'token.json']);
      expect(artists.entries.map((e) => e.id)).toEqual(['444']);
      expect(artists.title).toBe('Favorite artists');
    });

    it('resolves a playlist, keeping its videos flagged', () => {
      const res = runScript(tracksScript, ['playlist', 'pl-1', 'token.json']);

      expect(res.ok).toBe(true);
      expect(res.type).toBe('playlist');
      expect(res.entries.map((e) => e.mediaType)).toEqual(['track', 'track', 'video']);
      expect(res.videoCount).toBe(1);
    });

    it('resolves a mix through session.mix()', () => {
      const res = runScript(tracksScript, ['mix', 'mix-1', 'token.json']);

      expect(res.ok).toBe(true);
      expect(res.title).toBe('Mix mix-1');
      expect(res.entries.map((e) => e.id)).toEqual(['111', '222']);
    });

    it('resolves a nested favorite artist by id', () => {
      const res = runScript(tracksScript, ['artist', '521', 'token.json']);
      expect(res.ok).toBe(true);
      expect(res.title).toBe('Doja Cat');
      expect(res.entries.map((e) => e.id)).toEqual(['444']);
    });

    it('resolves favorite mixes & radio', () => {
      const res = runScript(tracksScript, ['favorites', 'mixes', 'token.json']);
      expect(res.ok).toBe(true);
      expect(res.title).toBe('Favorite mixes & radio');
      expect(res.entries.map((e) => e.id)).toEqual(['666']);
    });

    it('honours the limit argument and flags truncation', () => {
      const res = runScript(tracksScript, ['favorites', 'tracks', 'token.json', '1']);
      expect(res.total).toBe(2);
      expect(res.truncated).toBe(true);
      expect(res.entries).toHaveLength(1);
    });

    it('reports unsupported collection types instead of crashing', () => {
      let res;
      try {
        runScript(tracksScript, ['nonsense', 'x', 'token.json']);
        throw new Error('script should have exited non-zero');
      } catch (err) {
        res = JSON.parse((err.stdout ?? '').toString().trim());
      }
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Unsupported collection type/);
    });

    it('reports an unknown favorites kind instead of crashing', () => {
      let res;
      try {
        runScript(tracksScript, ['favorites', 'boom', 'token.json']);
        throw new Error('script should have exited non-zero');
      } catch (err) {
        res = JSON.parse((err.stdout ?? '').toString().trim());
      }
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Unknown favorites collection/);
    });
  });
});
