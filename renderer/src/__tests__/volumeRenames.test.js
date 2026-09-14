import { describe, it, expect } from 'vitest';
import { applyVolumeRenames, isDriveRoot } from '../volumeRenames.js';

describe('isDriveRoot', () => {
  it('detects Windows drive roots only', () => {
    expect(isDriveRoot('E:\\')).toBe(true);
    expect(isDriveRoot('E:')).toBe(true);
    expect(isDriveRoot('/run/media/u/USB')).toBe(false);
  });
});

describe('applyVolumeRenames', () => {
  it('rewrites a browsed folder when the drive letter changes', () => {
    const renames = [{ from: 'E:\\', to: 'D:\\' }];
    expect(applyVolumeRenames('E:\\music\\a.mp3', renames)).toBe('D:\\music\\a.mp3');
    expect(applyVolumeRenames('E:\\', renames)).toBe('D:\\');
    expect(applyVolumeRenames('E:', renames)).toBe('D:\\');
  });

  it('matches Windows roots case-insensitively', () => {
    expect(applyVolumeRenames('e:\\music', [{ from: 'E:\\', to: 'D:\\' }])).toBe('D:\\music');
  });

  it('leaves paths on other drives alone', () => {
    const renames = [{ from: 'E:\\', to: 'D:\\' }];
    expect(applyVolumeRenames('C:\\music', renames)).toBe('C:\\music');
    expect(applyVolumeRenames('F:\\music', renames)).toBe('F:\\music');
  });

  it('rewrites POSIX mount points without touching lookalikes', () => {
    const renames = [{ from: '/run/media/u/USB', to: '/media/u/USB' }];
    expect(applyVolumeRenames('/run/media/u/USB/music', renames)).toBe('/media/u/USB/music');
    expect(applyVolumeRenames('/run/media/u/USB2/music', renames)).toBe('/run/media/u/USB2/music');
  });

  it('anchors a naked Windows root with a backslash, not a slash', () => {
    // Detect-windows roots normally carry the separator, but a rename pair handed
    // in without one must still match real Windows paths (backslashes).
    expect(applyVolumeRenames('E:\\music', [{ from: 'E:', to: 'D:' }])).toBe('D:\\music');
    expect(applyVolumeRenames('E:', [{ from: 'E:', to: 'D:' }])).toBe('D:');
  });

  it('applies chained renames in order', () => {
    const renames = [
      { from: 'E:\\', to: 'F:\\' },
      { from: 'F:\\', to: 'G:\\' },
    ];
    expect(applyVolumeRenames('E:\\music', renames)).toBe('G:\\music');
  });

  it('returns the input untouched for empty or useless input', () => {
    expect(applyVolumeRenames(null, [{ from: 'E:\\', to: 'D:\\' }])).toBeNull();
    expect(applyVolumeRenames('E:\\music', [])).toBe('E:\\music');
    expect(applyVolumeRenames('E:\\music', null)).toBe('E:\\music');
    expect(applyVolumeRenames('E:\\music', [{ from: 'E:\\', to: 'E:\\' }])).toBe('E:\\music');
    expect(applyVolumeRenames('E:\\music', [{ from: '', to: 'D:\\' }])).toBe('E:\\music');
  });
});
