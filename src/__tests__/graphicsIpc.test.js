import { describe, expect, it, vi } from 'vitest';
import { registerGraphicsIpc } from '../main/ipc/graphicsIpc.js';

/**
 * These tests call the module directly, with a fake ipcMain and in-memory state.
 * That is the point of the extraction: the contract suite proves the behaviour
 * did not change, and this one proves the module no longer needs an Electron
 * runtime or main.js scope to be exercised.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };

  let state = overrides.initialState ?? {
    mode: 'auto',
    fallback: null,
    crashes: [],
    reportPath: 'graphics-crash-report.json',
  };
  const written = [];

  registerGraphicsIpc({
    ipcMain,
    graphicsUserDataDir: () => '/tmp/userdata',
    readGraphicsState: () => state,
    writeGraphicsState: (_dir, next) => {
      state = next;
      written.push(next);
      return true;
    },
    buildCrashReport: ({ environment }) => ({
      summary: { count: state.crashes.length },
      environment,
    }),
    readLogTail: () => ['line'],
    getLogDir: () => '/tmp/logs',
    getVersion: () => '1.0.25',
    relaunchApp: vi.fn(),
    platform: 'linux',
    kernel: '7.2.14',
    session: 'wayland',
    ...overrides.deps,
  });

  return {
    handlers,
    call: (ch, payload) => handlers.get(ch)({}, payload),
    written,
    state: () => state,
  };
}

const fallbackState = {
  mode: 'auto',
  fallback: { active: true, since: 1730000000000, reason: 'gpu-crash-loop', relaunchedAt: 1 },
  crashes: [{ at: 1730000000000, type: 'GPU', reason: 'crashed', exitCode: 139 }],
};

describe('registerGraphicsIpc', () => {
  it('registers the four graphics channels and nothing else', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'get-graphics-report',
      'get-graphics-state',
      'relaunch-app',
      'set-graphics-mode',
    ]);
  });

  it('reports the default state when nothing has happened', async () => {
    const { call } = setup();
    expect(await call('get-graphics-state')).toEqual({
      mode: 'auto',
      activeProfile: 'auto',
      notice: null,
      crashCount: 0,
      lastCrashAt: null,
    });
  });

  it('shows the recorded fallback as the profile the next start will use', async () => {
    const { call } = setup({ initialState: fallbackState });
    expect(await call('get-graphics-state')).toMatchObject({
      activeProfile: 'fallback',
      notice: 'gpu-crash',
      crashCount: 1,
      lastCrashAt: 1730000000000,
    });
  });

  it('does not warn when the user turned acceleration off on purpose', async () => {
    const { call } = setup({ initialState: { ...fallbackState, mode: 'disabled' } });
    expect((await call('get-graphics-state')).notice).toBeNull();
  });

  it('does not warn after the user forces acceleration back on over a recorded fallback', async () => {
    const { call } = setup({ initialState: { ...fallbackState, mode: 'enabled' } });
    expect(await call('get-graphics-state')).toMatchObject({
      mode: 'enabled',
      activeProfile: 'enabled',
      notice: null,
      crashCount: 1,
    });
  });

  it('rejects an unknown mode without touching the state', async () => {
    const { call, written } = setup();
    expect(await call('set-graphics-mode', { mode: 'warp-speed' })).toEqual({
      ok: false,
      error: 'Unknown graphics mode: warp-speed',
    });
    expect(written).toHaveLength(0);
  });

  it('refuses to re-enable acceleration after a fallback without explicit consent', async () => {
    const { call, written } = setup({ initialState: fallbackState });
    const result = await call('set-graphics-mode', { mode: 'enabled' });
    expect(result.ok).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(written).toHaveLength(0);
  });

  it('accepts re-enabling once the risk is confirmed, and keeps the crash record', async () => {
    const { call, state } = setup({ initialState: fallbackState });
    expect(await call('set-graphics-mode', { mode: 'enabled', confirmRisk: true })).toEqual({
      ok: true,
    });
    expect(state().mode).toBe('enabled');
    expect(state().fallback).toMatchObject({ active: true });
  });

  it('clears the fallback only when the user goes back to auto', async () => {
    const { call, state } = setup({ initialState: fallbackState });
    expect(await call('set-graphics-mode', { mode: 'auto' })).toEqual({ ok: true });
    expect(state().fallback).toBeNull();
  });

  it('passes the environment facts to the report instead of reading globals', async () => {
    const { call } = setup({ initialState: fallbackState });
    const report = await call('get-graphics-report');
    expect(report.environment).toMatchObject({
      app: '1.0.25',
      platform: 'linux',
      kernel: '7.2.14',
      session: 'wayland',
    });
    expect(report.summary.count).toBe(1);
  });

  it('relaunches through the injected function', async () => {
    const relaunchApp = vi.fn();
    const { call } = setup({ deps: { relaunchApp } });
    await call('relaunch-app');
    expect(relaunchApp).toHaveBeenCalledTimes(1);
  });
});
