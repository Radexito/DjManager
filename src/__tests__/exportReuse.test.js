import { describe, it, expect } from 'vitest';
import { reuseExistingUsbTrack } from '../usb/exportReuse.js';

describe('reuseExistingUsbTrack', () => {
  it('returns null when the track is not in the existing manifest', () => {
    const existingTracks = new Map();
    const usedNames = new Map();
    expect(reuseExistingUsbTrack(existingTracks, 'track-1', usedNames)).toBeNull();
    expect(usedNames.size).toBe(0);
  });

  it('returns null when the manifest entry has no file_path', () => {
    const existingTracks = new Map([['track-1', {}]]);
    const usedNames = new Map();
    expect(reuseExistingUsbTrack(existingTracks, 'track-1', usedNames)).toBeNull();
  });

  it('reuses the stored path and registers the filename in usedNames', () => {
    const existingTracks = new Map([
      ['track-1', { file_path: '/music/Artist - Title.mp3', file_size: 12345, bitrate: 320 }],
    ]);
    const usedNames = new Map();

    const result = reuseExistingUsbTrack(existingTracks, 'track-1', usedNames);

    expect(result).toEqual({
      path: '/music/Artist - Title.mp3',
      meta: { fileSize: 12345, bitrate: 320 },
    });
    expect(usedNames.get('artist - title.mp3')).toBe(true);
  });

  it('returns meta: null when the manifest entry has no file_size or bitrate', () => {
    const existingTracks = new Map([['track-1', { file_path: '/music/Track.mp3' }]]);
    const usedNames = new Map();

    const result = reuseExistingUsbTrack(existingTracks, 'track-1', usedNames);

    expect(result).toEqual({ path: '/music/Track.mp3', meta: null });
  });

  it('does not collide with a different track already registered in usedNames', () => {
    const existingTracks = new Map([
      ['track-1', { file_path: '/music/Artist - Title.mp3' }],
      ['track-2', { file_path: '/music/Other - Song.mp3' }],
    ]);
    const usedNames = new Map();

    reuseExistingUsbTrack(existingTracks, 'track-1', usedNames);
    reuseExistingUsbTrack(existingTracks, 'track-2', usedNames);

    expect(usedNames.size).toBe(2);
    expect(usedNames.get('artist - title.mp3')).toBe(true);
    expect(usedNames.get('other - song.mp3')).toBe(true);
  });
});
