import path from 'node:path';
import { downloadTidal, reindexTidalEntries } from '../../audio/tidalDlManager.js';
import { importAudioFile } from '../../audio/importManager.js';
import { addTrackToPlaylist, findOrCreatePlaylist } from '../../db/playlistRepository.js';

/**
 * TIDAL import service (tor B, step 4).
 *
 * `runTidalDownload` was the second-largest block in `src/main.js`: it resolves
 * the URLs handed to tdn, imports every downloaded file, creates or reuses the
 * playlist and reports per-track progress positionally.
 *
 * Injected, because each of these lives outside this module's ownership:
 *   * `send`        the renderer bridge,
 *   * `getTempDir`  the download scratch directory (app.getPath('userData')),
 *   * the library writes (importAudioFile / playlist helpers) stay imported,
 *     since they are plain module functions the tests already mock.
 */
export function createTidalImportService({ send = () => {}, getTempDir }) {
  if (typeof getTempDir !== 'function') {
    throw new Error('createTidalImportService: getTempDir is required');
  }

  function tidalEntryUrl(entry) {
    if (entry?.url) return entry.url;
    if (entry?.id) return `https://tidal.com/browse/track/${entry.id}`;
    return null;
  }

  function tidalCollectionUrl(type, id) {
    switch (type) {
      case 'playlist':
        return `https://tidal.com/browse/playlist/${id}`;
      case 'mix':
        return `https://tidal.com/browse/mix/${id}`;
      case 'album':
        return `https://tidal.com/browse/album/${id}`;
      case 'artist':
        return `https://tidal.com/browse/artist/${id}`;
      default:
        return 'https://tidal.com/my-collection';
    }
  }

  /**
   * Shared TIDAL download routine: resolves the URLs handed to tdn, imports every
   * downloaded file into the library and reports per-track progress.
   * Used by both `tidal-download-url` and `tidal-download-collection`.
   */
  async function runTidalDownload({
    url,
    selectedEntries,
    linkTrackIds,
    existingPlaylistId,
    newPlaylistName,
  }) {
    const sendTrackUpdate = (data) => send('tidal-track-update', data);
    const sendProgress = (msg) => send('tidal-progress', { msg });

    try {
      const tmpDir = path.join(getTempDir(), 'tidal_tmp');

      const entries = reindexTidalEntries(selectedEntries);

      const downloadUrls =
        entries.length > 0 ? entries.map((e) => tidalEntryUrl(e)).filter(Boolean) : [url];

      let playlistId = null;
      if (existingPlaylistId) {
        playlistId = existingPlaylistId;
      } else if (newPlaylistName?.trim()) {
        try {
          const { id } = findOrCreatePlaylist(newPlaylistName.trim(), null, url);
          playlistId = id;
          send('playlists-updated');
        } catch (err) {
          console.error('[tidal] findOrCreatePlaylist failed:', err.message);
        }
      }

      if (entries.length > 0) {
        sendTrackUpdate({ type: 'init', tracks: entries });
      }

      const trackIds = [];
      let fileIndex = 0;

      const onFileReady = async (filePath) => {
        const entry = entries[fileIndex] ?? null;
        const idx = fileIndex;
        fileIndex++;

        if (entry) {
          sendTrackUpdate({
            index: idx,
            title: entry.title,
            artist: entry.artist,
            status: 'importing',
          });
        } else {
          sendTrackUpdate({
            index: idx,
            title: path.basename(filePath),
            artist: '',
            status: 'importing',
          });
        }

        try {
          const trackSourceUrl = tidalEntryUrl(entry) ?? url;
          const trackId = await importAudioFile(filePath, {
            source_url: trackSourceUrl,
            source_link: url !== trackSourceUrl ? url : null,
            source_platform: 'tidal',
          });
          trackIds.push(trackId);
          if (playlistId) {
            addTrackToPlaylist(playlistId, trackId);
            send('playlists-updated');
          }
          send('library-updated');
          sendTrackUpdate({
            index: idx,
            title: entry?.title ?? path.basename(filePath),
            artist: entry?.artist ?? '',
            status: 'done',
            trackId,
          });
        } catch (err) {
          console.error('[tidal] importAudioFile failed:', err.message);
          sendTrackUpdate({
            index: idx,
            title: entry?.title ?? path.basename(filePath),
            artist: entry?.artist ?? '',
            status: 'failed',
            error: err.message,
          });
        }
      };

      sendProgress('Starting download…');

      const hasDownloads = entries.length > 0 || !selectedEntries;
      if (hasDownloads) {
        const files = await downloadTidal(downloadUrls, tmpDir, sendProgress, { onFileReady });
        if (files.length === 0 && trackIds.length === 0 && (linkTrackIds?.length ?? 0) === 0) {
          send('tidal-progress', null);
          return { ok: false, error: 'Download finished but no audio files were found.' };
        }
      }

      if (linkTrackIds?.length > 0 && playlistId) {
        for (const tid of linkTrackIds) {
          try {
            addTrackToPlaylist(playlistId, tid);
          } catch {}
        }
        send('playlists-updated');
      }

      send('tidal-progress', null);
      return { ok: true, trackIds, playlistId: playlistId ?? null };
    } catch (err) {
      send('tidal-progress', null);
      return { ok: false, error: err.message };
    }
  }

  return { tidalEntryUrl, tidalCollectionUrl, runTidalDownload };
}
