/**
 * yt-dlp IPC: playlist info and URL download (tor B, slice 3).
 *
 * Moved verbatim from `src/main.js`: the handler bodies are the same text, only
 * the `send` helper moved from a closure over `global.mainWindow` to an injected
 * dependency. Setting keys, progress payloads, the playlist creation order and
 * the post-download fallback are untouched - this slice changes the address,
 * not the behaviour.
 *
 * The collaborators it needs from the rest of the app arrive as arguments, so it
 * can be driven with fakes instead of booting Electron.
 */

import { handle } from './response.js';
/**
 * Register the yt-dlp channels: fetching playlist info and downloading a URL
 * into a playlist. Progress goes through `send`; the download falls back to a
 * plain import when the metadata path does not apply.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @throws {Error} when ipcMain is missing
 */
export function registerYtdlpIpc({
  ipcMain,
  getSetting,
  ytDlpFetchPlaylistInfo,
  ytDlpDownloadUrl,
  findOrCreatePlaylist,
  addTrackToPlaylist,
  importAudioFile,
  send = () => {},
}) {
  if (!ipcMain) throw new Error('registerYtdlpIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('ytdlp-fetch-info', async (_event, url) => {
    console.log('[ytdlp-fetch-info] fetching info for:', url);
    try {
      const cookiesBrowser = getSetting('ytdlp_cookies_browser', '') || null;
      if (cookiesBrowser)
        console.log('[ytdlp-fetch-info] using cookies from browser:', cookiesBrowser);
      const info = await ytDlpFetchPlaylistInfo(url, {
        cookiesBrowser,
        onBeforeCheck: (entries) => {
          send('ytdlp-entries-ready', entries);
        },
        onCheckProgress: ({ checked, total }) => {
          send('ytdlp-check-progress', { checked, total });
        },
        onEntryChecked: (entry) => {
          send('ytdlp-entry-checked', entry);
        },
      });
      send('ytdlp-check-progress', null);
      console.log(`[ytdlp-fetch-info] ok — type=${info.type} entries=${info.entries?.length}`);
      return { ok: true, ...info };
    } catch (err) {
      send('ytdlp-check-progress', null);
      console.error('[ytdlp-fetch-info] error:', err.message);
      return { ok: false, error: err.message };
    }
  });

  register(
    'ytdlp-download-url',
    async (_event, { url, playlistItems, playlistTitle, existingPlaylistId, newPlaylistName }) => {
      try {
        const sendProgress = (data) => send('ytdlp-progress', data);
        const sendTrackUpdate = (data) => send('ytdlp-track-update', data);

        const cookiesBrowser = getSetting('ytdlp_cookies_browser', '') || null;

        sendProgress({
          msg: 'Starting download…',
          pct: 0,
          trackPct: 0,
          overallCurrent: 1,
          overallTotal: 1,
        });

        let playlistId = null;
        const trackIds = [];
        const importPromises = [];
        const handledPaths = new Set();

        if (existingPlaylistId) {
          playlistId = existingPlaylistId;
        } else if (newPlaylistName) {
          try {
            const { id } = findOrCreatePlaylist(newPlaylistName, null, url);
            playlistId = id;
            send('playlists-updated');
          } catch (err) {
            console.error('[ytdlp] findOrCreatePlaylist failed:', err.message);
          }
        }

        const handleFileReady = async ({
          filePath,
          originalUrl,
          trackUrl,
          platform,
          quality,
          title,
          channel,
          index,
        }) => {
          handledPaths.add(filePath);
          sendTrackUpdate({ type: 'update', index, title, url: trackUrl, status: 'importing' });
          try {
            const trackId = await importAudioFile(filePath, {
              source_url: originalUrl,
              source_link: trackUrl !== originalUrl ? trackUrl : null,
              source_platform: platform,
              source_quality: quality,
              channel: channel || null,
            });
            trackIds.push(trackId);
            if (playlistId) {
              addTrackToPlaylist(playlistId, trackId);
              send('playlists-updated');
            }
            sendTrackUpdate({
              type: 'update',
              index,
              title,
              url: trackUrl,
              status: 'done',
              trackId,
            });
            send('library-updated');
          } catch (err) {
            sendTrackUpdate({
              type: 'update',
              index,
              title,
              url: trackUrl,
              status: 'failed',
              error: err.message,
            });
          }
        };

        let lastOverallCurrent = 0;

        const {
          files,
          playlistName: detectedPlaylistName,
          unavailableCount = 0,
        } = await ytDlpDownloadUrl(
          url,
          (data) => {
            if (data.overallTotal > 1 && data.overallCurrent !== lastOverallCurrent) {
              lastOverallCurrent = data.overallCurrent;
              sendTrackUpdate({
                type: 'update',
                index: data.overallCurrent - 1,
                status: 'downloading',
              });
            }
            sendProgress(data);
          },
          {
            cookiesBrowser,
            playlistItems: playlistItems || null,
            onFileReady: (f) => {
              importPromises.push(handleFileReady(f));
            },
            onTrackMeta: ({ index, title }) => {
              sendTrackUpdate({ type: 'update', index, title, status: 'downloading' });
            },
            onTrackUnavailable: ({ videoId, reason }) => {
              sendTrackUpdate({ type: 'unavailable', videoId, reason, status: 'failed' });
            },
            onPlaylistDetected: ({ name, total }) => {
              if (total > 1) {
                if (!playlistId) {
                  try {
                    const { id } = findOrCreatePlaylist(
                      name || playlistTitle || 'Imported Playlist',
                      null,
                      url
                    );
                    playlistId = id;
                    send('playlists-updated');
                  } catch (err) {
                    console.error('[ytdlp] findOrCreatePlaylist failed:', err.message);
                  }
                }
                sendTrackUpdate({ type: 'init', total });
              }
            },
          }
        );

        await Promise.allSettled(importPromises);

        for (const { filePath, originalUrl, trackUrl, platform, quality } of files) {
          if (handledPaths.has(filePath)) continue;
          sendProgress({
            msg: 'Importing to library…',
            pct: 99,
            trackPct: 99,
            overallCurrent: 1,
            overallTotal: 1,
          });
          try {
            const trackId = await importAudioFile(filePath, {
              source_url: originalUrl,
              source_link: trackUrl !== originalUrl ? trackUrl : null,
              source_platform: platform,
              source_quality: quality,
            });
            trackIds.push(trackId);
            send('library-updated');
          } catch {}
        }

        sendProgress(null);

        if (!playlistId && trackIds.length > 1) {
          try {
            const name =
              detectedPlaylistName ||
              playlistTitle ||
              `Playlist ${new Date().toLocaleDateString()}`;
            const { id: pid } = findOrCreatePlaylist(name, null, url);
            playlistId = pid;
            for (const tid of trackIds) {
              try {
                addTrackToPlaylist(playlistId, tid);
              } catch {}
            }
            send('playlists-updated');
          } catch (err) {
            console.error('[ytdlp] post-download createPlaylist failed:', err.message);
          }
        }

        return { ok: true, trackIds, playlistId: playlistId ?? null, unavailableCount };
      } catch (err) {
        send('ytdlp-progress', null);
        return { ok: false, error: err.message };
      }
    }
  );
}
