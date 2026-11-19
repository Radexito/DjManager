import { describe, expect, it, vi } from 'vitest';
import { createGraphicsCrashService } from '../main/services/graphicsCrashService.js';

/** A crash service wired to spies, with the GPU probe answering with fixed facts. */
function build({
  state = {},
  recordCrash,
  allowRestart = true,
  gpu = { info: 'g', status: 's' },
} = {}) {
  const deps = {
    app: {
      getPath: vi.fn(() => '/ud'),
      getVersion: vi.fn(() => '1.2.0'),
      getGPUInfo: vi.fn(() => Promise.resolve(gpu.info)),
      getGPUFeatureStatus: vi.fn(() => gpu.status),
    },
    readGraphicsState: vi.fn(() => state),
    writeGraphicsState: vi.fn(),
    graphicsReportPath: vi.fn((dir) => `${dir}/graphics-report.txt`),
    buildCrashReport: vi.fn((input) => `report:${input.environment.app}`),
    writeCrashReport: vi.fn(),
    readLogTail: vi.fn(() => 'tail'),
    getLogDir: vi.fn(() => '/logs'),
    recordCrash: vi.fn(
      recordCrash ??
        ((prev) => ({
          state: { ...prev, count: 1 },
          entry: { at: 42 },
          fallbackNow: false,
        }))
    ),
    markFallback: vi.fn((next) => ({ ...next, fallback: true })),
    shouldAllowAutomaticFallback: vi.fn(() => allowRestart),
    relaunchApp: vi.fn(),
    now: () => 1000,
    env: { XDG_SESSION_TYPE: 'wayland' },
    cliArgs: () => ['--flag'],
    log: { error: vi.fn() },
  };
  return { deps, service: createGraphicsCrashService(deps) };
}

const details = { type: 'GPU', reason: 'crashed', exitCode: 139 };

describe('graphicsCrashService.handle', () => {
  it('records the crash, persists the state and writes the report', async () => {
    const { deps, service } = build();
    await service.handle(details);

    expect(deps.readGraphicsState).toHaveBeenCalledWith('/ud');
    expect(deps.recordCrash).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        details,
        now: 1000,
        env: deps.env,
        versions: expect.objectContaining({ app: '1.2.0', os: process.platform }),
        gpu: { info: 'g', status: 's' },
      })
    );
    expect(deps.writeGraphicsState).toHaveBeenCalledWith('/ud', { count: 1 });
    expect(deps.writeCrashReport).toHaveBeenCalledWith('/ud/graphics-report.txt', 'report:1.2.0');
    expect(deps.buildCrashReport).toHaveBeenCalledWith(
      expect.objectContaining({
        logTail: 'tail',
        environment: expect.objectContaining({ session: 'wayland' }),
      })
    );
  });

  it('marks the fallback in the persisted state when the threshold is crossed', async () => {
    const { deps, service } = build({
      recordCrash: () => ({ state: { count: 3 }, entry: { at: 7 }, fallbackNow: true }),
    });
    await service.handle(details);

    expect(deps.markFallback).toHaveBeenCalledWith({ count: 3 }, { now: 7 });
    expect(deps.writeGraphicsState).toHaveBeenCalledWith('/ud', { count: 3, fallback: true });
  });

  it('restarts with acceleration off when fallback is allowed', async () => {
    const { deps, service } = build({
      recordCrash: () => ({ state: {}, entry: { at: 7 }, fallbackNow: true }),
      allowRestart: true,
    });
    const result = await service.handle(details);

    expect(deps.shouldAllowAutomaticFallback).toHaveBeenCalledWith({
      env: deps.env,
      cliArgs: ['--flag'],
    });
    expect(deps.relaunchApp).toHaveBeenCalledTimes(1);
    expect(result.restarted).toBe(true);
  });

  it('records without restarting when automatic fallback is not allowed', async () => {
    const { deps, service } = build({
      recordCrash: () => ({ state: {}, entry: { at: 7 }, fallbackNow: true }),
      allowRestart: false,
    });
    const result = await service.handle(details);

    expect(deps.relaunchApp).not.toHaveBeenCalled();
    expect(result.restarted).toBe(false);
    expect(deps.writeCrashReport).toHaveBeenCalled();
  });

  it('does not restart when the threshold was not crossed', async () => {
    const { deps, service } = build();
    const result = await service.handle(details);

    expect(result.restarted).toBe(false);
    expect(deps.relaunchApp).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when the crash cannot be recorded', async () => {
    const { deps, service } = build({
      recordCrash: () => {
        throw new Error('disk full');
      },
    });
    const result = await service.handle(details);

    expect(result.error).toBeInstanceOf(Error);
    expect(deps.log.error).toHaveBeenCalledWith('[crash] failed to record crash:', 'disk full');
    expect(deps.writeGraphicsState).not.toHaveBeenCalled();
  });
});

describe('graphicsCrashService.snapshot', () => {
  it('returns the GPU info and feature status', async () => {
    const { service } = build();
    await expect(service.snapshot()).resolves.toEqual({ info: 'g', status: 's' });
  });

  it('degrades to no facts when the GPU probe is unavailable', async () => {
    const { deps, service } = build();
    deps.app.getGPUInfo = () => undefined;
    await expect(service.snapshot()).resolves.toEqual({});
  });

  it('degrades to no facts when the feature probe throws synchronously', async () => {
    const { deps, service } = build();
    deps.app.getGPUFeatureStatus = () => {
      throw new Error('no gpu');
    };
    await expect(service.snapshot()).resolves.toEqual({});
  });

  it('keeps the info when only the feature probe rejects', async () => {
    const { deps, service } = build();
    deps.app.getGPUFeatureStatus = () => Promise.reject(new Error('no gpu'));
    await expect(service.snapshot()).resolves.toEqual({ info: 'g', status: null });
  });
});
