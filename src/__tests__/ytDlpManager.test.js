import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../deps.js', () => ({
  getYtDlpRuntimePath: () => '/usr/bin/yt-dlp',
  getFfmpegRuntimePath: () => '/usr/bin/ffmpeg',
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() }),
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
    },
  },
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() }),
}));

// child_process.spawn mock. Two modes, selected per-test via `fakeProc`:
//  - manual: a test sets `fakeProc` before invoking the code under test and
//    drives stdout/close itself (used by searchYouTube tests, which assert
//    on state between individual emit calls)
//  - auto: when no fakeProc is set, responds like the real yt-dlp binary
//    would for the calls fetchPlaylistInfo makes (--dump-single-json /
//    availability), used by the checkYouTubeAvailability tests
const spawnCalls = [];
let lastSpawnArgs = null;
let lastSpawnOptions = null;
let fakeProc = null;

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd, args, options) => {
    spawnCalls.push(args);
    lastSpawnArgs = args;
    lastSpawnOptions = options;

    if (fakeProc) {
      return fakeProc;
    }

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();

    queueMicrotask(() => {
      if (args.includes('--dump-single-json')) {
        proc.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              title: 'Test Playlist',
              entries: [
                {
                  id: 'abc123',
                  title: 'Track 1',
                  webpage_url: 'https://youtube.com/watch?v=abc123',
                  duration: 100,
                },
              ],
            })
          )
        );
      } else if (args.includes('availability')) {
        proc.stdout.emit('data', Buffer.from('public'));
      }
      proc.emit('close', 0);
    });

    return proc;
  }),
}));

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

import fs from 'fs';
import path from 'path';
import {
  detectPlatform,
  fetchPlaylistInfo,
  searchYouTube,
  createPreviewAudioStream,
  downloadUrl,
} from '../audio/ytDlpManager.js';

describe('detectPlatform', () => {
  it('returns youtube for youtube.com URLs', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(detectPlatform('https://youtube.com/playlist?list=abc123')).toBe('youtube');
  });

  it('returns youtube for youtu.be URLs', () => {
    expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
  });

  it('returns soundcloud for soundcloud.com URLs', () => {
    expect(detectPlatform('https://soundcloud.com/artist/track')).toBe('soundcloud');
  });

  it('returns bandcamp for bandcamp.com URLs', () => {
    expect(detectPlatform('https://someartist.bandcamp.com/album/release')).toBe('bandcamp');
  });

  it('returns other for generic/unrecognised URLs', () => {
    expect(detectPlatform('https://vimeo.com/123456789')).toBe('other');
    expect(detectPlatform('https://example.com/audio.mp3')).toBe('other');
  });

  it('returns other for invalid / non-URL strings', () => {
    expect(detectPlatform('not-a-url')).toBe('other');
    expect(detectPlatform('')).toBe('other');
    expect(detectPlatform('just some text')).toBe('other');
  });
});

// ── Cloud Search (#376) — YouTube side ────────────────────────────────────────

describe('searchYouTube', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    fakeProc = makeFakeProc();
  });

  it('spawns yt-dlp with a ytsearchN: pseudo-URL and maps results to the shared result shape', async () => {
    const resultPromise = searchYouTube('daft punk', { limit: 5 });

    fakeProc.stdout.emit(
      'data',
      JSON.stringify({
        entries: [
          {
            id: 'abc123',
            title: 'Daft Punk - One More Time',
            url: 'https://youtu.be/abc123',
            duration: 320,
          },
          {
            id: 'def456',
            title: 'Daft Punk - Harder Better Faster Stronger',
            url: 'https://youtu.be/def456',
            duration: 224,
          },
        ],
      })
    );
    fakeProc.emit('close', 0);

    const results = await resultPromise;

    expect(lastSpawnArgs).toContain('ytsearch5:daft punk');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      source: 'youtube',
      type: 'track',
      id: 'abc123',
      title: 'Daft Punk - One More Time',
      durationSec: 320,
      url: 'https://youtu.be/abc123',
    });
  });

  it('filters out unavailable entries', async () => {
    const resultPromise = searchYouTube('some query');

    fakeProc.stdout.emit(
      'data',
      JSON.stringify({
        entries: [
          { id: '1', title: 'Available Track', url: 'https://youtu.be/1', duration: 100 },
          { id: '2', title: '[Private video]', url: 'https://youtu.be/2', duration: 100 },
        ],
      })
    );
    fakeProc.emit('close', 0);

    const results = await resultPromise;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('defaults to a limit of 20 results when none is specified', async () => {
    const resultPromise = searchYouTube('some query');
    fakeProc.stdout.emit('data', JSON.stringify({ entries: [] }));
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(lastSpawnArgs).toContain('ytsearch20:some query');
  });

  it('passes cookiesBrowser through to yt-dlp so YouTube search authenticates (#466)', async () => {
    const resultPromise = searchYouTube('daft punk', { limit: 5, cookiesBrowser: 'firefox' });

    fakeProc.stdout.emit('data', JSON.stringify({ entries: [] }));
    fakeProc.emit('close', 0);
    await resultPromise;

    const cookieIdx = lastSpawnArgs.indexOf('--cookies-from-browser');
    expect(cookieIdx).toBeGreaterThan(-1);
    expect(lastSpawnArgs[cookieIdx + 1]).toBe('firefox');
  });

  it('does NOT add --cookies-from-browser when cookiesBrowser is omitted', async () => {
    const resultPromise = searchYouTube('daft punk', { limit: 5 });
    fakeProc.stdout.emit('data', JSON.stringify({ entries: [] }));
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(lastSpawnArgs).not.toContain('--cookies-from-browser');
  });
});

