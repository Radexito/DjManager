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

// ── #474 — metadata written into the exported file ──────────────────────────

describe('convertAudio — export metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawn.mockReturnValue(makeFakeProc());
  });

  const argsOf = () => spawn.mock.calls[0][1];

  it('writes title/artist/album plus ID3 BPM/key for an mp3', async () => {
    await convertAudio('/src/a.m4a', '/dest/a.mp3', {
      format: 'mp3',
      metadata: { title: 'Track', artist: 'Artist', album: 'Album', bpm: 128.4, key: '9B' },
    });
    const args = argsOf();
    expect(args).toContain('title=Track');
    expect(args).toContain('artist=Artist');
    expect(args).toContain('album=Album');
    expect(args).toContain('TBPM=128');
    expect(args).toContain('TKEY=9B');
  });

  it('uses the Vorbis names when converting to flac', async () => {
    await convertAudio('/src/a.m4a', '/dest/a.flac', {
      format: 'flac',
      metadata: { bpm: 174, key: '11A' },
    });
    const args = argsOf();
    expect(args).toContain('BPM=174');
    expect(args).toContain('KEY=11A');
    expect(args).not.toContain('TBPM=174');
  });

  it('always deletes the MP4 container fields inherited from the source', async () => {
    await convertAudio('/src/a.m4a', '/dest/a.mp3', { format: 'mp3' });
    const args = argsOf();
    expect(args).toContain('major_brand=');
    expect(args).toContain('minor_version=');
    expect(args).toContain('compatible_brands=');
  });

  it('writes no BPM/key when there are none (blind export)', async () => {
    await convertAudio('/src/a.m4a', '/dest/a.mp3', {
      format: 'mp3',
      metadata: { title: 'Track', bpm: null, key: null },
    });
    const args = argsOf();
    expect(args).toContain('title=Track');
    expect(args.some((a) => a.startsWith('TBPM='))).toBe(false);
    expect(args.some((a) => a.startsWith('TKEY='))).toBe(false);
  });

  it('adds no metadata args at all without a metadata object', async () => {
    await convertAudio('/src/a.m4a', '/dest/a.mp3', { format: 'mp3' });
    const args = argsOf();
    expect(args.some((a) => a === 'title=' || a.startsWith('TBPM=') || a.startsWith('TKEY='))).toBe(
      false
    );
  });
});
