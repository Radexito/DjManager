import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// #561 — ffprobe is the only process this module reaches for, and it is mocked
// here so the tests never spawn one. The database is REAL (db project,
// DB_PATH=:memory: with src/__tests__/setup.js calling initDB()), which is what
// makes the "probed once, then remembered" assertions meaningful.
vi.mock('../audio/ffmpeg.js', () => ({ ffprobe: vi.fn() }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ffprobe } from '../audio/ffmpeg.js';
import {
  sampleInfoFromProbe,
  bitDepthForFormat,
  resolveTrackSampleInfo,
  resolveExportSampleInfo,
  backfillPdbSampleInfo,
} from '../audio/sampleInfo.js';
import { addTrack, getTrackById } from '../db/trackRepository.js';

/** A real probe result for a 48 kHz / 24 bit flac (the shape ffprobe emits). */
const FLAC_24_48 = {
  format: { format_name: 'flac' },
  streams: [
    { codec_type: 'audio', codec_name: 'flac', sample_rate: '48000', bits_per_raw_sample: '24' },
  ],
};

/** Lossy mp3: ffprobe reports a rate but no usable depth. */
const MP3_44 = {
  format: { format_name: 'mp3' },
  streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', bits_per_sample: 0 }],
};

const TRACK = {
  title: 'Probe Me',
  artist: 'Someone',
  duration: 200,
  file_path: '/tmp/djm-561/probe.flac',
  file_hash: 'hash-561',
  format: 'flac',
  bitrate: 900000,
};

let tmpRoot;
const tmpRoots = [];

beforeEach(() => {
  ffprobe.mockReset();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djm-561-'));
  tmpRoots.push(tmpRoot);
});

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** Writes an empty file so the "is it on the stick" check passes; content is irrelevant. */
function makeUsbFile(relPath) {
  const abs = path.join(tmpRoot, relPath.replace(/^[/\\]+/, ''));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'not really audio');
  return abs;
}

describe('sampleInfoFromProbe (#561)', () => {
  it('reads sample_rate and prefers bits_per_raw_sample', () => {
    expect(sampleInfoFromProbe(FLAC_24_48)).toEqual({
      sampleRate: 48000,
      bitDepth: 24,
      codec: 'flac',
    });
  });

  it('ignores non-audio streams', () => {
    const probe = {
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          sample_rate: '90000',
          bits_per_raw_sample: '8',
        },
        {
          codec_type: 'audio',
          codec_name: 'pcm_s16le',
          sample_rate: '44100',
          bits_per_raw_sample: '16',
        },
      ],
    };
    expect(sampleInfoFromProbe(probe)).toEqual({
      sampleRate: 44100,
      bitDepth: 16,
      codec: 'pcm_s16le',
    });
  });

  it('falls back to bits_per_sample when bits_per_raw_sample is absent or 0', () => {
    expect(
      sampleInfoFromProbe({
        streams: [
          { codec_type: 'audio', codec_name: 'alac', sample_rate: '44100', bits_per_sample: 16 },
        ],
      }).bitDepth
    ).toBe(16);

    expect(
      sampleInfoFromProbe({
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'alac',
            sample_rate: '44100',
            bits_per_raw_sample: '0',
            bits_per_sample: 24,
          },
        ],
      }).bitDepth
    ).toBe(24);
  });

  it('treats a missing or zero field as unknown, never as 16', () => {
    expect(sampleInfoFromProbe(MP3_44)).toEqual({
      sampleRate: 44100,
      bitDepth: null,
      codec: 'mp3',
    });
    expect(sampleInfoFromProbe({ streams: [{ codec_type: 'audio', sample_rate: 0 }] })).toEqual({
      sampleRate: null,
      bitDepth: null,
      codec: null,
    });
    expect(sampleInfoFromProbe({ streams: [] })).toEqual({
      sampleRate: null,
      bitDepth: null,
      codec: null,
    });
    expect(sampleInfoFromProbe(null)).toEqual({ sampleRate: null, bitDepth: null, codec: null });
  });
});

