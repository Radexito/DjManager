import { describe, expect, it, vi } from 'vitest';
import { registerYtdlpIpc } from '../main/ipc/ytdlpIpc.js';

/** Drives the module with fakes; no Electron, no database, no yt-dlp binary. */
function setup(deps = {}) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };
  const sent = [];

  registerYtdlpIpc({
    ipcMain,
    getSetting: () => '',
    ytDlpFetchPlaylistInfo: vi.fn(),
    ytDlpDownloadUrl: vi.fn(async () => ({ files: [], unavailableCount: 0 })),
    findOrCreatePlaylist: vi.fn(() => ({ id: 7 })),
    addTrackToPlaylist: vi.fn(),
    importAudioFile: vi.fn(async () => 42),
    send: (channel, data) => sent.push([channel, data]),
    ...deps,
  });

  return { handlers, sent, call: (ch, payload) => handlers.get(ch)({}, payload) };
}

describe('registerYtdlpIpc', () => {
  it('registers the two yt-dlp channels and nothing else', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(['ytdlp-download-url', 'ytdlp-fetch-info']);
  });

  it('passes the configured cookie browser to the info fetch', async () => {
    const ytDlpFetchPlaylistInfo = vi.fn(async () => ({ type: 'playlist', entries: [1, 2] }));
    const { call } = setup({
      getSetting: (key, fallback) => (key === 'ytdlp_cookies_browser' ? 'firefox' : fallback),
      ytDlpFetchPlaylistInfo,
    });

    const res = await call('ytdlp-fetch-info', 'https://youtu.be/list');

    expect(res).toMatchObject({ ok: true, type: 'playlist' });
    expect(ytDlpFetchPlaylistInfo).toHaveBeenCalledWith(
      'https://youtu.be/list',
      expect.objectContaining({ cookiesBrowser: 'firefox' })
    );
  });

  it('clears the check progress after a successful info fetch', async () => {
    const { call, sent } = setup({
      ytDlpFetchPlaylistInfo: vi.fn(async (_url, options) => {
        options.onCheckProgress({ checked: 1, total: 2 });
        return { type: 'video', entries: [] };
      }),
    });

    await call('ytdlp-fetch-info', 'https://youtu.be/x');

    expect(sent).toContainEqual(['ytdlp-check-progress', { checked: 1, total: 2 }]);
    expect(sent.at(-1)).toEqual(['ytdlp-check-progress', null]);
  });

  it('clears the check progress and reports the message when the fetch fails', async () => {
    const { call, sent } = setup({
      ytDlpFetchPlaylistInfo: vi.fn(async () => {
        throw new Error('wideo prywatne');
      }),
    });

    expect(await call('ytdlp-fetch-info', 'https://youtu.be/x')).toEqual({
      ok: false,
      error: 'wideo prywatne',
    });
    expect(sent.at(-1)).toEqual(['ytdlp-check-progress', null]);
  });

  it('announces the download and returns the collected track ids', async () => {
    const { call, sent } = setup();

    const res = await call('ytdlp-download-url', { url: 'https://youtu.be/x' });

    expect(res).toEqual({ ok: true, trackIds: [], playlistId: null, unavailableCount: 0 });
    expect(sent[0]).toEqual([
      'ytdlp-progress',
      { msg: 'Starting download…', pct: 0, trackPct: 0, overallCurrent: 1, overallTotal: 1 },
    ]);
  });

  it('uses the playlist the user already picked', async () => {
    const { call } = setup({
      ytDlpDownloadUrl: vi.fn(async (_url, _onProgress, options) => {
        await options.onFileReady({
          filePath: '/tmp/a.mp3',
          originalUrl: 'https://youtu.be/x',
          trackUrl: 'https://youtu.be/x',
          platform: 'youtube',
          quality: 'best',
          title: 'Title',
          channel: 'Channel',
          index: 0,
        });
        return { files: [], unavailableCount: 0 };
      }),
    });

    const res = await call('ytdlp-download-url', {
      url: 'https://youtu.be/x',
      existingPlaylistId: 7,
    });

    expect(res).toMatchObject({ ok: true, trackIds: [42], playlistId: 7 });
  });

  it('clears the progress line and returns the message when the download throws', async () => {
    const { call, sent } = setup({
      ytDlpDownloadUrl: vi.fn(async () => {
        throw new Error('brak sieci');
      }),
    });

    expect(await call('ytdlp-download-url', { url: 'https://youtu.be/x' })).toEqual({
      ok: false,
      error: 'brak sieci',
    });
    expect(sent.at(-1)).toEqual(['ytdlp-progress', null]);
  });
});
