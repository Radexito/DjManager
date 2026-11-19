import { describe, expect, it, vi } from 'vitest';
import { createDepsProgressService } from '../main/services/depsProgressService.js';

/** A progress forwarder over a spy bridge and a spy logger. */
function build() {
  const deps = { send: vi.fn(), log: { log: vi.fn() } };
  return { deps, service: createDepsProgressService(deps) };
}

describe('depsProgressService.forward', () => {
  it('always forwards the payload', () => {
    const { deps, service } = build();
    service.forward({ msg: 'downloading', pct: 40 });
    expect(deps.send).toHaveBeenCalledWith('deps-progress', { msg: 'downloading', pct: 40 });
  });

  it('logs only the start and the end of a step', () => {
    const { deps, service } = build();
    service.forward({ msg: 'ffmpeg', pct: 0 });
    service.forward({ msg: 'ffmpeg', pct: 40 });
    service.forward({ msg: 'ffmpeg', pct: 100 });

    expect(deps.log.log.mock.calls).toEqual([['[deps]', 'ffmpeg']]);
  });

  it('does not repeat the same banner twice in a row', () => {
    const { deps, service } = build();
    service.forward({ msg: 'ffmpeg', pct: 0 });
    service.forward({ msg: 'ffmpeg', pct: 100 });

    expect(deps.log.log).toHaveBeenCalledTimes(1);
    expect(service.lastMessage()).toBe('ffmpeg');
  });

  it('logs nothing when the step ends with a null payload', () => {
    const { deps, service } = build();
    service.forward(null);
    expect(deps.send).toHaveBeenCalledWith('deps-progress', null);
    expect(deps.log.log).not.toHaveBeenCalled();
  });
});
