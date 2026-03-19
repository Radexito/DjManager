import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../deps.js', () => ({ getYtDlpRuntimePath: () => '/usr/bin/yt-dlp' }));

import { detectPlatform } from '../audio/ytDlpManager.js';

describe('detectPlatform', () => {
  it('returns youtube for youtube.com URLs', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(detectPlatform('https://youtube.com/playlist?list=abc123')).toBe('youtube');
  });

  it('returns youtube for youtu.be URLs', () => {
    expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
  });

  it('returns soundcloud for soundcloud.com URLs', () => {
    expect(detectPlatform('https://soundcloud.com/artist/track')).toBe('soundcloud');
  });

  it('returns bandcamp for bandcamp.com URLs', () => {
    expect(detectPlatform('https://someartist.bandcamp.com/album/release')).toBe('bandcamp');
  });

  it('returns other for generic/unrecognised URLs', () => {
    expect(detectPlatform('https://vimeo.com/123456789')).toBe('other');
    expect(detectPlatform('https://example.com/audio.mp3')).toBe('other');
  });

  it('returns other for invalid / non-URL strings', () => {
    expect(detectPlatform('not-a-url')).toBe('other');
    expect(detectPlatform('')).toBe('other');
    expect(detectPlatform('just some text')).toBe('other');
  });
});
