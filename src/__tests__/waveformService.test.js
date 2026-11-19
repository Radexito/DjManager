import { describe, expect, it, vi } from 'vitest';
import { createWaveformService } from '../main/services/waveformService.js';

/** A waveform service over a fixed track list and spies for every side effect. */
function build({ tracks = [], overview, editor } = {}) {
  const deps = {
    getTracks: vi.fn(() => tracks),
    updateTrackWaveform: vi.fn(),
    updateTrackDetailHires: vi.fn(),
    generateWaveformOverview: vi.fn(overview ?? (() => Promise.resolve(Buffer.from('ov')))),
    generateEditorWaveform: vi.fn(
      editor ?? (() => Promise.resolve({ detailHires: Buffer.from('hi') }))
    ),
    getFfmpegRuntimePath: vi.fn(() => '/bin/ffmpeg'),
    send: vi.fn(),
    log: { log: vi.fn(), warn: vi.fn() },
  };
  return { deps, service: createWaveformService(deps) };
}

describe('waveformService.generateMissingOverviews', () => {
  it('generates only for analyzed tracks that have no overview', async () => {
    const { deps, service } = build({
      tracks: [
        { id: 1, analyzed: 1, waveform_overview: null },
        { id: 2, analyzed: 1, waveform_overview: Buffer.from('x') },
        { id: 3, analyzed: 0, waveform_overview: null },
        { id: 4, analyzed: 1, waveform_overview: null },
      ],
    });
    await expect(service.generateMissingOverviews()).resolves.toBe(2);

    expect(deps.generateWaveformOverview).toHaveBeenCalledTimes(2);
    expect(deps.updateTrackWaveform.mock.calls.map((c) => c[0])).toEqual([1, 4]);
  });

  it('reports progress after each track and once at the end', async () => {
    const { deps, service } = build({
      tracks: [
        { id: 1, analyzed: 1, waveform_overview: null },
        { id: 2, analyzed: 1, waveform_overview: null },
      ],
    });
    await service.generateMissingOverviews();

    expect(deps.send.mock.calls).toEqual([
      ['waveform-gen-progress', { completed: 1, total: 2, done: false }],
      ['waveform-gen-progress', { completed: 2, total: 2, done: false }],
      ['waveform-gen-progress', { completed: 2, total: 2, done: true }],
    ]);
  });

  it('skips a failing track and keeps going', async () => {
    const { deps, service } = build({
      tracks: [
        { id: 1, analyzed: 1, waveform_overview: null, file_path: '/bad.flac' },
        { id: 2, analyzed: 1, waveform_overview: null, file_path: '/good.flac' },
      ],
      overview: (file) =>
        file.includes('bad')
          ? Promise.reject(new Error('decode'))
          : Promise.resolve(Buffer.from('ok')),
    });

    await expect(service.generateMissingOverviews()).resolves.toBe(2);
    expect(deps.log.warn).toHaveBeenCalledWith('[waveform] failed for track 1:', 'decode');
    expect(deps.updateTrackWaveform).toHaveBeenCalledTimes(1);
  });

  it('does nothing when every track already has an overview', async () => {
    const { deps, service } = build({
      tracks: [{ id: 1, analyzed: 1, waveform_overview: Buffer.from('x') }],
    });
    await expect(service.generateMissingOverviews()).resolves.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.generateWaveformOverview).not.toHaveBeenCalled();
  });
});

describe('waveformService.regenerateHires', () => {
  it('stores the detail waveform and tells the renderer', async () => {
    const { deps, service } = build();
    await expect(service.regenerateHires(9, '/music/a.flac')).resolves.toBe(true);

    expect(deps.generateEditorWaveform).toHaveBeenCalledWith('/music/a.flac', '/bin/ffmpeg');
    expect(deps.updateTrackDetailHires).toHaveBeenCalledWith(9, Buffer.from('hi'));
    expect(deps.send).toHaveBeenCalledWith('waveform-ready', { trackId: 9 });
  });

  it('logs and reports failure without throwing', async () => {
    const { deps, service } = build({
      editor: () => Promise.reject(new Error('ffmpeg died')),
    });
    await expect(service.regenerateHires(9, '/music/a.flac')).resolves.toBe(false);

    expect(deps.log.warn).toHaveBeenCalledWith(
      '[waveform] hires detail regen failed for track 9:',
      'ffmpeg died'
    );
    expect(deps.send).not.toHaveBeenCalled();
  });
});
