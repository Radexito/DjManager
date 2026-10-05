import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import {
  createLibraryWatcher,
  listAudioFiles,
  isAudioPath,
  AUDIO_EXTENSIONS,
} from '../library/libraryWatcher.js';

const FOLDER = '/ingest/music';

// Minimal fs stub — the watcher only needs existsSync/statSync/readdir.
function makeFsImpl({ readdir = vi.fn(async () => []), exists = true, size = 1234 } = {}) {
  return {
    existsSync: vi.fn(() => exists),
    statSync: vi.fn(() => ({ isFile: () => true, size })),
    promises: { readdir },
  };
}

// Captures the (folder, options, listener) of every watch registration.
function makeWatchImpl({ throwOn = null } = {}) {
  const registrations = [];
  const closeFn = vi.fn();
  const watchImpl = vi.fn((dir, opts, listener) => {
    if (throwOn === dir) throw new Error('watch not permitted');
    registrations.push({ dir, opts, listener });
    return { close: closeFn, on: vi.fn() };
  });
  return { watchImpl, registrations, closeFn };
}

const dirEntry = (name, isDir = false) => ({
  name,
  isDirectory: () => isDir,
  isFile: () => !isDir,
});

describe('isAudioPath / AUDIO_EXTENSIONS', () => {
  it('accepts the importable audio extensions only', () => {
    for (const ext of [...AUDIO_EXTENSIONS]) {
      expect(isAudioPath(`/x/track${ext}`)).toBe(true);
      expect(isAudioPath(`/x/track${ext.toUpperCase()}`)).toBe(true);
    }
    expect(isAudioPath('/x/cover.png')).toBe(false);
    expect(isAudioPath('/x/notes.txt')).toBe(false);
    expect(isAudioPath(null)).toBe(false);
  });
});

describe('listAudioFiles', () => {
  it('walks subfolders, keeps audio files and skips dot-directories', async () => {
    const readdir = vi.fn(async (dir) => {
      if (dir === FOLDER)
        return [
          dirEntry('a.mp3'),
          dirEntry('cover.jpg'),
          dirEntry('sub', true),
          dirEntry('.git', true),
        ];
      if (dir === path.join(FOLDER, 'sub')) return [dirEntry('b.flac'), dirEntry('c.txt')];
      if (dir === path.join(FOLDER, '.git')) throw new Error('should never be walked');
      return [];
    });

    const files = await listAudioFiles([FOLDER], { fsImpl: makeFsImpl({ readdir }) });

    expect(files.sort()).toEqual(
      [path.join(FOLDER, 'a.mp3'), path.join(FOLDER, 'sub', 'b.flac')].sort()
    );
  });

  it('stops at maxDepth and survives unreadable directories', async () => {
    const readdir = vi.fn(async (dir) => {
      if (dir === FOLDER) return [dirEntry('deep', true)];
      if (dir === path.join(FOLDER, 'deep')) return [dirEntry('deeper', true)];
      throw new Error('EACCES');
    });

    const files = await listAudioFiles([FOLDER], { fsImpl: makeFsImpl({ readdir }), maxDepth: 1 });
    expect(files).toEqual([]);
  });
});

