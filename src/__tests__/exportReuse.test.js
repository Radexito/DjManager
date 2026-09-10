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

// #463 — a track whose trim range changed must be copied again, otherwise the
// stick keeps the audio of the OLD trim range.
describe('reuseExistingUsbTrack — trim range handling (#463)', () => {
  const withTrim = (trim_start_ms, trim_end_ms) => ({
    file_path: '/music/Artist - Title.mp3',
    file_size: 12345,
    bitrate: 320,
    trim_start_ms,
    trim_end_ms,
  });

  it('reuses the file when the stored trim matches the current trim', () => {
    const existingTracks = new Map([['track-1', withTrim(30_000, 120_000)]]);
    const usedNames = new Map();

    const result = reuseExistingUsbTrack(existingTracks, 'track-1', usedNames, {
      trimStartMs: 30_000,
      trimEndMs: 120_000,
    });

    expect(result).toEqual({
      path: '/music/Artist - Title.mp3',
      meta: { fileSize: 12345, bitrate: 320 },
    });
  });

  it('forces a re-copy when a trim was added to an untrimmed export', () => {
    const existingTracks = new Map([['track-1', withTrim(null, null)]]);

    expect(
      reuseExistingUsbTrack(existingTracks, 'track-1', new Map(), {
        trimStartMs: 15_000,
        trimEndMs: null,
      })
    ).toBeNull();
  });

  it('forces a re-copy when the trim was cleared after a trimmed export', () => {
    const existingTracks = new Map([['track-1', withTrim(15_000, 120_000)]]);

    expect(
      reuseExistingUsbTrack(existingTracks, 'track-1', new Map(), {
        trimStartMs: null,
        trimEndMs: null,
      })
    ).toBeNull();
  });

  it('forces a re-copy when either trim point moved', () => {
    const existingTracks = new Map([['track-1', withTrim(15_000, 120_000)]]);

    expect(
      reuseExistingUsbTrack(existingTracks, 'track-1', new Map(), {
        trimStartMs: 20_000,
        trimEndMs: 120_000,
      })
    ).toBeNull();
    expect(
      reuseExistingUsbTrack(existingTracks, 'track-1', new Map(), {
        trimStartMs: 15_000,
        trimEndMs: 119_000,
      })
    ).toBeNull();
  });

  it('treats a manifest without trim fields as untrimmed', () => {
    const existingTracks = new Map([
      ['track-1', { file_path: '/music/Artist - Title.mp3' }], // pre-#463 manifest
    ]);

    expect(reuseExistingUsbTrack(existingTracks, 'track-1', new Map(), {})).not.toBeNull();
    expect(
      reuseExistingUsbTrack(existingTracks, 'track-1', new Map(), { trimStartMs: 15_000 })
    ).toBeNull();
  });

  it('keeps the trim check before registering the filename', () => {
    const existingTracks = new Map([['track-1', withTrim(15_000, null)]]);
    const usedNames = new Map();

    reuseExistingUsbTrack(existingTracks, 'track-1', usedNames, { trimStartMs: 9999 });

    expect(usedNames.size).toBe(0);
  });
});
