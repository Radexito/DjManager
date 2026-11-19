import { describe, expect, it, vi } from 'vitest';
import { createMediaServerService } from '../main/services/mediaServerService.js';

/** A media server service over fake libraries and a runtime object. */
function build({ libraries, startServer } = {}) {
  const runtime = { explorerAllowedBases: ['/default'] };
  const deps = {
    runtime,
    ytPreview: { streams: new Map([['a', 'b']]) },
    listLibraries: vi.fn(() => libraries ?? [{ id: 'lib-a' }, { id: 'lib-b' }]),
    getDefaultLibraryId: vi.fn(() => 'lib-a'),
    getLibraryBase: vi.fn((id) => `/audio/${id}`),
    getArtworkBase: vi.fn((id) => `/art/${id}`),
    allowExplorerBase: vi.fn(),
    startServer: startServer ?? vi.fn(() => Promise.resolve({ port: 5198 })),
  };
  return { runtime, deps, service: createMediaServerService(deps) };
}

describe('mediaServerService.start', () => {
  it('serves the default library roots and stores the port', async () => {
    const { runtime, deps, service } = build();
    await expect(service.start()).resolves.toBe(5198);

    expect(deps.startServer).toHaveBeenCalledWith(
      '/audio/lib-a',
      '/art/lib-a',
      ['/default'],
      deps.ytPreview.streams
    );
    expect(runtime.mediaServerPort).toBe(5198);
  });

  it('puts every other library on the explorer allowlist', async () => {
    const { runtime, deps, service } = build();
    await service.start();

    expect(deps.allowExplorerBase.mock.calls).toEqual([
      [runtime, '/audio/lib-b'],
      [runtime, '/art/lib-b'],
    ]);
  });

  it('does not touch the allowlist when there is one library', async () => {
    const { deps, service } = build({ libraries: [{ id: 'lib-a' }] });
    await service.start();
    expect(deps.allowExplorerBase).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledWith(
      '/audio/lib-a',
      '/art/lib-a',
      expect.any(Array),
      expect.anything()
    );
  });

  it('leaves the port unset when the server fails to start', async () => {
    const { runtime, service } = build({
      startServer: () => Promise.reject(new Error('EADDRINUSE')),
    });
    await expect(service.start()).rejects.toThrow('EADDRINUSE');
    expect(runtime.mediaServerPort).toBeUndefined();
  });
});
