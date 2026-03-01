import { describe, it, expect } from 'vitest';
import {
  addTrack,
  getTracks,
  getTrackById,
  getTrackByHash,
  updateTrack,
  removeTrack,
  getTrackIds,
  normalizeLibrary,
  clearTracks,
} from '../db/trackRepository.js';

const SAMPLE = {
  title: 'Test Track',
  artist: 'Test Artist',
  album: 'Test Album',
  duration: 180.5,
  file_path: '/tmp/test.mp3',
  file_hash: 'abc123',
  format: 'mp3',
  bitrate: 320000,
};

describe('trackRepository', () => {
  describe('addTrack / getTrackById', () => {
    it('inserts a track and returns it by ID', () => {
      const id = addTrack(SAMPLE);
      expect(id).toBeGreaterThan(0);

      const track = getTrackById(id);
      expect(track.title).toBe('Test Track');
      expect(track.artist).toBe('Test Artist');
      expect(track.duration).toBeCloseTo(180.5);
    });
  });

  describe('getTrackByHash', () => {
    it('returns track by file hash', () => {
      addTrack(SAMPLE);
      const track = getTrackByHash('abc123');
      expect(track).toBeDefined();
      expect(track.title).toBe('Test Track');
    });

    it('returns undefined for unknown hash', () => {
      expect(getTrackByHash('nope')).toBeUndefined();
    });
  });

  describe('getTracks', () => {
    it('returns all tracks', () => {
      addTrack(SAMPLE);
      addTrack({ ...SAMPLE, title: 'Second Track', file_hash: 'def456', file_path: '/tmp/b.mp3' });
      const tracks = getTracks({ limit: 50 });
      expect(tracks).toHaveLength(2);
    });

    it('filters by search term (title)', () => {
      addTrack(SAMPLE);
      addTrack({ ...SAMPLE, title: 'House Banger', file_hash: 'xyz', file_path: '/tmp/c.mp3' });
      const results = getTracks({ search: 'house' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('House Banger');
    });

    it('respects limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        addTrack({
          ...SAMPLE,
          title: `Track ${i}`,
          file_hash: `h${i}`,
          file_path: `/tmp/${i}.mp3`,
        });
      }
      const page1 = getTracks({ limit: 2, offset: 0 });
      const page2 = getTracks({ limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].title).not.toBe(page2[0].title);
    });

    it('filters by TITLE is', () => {
      addTrack(SAMPLE);
      addTrack({ ...SAMPLE, title: 'Other', file_hash: 'o1', file_path: '/tmp/o1.mp3' });
      const results = getTracks({ filters: [{ field: 'title', op: 'is', value: 'test track' }] });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Test Track');
    });

    it('filters by TITLE contains', () => {
      addTrack(SAMPLE);
      addTrack({
        ...SAMPLE,
        title: 'Deep House Banger',
        file_hash: 'dh1',
        file_path: '/tmp/dh1.mp3',
      });
      const results = getTracks({ filters: [{ field: 'title', op: 'contains', value: 'house' }] });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Deep House Banger');
    });

    it('filters by TITLE is not', () => {
      addTrack(SAMPLE);
      addTrack({ ...SAMPLE, title: 'Other', file_hash: 'o2', file_path: '/tmp/o2.mp3' });
      const results = getTracks({ filters: [{ field: 'title', op: 'is not', value: 'other' }] });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Test Track');
    });

    it('filters by BPM is', () => {
      const id = addTrack(SAMPLE);
      updateTrack(id, { bpm: 128 });
      addTrack({ ...SAMPLE, file_hash: 'bpm2', file_path: '/tmp/bpm2.mp3' });
      const results = getTracks({ filters: [{ field: 'bpm', op: 'is', value: 128 }] });
      expect(results).toHaveLength(1);
    });

    it('filters by BPM range', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { bpm: 130 });
      const id2 = addTrack({ ...SAMPLE, file_hash: 'bpm3', file_path: '/tmp/bpm3.mp3' });
      updateTrack(id2, { bpm: 150 });
      const results = getTracks({ filters: [{ field: 'bpm', op: 'range', from: 125, to: 135 }] });
      expect(results).toHaveLength(1);
    });

    it('filters by BPM > operator', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { bpm: 140 });
      const id2 = addTrack({ ...SAMPLE, file_hash: 'bpm4', file_path: '/tmp/bpm4.mp3' });
      updateTrack(id2, { bpm: 100 });
      const results = getTracks({ filters: [{ field: 'bpm', op: '>', value: 130 }] });
      expect(results).toHaveLength(1);
    });

    it('filters by KEY is', () => {
      const id = addTrack(SAMPLE);
      updateTrack(id, { key_camelot: '8a' });
      addTrack({ ...SAMPLE, file_hash: 'k2', file_path: '/tmp/k2.mp3' });
      const results = getTracks({ filters: [{ field: 'key', op: 'is', value: '8A' }] });
      expect(results).toHaveLength(1);
    });

    it('filters by KEY adjacent', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { key_camelot: '7a' }); // adjacent to 8A
      const id2 = addTrack({ ...SAMPLE, file_hash: 'k3', file_path: '/tmp/k3.mp3' });
      updateTrack(id2, { key_camelot: '9a' }); // adjacent to 8A
      const id3 = addTrack({ ...SAMPLE, file_hash: 'k4', file_path: '/tmp/k4.mp3' });
      updateTrack(id3, { key_camelot: '1a' }); // not adjacent
      const results = getTracks({ filters: [{ field: 'key', op: 'adjacent', value: '8A' }] });
      expect(results).toHaveLength(2);
    });

    it('filters by KEY mode switch', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { key_camelot: '8b' }); // mode switch of 8A
      const id2 = addTrack({ ...SAMPLE, file_hash: 'k5', file_path: '/tmp/k5.mp3' });
      updateTrack(id2, { key_camelot: '8a' }); // not mode switch
      const results = getTracks({ filters: [{ field: 'key', op: 'mode switch', value: '8A' }] });
      expect(results).toHaveLength(1);
    });

    it('filters by KEY matches (all 4)', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { key_camelot: '8a' }); // self
      const id2 = addTrack({ ...SAMPLE, file_hash: 'k6', file_path: '/tmp/k6.mp3' });
      updateTrack(id2, { key_camelot: '8b' }); // mode switch
      const id3 = addTrack({ ...SAMPLE, file_hash: 'k7', file_path: '/tmp/k7.mp3' });
      updateTrack(id3, { key_camelot: '7a' }); // adjacent
      const id4 = addTrack({ ...SAMPLE, file_hash: 'k8', file_path: '/tmp/k8.mp3' });
      updateTrack(id4, { key_camelot: '1b' }); // unrelated
      const results = getTracks({ filters: [{ field: 'key', op: 'matches', value: '8A' }] });
      expect(results).toHaveLength(3); // 8a, 8b, 7a (and 9a if present)
    });

    it('filters by GENRE is', () => {
      const id = addTrack(SAMPLE);
      updateTrack(id, { genres: JSON.stringify(['Techno', 'Industrial']) });
      addTrack({ ...SAMPLE, file_hash: 'g2', file_path: '/tmp/g2.mp3' });
      const results = getTracks({ filters: [{ field: 'genre', op: 'is', value: 'Techno' }] });
      expect(results).toHaveLength(1);
    });

    it('filters by GENRE contains', () => {
      const id = addTrack(SAMPLE);
      updateTrack(id, { genres: JSON.stringify(['Psytrance']) });
      addTrack({ ...SAMPLE, file_hash: 'g3', file_path: '/tmp/g3.mp3' });
      const results = getTracks({ filters: [{ field: 'genre', op: 'contains', value: 'psy' }] });
      expect(results).toHaveLength(1);
    });

    it('filters by GENRE is not', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { genres: JSON.stringify(['Techno']) });
      const id2 = addTrack({ ...SAMPLE, file_hash: 'g4', file_path: '/tmp/g4.mp3' });
      updateTrack(id2, { genres: JSON.stringify(['House']) });
      const results = getTracks({ filters: [{ field: 'genre', op: 'is not', value: 'House' }] });
      expect(results.map((t) => t.id)).toContain(id1);
      expect(results.map((t) => t.id)).not.toContain(id2);
    });

    it('stacks multiple filters (AND)', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { bpm: 128, key_camelot: '8a' });
      const id2 = addTrack({ ...SAMPLE, file_hash: 'st2', file_path: '/tmp/st2.mp3' });
      updateTrack(id2, { bpm: 140, key_camelot: '8a' });
      const results = getTracks({
        filters: [
          { field: 'bpm', op: 'is', value: 128 },
          { field: 'key', op: 'is', value: '8A' },
        ],
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(id1);
    });

    it('filters by YEAR range', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { year: 2020 });
      const id2 = addTrack({ ...SAMPLE, file_hash: 'yr2', file_path: '/tmp/yr2.mp3' });
      updateTrack(id2, { year: 2015 });
      const results = getTracks({
        filters: [{ field: 'year', op: 'range', from: 2018, to: 2022 }],
      });
      expect(results).toHaveLength(1);
    });

    it('filters by LOUDNESS >', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { loudness: -8 });
      const id2 = addTrack({ ...SAMPLE, file_hash: 'ld2', file_path: '/tmp/ld2.mp3' });
      updateTrack(id2, { loudness: -14 });
      const results = getTracks({ filters: [{ field: 'loudness', op: '>', value: -10 }] });
      expect(results).toHaveLength(1);
    });
  });

  describe('getTrackIds', () => {
    it('returns array of IDs', () => {
      const id1 = addTrack(SAMPLE);
      const id2 = addTrack({ ...SAMPLE, file_hash: 'zzz', file_path: '/tmp/z.mp3' });
      const ids = getTrackIds({});
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });

    it('returns filtered IDs with filters param', () => {
      const id1 = addTrack(SAMPLE);
      updateTrack(id1, { bpm: 128 });
      const id2 = addTrack({ ...SAMPLE, file_hash: 'fid2', file_path: '/tmp/fid2.mp3' });
      updateTrack(id2, { bpm: 140 });
      const ids = getTrackIds({ filters: [{ field: 'bpm', op: 'is', value: 128 }] });
      expect(ids).toContain(id1);
      expect(ids).not.toContain(id2);
    });
  });

  describe('updateTrack', () => {
    it('updates specified fields', () => {
      const id = addTrack(SAMPLE);
      updateTrack(id, { bpm: 128, key_raw: 'Am' });
      const track = getTrackById(id);
      expect(track.bpm).toBe(128);
      expect(track.key_raw).toBe('Am');
      expect(track.title).toBe('Test Track'); // unchanged
    });
  });

  describe('removeTrack', () => {
    it('deletes the track', () => {
      const id = addTrack(SAMPLE);
      removeTrack(id);
      expect(getTrackById(id)).toBeUndefined();
    });

    it('does not affect other tracks', () => {
      const id1 = addTrack(SAMPLE);
      const id2 = addTrack({ ...SAMPLE, file_hash: 'other', file_path: '/tmp/other.mp3' });
      removeTrack(id1);
      expect(getTrackById(id2)).toBeDefined();
    });
  });

  describe('normalizeLibrary', () => {
    it('sets replay_gain for tracks with loudness', () => {
      const id = addTrack(SAMPLE);
      updateTrack(id, { loudness: -14 });
      const changes = normalizeLibrary(-14);
      expect(changes).toBeGreaterThan(0);
      const track = getTrackById(id);
      expect(track.replay_gain).toBe(0);
    });

    it('returns 0 when no tracks have loudness', () => {
      addTrack(SAMPLE); // no loudness set
      const changes = normalizeLibrary(-14);
      expect(changes).toBe(0);
    });
  });

  describe('clearTracks', () => {
    it('removes all tracks', () => {
      addTrack(SAMPLE);
      addTrack({ ...SAMPLE, file_hash: 'ct2', file_path: '/tmp/ct2.mp3' });
      clearTracks();
      expect(getTracks({ limit: 100 })).toHaveLength(0);
    });
  });
});