describe('bitDepthForFormat (#561)', () => {
  it('is 16 bit for the lossy codecs and for the pcm_s16 export formats', () => {
    expect(bitDepthForFormat('mp3', 24)).toBe(16);
    expect(bitDepthForFormat('aac', 24)).toBe(16);
    expect(bitDepthForFormat('wav', 24)).toBe(16); // FORMAT_CODEC writes pcm_s16le
    expect(bitDepthForFormat('aiff', 24)).toBe(16); // FORMAT_CODEC writes pcm_s16be
  });

  it('keeps the source depth for flac and for anything else', () => {
    expect(bitDepthForFormat('flac', 24)).toBe(24);
    expect(bitDepthForFormat('flac', null)).toBeNull();
    expect(bitDepthForFormat(null, 24)).toBe(24);
  });

  it('recognises the codec names ffprobe returns', () => {
    expect(bitDepthForFormat('pcm_s16le', null)).toBe(16);
    expect(bitDepthForFormat('pcm_s24le', null)).toBeNull();
  });
});

describe('resolveTrackSampleInfo (#561)', () => {
  it('uses the stored values and never probes', async () => {
    const id = addTrack({ ...TRACK, sample_rate: 48000, bit_depth: 24 });

    const info = await resolveTrackSampleInfo(getTrackById(id));

    expect(info).toEqual({ sampleRate: 48000, bitDepth: 24, probed: false });
    expect(ffprobe).not.toHaveBeenCalled();
  });

  it('probes a track imported before the columns existed and stores the answer', async () => {
    const id = addTrack(TRACK);
    ffprobe.mockResolvedValueOnce(FLAC_24_48);

    const info = await resolveTrackSampleInfo(getTrackById(id));

    expect(info).toEqual({ sampleRate: 48000, bitDepth: 24, probed: true });
    expect(ffprobe).toHaveBeenCalledTimes(1);
    expect(ffprobe).toHaveBeenCalledWith(TRACK.file_path);

    const stored = getTrackById(id);
    expect(stored.sample_rate).toBe(48000);
    expect(stored.bit_depth).toBe(24);
  });

  it('does not probe the same track twice', async () => {
    const id = addTrack(TRACK);
    ffprobe.mockResolvedValueOnce(FLAC_24_48);

    await resolveTrackSampleInfo(getTrackById(id));
    const second = await resolveTrackSampleInfo(getTrackById(id));

    expect(second).toEqual({ sampleRate: 48000, bitDepth: 24, probed: false });
    expect(ffprobe).toHaveBeenCalledTimes(1);
  });

  it('stores the rate even when the probe reports no depth', async () => {
    const id = addTrack(TRACK);
    ffprobe.mockResolvedValueOnce(MP3_44);

    await resolveTrackSampleInfo(getTrackById(id));

    const stored = getTrackById(id);
    expect(stored.sample_rate).toBe(44100);
    expect(stored.bit_depth).toBeNull();
  });

  it('fills only the missing value and keeps the stored one', async () => {
    const id = addTrack({ ...TRACK, sample_rate: 44100 });
    ffprobe.mockResolvedValueOnce(FLAC_24_48);

    await resolveTrackSampleInfo(getTrackById(id));

    const stored = getTrackById(id);
    expect(stored.sample_rate).toBe(44100); // stored value wins over the probe
    expect(stored.bit_depth).toBe(24);
  });

  it('leaves the track alone and reports when ffprobe fails', async () => {
    const id = addTrack(TRACK);
    const log = vi.fn();
    ffprobe.mockRejectedValueOnce(new Error('No such file or directory'));

    const info = await resolveTrackSampleInfo(getTrackById(id), { log });

    expect(info).toEqual({ sampleRate: null, bitDepth: null, probed: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ffprobe failed'));
    expect(getTrackById(id).sample_rate).toBeNull();
  });

  it('logs and stores nothing when the probe reports no usable numbers', async () => {
    const id = addTrack(TRACK);
    const log = vi.fn();
    ffprobe.mockResolvedValueOnce({ format: {}, streams: [{ codec_type: 'audio' }] });

    const info = await resolveTrackSampleInfo(getTrackById(id), { log });

    expect(info).toEqual({ sampleRate: null, bitDepth: null, probed: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nothing usable'));
    expect(getTrackById(id).bit_depth).toBeNull();
  });
});

describe('resolveExportSampleInfo (#561)', () => {
  it('passes the library values through for a file that was copied unchanged', async () => {
    const id = addTrack({ ...TRACK, sample_rate: 96000, bit_depth: 24 });

    const map = await resolveExportSampleInfo([getTrackById(id)], {});

    expect(map.get(id)).toEqual({ sampleRate: 96000, bitDepth: 24 });
    expect(ffprobe).not.toHaveBeenCalled();
  });

  it('reports the output codec depth when the export re-encodes', async () => {
    const id = addTrack({ ...TRACK, sample_rate: 96000, bit_depth: 24 });
    const usbMeta = new Map([
      [id, { fileSize: 1, bitrate: 320000, reencoded: true, format: 'mp3' }],
    ]);

    const map = await resolveExportSampleInfo([getTrackById(id)], { usbMeta });

    // mp3 is 16 bit; ffmpeg is never asked to resample, so the rate is kept
    expect(map.get(id)).toEqual({ sampleRate: 96000, bitDepth: 16 });
  });

  it('keeps the source depth when the export re-encodes to flac', async () => {
    const id = addTrack({ ...TRACK, sample_rate: 48000, bit_depth: 24 });
    const usbMeta = new Map([[id, { reencoded: true, format: 'flac' }]]);

    const map = await resolveExportSampleInfo([getTrackById(id)], { usbMeta });

    expect(map.get(id)).toEqual({ sampleRate: 48000, bitDepth: 24 });
  });

  it('probes and stores for a track with no values, and reports nothing for a failed probe', async () => {
    const missing = addTrack({ ...TRACK, file_hash: 'h1', file_path: '/tmp/djm-561/a.flac' });
    const broken = addTrack({ ...TRACK, file_hash: 'h2', file_path: '/tmp/djm-561/b.flac' });
    ffprobe.mockImplementation(async (filePath) => {
      if (filePath.endsWith('a.flac')) return FLAC_24_48;
      throw new Error('gone');
    });
    const log = vi.fn();

    const map = await resolveExportSampleInfo([getTrackById(missing), getTrackById(broken)], {
      log,
    });

    expect(map.get(missing)).toEqual({ sampleRate: 48000, bitDepth: 24 });
    expect(map.get(broken)).toEqual({ sampleRate: null, bitDepth: null });
    expect(ffprobe).toHaveBeenCalledTimes(2);
    expect(getTrackById(missing).sample_rate).toBe(48000);
    expect(getTrackById(broken).sample_rate).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ffprobe failed'));
  });

  it('takes the manifest values for a reused file instead of guessing from the library', async () => {
    const id = addTrack({ ...TRACK, sample_rate: 96000, bit_depth: 24 });
    const manifestTracks = new Map([
      [id, { id, file_path: '/music/x.mp3', sample_rate: 44100, bit_depth: 16 }],
    ]);

    const map = await resolveExportSampleInfo([getTrackById(id)], {
      reusedIds: new Set([id]),
      manifestTracks,
    });

    expect(map.get(id)).toEqual({ sampleRate: 44100, bitDepth: 16 });
    expect(ffprobe).not.toHaveBeenCalled();
  });

  it('leaves a reused file from an older manifest empty for the backfill', async () => {
    const id = addTrack({ ...TRACK, sample_rate: 96000, bit_depth: 24 });
    const manifestTracks = new Map([[id, { id, file_path: '/music/x.mp3' }]]);

    const map = await resolveExportSampleInfo([getTrackById(id)], {
      reusedIds: new Set([id]),
      manifestTracks,
    });

    expect(map.get(id)).toEqual({ sampleRate: null, bitDepth: null });
    expect(ffprobe).not.toHaveBeenCalled();
  });
});

describe('backfillPdbSampleInfo (#561)', () => {
  it('does not probe a row that already has both values', async () => {
    const rows = [{ id: 1, file_path: '/music/a.flac', sample_rate: 48000, bit_depth: 24 }];

    const result = await backfillPdbSampleInfo(rows, { usbRoot: tmpRoot });

    expect(result).toEqual({ probed: 0, unresolved: 0 });
    expect(ffprobe).not.toHaveBeenCalled();
    expect(rows[0].sample_rate).toBe(48000);
    expect(rows[0].bit_depth).toBe(24);
  });

  it('probes the file on the stick once and keeps the answer in the row', async () => {
    makeUsbFile('music/a.flac');
    const rows = [{ id: 1, file_path: '/music/a.flac', sample_rate: null, bit_depth: null }];
    ffprobe.mockResolvedValueOnce(FLAC_24_48);

    const result = await backfillPdbSampleInfo(rows, { usbRoot: tmpRoot });

    expect(result).toEqual({ probed: 1, unresolved: 0 });
    expect(ffprobe).toHaveBeenCalledWith(path.join(tmpRoot, 'music/a.flac'));
    expect(rows[0]).toEqual({
      id: 1,
      file_path: '/music/a.flac',
      sample_rate: 48000,
      bit_depth: 24,
    });

    // Second pass over the same rows: nothing left to probe
    const again = await backfillPdbSampleInfo(rows, { usbRoot: tmpRoot });
    expect(again).toEqual({ probed: 0, unresolved: 0 });
    expect(ffprobe).toHaveBeenCalledTimes(1);
  });

  it('fills a partial row from the probe and replaces a half-known pair', async () => {
    makeUsbFile('music/b.flac');
    const rows = [{ id: 2, file_path: '/music/b.flac', sample_rate: 44100, bit_depth: null }];
    ffprobe.mockResolvedValueOnce(FLAC_24_48);

    await backfillPdbSampleInfo(rows, { usbRoot: tmpRoot });

    expect(rows[0].sample_rate).toBe(44100);
    expect(rows[0].bit_depth).toBe(24);
  });

  it('writes 16 bit for a lossy file whose depth ffprobe does not report', async () => {
    makeUsbFile('music/c.mp3');
    const rows = [{ id: 3, file_path: '/music/c.mp3', sample_rate: null, bit_depth: null }];
    ffprobe.mockResolvedValueOnce(MP3_44);

    const result = await backfillPdbSampleInfo(rows, { usbRoot: tmpRoot });

    expect(result).toEqual({ probed: 1, unresolved: 0 });
    expect(rows[0].sample_rate).toBe(44100);
    expect(rows[0].bit_depth).toBe(16); // mp3 decodes to 16 bit by definition
  });

  it('logs once and falls back when the probe fails, without throwing', async () => {
    makeUsbFile('music/d.flac');
    const rows = [{ id: 4, file_path: '/music/d.flac', sample_rate: null, bit_depth: null }];
    ffprobe.mockRejectedValueOnce(new Error('unreadable'));
    const log = vi.fn();

    const result = await backfillPdbSampleInfo(rows, { usbRoot: tmpRoot, log });

    expect(result).toEqual({ probed: 1, unresolved: 1 });
    expect(rows[0].sample_rate).toBeNull();
    expect(rows[0].bit_depth).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ffprobe failed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('44100 Hz / 16 bit'));
  });

  it('does not probe a row whose file is not on the stick', async () => {
    const rows = [{ id: 5, file_path: '/music/missing.flac', sample_rate: null, bit_depth: null }];
    const log = vi.fn();

    const result = await backfillPdbSampleInfo(rows, { usbRoot: tmpRoot, log });

    expect(result).toEqual({ probed: 0, unresolved: 1 });
    expect(ffprobe).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });
});
