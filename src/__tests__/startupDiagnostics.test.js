import { describe, expect, it, vi } from 'vitest';
import { logStartupDiagnostics } from '../main/startupDiagnostics.js';

/** Run the diagnostics with a recording logger. */
function run(overrides = {}) {
  const log = vi.fn();
  const inspected = logStartupDiagnostics({
    userDataPath: '/home/u/.config/dj',
    appVersion: '1.2.0',
    platform: 'win32',
    release: '10.0.22631',
    osVersion: 'Windows 11',
    arch: 'x64',
    exists: () => false,
    log,
    ...overrides,
  });
  return { log, inspected };
}

describe('logStartupDiagnostics', () => {
  it('reports every key path with its length and existence', () => {
    const { log, inspected } = run();

    expect(inspected.map((entry) => entry.label)).toEqual([
      'userData',
      'bin',
      'ffmpeg.exe',
      'ffprobe.exe',
      'analysis.exe',
      'yt-dlp.exe',
    ]);
    expect(inspected[0]).toEqual({
      label: 'userData',
      path: '/home/u/.config/dj',
      length: 18,
      exists: false,
      tooLong: false,
    });
    expect(log.mock.calls.flat().join('\n')).toContain('app.version   = 1.2.0');
  });

  it('flags a path at the Windows limit', () => {
    const long = 'C:\\' + 'a'.repeat(257);
    const { inspected } = run({ userDataPath: long, exists: () => true });

    expect(inspected[0].tooLong).toBe(true);
    expect(inspected[0].exists).toBe(true);
  });

  it('does not flag a path just below the limit', () => {
    const short = 'C:\\' + 'a'.repeat(256);
    expect(short.length).toBe(259);
    const { inspected } = run({ userDataPath: short });
    expect(inspected[0].tooLong).toBe(false);
  });

  it('never throws when the userData directory does not exist', () => {
    expect(() => run({ exists: () => false })).not.toThrow();
  });
});
