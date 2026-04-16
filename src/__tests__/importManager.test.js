import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('better-sqlite3', () => {
  const mockStmt = {
    run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 0 }),
    get: vi.fn(),
    all: vi.fn(),
  };
  return {
    default: vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue(mockStmt),
      pragma: vi.fn(),
      exec: vi.fn(),
    }),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/djman-test' },
}));

vi.mock('worker_threads', () => ({
  Worker: vi.fn(function () {
    this.on = vi.fn();
    this.terminate = vi.fn();
  }),
}));

vi.mock('../deps.js', () => ({
  getAnalyzerRuntimePath: vi.fn().mockReturnValue('/fake/analyzer'),
  getFfmpegRuntimePath: vi.fn().mockReturnValue('/fake/ffmpeg'),
}));

// child_process mock — execFile calls succeed by default
const mockExecFile = vi.fn((bin, args, cb) => cb(null, '', ''));
vi.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

vi.mock('../db/settingsRepository.js', () => ({
  getSetting: vi.fn().mockReturnValue(null),
}));

vi.mock('../db/cuePointRepository.js', () => ({
  getCuePoints: vi.fn().mockReturnValue([]),
  addCuePoint: vi.fn().mockReturnValue(1),
}));

const FAKE_HASH = 'deadbeef1234567890abcdef1234567890abcdef';
const ALT_HASH = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';

// Crypto mock — createHash is a vi.fn() so tests can override per-call
vi.mock('crypto', () => {
  const mockCreateHash = vi.fn().mockImplementation(() => ({
    update() {
      return this;
    },
    digest() {
      return FAKE_HASH;
    },
  }));
  return { default: { createHash: mockCreateHash }, createHash: mockCreateHash };
});

// fs mock — createReadStream resolves synchronously so hashFile Promise resolves
vi.mock('fs', () => {
  const makeStream = () => ({
    on: vi.fn().mockImplementation(function (event, cb) {
      if (event === 'data') cb(Buffer.from('x'));
      if (event === 'end') cb();
      return this;
    }),
  });
  const fsMock = {
    existsSync: vi.fn().mockReturnValue(false),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    createReadStream: vi.fn().mockImplementation(makeStream),
  };
  return { default: fsMock, ...fsMock };
});

// ffprobe mock — returns minimal valid probe result
vi.mock('../audio/ffmpeg.js', () => ({
  ffprobe: vi.fn().mockResolvedValue({
    format: {
      format_name: 'mp3',
      duration: '180.0',
      bit_rate: '320000',
      tags: { title: 'Test Song', artist: 'Test Artist', album: 'Test Album' },
    },
    streams: [],
  }),
}));

// trackRepository mock — controlled stubs; no SQLite needed
const mockGetTrackByHash = vi.fn();
const mockAddTrack = vi.fn().mockReturnValue(99);
const mockUpdateTrack = vi.fn();
const mockGetTrackById = vi.fn();

vi.mock('../db/trackRepository.js', () => ({
  getTrackByHash: (...args) => mockGetTrackByHash(...args),
  addTrack: (...args) => mockAddTrack(...args),
  updateTrack: (...args) => mockUpdateTrack(...args),
  getTrackById: (...args) => mockGetTrackById(...args),
}));

// Import AFTER mocks so the module picks up all stubs
import { importAudioFile, normalizeAudioFile } from '../audio/importManager.js';
import cryptoDefault from 'crypto';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockAddTrack.mockReturnValue(99);
  mockGetTrackByHash.mockReturnValue(undefined);
  mockExecFile.mockImplementation((bin, args, cb) => cb(null, '', ''));
  // Restore default hash implementation after clearAllMocks
  cryptoDefault.createHash.mockImplementation(() => ({
    update() {
      return this;
    },
    digest() {
      return FAKE_HASH;
    },
  }));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('importAudioFile — duplicate prevention', () => {
  it('imports a new file and stores its hash', async () => {
    const id = await importAudioFile('/music/song.mp3');

    expect(id).toBe(99);
    expect(mockAddTrack).toHaveBeenCalledOnce();
    expect(mockAddTrack.mock.calls[0][0].file_hash).toBe(FAKE_HASH);
  });

  it('skips import when hash already exists and returns existing track id', async () => {
    mockGetTrackByHash.mockReturnValue({ id: 7, title: 'Existing', file_hash: FAKE_HASH });

    const id = await importAudioFile('/music/song.mp3');

    expect(id).toBe(7);
    expect(mockAddTrack).not.toHaveBeenCalled();
  });

  it('calls getTrackByHash with the computed file hash', async () => {
    await importAudioFile('/music/song.mp3');

    expect(mockGetTrackByHash).toHaveBeenCalledWith(FAKE_HASH);
  });

  it('importing the same file twice only adds one DB record', async () => {
    mockGetTrackByHash.mockReturnValueOnce(undefined);
    const firstId = await importAudioFile('/music/song.mp3');
    expect(mockAddTrack).toHaveBeenCalledTimes(1);

    // Second import: hash now found in DB
    mockGetTrackByHash.mockReturnValueOnce({ id: firstId, file_hash: FAKE_HASH });
    const secondId = await importAudioFile('/music/song.mp3');
    expect(mockAddTrack).toHaveBeenCalledTimes(1); // still only 1 call
    expect(secondId).toBe(firstId);
  });

  it('importing two different files (different hashes) adds two DB records', async () => {
    // First file → FAKE_HASH
    cryptoDefault.createHash.mockImplementationOnce(() => ({
      update() {
        return this;
      },
      digest() {
        return FAKE_HASH;
      },
    }));
    mockGetTrackByHash.mockReturnValueOnce(undefined);
    mockAddTrack.mockReturnValueOnce(1);
    await importAudioFile('/music/a.mp3');

    // Second file → ALT_HASH
    cryptoDefault.createHash.mockImplementationOnce(() => ({
      update() {
        return this;
      },
      digest() {
        return ALT_HASH;
      },
    }));
    mockGetTrackByHash.mockReturnValueOnce(undefined);
    mockAddTrack.mockReturnValueOnce(2);
    await importAudioFile('/music/b.mp3');

    expect(mockAddTrack).toHaveBeenCalledTimes(2);
  });
});

