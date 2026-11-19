import { describe, expect, it, vi } from 'vitest';
import { registerDiagnosticsIpc, registerRendererLogChannel } from '../main/ipc/diagnosticsIpc.js';

/** Drives the module with a fake ipcMain; no Electron, no main.js scope. */
function setup(deps = {}) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };
  const progress = [];

  registerDiagnosticsIpc({
    ipcMain,
    getLogDir: () => '/tmp/logs',
    openPath: vi.fn(),
    openDevTools: vi.fn(),
    getInstalledVersions: () => ({ ytDlp: '2026.01.01' }),
    checkForUpdates: () => [{ name: 'yt-dlp', latest: '2026.02.02' }],
    updateAnalyzer: vi.fn(),
    updateYtDlp: vi.fn(),
    updateAll: vi.fn(),
    updateTidalDlNg: vi.fn(),
    sendProgress: (channel, payload) => progress.push([channel, payload]),
    ...deps,
  });

  return { handlers, progress, call: (ch, payload) => handlers.get(ch)({}, payload) };
}

describe('registerDiagnosticsIpc', () => {
  it('registers the diagnostics and dependency channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'check-dep-updates',
      'get-dep-versions',
      'get-log-dir',
      'open-devtools',
      'open-log-dir',
      'update-all-deps',
      'update-analyzer',
      'update-tidal-dl-ng',
      'update-yt-dlp',
    ]);
  });

  it('answers the log directory and opens it through the injected shell', async () => {
    const openPath = vi.fn();
    const { call } = setup({ openPath });
    await expect(call('get-log-dir')).resolves.toBe('/tmp/logs');
    await expect(call('open-log-dir')).resolves.toMatchObject({ ok: true });
    expect(openPath).toHaveBeenCalledWith('/tmp/logs');
  });

  it('opens devtools through the injected callback', async () => {
    const openDevTools = vi.fn();
    const { call } = setup({ openDevTools });
    call('open-devtools');
    expect(openDevTools).toHaveBeenCalledTimes(1);
  });

  it('forwards progress to the UI and clears it when the update ends', async () => {
    const updateYtDlp = vi.fn(async (report) => report('pobieram', 40));
    const { call, progress } = setup({ updateYtDlp });

    await call('update-yt-dlp', '2026.02.02');

    expect(updateYtDlp).toHaveBeenCalledWith(expect.any(Function), '2026.02.02');
    expect(progress).toEqual([
      ['deps-progress', { msg: 'pobieram', pct: 40 }],
      ['deps-progress', null],
    ]);
  });

  it('clears progress even when the update throws, and reports the error', async () => {
    const updateTidalDlNg = vi.fn(async () => {
      throw new Error('brak sieci');
    });
    const { call, progress } = setup({ updateTidalDlNg });

    expect(await call('update-tidal-dl-ng')).toMatchObject({
      ok: false,
      code: 'failed',
      error: 'brak sieci',
    });
    expect(progress.at(-1)).toEqual(['deps-progress', null]);
  });

  it('returns ok when the TIDAL update succeeds', async () => {
    const { call } = setup({ updateTidalDlNg: vi.fn(async () => {}) });
    expect(await call('update-tidal-dl-ng')).toEqual({ ok: true });
  });

  it('runs each updater once per call', async () => {
    const updateAnalyzer = vi.fn(async () => {});
    const updateAll = vi.fn(async () => {});
    const { call } = setup({ updateAnalyzer, updateAll });

    await call('update-analyzer');
    await call('update-all-deps');

    expect(updateAnalyzer).toHaveBeenCalledTimes(1);
    expect(updateAll).toHaveBeenCalledTimes(1);
  });
});

describe('registerRendererLogChannel', () => {
  function setupLogChannel() {
    const listeners = new Map();
    const ipcMain = { on: vi.fn((channel, fn) => listeners.set(channel, fn)) };
    registerRendererLogChannel(ipcMain);
    return listeners;
  }

  it('requires an ipcMain', () => {
    expect(() => registerRendererLogChannel()).toThrow('ipcMain is required');
  });

  it('sends error and warn levels to their console method and the rest to log', () => {
    const listeners = setupLogChannel();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const emit = listeners.get('renderer-log');

    emit({}, { level: 'error', msg: 'boom' });
    emit({}, { level: 'warn', msg: 'careful' });
    emit({}, { level: 'info', msg: 'fyi' });

    expect(error).toHaveBeenCalledWith('[renderer] boom');
    expect(warn).toHaveBeenCalledWith('[renderer] careful');
    expect(log).toHaveBeenCalledWith('[renderer] fyi');

    error.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  });

  it('survives an empty payload instead of throwing on the listener', () => {
    const listeners = setupLogChannel();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => listeners.get('renderer-log')({}, undefined)).not.toThrow();
    expect(log).toHaveBeenCalledWith('[renderer] undefined');

    log.mockRestore();
  });
});
