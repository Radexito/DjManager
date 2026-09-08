import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

vi.mock('../deps.js', () => ({
  getFfmpegRuntimePath: () => '/fake/ffmpeg',
  getFfprobeRuntimePath: () => '/fake/ffprobe',
}));

// Import after mocks
import { convertAudio } from '../audio/ffmpeg.js';
import { spawn } from 'child_process';

function makeFakeProc(exitCode = 0) {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

describe('convertAudio — format conversion arg building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawn.mockReturnValue(makeFakeProc());
  });

  it('does a lossless stream copy when no gain and no format change', async () => {
    await convertAudio('/src/track.mp3', '/dest/track.mp3', {});
    const args = spawn.mock.calls[0][1];
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args).not.toContain('-map');
  });

  it('builds codec args and maps only the audio stream when converting format', async () => {
    await convertAudio('/src/track.wav', '/dest/track.mp3', {
      format: 'mp3',
      sourceBitrateKbps: 1411,
    });
    const args = spawn.mock.calls[0][1];
    expect(args).toContain('-map');
    expect(args).toContain('0:a:0');
    expect(args).toContain('-c:a');
    expect(args).toContain('libmp3lame');
    // Bitrate must be capped at mp3's maxBitrateKbps (320), not the lossless source bitrate
    const bIdx = args.indexOf('-b:a');
    expect(bIdx).toBeGreaterThan(-1);
    expect(args[bIdx + 1]).toBe('320k');
  });

  it('uses the codec default bitrate when no source bitrate is given', async () => {
    await convertAudio('/src/track.flac', '/dest/track.aac', { format: 'aac' });
    const args = spawn.mock.calls[0][1];
    const bIdx = args.indexOf('-b:a');
    expect(args[bIdx + 1]).toBe('256k');
  });

  it('omits -b:a for lossless target formats (flac/wav/aiff)', async () => {
    await convertAudio('/src/track.mp3', '/dest/track.flac', { format: 'flac' });
    const args = spawn.mock.calls[0][1];
    expect(args).not.toContain('-b:a');
    expect(args).toContain('-c:a');
    expect(args).toContain('flac');
  });

  it('throws for an unsupported format', () => {
    expect(() => convertAudio('/src/track.mp3', '/dest/track.ogg', { format: 'ogg' })).toThrow(
      /Unsupported export format/
    );
  });

  it('applies gain-only re-encode without -map when format is not given', async () => {
    await convertAudio('/src/track.mp3', '/dest/track.mp3', {
      gainDb: 3,
      sourceBitrateKbps: 192,
    });
    const args = spawn.mock.calls[0][1];
    expect(args).not.toContain('-map');
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    expect(args.some((a) => typeof a === 'string' && a.includes('volume=3.00dB'))).toBe(true);
  });

  it('combines gain and format conversion, applying the filter alongside codec args', async () => {
    await convertAudio('/src/track.wav', '/dest/track.mp3', {
      gainDb: -2,
      format: 'mp3',
      sourceBitrateKbps: 1411,
    });
    const args = spawn.mock.calls[0][1];
    expect(args.some((a) => typeof a === 'string' && a.includes('volume=-2.00dB'))).toBe(true);
    expect(args).toContain('-map');
    expect(args).toContain('libmp3lame');
  });
});
