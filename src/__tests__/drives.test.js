import { describe, it, expect } from 'vitest';
import { detectWindowsDrives } from '../explorer/drives.js';

describe('detectWindowsDrives', () => {
  it('returns [] on non-Windows platforms', () => {
    expect(detectWindowsDrives({ platform: 'linux' })).toEqual([]);
    expect(detectWindowsDrives({ platform: 'darwin' })).toEqual([]);
  });

  it('returns the drive roots that exist on Windows', () => {
    const exists = (p) => p === 'C:\\' || p === 'E:\\';
    expect(detectWindowsDrives({ platform: 'win32', existsSync: exists })).toEqual([
      'C:\\',
      'E:\\',
    ]);
  });

  it('skips drives whose existence check throws', () => {
    const exists = (p) => {
      if (p === 'C:\\') return true;
      throw new Error('access denied');
    };
    expect(detectWindowsDrives({ platform: 'win32', existsSync: exists })).toEqual(['C:\\']);
  });
});