describe('createLibraryWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('watches each folder recursively and ignores non-audio events', async () => {
    const onNewFile = vi.fn();
    const { watchImpl, registrations } = makeWatchImpl();

    const watcher = createLibraryWatcher({
      folders: [FOLDER],
      onNewFile,
      fsImpl: makeFsImpl(),
      watchImpl,
      debounceMs: 1000,
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0].dir).toBe(FOLDER);
    expect(registrations[0].opts).toEqual({ recursive: true });

    registrations[0].listener('rename', 'artwork.png');
    registrations[0].listener('rename', null);
    await vi.advanceTimersByTimeAsync(2000);

    expect(onNewFile).not.toHaveBeenCalled();
    watcher.close();
  });

  it('debounces a burst of events for the same file into a single import', async () => {
    const onNewFile = vi.fn();
    const { watchImpl, registrations } = makeWatchImpl();

    const watcher = createLibraryWatcher({
      folders: [FOLDER],
      onNewFile,
      fsImpl: makeFsImpl(),
      watchImpl,
      debounceMs: 1000,
    });

    const listener = registrations[0].listener;
    listener('rename', 'track.mp3'); // copy starts
    listener('change', 'track.mp3'); // partial writes
    listener('change', 'track.mp3');
    await vi.advanceTimersByTimeAsync(1500);

    expect(onNewFile).toHaveBeenCalledTimes(1);
    expect(onNewFile).toHaveBeenCalledWith(path.join(FOLDER, 'track.mp3'));
    watcher.close();
  });

  it('waits for the debounce window before importing (not on the raw event)', async () => {
    const onNewFile = vi.fn();
    const { watchImpl, registrations } = makeWatchImpl();
    const watcher = createLibraryWatcher({
      folders: [FOLDER],
      onNewFile,
      fsImpl: makeFsImpl(),
      watchImpl,
      debounceMs: 5000,
    });

    registrations[0].listener('rename', 'track.wav');
    await vi.advanceTimersByTimeAsync(4999);
    expect(onNewFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(onNewFile).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('skips files that vanished or are still empty', async () => {
    const onNewFile = vi.fn();
    const { watchImpl, registrations } = makeWatchImpl();

    const missing = makeFsImpl();
    // the folder exists, the just-created file is already gone
    missing.existsSync.mockImplementation((p) => p === FOLDER);
    const watcherMissing = createLibraryWatcher({
      folders: [FOLDER],
      onNewFile,
      fsImpl: missing,
      watchImpl,
      debounceMs: 100,
    });
    registrations[0].listener('rename', 'gone.mp3');
    await vi.advanceTimersByTimeAsync(200);
    expect(onNewFile).not.toHaveBeenCalled();
    watcherMissing.close();

    const empty = makeFsImpl({ size: 0 });
    const watcherEmpty = createLibraryWatcher({
      folders: [FOLDER],
      onNewFile,
      fsImpl: empty,
      watchImpl,
      debounceMs: 100,
    });
    registrations[1].listener('rename', 'partial.mp3');
    await vi.advanceTimersByTimeAsync(200);
    expect(onNewFile).not.toHaveBeenCalled();
    watcherEmpty.close();
  });

  it('reports a missing folder and an unwatchable folder without throwing', () => {
    const onError = vi.fn();
    const { watchImpl, registrations } = makeWatchImpl({ throwOn: '/ingest/denied' });

    const missingFs = makeFsImpl();
    missingFs.existsSync.mockImplementation((p) => p !== '/ingest/missing');

    createLibraryWatcher({
      folders: ['/ingest/missing'],
      onNewFile: vi.fn(),
      onError,
      fsImpl: missingFs,
      watchImpl,
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), '/ingest/missing');

    createLibraryWatcher({
      folders: ['/ingest/denied'],
      onNewFile: vi.fn(),
      onError,
      fsImpl: makeFsImpl(),
      watchImpl,
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), '/ingest/denied');
    expect(registrations).toHaveLength(0);
  });

  it('close() stops pending debounces and closes every watcher', async () => {
    const onNewFile = vi.fn();
    const { watchImpl, registrations, closeFn } = makeWatchImpl();

    const watcher = createLibraryWatcher({
      folders: [FOLDER],
      onNewFile,
      fsImpl: makeFsImpl(),
      watchImpl,
      debounceMs: 1000,
    });

    registrations[0].listener('rename', 'track.mp3');
    watcher.close();
    await vi.advanceTimersByTimeAsync(5000);

    expect(onNewFile).not.toHaveBeenCalled();
    expect(closeFn).toHaveBeenCalledTimes(1);

    watcher.close(); // idempotent
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});
