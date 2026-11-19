import { describe, expect, it, vi } from 'vitest';
import { createLegacyCleanupService } from '../main/services/legacyCleanupService.js';

/** A cleanup service over a fake filesystem, so no real file is touched. */
function build({ tracks = [], existing = [], unlinkThrows = [] } = {}) {
  const deps = {
    getLegacyNormalizedTracks: vi.fn(() => tracks),
    clearLegacyNormalizedPaths: vi.fn(),
    fsImpl: {
      existsSync: vi.fn((p) => existing.includes(p)),
      unlinkSync: vi.fn((p) => {
        if (unlinkThrows.includes(p)) throw new Error('EBUSY');
      }),
    },
    log: { log: vi.fn(), warn: vi.fn() },
  };
  return { deps, service: createLegacyCleanupService(deps) };
}

describe('legacyCleanupService.cleanupNormalizedFiles', () => {
  it('deletes the files that exist and clears every database path', () => {
    const { deps, service } = build({
      tracks: [
        { id: 1, normalized_file_path: '/t/a' },
        { id: 2, normalized_file_path: '/t/b' },
      ],
      existing: ['/t/a'],
    });

    expect(service.cleanupNormalizedFiles()).toEqual({ deleted: 1, cleared: 2 });
    expect(deps.fsImpl.unlinkSync).toHaveBeenCalledWith('/t/a');
    expect(deps.clearLegacyNormalizedPaths).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one file cannot be deleted', () => {
    const { deps, service } = build({
      tracks: [
        { id: 1, normalized_file_path: '/t/locked' },
        { id: 2, normalized_file_path: '/t/free' },
      ],
      existing: ['/t/locked', '/t/free'],
      unlinkThrows: ['/t/locked'],
    });

    expect(service.cleanupNormalizedFiles()).toEqual({ deleted: 1, cleared: 2 });
    expect(deps.log.warn).toHaveBeenCalledWith(
      '[cleanup] could not delete legacy normalized file /t/locked:',
      'EBUSY'
    );
    expect(deps.clearLegacyNormalizedPaths).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no track carries a legacy path', () => {
    const { deps, service } = build();
    expect(service.cleanupNormalizedFiles()).toEqual({ deleted: 0, cleared: 0 });
    expect(deps.clearLegacyNormalizedPaths).not.toHaveBeenCalled();
  });
});
