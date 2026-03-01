import { describe, it, expect } from 'vitest';
import {
  createPlaylist,
  getPlaylists,
  getPlaylist,
  renamePlaylist,
  updatePlaylistColor,
  deletePlaylist,
  addTracksToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  getPlaylistTracks,
  getPlaylistsForTrack,
  clearPlaylists,
} from '../db/playlistRepository.js';
import { addTrack, getTracks, clearTracks } from '../db/trackRepository.js';

const TRACK = {
  title: 'Track A',
  artist: 'Artist',
  album: '',
  duration: 200,
  file_path: '/tmp/a.mp3',
  file_hash: 'aaa',
  format: 'mp3',
  bitrate: 320000,
};

describe('playlistRepository', () => {
  describe('createPlaylist / getPlaylists', () => {
    it('creates a playlist and lists it', () => {
      createPlaylist('Techno Set', '#e63946');
      const playlists = getPlaylists();
      expect(playlists).toHaveLength(1);
      expect(playlists[0].name).toBe('Techno Set');
      expect(playlists[0].color).toBe('#e63946');
      expect(playlists[0].track_count).toBe(0);
    });

    it('includes track count and total duration', () => {
      const plId = createPlaylist('House Set', null);
      const tId1 = addTrack(TRACK);
      const tId2 = addTrack({ ...TRACK, title: 'B', file_hash: 'bbb', file_path: '/tmp/b.mp3' });
      addTracksToPlaylist(plId, [tId1, tId2]);

      const pl = getPlaylist(plId);
      expect(pl.track_count).toBe(2);
      expect(pl.total_duration).toBeCloseTo(400);
    });
  });

  describe('renamePlaylist', () => {
    it('updates the name', () => {
      const id = createPlaylist('Old Name', null);
      renamePlaylist(id, 'New Name');
      expect(getPlaylist(id).name).toBe('New Name');
    });
  });

  describe('updatePlaylistColor', () => {
    it('updates the color', () => {
      const id = createPlaylist('Set', null);
      updatePlaylistColor(id, '#00bbf9');
      expect(getPlaylist(id).color).toBe('#00bbf9');
    });
  });

  describe('addTracksToPlaylist / getPlaylistTracks', () => {
    it('adds tracks in order', () => {
      const plId = createPlaylist('My Set', null);
      const t1 = addTrack(TRACK);
      const t2 = addTrack({ ...TRACK, title: 'B', file_hash: 'bbb', file_path: '/tmp/b.mp3' });
      addTracksToPlaylist(plId, [t1, t2]);

      const tracks = getPlaylistTracks(plId);
      expect(tracks).toHaveLength(2);
      expect(tracks[0].id).toBe(t1);
      expect(tracks[1].id).toBe(t2);
    });

    it('ignores duplicate adds', () => {
      const plId = createPlaylist('Dedup', null);
      const t = addTrack(TRACK);
      addTracksToPlaylist(plId, [t]);
      addTracksToPlaylist(plId, [t]); // duplicate
      expect(getPlaylistTracks(plId)).toHaveLength(1);
    });
  });

  describe('removeTrackFromPlaylist', () => {
    it('removes only the specified track', () => {
      const plId = createPlaylist('Set', null);
      const t1 = addTrack(TRACK);
      const t2 = addTrack({ ...TRACK, title: 'B', file_hash: 'bbb', file_path: '/tmp/b.mp3' });
      addTracksToPlaylist(plId, [t1, t2]);
      removeTrackFromPlaylist(plId, t1);

      const tracks = getPlaylistTracks(plId);
      expect(tracks).toHaveLength(1);
      expect(tracks[0].id).toBe(t2);
    });
  });

  describe('reorderPlaylistTracks', () => {
    it('reorders tracks', () => {
      const plId = createPlaylist('Set', null);
      const t1 = addTrack(TRACK);
      const t2 = addTrack({ ...TRACK, title: 'B', file_hash: 'bbb', file_path: '/tmp/b.mp3' });
      const t3 = addTrack({ ...TRACK, title: 'C', file_hash: 'ccc', file_path: '/tmp/c.mp3' });
      addTracksToPlaylist(plId, [t1, t2, t3]);

      reorderPlaylistTracks(plId, [t3, t1, t2]);
      const tracks = getPlaylistTracks(plId);
      expect(tracks.map((t) => t.id)).toEqual([t3, t1, t2]);
    });
  });

  describe('getPlaylistsForTrack', () => {
    it('returns all playlists with is_member flag', () => {
      const pl1 = createPlaylist('A', null);
      const pl2 = createPlaylist('B', null);
      const t = addTrack(TRACK);
      addTracksToPlaylist(pl1, [t]);

      const result = getPlaylistsForTrack(t);
      expect(result).toHaveLength(2);
      const member = result.find((p) => p.id === pl1);
      const nonMember = result.find((p) => p.id === pl2);
      expect(member.is_member).toBe(1);
      expect(nonMember.is_member).toBe(0);
    });
  });

  describe('deletePlaylist', () => {
    it('removes the playlist and cascades to playlist_tracks', () => {
      const plId = createPlaylist('Temp', null);
      const t = addTrack(TRACK);
      addTracksToPlaylist(plId, [t]);
      deletePlaylist(plId);

      expect(getPlaylist(plId)).toBeUndefined();
      expect(getPlaylistTracks(plId)).toHaveLength(0);
    });
  });

  describe('clearPlaylists + clearTracks (clear-library behaviour)', () => {
    it('clearPlaylists removes all playlists', () => {
      createPlaylist('Set A', null);
      createPlaylist('Set B', '#ff0000');
      expect(getPlaylists()).toHaveLength(2);
      clearPlaylists();
      expect(getPlaylists()).toHaveLength(0);
    });

    it('clearTracks then clearPlaylists leaves both tables empty', () => {
      const plId = createPlaylist('DJ Set', null);
      const tId = addTrack(TRACK);
      addTracksToPlaylist(plId, [tId]);

      clearTracks();
      clearPlaylists();

      expect(getTracks({ limit: 100 })).toHaveLength(0);
      expect(getPlaylists()).toHaveLength(0);
    });

    it('clearPlaylists cascades to playlist_tracks', () => {
      const plId = createPlaylist('Set', null);
      const tId = addTrack(TRACK);
      addTracksToPlaylist(plId, [tId]);

      clearPlaylists();

      // Playlist is gone; its tracks association is gone too
      expect(getPlaylist(plId)).toBeUndefined();
      expect(getPlaylistTracks(plId)).toHaveLength(0);
      // But the track itself still exists
      expect(getTracks({ limit: 100 })).toHaveLength(1);
    });
  });
});
