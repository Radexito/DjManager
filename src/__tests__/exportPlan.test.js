import { describe, it, expect } from 'vitest';
import {
  EXPORT_ACTION,
  CONVERT_REASON,
  planExportActions,
  describeExportPlan,
  describeCopyProgress,
  describeConvertProgress,
  formatElapsed,
} from '../usb/exportPlan.js';

/** Minimal track row shaped like the DB row copyTrackToUsb() reads. */
function track(over = {}) {
  return {
    id: 't1',
    file_path: '/lib/audio/aa/hash.mp3',
    loudness: null,
    duration: 300,
    trim_start_ms: null,
    trim_end_ms: null,
    ...over,
  };
}

const opts = (over = {}) => ({
  useNormalized: false,
  targetLufs: null,
  targetDevice: null,
  forceMp3: false,
  applyTrim: true,
  ...over,
});

describe('planExportActions — copy path', () => {
  it('is a plain copy when nothing changes the file', () => {
    const plan = planExportActions([track({ id: 'a' }), track({ id: 'b' })], opts());
    expect(plan.tracks.map((t) => t.action)).toEqual([EXPORT_ACTION.COPY, EXPORT_ACTION.COPY]);
    expect(plan.tracks[0]).toMatchObject({ id: 'a', reason: 'copy', reasons: [] });
    expect(plan.totals).toMatchObject({ total: 2, copy: 2, convert: 0, reuse: 0 });
    expect(plan.totals.byReason).toEqual({ loudness: 0, format: 0, trim: 0 });
  });

  it('is a copy when normalization is on but the gain is exactly zero', () => {
    const plan = planExportActions(
      [track({ id: 'a', loudness: -9 })],
      opts({ useNormalized: true, targetLufs: -9 })
    );
    expect(plan.byId.get('a').action).toBe(EXPORT_ACTION.COPY);
    expect(plan.totals.convert).toBe(0);
  });

  it('is a copy when normalization is on but the track has no loudness measurement', () => {
    const plan = planExportActions(
      [track({ id: 'a', loudness: null })],
      opts({ useNormalized: true, targetLufs: -9 })
    );
    expect(plan.byId.get('a').action).toBe(EXPORT_ACTION.COPY);
  });

  it('is a copy when the track has a trim but the export disables trimming', () => {
    const row = track({ id: 'a', trim_start_ms: 10000, trim_end_ms: 200000, duration: 300 });
    expect(planExportActions([row], opts({ applyTrim: true })).byId.get('a').action).toBe(
      EXPORT_ACTION.CONVERT
    );
    expect(planExportActions([row], opts({ applyTrim: false })).byId.get('a').action).toBe(
      EXPORT_ACTION.COPY
    );
  });
});

