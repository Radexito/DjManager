import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

vi.mock('../audio/waveformGenerator.js', () => ({
  generateWaveform: vi.fn().mockResolvedValue({
    pwv3: Buffer.alloc(100, 0x21),
    pwv5: Buffer.alloc(200, 0x11),
    pwav: Buffer.alloc(10, 0x41),
  }),
}));

vi.mock('fs', () => {
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const existsSync = vi.fn().mockReturnValue(false);
  const mod = { writeFileSync, mkdirSync, existsSync };
  return { default: mod, ...mod };
});

// Import after mocks
import { writeAnlz, getAnlzFolder } from '../audio/anlzWriter.js';
import fs from 'fs';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getAnlzFolder', () => {
  it('returns path in PIONEER/USBANLZ/P{3hex}/{8hex} format', () => {
    const result = getAnlzFolder('/music/testsong.mp3');
    expect(result).toMatch(/PIONEER[/\\]USBANLZ[/\\]P[0-9A-F]{3}[/\\][0-9A-F]{8}$/);
  });

  it('is deterministic — same path gives same folder', () => {
    const a = getAnlzFolder('/music/artist/track.mp3');
    const b = getAnlzFolder('/music/artist/track.mp3');
    expect(a).toBe(b);
  });

  it('different paths give different folders', () => {
    const a = getAnlzFolder('/music/track1.mp3');
    const b = getAnlzFolder('/music/track2.mp3');
    expect(a).not.toBe(b);
  });

  it('normalises Windows backslashes before hashing', () => {
    const forward = getAnlzFolder('/music/track.mp3');
    const backward = getAnlzFolder('\\music\\track.mp3');
    // Both should produce the same folder since normalisation adds leading /
    expect(forward).toBe(backward);
  });

  it('adds leading slash if missing', () => {
    const withSlash = getAnlzFolder('/music/track.mp3');
    const withoutSlash = getAnlzFolder('music/track.mp3');
    expect(withSlash).toBe(withoutSlash);
  });
});

describe('writeAnlz', () => {
  const baseOpts = {
    usbFilePath: '/music/testsong.mp3',
    sourceFilePath: '/local/testsong.mp3',
    beatgrid: null,
    bpm: 128,
    usbRoot: '/tmp/usb',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes exactly two files: ANLZ0000.DAT and ANLZ0000.EXT', async () => {
    await writeAnlz(baseOpts);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    const writtenPaths = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(writtenPaths.some((p) => p.endsWith('ANLZ0000.DAT'))).toBe(true);
    expect(writtenPaths.some((p) => p.endsWith('ANLZ0000.EXT'))).toBe(true);
  });

  it('creates the ANLZ directory with recursive: true', async () => {
    await writeAnlz(baseOpts);

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('PIONEER'), {
      recursive: true,
    });
  });

  it('DAT file starts with PMAI magic bytes', async () => {
    await writeAnlz(baseOpts);

    const datCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('ANLZ0000.DAT'));
    expect(datCall).toBeDefined();
    expect(datCall[1].slice(0, 4).toString('ascii')).toBe('PMAI');
  });

  it('EXT file starts with PMAI magic bytes', async () => {
    await writeAnlz(baseOpts);

    const extCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('ANLZ0000.EXT'));
    expect(extCall).toBeDefined();
    expect(extCall[1].slice(0, 4).toString('ascii')).toBe('PMAI');
  });

  it('DAT file contains PPTH (path tag) section', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    expect(datBuf.toString('binary')).toContain('PPTH');
  });

  it('DAT file contains PQTZ (beat grid) section', async () => {
    await writeAnlz({ ...baseOpts, beatgrid: JSON.stringify([0.5, 0.97, 1.44]) });

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    expect(datBuf.toString('binary')).toContain('PQTZ');
  });

  it('EXT file contains PWV3 waveform section', async () => {
    await writeAnlz(baseOpts);

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    expect(extBuf.toString('binary')).toContain('PWV3');
  });

  it('EXT file contains PPTH section', async () => {
    await writeAnlz(baseOpts);

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    expect(extBuf.toString('binary')).toContain('PPTH');
  });

  it('returns path to the DAT file', async () => {
    const result = await writeAnlz(baseOpts);

    expect(result).toMatch(/ANLZ0000\.DAT$/);
  });

  it('skips waveform generation when sourceFilePath is null', async () => {
    const { generateWaveform } = await import('../audio/waveformGenerator.js');
    await writeAnlz({ ...baseOpts, sourceFilePath: null });

    expect(generateWaveform).not.toHaveBeenCalled();
    // Still writes both files (with fallback placeholder waveform)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('still writes files when waveform generation fails (graceful fallback)', async () => {
    const { generateWaveform } = await import('../audio/waveformGenerator.js');
    generateWaveform.mockRejectedValueOnce(new Error('ffmpeg not found'));

    await expect(writeAnlz(baseOpts)).resolves.not.toThrow();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('ANLZ dir is inside usbRoot/PIONEER/USBANLZ', async () => {
    await writeAnlz({ ...baseOpts, usbRoot: '/mnt/usb' });

    const mkdirPath = fs.mkdirSync.mock.calls[0][0];
    expect(mkdirPath).toMatch(/\/mnt\/usb[/\\]PIONEER[/\\]USBANLZ/);
  });
});
