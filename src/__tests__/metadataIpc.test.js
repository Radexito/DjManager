import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMetadataIpc } from '../main/ipc/metadataIpc.js';

let root;

/**
 * Wires the metadata handlers against stub search providers and repositories.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} Registered handlers, the stub deps and a `call` helper.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  const deps = {
    ipcMain,
    searchMusicBrainz: vi.fn(async () => [{ source: 'mb' }]),
    searchDiscogs: vi.fn(async () => [{ source: 'discogs' }]),
    searchItunes: vi.fn(async () => [{ source: 'itunes' }]),
    searchDeezer: vi.fn(async () => [{ source: 'deezer' }]),
    getTrackById: vi.fn(() => ({ id: 1, library_id: 'lib1' })),
    getCurrentLibraryId: vi.fn(() => 'lib1'),
    getArtworkBase: vi.fn(() => path.join(root, 'artwork')),
    updateTrack: vi.fn(),
    getExistingSourceUrls: vi.fn(() => [{ url: 'https://x', trackId: 2 }]),
    openExternal: vi.fn(async () => {}),
    ...overrides,
  };

  registerMetadataIpc(deps);
  return { handlers, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

/**
 * Fakes a `fetch` response carrying artwork bytes.
 *
 * @param {object} [options] Content type, payload bytes, ok flag and content-length header.
 * @returns {object} The slice of the Response API the artwork downloader reads.
 */
function artworkResponse({ type = 'image/png', bytes = [1, 2, 3], ok = true, length = null } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: {
      get: (name) => {
        if (name === 'content-type') return type;
        if (name === 'content-length') return length;
        return null;
      },
    },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metaipc-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerMetadataIpc', () => {
  it('registers the four metadata channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      ['auto-tag-search', 'fetch-artwork-url', 'check-duplicate-urls', 'open-external'].sort()
    );
  });

  it('merges every provider that answered', async () => {
    const { call } = setup({
      searchDiscogs: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });

    const res = await call('auto-tag-search', { query: 'artist title' });

    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.source)).toEqual(['mb', 'itunes', 'deezer']);
  });

  it('stores a PNG cover and marks the track', async () => {
    const { call, deps } = setup({ fetchImpl: vi.fn(async () => artworkResponse()) });

    const res = await call('fetch-artwork-url', { trackId: 1, url: 'https://x/a.png' });

    expect(res.ok).toBe(true);
    expect(res.artwork_path.endsWith('.png')).toBe(true);
    expect(fs.existsSync(res.artwork_path)).toBe(true);
    expect(deps.updateTrack).toHaveBeenCalledWith(1, {
      has_artwork: 1,
      artwork_path: res.artwork_path,
    });
  });

  it('falls back to .jpg for a non-PNG content type', async () => {
    const { call } = setup({
      fetchImpl: vi.fn(async () => artworkResponse({ type: 'image/jpeg' })),
    });

    const res = await call('fetch-artwork-url', { trackId: 1, url: 'https://x/a.jpg' });

    expect(res.artwork_path.endsWith('.jpg')).toBe(true);
  });

  it('reports an HTTP failure without touching the track', async () => {
    const { call, deps } = setup({
      fetchImpl: vi.fn(async () => artworkResponse({ ok: false })),
    });

    const res = await call('fetch-artwork-url', { trackId: 1, url: 'https://x/a.png' });

    expect(res).toMatchObject({ ok: false, code: 'failed', error: 'HTTP 500' });
    expect(deps.updateTrack).not.toHaveBeenCalled();
  });

  it('refuses a non-http artwork URL before fetching it', async () => {
    const fetchImpl = vi.fn();
    const { call } = setup({ fetchImpl });

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y.png', 'nonsense']) {
      const res = await call('fetch-artwork-url', { trackId: 1, url });
      expect(res, url).toMatchObject({ ok: false });
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an artwork body over the cap, by header and by actual size', async () => {
    const byHeader = setup({
      maxArtworkBytes: 4,
      fetchImpl: vi.fn(async () => artworkResponse({ length: '5' })),
    });
    await expect(
      byHeader.call('fetch-artwork-url', { trackId: 1, url: 'https://x/a.png' })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('too large') });

    const byBody = setup({
      maxArtworkBytes: 2,
      fetchImpl: vi.fn(async () => artworkResponse({ bytes: [1, 2, 3, 4, 5] })),
    });
    await expect(
      byBody.call('fetch-artwork-url', { trackId: 1, url: 'https://x/a.png' })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('too large') });
  });

  it('passes the duplicate-url lookup straight through', async () => {
    const { call, deps } = setup();

    await expect(call('check-duplicate-urls', [{ url: 'https://x' }])).resolves.toEqual([
      { url: 'https://x', trackId: 2 },
    ]);
    expect(deps.getExistingSourceUrls).toHaveBeenCalledWith([{ url: 'https://x' }]);
  });

  it('allows browser and mail links and hands over the caller string unchanged', async () => {
    const { call, deps } = setup();

    await expect(call('open-external', 'https://rwtechworks.pl')).resolves.toEqual({ ok: true });
    await expect(call('open-external', 'mailto:a@b.pl')).resolves.toEqual({ ok: true });

    expect(deps.openExternal).toHaveBeenCalledWith('https://rwtechworks.pl');
    expect(deps.openExternal).toHaveBeenCalledWith('mailto:a@b.pl');
  });

  it('refuses schemes that reach local files or run script', async () => {
    const { call, deps } = setup();

    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'smb://h/s',
      '',
    ]) {
      await expect(call('open-external', url), url).resolves.toMatchObject({ ok: false });
    }

    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});
