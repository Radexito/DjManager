import { describe, it, expect, vi, beforeEach } from 'vitest';

// deps.js pulls in electron — stub it out.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../deps.js', () => ({
  getFfmpegRuntimePath: () => '/usr/bin/ffmpeg',
  getFfprobeRuntimePath: () => '/usr/bin/ffprobe',
}));

// ffprobe drives "what tags already exist" — each test sets `probeTags`.
let probeTags = {};
vi.mock('../audio/ffmpeg.js', () => ({
  ffprobe: vi.fn(async () => ({ format: { tags: probeTags } })),
}));

// Record every ffmpeg/ffprobe invocation instead of spawning processes.
const execCalls = [];
let ffmpegShouldFail = false;
vi.mock('child_process', () => ({
  // promisify appends its callback after the original args — accept it in
  // either position (2-arg calls land it 3rd, with-options calls 4th).
  execFile: (file, args, optsOrCb, maybeCb) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    execCalls.push([file, ...(Array.isArray(args) ? args : [args])]);
    if (file.endsWith('ffmpeg') && ffmpegShouldFail) {
      return cb(new Error('ffmpeg exploded'));
    }
    return cb(null, { stdout: '', stderr: '' });
  },
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import fs from 'fs';
import {
  writeBpmKeyTags,
  writeId3Tags,
  readBpmKeyTags,
  supportsBpmKeyTags,
} from '../audio/id3Writer.js';

const metadataArgs = () => {
  const call = execCalls.find((c) => c[0].endsWith('ffmpeg'));
  return call ?? [];
};

beforeEach(() => {
  execCalls.length = 0;
  probeTags = {};
  ffmpegShouldFail = false;
  vi.clearAllMocks();
});

describe('supportsBpmKeyTags', () => {
  it('accepts mp3/flac/ogg/opus and rejects m4a/wav/aiff', () => {
    expect(supportsBpmKeyTags('/music/a.mp3')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.flac')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.ogg')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.opus')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.m4a')).toBe(false);
    expect(supportsBpmKeyTags('/music/a.wav')).toBe(false);
    expect(supportsBpmKeyTags('/music/a.aiff')).toBe(false);
  });
});

describe('readBpmKeyTags', () => {
  it('reads BPM/key regardless of the naming convention in the file', async () => {
    probeTags = { TBPM: '128', initialkey: '8A' };
    expect(await readBpmKeyTags('/music/a.mp3')).toEqual({ bpm: '128', key: '8A' });

    probeTags = { BPM: '174', KEY: '9B' };
    expect(await readBpmKeyTags('/music/a.flac')).toEqual({ bpm: '174', key: '9B' });

    probeTags = {};
    expect(await readBpmKeyTags('/music/a.mp3')).toEqual({ bpm: null, key: null });
  });
});

describe('writeBpmKeyTags', () => {
  it('writes ID3 TBPM/TKEY for MP3', async () => {
    const res = await writeBpmKeyTags('/music/a.mp3', { bpm: 128, key: '8A' });

    expect(res).toEqual({ ok: true, wrote: ['bpm', 'key'] });
    expect(metadataArgs()).toContain('TBPM=128');
    expect(metadataArgs()).toContain('TKEY=8A');
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('writes Vorbis BPM/KEY for FLAC', async () => {
    const res = await writeBpmKeyTags('/music/a.flac', { bpm: 174, key: '9B' });

    expect(res.ok).toBe(true);
    expect(metadataArgs()).toContain('BPM=174');
    expect(metadataArgs()).toContain('KEY=9B');
    expect(metadataArgs()).not.toContain('TBPM=174');
  });

  it('skips containers with no interoperable slot (m4a/wav/aiff)', async () => {
    for (const ext of ['m4a', 'wav', 'aiff']) {
      const res = await writeBpmKeyTags(`/music/a.${ext}`, { bpm: 128, key: '8A' });
      expect(res).toEqual({ ok: false, reason: 'unsupported-format' });
    }
    expect(execCalls).toHaveLength(0);
  });

  it('reports missing files and empty values without touching ffmpeg', async () => {
    fs.existsSync.mockReturnValueOnce(false);
    expect(await writeBpmKeyTags('/music/gone.mp3', { bpm: 128 })).toEqual({
      ok: false,
      reason: 'missing-file',
    });
    expect(await writeBpmKeyTags('/music/a.mp3', { bpm: null, key: null })).toEqual({
      ok: false,
      reason: 'no-values',
    });
    expect(execCalls).toHaveLength(0);
  });

  it('fill-missing (default): leaves an existing tag alone entirely', async () => {
    probeTags = { TBPM: '120', TKEY: '8A' };
    const res = await writeBpmKeyTags('/music/a.mp3', { bpm: 128, key: '9B' });

    expect(res).toEqual({ ok: true, reason: 'already-current', wrote: [] });
    expect(execCalls).toHaveLength(0);
  });

  it('fill-missing: writes only the tag that is absent', async () => {
    probeTags = { TBPM: '120' };
    const res = await writeBpmKeyTags('/music/a.mp3', { bpm: 128, key: '9B' });

    expect(res.wrote).toEqual(['key']);
    expect(metadataArgs()).toContain('TKEY=9B');
    expect(metadataArgs()).not.toContain('TBPM=128');
  });

  it('overwrite: replaces a differing value but not an equal one', async () => {
    probeTags = { TBPM: '120', TKEY: '9B' };
    const res = await writeBpmKeyTags('/music/a.mp3', {
      bpm: 128,
      key: '9B',
      overwrite: true,
    });

    expect(res.wrote).toEqual(['bpm']);
    expect(metadataArgs()).toContain('TBPM=128');
  });

  it('overwrite: rewrites when the stored tag differs (key compared case-insensitively)', async () => {
    probeTags = { TBPM: '128', TKEY: '8a' };
    const res = await writeBpmKeyTags('/music/a.mp3', {
      bpm: 128,
      key: '8A',
      overwrite: true,
    });

    expect(res).toEqual({ ok: true, reason: 'already-current', wrote: [] });
  });

  it('reports an ffmpeg failure and cleans up the temp file', async () => {
    ffmpegShouldFail = true;
    const res = await writeBpmKeyTags('/music/a.mp3', { bpm: 128 });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('write-failed');
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith('/music/a.mp3.id3tmp.mp3');
  });

  it('rounds fractional BPM values', async () => {
    await writeBpmKeyTags('/music/a.flac', { bpm: 127.6, key: null });
    expect(metadataArgs()).toContain('BPM=128');
  });
});

describe('writeId3Tags (existing text tags — regression)', () => {
  it('still writes the mapped text/genre fields', async () => {
    await writeId3Tags('/music/a.mp3', {
      title: 'Song',
      artist: 'Artist',
      genres: JSON.stringify(['House', 'Techno']),
    });

    expect(metadataArgs()).toContain('title=Song');
    expect(metadataArgs()).toContain('artist=Artist');
    expect(metadataArgs()).toContain('genre=House, Techno');
    expect(fs.renameSync).toHaveBeenCalled();
  });
});