describe('normalizeAudioFile', () => {
  const TRACK = {
    file_path: '/audio/ab/deadbeef_norm.mp3',
    file_hash: FAKE_HASH,
    loudness: -14,
    source_loudness: null,
  };

  it('calls ffmpeg with the computed gain (targetLufs - loudness)', async () => {
    await normalizeAudioFile(TRACK, -9);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [_bin, args] = mockExecFile.mock.calls[0];
    const filterIndex = args.indexOf('-filter:a');
    expect(filterIndex).toBeGreaterThan(-1);
    expect(args[filterIndex + 1]).toBe('volume=5.00dB'); // -9 - (-14) = +5
  });

  it('uses source_loudness instead of loudness to prevent cumulative drift', async () => {
    const trackWithSource = { ...TRACK, loudness: -9, source_loudness: -14 };
    await normalizeAudioFile(trackWithSource, -9);
    const [_bin, args] = mockExecFile.mock.calls[0];
    const filterIndex = args.indexOf('-filter:a');
    expect(args[filterIndex + 1]).toBe('volume=5.00dB'); // -9 - (-14) = +5, not 0
  });

  it('throws when there is no loudness data', async () => {
    const noLoudness = { ...TRACK, loudness: null, source_loudness: null };
    await expect(normalizeAudioFile(noLoudness, -9)).rejects.toThrow('no loudness data');
  });

  it('returns the normalized file path', async () => {
    const result = await normalizeAudioFile(TRACK, -9);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/_norm\.mp3$/);
  });

  it('passes the original file_path (not normalized path) as ffmpeg input', async () => {
    await normalizeAudioFile(TRACK, -9);
    const [_bin, args] = mockExecFile.mock.calls[0];
    const iIndex = args.indexOf('-i');
    expect(args[iIndex + 1]).toBe(TRACK.file_path);
  });
});

// ── Artist detection from filename ────────────────────────────────────────────

import { ffprobe } from '../audio/ffmpeg.js';

describe('importAudioFile — artist detection from filename', () => {
  it('uses ID3 artist tag when present, ignoring filename', async () => {
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: 'My Song', artist: 'Tag Artist' },
      },
      streams: [],
    });

    await importAudioFile('/music/Someone Else - My Song.mp3');

    expect(mockAddTrack.mock.calls[0][0].artist).toBe('Tag Artist');
  });

  it('parses artist from "Artist - Title" filename when artist tag is missing', async () => {
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: '', artist: '' },
      },
      streams: [],
    });

    await importAudioFile('/music/Deadmau5 - Some Chords.mp3');

    expect(mockAddTrack.mock.calls[0][0].artist).toBe('Deadmau5');
    expect(mockAddTrack.mock.calls[0][0].title).toBe('Some Chords');
  });

  it('leaves artist empty when no tag and no dash in filename', async () => {
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: '', artist: '' },
      },
      streams: [],
    });

    await importAudioFile('/music/untitled_track.mp3');

    expect(mockAddTrack.mock.calls[0][0].artist).toBe('');
    expect(mockAddTrack.mock.calls[0][0].title).toBe('untitled_track');
  });

  it('uses channel name as artist when no tag, no dash in filename, and channel provided', async () => {
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: 'Midnight Dreams', artist: '' },
      },
      streams: [],
    });

    await importAudioFile('/music/Midnight Dreams [abc123].mp3', { channel: 'DJ Koze' });

    expect(mockAddTrack.mock.calls[0][0].artist).toBe('DJ Koze');
    expect(mockAddTrack.mock.calls[0][0].title).toBe('Midnight Dreams');
  });

  it('does not overwrite ID3 artist with channel name', async () => {
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: 'Some Track', artist: 'Real Artist' },
      },
      streams: [],
    });

    await importAudioFile('/music/Some Track [abc123].mp3', { channel: 'Channel Name' });

    expect(mockAddTrack.mock.calls[0][0].artist).toBe('Real Artist');
  });

  it('does not overwrite filename-parsed artist with channel name', async () => {
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: '', artist: '' },
      },
      streams: [],
    });

    await importAudioFile('/music/Deadmau5 - Some Track [abc123].mp3', { channel: 'Channel Name' });

    expect(mockAddTrack.mock.calls[0][0].artist).toBe('Deadmau5');
  });

  it('keeps ID3 title when artist is missing but filename has dash', async () => {
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: 'ID3 Title', artist: '' },
      },
      streams: [],
    });

    await importAudioFile('/music/Filename Artist - Other Title.mp3');

    expect(mockAddTrack.mock.calls[0][0].artist).toBe('Filename Artist');
    // ID3 title wins over filename-derived title
    expect(mockAddTrack.mock.calls[0][0].title).toBe('ID3 Title');
  });
});