describe('planExportActions — re-encode reasons', () => {
  it('normalization with a non-zero gain re-encodes, reason loudness', () => {
    const plan = planExportActions(
      [track({ id: 'a', loudness: -5.95 })],
      opts({ useNormalized: true, targetLufs: -9 })
    );
    expect(plan.byId.get('a')).toMatchObject({
      action: EXPORT_ACTION.CONVERT,
      reason: CONVERT_REASON.LOUDNESS,
      reasons: [CONVERT_REASON.LOUDNESS],
    });
    expect(plan.totals.byReason.loudness).toBe(1);
  });

  it('an unsupported source format re-encodes, reason format', () => {
    const plan = planExportActions(
      [track({ id: 'a', file_path: '/lib/audio/aa/hash.flac' })],
      opts({ targetDevice: 'xdj-1000mk2' })
    );
    expect(plan.byId.get('a')).toMatchObject({
      action: EXPORT_ACTION.CONVERT,
      reason: CONVERT_REASON.FORMAT,
      reasons: [CONVERT_REASON.FORMAT],
    });
  });

  it('forceMp3 re-encodes everything that is not already mp3', () => {
    const plan = planExportActions(
      [
        track({ id: 'wav', file_path: '/lib/a.wav' }),
        track({ id: 'mp3', file_path: '/lib/a.mp3' }),
      ],
      opts({ forceMp3: true })
    );
    expect(plan.byId.get('wav').action).toBe(EXPORT_ACTION.CONVERT);
    expect(plan.byId.get('mp3').action).toBe(EXPORT_ACTION.COPY);
    expect(plan.totals).toMatchObject({ copy: 1, convert: 1 });
  });

  it('a usable trim range re-encodes, reason trim', () => {
    const plan = planExportActions(
      [track({ id: 'a', trim_start_ms: 5000, trim_end_ms: 120000, duration: 300 })],
      opts()
    );
    expect(plan.byId.get('a')).toMatchObject({
      action: EXPORT_ACTION.CONVERT,
      reasons: [CONVERT_REASON.TRIM],
    });
    expect(plan.totals.byReason.trim).toBe(1);
  });

  it('lists every reason a track carries, loudness first', () => {
    const plan = planExportActions(
      [
        track({
          id: 'a',
          file_path: '/lib/a.flac',
          loudness: -4,
          trim_start_ms: 5000,
          trim_end_ms: 120000,
          duration: 300,
        }),
      ],
      opts({ useNormalized: true, targetLufs: -9, targetDevice: 'xdj-1000mk2' })
    );
    expect(plan.byId.get('a').reasons).toEqual([
      CONVERT_REASON.LOUDNESS,
      CONVERT_REASON.FORMAT,
      CONVERT_REASON.TRIM,
    ]);
    expect(plan.totals.byReason).toEqual({ loudness: 1, format: 1, trim: 1 });
  });
});

describe('planExportActions — reuse', () => {
  const manifest = new Map([
    [
      'a',
      {
        file_path: '/music/Artist - Title.mp3',
        file_size: 1000,
        bitrate: 320000,
        trim_start_ms: null,
        trim_end_ms: null,
      },
    ],
  ]);

  it('is a reuse when the track is already on the USB with the same trim', () => {
    const plan = planExportActions([track({ id: 'a', loudness: -4 })], {
      ...opts({ useNormalized: true, targetLufs: -9 }),
      existingTracks: manifest,
    });
    expect(plan.byId.get('a')).toMatchObject({ action: EXPORT_ACTION.REUSE, reasons: [] });
    expect(plan.totals).toMatchObject({ total: 1, copy: 0, convert: 0, reuse: 1 });
  });

  it('is not a reuse when the trim changed since the file was exported', () => {
    const plan = planExportActions(
      [track({ id: 'a', trim_start_ms: 3000, trim_end_ms: 90000, duration: 300 })],
      { ...opts(), existingTracks: manifest }
    );
    expect(plan.byId.get('a').action).toBe(EXPORT_ACTION.CONVERT);
  });

  it('is a reuse when the export disables trimming and the manifest recorded none', () => {
    const plan = planExportActions(
      [track({ id: 'a', trim_start_ms: 3000, trim_end_ms: 90000, duration: 300 })],
      { ...opts({ applyTrim: false }), existingTracks: manifest }
    );
    expect(plan.byId.get('a').action).toBe(EXPORT_ACTION.REUSE);
  });
});

describe('planExportActions — mixed set totals', () => {
  const manifest = new Map([
    ['reused', { file_path: '/music/on-stick.mp3', trim_start_ms: null, trim_end_ms: null }],
  ]);

  it('counts each action and each reason once over the whole set', () => {
    const tracks = [
      track({ id: 'reused', loudness: -3 }),
      track({ id: 'loud1', loudness: -6 }),
      track({ id: 'loud2', loudness: -12 }),
      track({ id: 'fmt', file_path: '/lib/a.flac', loudness: -9 }),
      track({ id: 'plain' }),
    ];
    const plan = planExportActions(tracks, {
      ...opts({ useNormalized: true, targetLufs: -9, targetDevice: 'xdj-1000mk2' }),
      existingTracks: manifest,
    });

    expect(plan.totals).toEqual({
      total: 5,
      copy: 1,
      convert: 3,
      reuse: 1,
      byReason: { loudness: 2, format: 1, trim: 0 },
    });
    expect(plan.byId.get('plain').action).toBe(EXPORT_ACTION.COPY);
    expect(plan.byId.get('fmt').reasons).toEqual([CONVERT_REASON.FORMAT]);
    expect(plan.byId.size).toBe(5);
    expect(plan.tracks).toHaveLength(5);
  });

  it('tolerates an empty or missing track list', () => {
    expect(planExportActions([], opts()).totals.total).toBe(0);
    expect(planExportActions(undefined, opts()).tracks).toEqual([]);
  });
});

