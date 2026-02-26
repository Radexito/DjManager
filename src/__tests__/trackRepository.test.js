import { describe, it, expect } from 'vitest';
import {
  addTrack,
  getTracks,
  getTrackById,
  updateTrack,
  removeTrack,
  getTrackIds,
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
  });

  describe('getTrackIds', () => {
    it('returns array of IDs', () => {
      const id1 = addTrack(SAMPLE);
      const id2 = addTrack({ ...SAMPLE, file_hash: 'zzz', file_path: '/tmp/z.mp3' });
      const ids = getTrackIds({});
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
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
});
