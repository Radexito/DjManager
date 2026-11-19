import fs from 'node:fs';
import path from 'node:path';
import { allowExplorerBase } from '../runtime.js';
import { handle } from './response.js';

/**
 * TIDAL and cloud-search IPC (tor B, slice 4).
 *
 * Nine channels moved out of `src/main.js`. The bodies are the same code: the
 * only edits are the address of `send` (injected instead of a closure over
 * global.mainWindow) and the temp directory (injected instead of reaching for
 * `app.getPath`). Channel names, payloads, log lines and return shapes are
 * unchanged, and their contract is fixed.
 *
 * `runTidalDownload` stays in main.js for now and arrives as an argument: it is
 * 230 lines of download orchestration with its own slice ahead of it, and
 * dragging it in here would turn a reviewable move into a rewrite.
 */
export function registerTidalIpc({
  ipcMain,
  runtime,
  send = () => {},
  getSetting,
  checkTidalSetup,
  ensureTidalDlNg,
  fetchTidalInfo,
  searchYouTube,
  searchTidal,
  getTidalPreviewUrl,
  registerYtPreviewStream,
  tidalStartLogin,
  runTidalDownload,
  fetchTidalCollections,
  fetchTidalCollectionTracks,
  splitTidalCollectionEntries,
  tidalCollectionUrl,
  getTempDir,
}) {
  if (!ipcMain) throw new Error('registerTidalIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });
  if (!runtime) throw new Error('registerTidalIpc: runtime is required');

  register('tidal-check', async () => {
    return checkTidalSetup();
  });

  register('tidal-install', async () => {
    try {
      await ensureTidalDlNg((line) => {
        send('tidal-install-progress', { msg: line });
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  register('tidal-fetch-info', async (_event, url) => {
    console.log('[tidal-fetch-info] fetching info for:', url);
    try {
      const info = await fetchTidalInfo(url);
      console.log(`[tidal-fetch-info] ok — type=${info.type} entries=${info.entries?.length}`);
      return info;
    } catch (err) {
      console.error('[tidal-fetch-info] error:', err.message);
      return { ok: false, error: err.message };
    }
  });

  register('cloud-search', async (_event, { source, query, types, limit }) => {
    if (!query?.trim()) return { ok: false, error: 'Empty query' };
    try {
      if (source === 'youtube') {
        const cookiesBrowser = getSetting('ytdlp_cookies_browser', '') || null;
        const results = await searchYouTube(query, { limit, cookiesBrowser });
        return { ok: true, results };
      }
      if (source === 'tidal') {
        const res = await searchTidal(query, { types, limit });
        if (!res.ok) return res;
        return {
          ok: true,
          results: res.results.map((r) => ({
            source: 'tidal',
            type: r.type,
            id: r.id,
            title: r.title,
            artist: r.artist,
            album: r.album,
            durationSec: r.duration,
            numTracks: r.numTracks,
            quality: r.quality,
            url: r.url,
          })),
        };
      }
      return { ok: false, error: `Unknown source: ${source}` };
    } catch (err) {
      console.error('[cloud-search] error:', err.message);
      return { ok: false, error: err.message };
    }
  });

  register('cloud-search-preview', async (_event, { source, type, url }) => {
    if (!url) return { ok: false, error: 'Missing result URL' };

    try {
      if (source === 'youtube') {
        const cookiesBrowser = getSetting('ytdlp_cookies_browser', '') || null;
        const previewDir = path.join(getTempDir(), 'djman-preview');
        await fs.promises.mkdir(previewDir, { recursive: true });
        allowExplorerBase(runtime, previewDir);
        const token = registerYtPreviewStream(url, cookiesBrowser);
        return {
          ok: true,
          url: `http://127.0.0.1:${runtime.mediaServerPort}/djman-yt-preview/${token}`,
        };
      }
      if (source === 'tidal') {
        if (type !== 'track') {
          return { ok: false, error: 'Inline preview is only available for TIDAL track results' };
        }
        return await getTidalPreviewUrl(url);
      }
      return { ok: false, error: `Unknown source: ${source}` };
    } catch (err) {
      console.error('[cloud-search-preview] error:', err.message);
      return { ok: false, error: err.message };
    }
  });

  register('tidal-login', async () => {
    try {
      await tidalStartLogin((url) => {
        send('tidal-login-url', url);
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  register('tidal-download-url', async (_event, opts) => runTidalDownload(opts ?? {}));

  register('tidal-list-collections', async () => {
    try {
      const res = await fetchTidalCollections();
      console.log(`[tidal-list-collections] ok=${res.ok} count=${res.collections?.length ?? 0}`);
      return res;
    } catch (err) {
      console.error('[tidal-list-collections] error:', err.message);
      return { ok: false, error: err.message, collections: [], warnings: [] };
    }
  });

  register('tidal-collection-tracks', async (_event, { type, id } = {}) => {
    if (!type || !id) return { ok: false, error: 'Missing collection type or id', entries: [] };

    try {
      const res = await fetchTidalCollectionTracks(type, id);
      if (!res.ok) return { ...res, entries: [] };
      const entries = res.entries ?? [];
      console.log(`[tidal-collection-tracks] ${type}:${id} entries=${entries.length}`);
      return {
        ok: true,
        title: res.title,
        type: res.type,
        entries,
        total: res.total,
        truncated: res.truncated === true,
        videoCount: entries.filter((e) => e.mediaType === 'video').length,
      };
    } catch (err) {
      console.error('[tidal-collection-tracks] error:', err.message);
      return { ok: false, error: err.message, entries: [] };
    }
  });

  register(
    'tidal-download-collection',
    async (
      _event,
      { type, id, title, selectedEntries, existingPlaylistId, newPlaylistName } = {}
    ) => {
      if (!type || !id) return { ok: false, error: 'Missing collection type or id' };

      try {
        const picked =
          Array.isArray(selectedEntries) && selectedEntries.length > 0 ? selectedEntries : null;
        const resolved = picked
          ? { ok: true, title, entries: picked }
          : await fetchTidalCollectionTracks(type, id);
        if (!resolved.ok) return resolved;

        const { tracks, videoCount: splitVideos } = splitTidalCollectionEntries(resolved.entries);
        const videoCount = Math.max(splitVideos, picked ? 0 : Number(resolved.videoCount) || 0);
        const collectionTitle = resolved.title || title || id;

        if (tracks.length === 0) {
          return {
            ok: false,
            error:
              videoCount > 0
                ? `"${collectionTitle}" contains only video items. DjManager imports audio tracks only.`
                : 'This collection has no downloadable tracks.',
            videoCount,
          };
        }

        send('tidal-progress', {
          msg: `Downloading ${tracks.length} tracks from ${collectionTitle}...`,
        });

        const res = await runTidalDownload({
          url: tidalCollectionUrl(type, id),
          selectedEntries: tracks,
          linkTrackIds: [],
          existingPlaylistId: existingPlaylistId ?? null,
          newPlaylistName: newPlaylistName ?? collectionTitle,
        });

        return { ...res, videoCount };
      } catch (err) {
        console.error('[tidal-download-collection] error:', err.message);
        return { ok: false, error: err.message };
      }
    }
  );
}
