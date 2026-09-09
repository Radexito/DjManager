import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../deps.js', () => ({
  getYtDlpRuntimePath: () => '/usr/bin/yt-dlp',
  getFfmpegRuntimePath: () => '/usr/bin/ffmpeg',
}));

vi.mock('fs', () => ({
  default: { existsSync: vi.fn().mockReturnValue(true) },
  existsSync: vi.fn().mockReturnValue(true),
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
let fakeProc = null;

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd, args) => {
    spawnCalls.push(args);
    lastSpawnArgs = args;

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
import { detectPlatform, fetchPlaylistInfo, searchYouTube } from '../audio/ytDlpManager.js';

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
