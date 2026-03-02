import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

// Mock better-sqlite3 so setup.js can load database.js without the native module
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
  Worker: vi.fn(),
}));

vi.mock('../deps.js', () => ({
  getAnalyzerRuntimePath: vi.fn().mockResolvedValue('/fake/analyzer'),
}));

vi.mock('../db/settingsRepository.js', () => ({
  getSetting: vi.fn().mockReturnValue(null),
}));

const FAKE_HASH = 'deadbeef1234567890abcdef1234567890abcdef';

// Predictable SHA-1 hash for all file reads
vi.mock('crypto', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createHash: () => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue(FAKE_HASH),
    }),
  };
});

// Mock fs — file copies are no-ops; readstream feeds the hash mock
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    existsSync: vi.fn().mockReturnValue(false),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    createReadStream: vi.fn().mockImplementation(() => ({
      on: vi.fn().mockImplementation(function (event, cb) {
        if (event === 'data') cb(Buffer.from('x'));
        if (event === 'end') cb();
        return this;
      }),
    })),
  };
});

// Mock ffprobe — returns minimal valid probe result
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

// Mock trackRepository — use controlled stubs so tests don't need SQLite
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

// Import after mocks are registered
import { importAudioFile } from '../audio/importManager.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockAddTrack.mockReturnValue(99);
  mockGetTrackByHash.mockReturnValue(undefined);
});

describe('importAudioFile — duplicate prevention', () => {
  it('imports a new file and stores its hash', async () => {
    const id = await importAudioFile('/music/song.mp3');

    expect(id).toBe(99);
    expect(mockAddTrack).toHaveBeenCalledOnce();

    const call = mockAddTrack.mock.calls[0][0];
    expect(call.file_hash).toBe(FAKE_HASH);
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
    // First import — no existing track
    mockGetTrackByHash.mockReturnValueOnce(undefined);
    const firstId = await importAudioFile('/music/song.mp3');
    expect(mockAddTrack).toHaveBeenCalledTimes(1);

    // Second import — hash already in DB (simulate what real DB would return)
    mockGetTrackByHash.mockReturnValueOnce({ id: firstId, file_hash: FAKE_HASH });
    const secondId = await importAudioFile('/music/song.mp3');
    expect(mockAddTrack).toHaveBeenCalledTimes(1); // still just 1 call total
    expect(secondId).toBe(firstId);
  });

  it('importing two different files (different hashes) adds two DB records', async () => {
    const { createHash } = await import('crypto');

    // First file → FAKE_HASH
    createHash.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue(FAKE_HASH),
    });
    mockGetTrackByHash.mockReturnValueOnce(undefined);
    mockAddTrack.mockReturnValueOnce(1);
    await importAudioFile('/music/a.mp3');

    // Second file → different hash
    createHash.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('aaaa1111bbbb2222cccc3333dddd4444eeee5555'),
    });
    mockGetTrackByHash.mockReturnValueOnce(undefined);
    mockAddTrack.mockReturnValueOnce(2);
    await importAudioFile('/music/b.mp3');

    expect(mockAddTrack).toHaveBeenCalledTimes(2);
  });
});
