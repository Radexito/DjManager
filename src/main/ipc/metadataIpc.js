/**
 * Metadata search, artwork download and the external-link channel (tor B,
 * slice 18).
 *
 * Four channels moved out of `src/main.js`. Two of them accept a URL from the
 * renderer, so both validate it here rather than trusting the caller:
 *
 *   - `open-external` may only reach the browser or the mail client. `file:`
 *     opens a local file, `javascript:` and `data:` run script, `smb:` mounts a
 *     remote share.
 *   - `fetch-artwork-url` may only fetch over http(s), and the body is capped.
 *     Without the cap a huge or endless response is an out-of-memory in the
 *     main process, which takes the whole app with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail, failFromError, handle, ok } from './response.js';

/** Only schemes that hand off to the user's browser or mail client. */
export const EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Only schemes an artwork download may use. */
export const ARTWORK_URL_SCHEMES = new Set(['http:', 'https:']);

/** Refuse an artwork body larger than this. */
export const MAX_ARTWORK_BYTES = 20 * 1024 * 1024;

/**
 * Register the metadata channels: the multi-source tag search, artwork
 * download, duplicate-URL check and open-external. Both URL-taking channels
 * validate the scheme here, and artwork bodies are capped at
 * `maxArtworkBytes`.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {object} [deps.fsImpl] filesystem implementation to use instead of node:fs
 * @param {number} [deps.maxArtworkBytes] artwork size limit in bytes
 * @throws {Error} when ipcMain is missing
 */
export function registerMetadataIpc({
  ipcMain,
  searchMusicBrainz,
  searchDiscogs,
  searchItunes,
  searchDeezer,
  getTrackById,
  getCurrentLibraryId,
  getArtworkBase,
  updateTrack,
  getExistingSourceUrls,
  openExternal,
  fetchImpl = null,
  fsImpl = fs,
  maxArtworkBytes = MAX_ARTWORK_BYTES,
}) {
  if (!ipcMain) throw new Error('registerMetadataIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...a) => console.error(...a) });

  register('auto-tag-search', async (_, { query }) => {
    try {
      const [mbRes, discogsRes, itunesRes, deezerRes] = await Promise.allSettled([
        searchMusicBrainz(query),
        searchDiscogs(query),
        searchItunes(query),
        searchDeezer(query),
      ]);
      const results = [
        ...(mbRes.status === 'fulfilled' ? mbRes.value : []),
        ...(discogsRes.status === 'fulfilled' ? discogsRes.value : []),
        ...(itunesRes.status === 'fulfilled' ? itunesRes.value : []),
        ...(deezerRes.status === 'fulfilled' ? deezerRes.value : []),
      ];
      return ok({ results });
    } catch (err) {
      return failFromError(err);
    }
  });

  register('fetch-artwork-url', async (_, { trackId, url }) => {
    let parsed;
    try {
      parsed = new URL(String(url ?? ''));
    } catch {
      return fail('invalid-url', 'Invalid URL', { error: 'Invalid URL' });
    }
    if (!ARTWORK_URL_SCHEMES.has(parsed.protocol)) {
      return fail('unsupported-scheme', `Unsupported URL scheme: ${parsed.protocol}`, {
        error: `Unsupported URL scheme: ${parsed.protocol}`,
      });
    }

    try {
      const track = getTrackById(trackId);
      const artworkBase = getArtworkBase(track?.library_id ?? getCurrentLibraryId());
      fsImpl.mkdirSync(artworkBase, { recursive: true });

      const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
      const res = await doFetch(String(url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const announced = Number(res.headers?.get?.('content-length') ?? 0);
      if (announced > maxArtworkBytes) {
        throw new Error(`Artwork too large: ${announced} bytes`);
      }

      const contentType = res.headers?.get?.('content-type') ?? '';
      const ext = contentType.includes('png') ? '.png' : '.jpg';

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxArtworkBytes) {
        throw new Error(`Artwork too large: ${buf.length} bytes`);
      }

      const artworkPath = path.join(artworkBase, `track_${trackId}${ext}`);
      fsImpl.writeFileSync(artworkPath, buf);

      await updateTrack(trackId, { has_artwork: 1, artwork_path: artworkPath });
      return ok({ artwork_path: artworkPath });
    } catch (err) {
      return failFromError(err);
    }
  });

  register('check-duplicate-urls', (_, entries) => getExistingSourceUrls(entries));

  register('open-external', async (_, url) => {
    let parsed;
    try {
      parsed = new URL(String(url ?? ''));
    } catch {
      return fail('invalid-url', 'Invalid URL', { error: 'Invalid URL' });
    }
    if (!EXTERNAL_URL_SCHEMES.has(parsed.protocol)) {
      return fail('unsupported-scheme', `Unsupported URL scheme: ${parsed.protocol}`, {
        error: `Unsupported URL scheme: ${parsed.protocol}`,
      });
    }
    await openExternal(String(url));
    return ok();
  });
}
