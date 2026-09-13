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

// MP4 tag writing is exercised in mp4Tags.test.js — here we only check that
// .m4a/.mp4 is routed there with the right policy.
let mp4Existing = { bpm: null, key: null };
const mp4Writes = [];
vi.mock('../audio/mp4Tags.js', () => ({
  supportsMp4Tags: (p) => /\.(m4a|mp4)$/i.test(p || ''),
  readMp4Tags: () => mp4Existing,
  writeMp4Tags: (filePath, opts) => {
    mp4Writes.push({ filePath, ...opts });
    return { ok: true, inserted: 2, replaced: 0, chunkOffsetsPatched: 9 };
  },
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
    readFileSync: vi.fn(() => Buffer.alloc(0)),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => Buffer.alloc(0)),
  writeFileSync: vi.fn(),
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
  it('accepts the containers that have a place to put BPM/key', () => {
    expect(supportsBpmKeyTags('/music/a.mp3')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.flac')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.ogg')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.opus')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.m4a')).toBe(true);
    expect(supportsBpmKeyTags('/music/a.mp4')).toBe(true);
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

  it('skips containers with no interoperable slot (wav/aiff)', async () => {
    for (const ext of ['wav', 'aiff']) {
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

// ── #474 (m4a) + container cleanup ───────────────────────────────────────────

describe('MP4 files go through the atom writer', () => {
  it('routes .m4a writes there with both values', async () => {
    mp4Existing = { bpm: null, key: null };
    mp4Writes.length = 0;
    const res = await writeBpmKeyTags('/music/a.m4a', { bpm: 128, key: '9B' });
    expect(res).toMatchObject({ ok: true, wrote: ['bpm', 'key'] });
    expect(mp4Writes).toEqual([{ filePath: '/music/a.m4a', bpm: 128, key: '9B' }]);
  });

  it('fills only the missing field (fill-missing policy)', async () => {
    mp4Existing = { bpm: 146, key: null };
    mp4Writes.length = 0;
    const res = await writeBpmKeyTags('/music/a.m4a', { bpm: 128, key: '9B' });
    expect(res.wrote).toEqual(['key']);
    expect(mp4Writes[0]).toMatchObject({ bpm: null, key: '9B' });
  });

  it('rewrites both fields when overwriting is on', async () => {
    mp4Existing = { bpm: 146, key: '1A' };
    mp4Writes.length = 0;
    const res = await writeBpmKeyTags('/music/a.m4a', { bpm: 128, key: '9B', overwrite: true });
    expect(res.wrote).toEqual(['bpm', 'key']);
    expect(mp4Writes[0]).toMatchObject({ bpm: 128, key: '9B' });
  });

  it('leaves an .m4a alone when it already matches', async () => {
    mp4Existing = { bpm: 128, key: '9B' };
    mp4Writes.length = 0;
    const res = await writeBpmKeyTags('/music/a.m4a', { bpm: 128, key: '9B' });
    expect(res).toMatchObject({ ok: true, reason: 'already-current' });
    expect(mp4Writes).toEqual([]);
  });

  it('rounds a fractional BPM before it reaches the atom', async () => {
    mp4Existing = { bpm: null, key: null };
    mp4Writes.length = 0;
    await writeBpmKeyTags('/music/a.m4a', { bpm: 127.6, key: null });
    expect(mp4Writes[0].bpm).toBe(128);
  });
});

describe('inherited MP4 container fields are cleaned up', () => {
  it('deletes them when writing BPM/key to an mp3', async () => {
    probeTags = {};
    await writeBpmKeyTags('/music/a.mp3', { bpm: 120, key: null });
    const args = metadataArgs();
    expect(args).toContain('major_brand=');
    expect(args).toContain('minor_version=');
    expect(args).toContain('compatible_brands=');
  });

  it('deletes them when writing text tags too', async () => {
    await writeId3Tags('/music/a.mp3', { title: 'Song' });
    expect(metadataArgs()).toContain('compatible_brands=');
  });
});
