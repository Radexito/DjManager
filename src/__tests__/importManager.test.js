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

// libraryRepository mock — a single library (id 1) is both "current" and
// "default" (oldest) unless a test overrides it, matching a fresh single-
// library install.
const mockLibraries = new Map([
  [1, { id: 1, name: 'Default', root_path: null, storage_format: 'hashed' }],
]);
const mockGetLibrary = vi.fn((id) => mockLibraries.get(id));
const mockGetCurrentLibraryId = vi.fn(() => 1);
const mockGetDefaultLibraryId = vi.fn(() => 1);
const mockSetLibraryStorageFormat = vi.fn((id, format) => {
  const lib = mockLibraries.get(id);
  if (lib) lib.storage_format = format;
});
vi.mock('../db/libraryRepository.js', () => ({
  getLibrary: (...args) => mockGetLibrary(...args),
  getCurrentLibraryId: (...args) => mockGetCurrentLibraryId(...args),
  getDefaultLibraryId: (...args) => mockGetDefaultLibraryId(...args),
  setLibraryStorageFormat: (...args) => mockSetLibraryStorageFormat(...args),
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
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ size: 0 }),
    statfsSync: vi.fn().mockReturnValue({ bavail: 0, bsize: 0 }),
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
const mockGetTracks = vi.fn().mockReturnValue([]);

vi.mock('../db/trackRepository.js', () => ({
  getTrackByHash: (...args) => mockGetTrackByHash(...args),
  addTrack: (...args) => mockAddTrack(...args),
  updateTrack: (...args) => mockUpdateTrack(...args),
  getTrackById: (...args) => mockGetTrackById(...args),
  getTracks: (...args) => mockGetTracks(...args),
}));

const mockMoveFileSafe = vi.fn();
vi.mock('../utils/fsMove.js', () => ({
  moveFileSafe: (...args) => mockMoveFileSafe(...args),
}));

// Import AFTER mocks so the module picks up all stubs
import path from 'path';
import fs from 'fs';
import {
  importAudioFile,
  moveTrackToLibrary,
  convertStorageFormat,
  getLibraryDiskUsage,
  getLibraryFreeSpace,
} from '../audio/importManager.js';
import cryptoDefault from 'crypto';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockAddTrack.mockReturnValue(99);
  mockGetTrackByHash.mockReturnValue(undefined);
  mockExecFile.mockImplementation((bin, args, cb) => cb(null, '', ''));
  mockLibraries.clear();
  mockLibraries.set(1, { id: 1, name: 'Default', root_path: null, storage_format: 'hashed' });
  mockGetLibrary.mockImplementation((id) => mockLibraries.get(id));
  mockGetCurrentLibraryId.mockReturnValue(1);
  mockGetDefaultLibraryId.mockReturnValue(1);
  fs.existsSync.mockReset().mockReturnValue(false);
  mockMoveFileSafe.mockReset();
  mockGetTrackById.mockReset();
  mockGetTracks.mockReset().mockReturnValue([]);
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

// ── Multiple libraries (#390 rework) ──────────────────────────────────────────

describe('importAudioFile — library scoping', () => {
  it('stores library_id from the current library when none is passed explicitly', async () => {
    mockGetCurrentLibraryId.mockReturnValue(1);
    await importAudioFile('/music/song.mp3');
    expect(mockAddTrack.mock.calls[0][0].library_id).toBe(1);
  });

  it('stores library_id from an explicit argument, overriding the current library', async () => {
    mockLibraries.set(2, { id: 2, name: 'Second', root_path: null, storage_format: 'hashed' });
    await importAudioFile('/music/song.mp3', {}, 2);
    expect(mockAddTrack.mock.calls[0][0].library_id).toBe(2);
  });

  it("uses the non-default library's scoped default folder, not the shared userData/audio path", async () => {
    mockLibraries.set(2, { id: 2, name: 'Second', root_path: null, storage_format: 'hashed' });
    await importAudioFile('/music/song.mp3', {}, 2);
    const destPath = mockAddTrack.mock.calls[0][0].file_path;
    expect(destPath).toContain(path.join('libraries', '2', 'audio'));
  });

  it("uses the default (oldest) library's unscoped audio path for backward compatibility", async () => {
    await importAudioFile('/music/song.mp3', {}, 1);
    const destPath = mockAddTrack.mock.calls[0][0].file_path;
    expect(destPath).toBe(path.join('/tmp/djman-test', 'audio', 'de', `${FAKE_HASH}.mp3`));
  });
});

describe('importAudioFile — readable storage format', () => {
  it('names the file "<artist>/<artist> - <title>.<ext>" instead of a hash path', async () => {
    mockLibraries.get(1).storage_format = 'readable';

    await importAudioFile('/music/song.mp3');

    const destPath = mockAddTrack.mock.calls[0][0].file_path;
    expect(destPath).toBe(
      path.join('/tmp/djman-test', 'audio', 'Test Artist', 'Test Artist - Test Song.mp3')
    );
  });

  it('sanitizes filesystem-unsafe characters in artist/title', async () => {
    mockLibraries.get(1).storage_format = 'readable';
    ffprobe.mockResolvedValueOnce({
      format: {
        format_name: 'mp3',
        duration: '180.0',
        bit_rate: '320000',
        tags: { title: 'Track: Part 2?', artist: 'A/B*C' },
      },
      streams: [],
    });

    await importAudioFile('/music/song.mp3');

    const destPath = mockAddTrack.mock.calls[0][0].file_path;
    expect(destPath).toBe(
      path.join('/tmp/djman-test', 'audio', 'A_B_C', 'A_B_C - Track_ Part 2_.mp3')
    );
  });

  it('disambiguates a filename collision with a different track', async () => {
    mockLibraries.get(1).storage_format = 'readable';
    // Simulate: the plain "Artist - Title.mp3" path already exists (a
    // different track, since true duplicates are caught by the hash check
    // before this point), so it should fall back to the "(2)" suffix.
    fs.existsSync.mockImplementation((p) => !p.includes('(2)'));

    await importAudioFile('/music/song.mp3');

    const destPath = mockAddTrack.mock.calls[0][0].file_path;
    expect(destPath).toBe(
      path.join('/tmp/djman-test', 'audio', 'Test Artist', 'Test Artist - Test Song (2).mp3')
    );
  });

  it("only affects the library it's set on — other libraries keep their own format", async () => {
    mockLibraries.set(2, { id: 2, name: 'Second', root_path: null, storage_format: 'hashed' });
    mockLibraries.get(1).storage_format = 'readable';

    await importAudioFile('/music/song.mp3', {}, 2);

    const destPath = mockAddTrack.mock.calls[0][0].file_path;
    // Library 2 stayed hashed — unaffected by library 1's format
    expect(destPath).toBe(
      path.join('/tmp/djman-test', 'libraries', '2', 'audio', 'de', `${FAKE_HASH}.mp3`)
    );
  });
});

describe('convertStorageFormat', () => {
  it('moves an owned track to the new layout and updates its file_path', () => {
    mockLibraries.get(1).storage_format = 'hashed';
    mockGetTracks.mockReturnValue([
      {
        id: 5,
        file_path: '/tmp/djman-test/audio/de/deadbeef.mp3',
        file_hash: FAKE_HASH,
        is_linked: 0,
        artist: 'A',
        title: 'T',
      },
    ]);
    fs.existsSync.mockImplementation((p) => p === '/tmp/djman-test/audio/de/deadbeef.mp3');

    const result = convertStorageFormat(1, 'readable');

    expect(result).toEqual({ moved: 1, total: 1 });
    expect(mockMoveFileSafe).toHaveBeenCalledWith(
      '/tmp/djman-test/audio/de/deadbeef.mp3',
      path.join('/tmp/djman-test', 'audio', 'A', 'A - T.mp3')
    );
    expect(mockUpdateTrack).toHaveBeenCalledWith(5, {
      file_path: path.join('/tmp/djman-test', 'audio', 'A', 'A - T.mp3'),
    });
  });

  it('is a no-op when the library is already in the requested format', () => {
    mockLibraries.get(1).storage_format = 'hashed';
    const result = convertStorageFormat(1, 'hashed');
    expect(result).toEqual({ moved: 0, total: 0 });
    expect(mockGetTracks).not.toHaveBeenCalled();
  });

  it('skips linked tracks entirely — their file has no hash and lives outside app storage', () => {
    mockLibraries.get(1).storage_format = 'hashed';
    mockGetTracks.mockReturnValue([
      {
        id: 5,
        file_path: '/external/mixtape/track.mp3',
        file_hash: null,
        is_linked: 1,
        artist: 'Ext Artist',
        title: 'Ext Title',
      },
    ]);
    fs.existsSync.mockImplementation((p) => p === '/external/mixtape/track.mp3');

    expect(() => convertStorageFormat(1, 'readable')).not.toThrow();
    expect(mockMoveFileSafe).not.toHaveBeenCalled();
    expect(mockUpdateTrack).not.toHaveBeenCalled();
  });

  it('does not crash converting hashed<-readable when a linked track (null hash) is present', () => {
    mockLibraries.get(1).storage_format = 'readable';
    mockGetTracks.mockReturnValue([
      {
        id: 5,
        file_path: '/external/mixtape/track.mp3',
        file_hash: null,
        is_linked: 1,
        artist: 'Ext Artist',
        title: 'Ext Title',
      },
    ]);
    fs.existsSync.mockImplementation((p) => p === '/external/mixtape/track.mp3');

    expect(() => convertStorageFormat(1, 'hashed')).not.toThrow();
  });
});

// ── Moving a track between libraries (#393) ───────────────────────────────────

describe('moveTrackToLibrary', () => {
  beforeEach(() => {
    mockLibraries.set(2, { id: 2, name: 'Second', root_path: null, storage_format: 'hashed' });
  });

  it('moves an owned (non-linked) track: relocates the file and updates library_id', async () => {
    fs.existsSync.mockReturnValue(true);
    mockGetTrackById.mockReturnValue({
      id: 5,
      file_path: '/old/lib/audio/de/deadbeef.mp3',
      file_hash: FAKE_HASH,
      is_linked: 0,
      library_id: 1,
      artist: 'A',
      title: 'T',
      artwork_path: null,
    });

    const result = await moveTrackToLibrary(5, 2);

    expect(result.ok).toBe(true);
    expect(result.moved).toBe(true);
    expect(mockMoveFileSafe).toHaveBeenCalledOnce();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
    expect(mockUpdateTrack).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ library_id: 2, is_linked: 0 })
    );
  });

  it('is a no-op when the track already belongs to the target library and is not linked', async () => {
    fs.existsSync.mockReturnValue(true);
    mockGetTrackById.mockReturnValue({
      id: 5,
      file_path: '/old/lib/audio/de/deadbeef.mp3',
      file_hash: FAKE_HASH,
      is_linked: 0,
      library_id: 2,
    });

    const result = await moveTrackToLibrary(5, 2);

    expect(result).toEqual({ ok: true, moved: false });
    expect(mockUpdateTrack).not.toHaveBeenCalled();
    expect(mockMoveFileSafe).not.toHaveBeenCalled();
  });

  it('imports a linked track into a library: copies (does not delete) the source file', async () => {
    fs.existsSync.mockReturnValue(true);
    mockGetTrackById.mockReturnValue({
      id: 6,
      file_path: '/usb/drive/track.mp3',
      file_hash: null,
      is_linked: 1,
      library_id: 1,
      artist: 'A',
      title: 'T',
      artwork_path: null,
    });

    const result = await moveTrackToLibrary(6, 2);

    expect(result.ok).toBe(true);
    expect(fs.copyFileSync).toHaveBeenCalled();
    expect(mockMoveFileSafe).not.toHaveBeenCalled();
    expect(mockUpdateTrack).toHaveBeenCalledWith(
      6,
      expect.objectContaining({ library_id: 2, is_linked: 0, file_hash: FAKE_HASH })
    );
  });

  it('merges into an existing track when the same content already lives in the target library', async () => {
    fs.existsSync.mockReturnValue(true);
    mockGetTrackById.mockReturnValue({
      id: 6,
      file_path: '/usb/drive/track.mp3',
      file_hash: null,
      is_linked: 1,
      library_id: 1,
    });
    mockGetTrackByHash.mockReturnValue({
      id: 42,
      library_id: 2,
      file_path: '/lib2/audio/de/deadbeef.mp3',
    });

    const result = await moveTrackToLibrary(6, 2);

    expect(result.mergedWithExisting).toBe(true);
    expect(fs.copyFileSync).not.toHaveBeenCalled();
    expect(mockUpdateTrack).toHaveBeenCalledWith(
      6,
      expect.objectContaining({ file_path: '/lib2/audio/de/deadbeef.mp3', library_id: 2 })
    );
  });

  it('throws when the source file no longer exists on disk', async () => {
    fs.existsSync.mockReturnValue(false);
    mockGetTrackById.mockReturnValue({
      id: 5,
      file_path: '/gone.mp3',
      file_hash: FAKE_HASH,
      is_linked: 0,
      library_id: 1,
    });

    await expect(moveTrackToLibrary(5, 2)).rejects.toThrow('Source file not found');
  });

  it('throws when the track does not exist', async () => {
    mockGetTrackById.mockReturnValue(undefined);
    await expect(moveTrackToLibrary(999, 2)).rejects.toThrow('Track not found');
  });

  it('throws when the target library does not exist', async () => {
    fs.existsSync.mockReturnValue(true);
    mockGetTrackById.mockReturnValue({
      id: 5,
      file_path: '/old.mp3',
      file_hash: FAKE_HASH,
      is_linked: 0,
      library_id: 1,
    });
    await expect(moveTrackToLibrary(5, 999)).rejects.toThrow('Target library not found');
  });
});