describe('describeExportPlan — the cost, before the wait', () => {
  const planOf = (tracks, options) => planExportActions(tracks, options);

  it('names loudness normalization as the reason for a single-reason set', () => {
    const plan = planOf(
      [track({ id: 'a', loudness: -5 }), track({ id: 'b', loudness: -6 })],
      opts({ useNormalized: true, targetLufs: -9 })
    );
    expect(describeExportPlan(plan)).toBe(
      'Exporting 2 tracks (2 will be re-encoded for loudness normalization)…'
    );
  });

  it('breaks the count down by reason when more than one reason applies', () => {
    const manifest = new Map([
      ['reused', { file_path: '/music/on-stick.mp3', trim_start_ms: null, trim_end_ms: null }],
    ]);
    const plan = planOf(
      [
        track({ id: 'reused', loudness: -3 }),
        track({ id: 'loud1', loudness: -6 }),
        track({ id: 'loud2', loudness: -12 }),
        track({ id: 'fmt', file_path: '/lib/a.flac', loudness: -9 }),
        track({ id: 'plain' }),
      ],
      {
        ...opts({ useNormalized: true, targetLufs: -9, targetDevice: 'xdj-1000mk2' }),
        existingTracks: manifest,
      }
    );
    expect(describeExportPlan(plan)).toBe(
      'Exporting 5 tracks (3 will be re-encoded: 2 for loudness normalization, 1 for a format change)…'
    );
  });

  it('says so when nothing needs re-encoding', () => {
    expect(describeExportPlan(planOf([track({ id: 'a' })], opts()))).toBe(
      'Exporting 1 track (no re-encoding needed)…'
    );
  });

  it('says so when every track is already on the USB', () => {
    const manifest = new Map([
      ['a', { file_path: '/music/a.mp3', trim_start_ms: null, trim_end_ms: null }],
    ]);
    const plan = planOf([track({ id: 'a' })], { ...opts(), existingTracks: manifest });
    expect(describeExportPlan(plan)).toBe('Exporting 1 track (all already on the USB)…');
  });

  it('does not claim anything about an empty export', () => {
    expect(describeExportPlan(planOf([], opts()))).toBe('Exporting 0 tracks…');
  });
});

describe('progress line builders', () => {
  it('tells copying apart from converting, and names the conversion reason', () => {
    expect(describeCopyProgress({ done: 12, total: 20 })).toBe('Copying 12/20');
    expect(
      describeConvertProgress({ done: 12, total: 62, reasons: [CONVERT_REASON.LOUDNESS] })
    ).toBe('Converting 12/62 (loudness normalization)');
  });

  it('joins multiple reasons in one conversion line', () => {
    expect(
      describeConvertProgress({
        done: 1,
        total: 4,
        reasons: [CONVERT_REASON.LOUDNESS, CONVERT_REASON.FORMAT],
      })
    ).toBe('Converting 1/4 (loudness normalization + format change)');
  });

  it('falls back to a plain label when the plan entry is missing', () => {
    expect(describeConvertProgress({ done: 1, total: 4 })).toBe('Converting 1/4 (re-encoding)');
  });

  it('appends elapsed time so a long phase is explainable', () => {
    expect(describeCopyProgress({ done: 3, total: 9, elapsedMs: 45000 })).toBe('Copying 3/9 · 45s');
    expect(
      describeConvertProgress({
        done: 12,
        total: 62,
        reasons: [CONVERT_REASON.LOUDNESS],
        elapsedMs: 185000,
      })
    ).toBe('Converting 12/62 (loudness normalization) · 3:05');
  });

  it('formats elapsed time from seconds to hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(5998)).toBe('6s');
    expect(formatElapsed(60000)).toBe('1:00');
    expect(formatElapsed(3723000)).toBe('1:02:03');
  });
});