// Regression for #404: the per-entry availability check used player_client=web
// only, which fails format resolution for most videos (YouTube's SABR-streaming/
// PO-token enforcement on the web client) and was misread as "unavailable".
describe('checkYouTubeAvailability (via fetchPlaylistInfo)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    fakeProc = null;
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  it('probes availability using the android_vr,web extractor client', async () => {
    await fetchPlaylistInfo('https://www.youtube.com/playlist?list=xyz');

    const availabilityCall = spawnCalls.find((args) => args.includes('availability'));
    expect(availabilityCall).toBeDefined();
    const clientArgIndex = availabilityCall.indexOf('--extractor-args');
    expect(availabilityCall[clientArgIndex + 1]).toBe('youtube:player_client=android_vr,web');
  });

  it('does not flag a publicly-available entry as unavailable', async () => {
    const info = await fetchPlaylistInfo('https://www.youtube.com/playlist?list=xyz');
    expect(info.entries[0].unavailable).toBe(false);
  });
});

// Cloud-search inline preview streams yt-dlp stdout live (-o -) so playback
// starts as data arrives; cookies are required for age-restricted tracks.
describe('createPreviewAudioStream', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    fakeProc = makeFakeProc();
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  it('spawns yt-dlp with -o - and cookies when cookiesBrowser is provided', () => {
    createPreviewAudioStream('https://www.youtube.com/watch?v=abc123', {
      cookiesBrowser: 'librewolf',
    });

    expect(lastSpawnArgs).toContain('-o');
    expect(lastSpawnArgs).toContain('-');
    const cookieIdx = lastSpawnArgs.indexOf('--cookies-from-browser');
    expect(cookieIdx).toBeGreaterThan(-1);
    expect(lastSpawnArgs[lastSpawnArgs.length - 1]).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('does NOT add --cookies-from-browser when cookiesBrowser is omitted', () => {
    createPreviewAudioStream('https://www.youtube.com/watch?v=abc123');
    expect(lastSpawnArgs).not.toContain('--cookies-from-browser');
  });
});

// ── Non-ASCII titles on Windows (#615) ────────────────────────────────────────
// yt-dlp writes its `--print` output into a PIPE; on Windows the interpreter
// encodes that pipe with the ANSI code page, so "Canopée" arrives as a byte that
// is invalid UTF-8. Decoding with chunk.toString() produced U+FFFD, the reported
// file path then did not exist on disk (ENOENT on import) and, because
// destinationFiles was non-empty, the tmpDir fallback scan never ran, so the
// correctly-named file actually sitting in %TEMP%\djman-ytdlp was never imported.
describe('yt-dlp UTF-8 stdio (#615)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    lastSpawnArgs = null;
    lastSpawnOptions = null;
    fakeProc = makeFakeProc();
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  it('forces UTF-8 text output with --encoding on the yt-dlp command line', () => {
    createPreviewAudioStream('https://www.youtube.com/watch?v=abc123');

    const idx = lastSpawnArgs.indexOf('--encoding');
    expect(idx).toBeGreaterThan(-1);
    expect(lastSpawnArgs[idx + 1]).toBe('utf-8');
  });

  it('forces the interpreter stdio to UTF-8 through the spawn env', () => {
    createPreviewAudioStream('https://www.youtube.com/watch?v=abc123');

    expect(lastSpawnOptions.env.PYTHONIOENCODING).toBe('utf-8');
    expect(lastSpawnOptions.env.PYTHONUTF8).toBe('1');
  });

  it('keeps a multi-byte title intact when a chunk boundary splits the character', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        entries: [
          {
            id: 'abc123',
            title: 'Canopée – Impératrice',
            url: 'https://youtu.be/abc123',
            duration: 200,
          },
        ],
      }),
      'utf8'
    );
    // cut the buffer inside the two bytes of the "é" in "Canopée"
    const cut = payload.indexOf(Buffer.from('é', 'utf8')) + 1;
    expect(cut).toBeGreaterThan(0);

    const resultPromise = searchYouTube('canopee', { limit: 1 });
    fakeProc.stdout.emit('data', payload.subarray(0, cut));
    fakeProc.stdout.emit('data', payload.subarray(cut));
    fakeProc.emit('close', 0);

    const results = await resultPromise;
    expect(results[0].title).toBe('Canopée – Impératrice');
  });

  it('rescans tmpDir when the path reported by the marker is not on disk', async () => {
    const tmpDir = path.join('/tmp', 'djman-ytdlp');
    const mangled = path.join(tmpDir, 'Canop\ufffde [abc123].mp3');
    const realFile = path.join(tmpDir, 'Canopée [abc123].mp3');

    fs.existsSync.mockImplementation((p) => p !== mangled);
    fs.promises.readdir.mockResolvedValue(['Canopée [abc123].mp3']);
    fs.statSync.mockReturnValue({ mtimeMs: Date.now() });

    const onFileReady = vi.fn();
    const resultPromise = downloadUrl('https://www.youtube.com/watch?v=abc123', undefined, {
      onFileReady,
    });
    // _downloadUrlOnce awaits mkdir before spawning, so let that settle before
    // driving the fake process.
    await new Promise((resolve) => setTimeout(resolve, 0));

    fakeProc.stdout.emit('data', Buffer.from('__YTDLP_TRACK__:1:Canop\ufffde\n'));
    // no trailing newline on the marker line: it must still be flushed on close
    fakeProc.stdout.emit('data', Buffer.from(`__YTDLP_FILE__:${mangled}`));
    fakeProc.emit('close', 0);

    const result = await resultPromise;

    expect(onFileReady).toHaveBeenCalledWith(expect.objectContaining({ filePath: realFile }));
    expect(result.files.map((f) => f.filePath)).toEqual([realFile]);
  });
});