describe('getLibraryDiskUsage', () => {
  it('sums file sizes recursively across the library audio and artwork bases', () => {
    // Library 1 is the default library (see mockGetDefaultLibraryId), so its
    // audio/artwork bases resolve to the mocked userData dir unscoped.
    const audioBase = path.join('/tmp/djman-test', 'audio');
    const artworkBase = path.join('/tmp/djman-test', 'artwork');
    fs.readdirSync.mockImplementation((dir) => {
      if (dir === audioBase) {
        return [
          { name: 'de', isDirectory: () => true, isFile: () => false },
          { name: 'top.mp3', isDirectory: () => false, isFile: () => true },
        ];
      }
      if (dir === path.join(audioBase, 'de')) {
        return [{ name: 'deadbeef.mp3', isDirectory: () => false, isFile: () => true }];
      }
      if (dir === artworkBase) {
        return [{ name: 'cover.jpg', isDirectory: () => false, isFile: () => true }];
      }
      throw new Error(`unexpected readdirSync(${dir})`);
    });
    fs.statSync.mockImplementation((file) => {
      const sizes = {
        [path.join(audioBase, 'top.mp3')]: 100,
        [path.join(audioBase, 'de', 'deadbeef.mp3')]: 200,
        [path.join(artworkBase, 'cover.jpg')]: 50,
      };
      return { size: sizes[file] ?? 0 };
    });

    expect(getLibraryDiskUsage(1)).toBe(350);
  });

  it('returns 0 when a base directory does not exist yet', () => {
    fs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getLibraryDiskUsage(1)).toBe(0);
  });
});

describe('getLibraryFreeSpace', () => {
  it('returns free bytes (bavail * bsize) for the library base directory', () => {
    const audioBase = path.join('/tmp/djman-test', 'audio');
    fs.existsSync.mockImplementation((p) => p === audioBase);
    fs.statfsSync.mockReturnValue({ bavail: 1000, bsize: 4096 });

    expect(getLibraryFreeSpace(1)).toBe(1000 * 4096);
    expect(fs.statfsSync).toHaveBeenCalledWith(audioBase);
  });

  it('walks up to the nearest existing ancestor when the library folder does not exist yet', () => {
    const audioBase = path.join('/tmp/djman-test', 'audio');
    fs.existsSync.mockImplementation((p) => p === '/tmp/djman-test');
    fs.statfsSync.mockReturnValue({ bavail: 500, bsize: 4096 });

    expect(getLibraryFreeSpace(1)).toBe(500 * 4096);
    expect(fs.statfsSync).toHaveBeenCalledWith('/tmp/djman-test');
    expect(fs.statfsSync).not.toHaveBeenCalledWith(audioBase);
  });

  it('returns null when statfsSync throws (e.g. unmounted drive)', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statfsSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getLibraryFreeSpace(1)).toBeNull();
  });
});
