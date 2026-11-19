import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registerTidalIpc } from '../main/ipc/tidalIpc.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-tidal-'));
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

/** Drives the module with fakes; no Electron, no tdn binary, no TIDAL account. */
function setup(deps = {}) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };
  const sent = [];
  const runtime = { mediaServerPort: 4321, explorerAllowedBases: [] };

  registerTidalIpc({
    ipcMain,
    runtime,
    send: (channel, data) => sent.push([channel, data]),
    getSetting: () => '',
    checkTidalSetup: vi.fn(async () => ({ ok: true, installed: true })),
    ensureTidalDlNg: vi.fn(async (onLine) => onLine('installing')),
    fetchTidalInfo: vi.fn(async () => ({ type: 'playlist', entries: [{}, {}] })),
    searchYouTube: vi.fn(async () => [{ id: 'yt1' }]),
    searchTidal: vi.fn(async () => ({ ok: true, results: [] })),
    getTidalPreviewUrl: vi.fn(async () => ({ ok: true, url: 'https://tidal/preview' })),
    registerYtPreviewStream: vi.fn(() => 'token-123'),
    tidalStartLogin: vi.fn(async (onUrl) => onUrl('https://tidal/login')),
    runTidalDownload: vi.fn(async () => ({ ok: true, trackIds: [] })),
    fetchTidalCollections: vi.fn(async () => ({ ok: true, collections: [] })),
    fetchTidalCollectionTracks: vi.fn(async () => ({ ok: true, entries: [], title: 'Mix' })),
    splitTidalCollectionEntries: vi.fn((entries) => ({ tracks: entries, videoCount: 0 })),
    tidalCollectionUrl: vi.fn((type, id) => `https://tidal.example/${type}/${id}`),
    getTempDir: () => tempRoot,
    ...deps,
  });

  return { handlers, sent, runtime, call: (ch, payload) => handlers.get(ch)({}, payload) };
}

describe('registerTidalIpc', () => {
  it('registers the ten TIDAL and cloud-search channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'cloud-search',
      'cloud-search-preview',
      'tidal-check',
      'tidal-collection-tracks',
      'tidal-download-collection',
      'tidal-download-url',
      'tidal-fetch-info',
      'tidal-install',
      'tidal-list-collections',
      'tidal-login',
    ]);
  });

  it('answers the setup check straight through', async () => {
    const { call } = setup();
    expect(await call('tidal-check')).toEqual({ ok: true, installed: true });
  });

  it('streams installer output to the UI and reports success', async () => {
    const { call, sent } = setup();
    expect(await call('tidal-install')).toEqual({ ok: true });
    expect(sent).toContainEqual(['tidal-install-progress', { msg: 'installing' }]);
  });

  it('returns the installer error instead of throwing', async () => {
    const { call } = setup({
      ensureTidalDlNg: vi.fn(async () => {
        throw new Error('brak pip');
      }),
    });
    expect(await call('tidal-install')).toEqual({ ok: false, error: 'brak pip' });
  });

  it('rejects an empty cloud search without touching the network', async () => {
    const searchYouTube = vi.fn();
    const { call } = setup({ searchYouTube });
    expect(await call('cloud-search', { source: 'youtube', query: '   ' })).toEqual({
      ok: false,
      error: 'Empty query',
    });
    expect(searchYouTube).not.toHaveBeenCalled();
  });

  it('passes the cookie browser to the YouTube search', async () => {
    const searchYouTube = vi.fn(async () => [{ id: 'yt1' }]);
    const { call } = setup({
      getSetting: (key, fallback) => (key === 'ytdlp_cookies_browser' ? 'firefox' : fallback),
      searchYouTube,
    });

    const res = await call('cloud-search', { source: 'youtube', query: 'daft punk', limit: 5 });

    expect(res).toEqual({ ok: true, results: [{ id: 'yt1' }] });
    expect(searchYouTube).toHaveBeenCalledWith('daft punk', {
      limit: 5,
      cookiesBrowser: 'firefox',
    });
  });

  it('reports an unknown search source', async () => {
    const { call } = setup();
    expect(await call('cloud-search', { source: 'spotify', query: 'x' })).toEqual({
      ok: false,
      error: 'Unknown source: spotify',
    });
  });

  it('registers a live preview stream and lets the media server serve it', async () => {
    const registerYtPreviewStream = vi.fn(() => 'token-123');
    const { call, runtime } = setup({ registerYtPreviewStream });

    const res = await call('cloud-search-preview', {
      source: 'youtube',
      type: 'video',
      url: 'https://youtu.be/x',
    });

    expect(res).toEqual({ ok: true, url: 'http://127.0.0.1:4321/djman-yt-preview/token-123' });
    expect(runtime.explorerAllowedBases).toContain(path.join(tempRoot, 'djman-preview'));
  });

  it('explains why only TIDAL tracks can be previewed inline', async () => {
    const { call } = setup();
    expect(
      await call('cloud-search-preview', { source: 'tidal', type: 'album', url: 'https://tidal/x' })
    ).toEqual({
      ok: false,
      error: 'Inline preview is only available for TIDAL track results',
    });
  });

  it('forwards the login URL to the UI', async () => {
    const { call, sent } = setup();
    expect(await call('tidal-login')).toEqual({ ok: true });
    expect(sent).toContainEqual(['tidal-login-url', 'https://tidal/login']);
  });

  it('requires a collection type and id', async () => {
    const { call } = setup();
    expect(await call('tidal-collection-tracks', { type: 'album' })).toEqual({
      ok: false,
      error: 'Missing collection type or id',
      entries: [],
    });
  });

  it('degrades to an empty collection list when TIDAL is unreachable', async () => {
    const { call } = setup({
      fetchTidalCollections: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    expect(await call('tidal-list-collections')).toEqual({
      ok: false,
      error: 'timeout',
      collections: [],
      warnings: [],
    });
  });

  it('rejects a collection download without type or id', async () => {
    const { call } = setup();
    expect(await call('tidal-download-collection', { id: 'x' })).toMatchObject({
      ok: false,
      error: 'Missing collection type or id',
    });
  });

  it('downloads a collection through the shared routine', async () => {
    const { call, sent } = setup();

    const res = await call('tidal-download-collection', {
      type: 'playlist',
      id: 'p1',
      title: 'My Mix',
      selectedEntries: [{ title: 'A', artist: 'B' }],
    });

    expect(res).toMatchObject({ ok: true, videoCount: 0 });
    expect(sent.some(([ch, d]) => ch === 'tidal-progress' && /My Mix/.test(d.msg))).toBe(true);
  });

  it('explains a collection that contains only videos', async () => {
    const { call } = setup({
      splitTidalCollectionEntries: vi.fn(() => ({ tracks: [], videoCount: 3 })),
    });

    const res = await call('tidal-download-collection', {
      type: 'playlist',
      id: 'p1',
      title: 'Video Only',
      selectedEntries: [{ title: 'A' }],
    });

    expect(res.ok).toBe(false);
    expect(res.videoCount).toBe(3);
    expect(res.error).toMatch(/only video items/);
  });
});
