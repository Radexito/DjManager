import { describe, expect, it, vi } from 'vitest';
import { registerSettingsIpc } from '../main/ipc/settingsIpc.js';

/**
 * Wires the settings handlers against an in-memory settings store.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} Registered handlers, sent messages, the store, the stub deps and `call`.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };
  const sent = [];
  const store = new Map();
  const deps = {
    ipcMain,
    getSetting: vi.fn((key, def) => (store.has(key) ? store.get(key) : def)),
    setSetting: vi.fn((key, value) => store.set(key, value)),
    restartLibraryWatcher: vi.fn(),
    scanWatchFolders: vi.fn(async () => ({ added: 3 })),
    getWatchFolders: vi.fn(() => ['/music/inbox']),
    watchFoldersEnabled: vi.fn(() => true),
    isWatchScanRunning: vi.fn(() => false),
    ensureDeps: vi.fn(async () => ({})),
    sendDepsProgress: vi.fn(),
    send: (channel, data) => sent.push([channel, data]),
    getMediaServerPort: vi.fn(() => 4321),
    ...overrides,
  };
  registerSettingsIpc(deps);
  return { handlers, sent, store, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

describe('registerSettingsIpc', () => {
  it('registers the six settings/watch channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'get-media-port',
      'get-setting',
      'get-watch-state',
      'retry-deps',
      'scan-watch-folders',
      'set-setting',
    ]);
  });

  it('reads a setting and falls back to the caller default', async () => {
    const { call } = setup();
    expect(await call('get-setting', undefined)).toBeNull();
    expect(await call('get-setting', 'missing_key', 'fallback')).toBe('fallback');
  });

  it('writes a setting and notifies the renderer', async () => {
    const { call, sent, store } = setup();
    await call('set-setting', 'auto_cue_generation', 'true');
    expect(store.get('auto_cue_generation')).toBe('true');
    expect(sent).toEqual([['settings-updated', { key: 'auto_cue_generation', value: 'true' }]]);
  });

  it('rebuilds the watcher only for watch settings', async () => {
    const { call, deps } = setup();
    await call('set-setting', 'theme', 'dark');
    expect(deps.restartLibraryWatcher).not.toHaveBeenCalled();

    await call('set-setting', 'watch_folders', '["/a"]');
    await call('set-setting', 'watch_enabled', 'true');
    expect(deps.restartLibraryWatcher).toHaveBeenCalledTimes(2);
  });

  it('starts a scan and reports the live watch state', async () => {
    const { call, deps } = setup({ isWatchScanRunning: vi.fn(() => true) });
    expect(await call('scan-watch-folders')).toEqual({ added: 3 });
    expect(deps.scanWatchFolders).toHaveBeenCalledTimes(1);

    expect(await call('get-watch-state')).toEqual({
      folders: ['/music/inbox'],
      enabled: true,
      scanning: true,
    });
  });

  it('retries the dependency download and clears the progress bar', async () => {
    const { call, deps } = setup();
    await call('retry-deps');
    await vi.waitFor(() => expect(deps.sendDepsProgress).toHaveBeenCalledWith(null));
    expect(deps.ensureDeps).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed dependency download as progress with an error', async () => {
    const { call, deps } = setup({
      ensureDeps: vi.fn(async () => {
        throw new Error('no network');
      }),
    });
    await call('retry-deps');
    await vi.waitFor(() =>
      expect(deps.sendDepsProgress).toHaveBeenCalledWith({
        msg: 'Error: no network',
        pct: -1,
        error: 'no network',
      })
    );
  });

  it('reports the current media server port', async () => {
    const { call } = setup();
    expect(await call('get-media-port')).toBe(4321);
  });
});
