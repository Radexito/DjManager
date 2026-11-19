import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { getResetCleanupTargets, startResetCleanup } from '../resetCleanup.js';

describe('getResetCleanupTargets', () => {
  it('includes app data directories and legacy dev database files', () => {
    const targets = getResetCleanupTargets({
      userDataPath: 'C:\\Users\\me\\AppData\\Roaming\\DJ Manager',
      cachePath: 'C:\\Users\\me\\AppData\\Local\\DJ Manager\\Cache',
      logsPath: 'C:\\Users\\me\\AppData\\Roaming\\DJ Manager\\logs',
      cwd: 'C:\\Users\\me\\DjManager',
    });

    expect(targets).toEqual([
      'C:\\Users\\me\\AppData\\Roaming\\DJ Manager',
      'C:\\Users\\me\\AppData\\Local\\DJ Manager\\Cache',
      'C:\\Users\\me\\AppData\\Roaming\\DJ Manager\\logs',
      path.join('C:\\Users\\me\\DjManager', 'library.db'),
      path.join('C:\\Users\\me\\DjManager', 'library.db-shm'),
      path.join('C:\\Users\\me\\DjManager', 'library.db-wal'),
    ]);
  });

  it('deduplicates repeated targets', () => {
    const targets = getResetCleanupTargets({
      userDataPath: 'C:\\temp\\userData',
      cachePath: 'C:\\temp\\userData',
      logsPath: 'C:\\temp\\userData',
      cwd: 'C:\\temp',
    });

    expect(targets).toEqual([
      'C:\\temp\\userData',
      path.join('C:\\temp', 'library.db'),
      path.join('C:\\temp', 'library.db-shm'),
      path.join('C:\\temp', 'library.db-wal'),
    ]);
  });
});

describe('startResetCleanup', () => {
  it('spawns a detached node-mode helper and unreferences it', () => {
    const unref = vi.fn();
    const spawnImpl = vi.fn().mockReturnValue({ unref });

    startResetCleanup({
      parentPid: 4242,
      targets: ['C:\\temp\\userData'],
      spawnImpl,
      execPath: 'C:\\Program Files\\DjManager\\DJ Manager.exe',
      env: { PATH: 'C:\\Windows\\System32' },
      scriptPath: 'C:\\Users\\me\\DjManager\\src\\resetCleanupWorker.js',
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'C:\\Program Files\\DjManager\\DJ Manager.exe',
      [
        'C:\\Users\\me\\DjManager\\src\\resetCleanupWorker.js',
        '4242',
        JSON.stringify(['C:\\temp\\userData']),
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          PATH: 'C:\\Windows\\System32',
          ELECTRON_RUN_AS_NODE: '1',
        },
      }
    );
    expect(unref).toHaveBeenCalled();
  });
});
