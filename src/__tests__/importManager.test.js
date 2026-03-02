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
  }),
}));

vi.mock('../deps.js', () => ({
  getAnalyzerRuntimePath: vi.fn().mockReturnValue('/fake/analyzer'),
}));

vi.mock('../db/settingsRepository.js', () => ({
  getSetting: vi.fn().mockReturnValue(null),
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
import { importAudioFile } from '../audio/importManager.js';
import cryptoDefault from 'crypto';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockAddTrack.mockReturnValue(99);
  mockGetTrackByHash.mockReturnValue(undefined);
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
