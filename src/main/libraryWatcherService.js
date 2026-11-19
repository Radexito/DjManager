/**
 * Library watcher and folder-tracked playlists (tor B, serwisy).
 *
 * The watcher and the folder mirror share the same state: which folders are
 * watched comes from two independent lists (the opt-in ingest list and every
 * folder-tracked playlist), and one watcher covers both because a folder can be
 * in both at once.
 *
 * Three pieces of state live here and nowhere else: the watcher handle, the
 * scan-in-progress flag and the refresh-in-progress flag. They are module state
 * by nature, so this is a factory rather than a set of loose functions — the
 * caller gets one object and cannot accidentally hold a stale copy.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build the library watcher service: one fs watcher over both the opt-in ingest
 * folders and every folder-tracked playlist, plus the scan and folder-sync
 * routines that share its state. The watcher handle and the two in-progress
 * flags live in the closure, so callers keep one service instance.
 * @param {object} deps repositories, watcher/import helpers and loggers; every
 *   collaborator is injected, `fsImpl`, `send` and the loggers have defaults
 * @returns {object} getWatchFolders, isEnabled, folderPlaylistFolders,
 *   playlistsForFile, restart, stop, scan, syncFolderPlaylist,
 *   refreshFolderPlaylists and isScanRunning
 */
export function createLibraryWatcherService({
  getSetting,
  getFolderPlaylists,
  getPlaylist,
  getPlaylistTracks,
  getTracksByPaths,
  listAudioFiles,
  linkAudioFile,
  importAudioFile,
  spawnAnalysis,
  addTrackToPlaylist,
  addTracksToPlaylist,
  markPlaylistFolderSynced,
  planFolderSync,
  isInsideFolder,
  scanFoldersForNewTracks,
  createLibraryWatcher,
  send = () => {},
  log = () => {},
  warn = () => {},
  error = () => {},
  fsImpl = fs,
}) {
  let libraryWatcher = null;
  let scanRunning = false;
  let refreshRunning = false;

  function getWatchFolders() {
    try {
      const parsed = JSON.parse(getSetting('watch_folders', '[]') || '[]');
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : [];
    } catch {
      return [];
    }
  }

  function isEnabled() {
    return getSetting('watch_enabled', 'false') === 'true';
  }

  function folderPlaylistFolders() {
    return getFolderPlaylists()
      .map((p) => p.folder_path)
      .filter(Boolean);
  }

  /** Folder-tracked playlists whose folder contains this file. */
  function playlistsForFile(filePath) {
    return getFolderPlaylists().filter((p) =>
      isInsideFolder(filePath, p.folder_path, { recursive: p.folder_recursive === 1 })
    );
  }

  /** (Re)build the watcher from current settings — safe to call any time. */
  function restart() {
    libraryWatcher?.close();
    libraryWatcher = null;

    const ingestFolders = isEnabled() ? getWatchFolders() : [];
    const folders = [...new Set([...ingestFolders, ...folderPlaylistFolders()])];
    if (folders.length === 0) return;

    libraryWatcher = createLibraryWatcher({
      folders,
      onNewFile: async (filePath) => {
        const targets = playlistsForFile(filePath);
        let id = null;
        if (targets.length > 0) {
          const res = await linkAudioFile(filePath);
          if (!res?.id) return;
          id = res.id;
          if (!res.duplicate) spawnAnalysis(id, filePath);
          for (const pl of targets) {
            try {
              addTrackToPlaylist(pl.id, id);
            } catch (err) {
              warn(`[folder-playlist] add to ${pl.id} failed:`, err.message);
            }
            send('folder-playlist-updated', {
              playlistId: pl.id,
              event: 'added',
              added: 1,
              filePath,
            });
          }
        } else {
          id = await importAudioFile(filePath, {});
        }
        if (!id) return;
        send('library-updated');
        send('watch-status', { event: 'imported', filePath });
      },
      onError: (err, folder) => warn(`[watcher] ${folder ?? ''} ${err.message}`),
    });
    log(`[watcher] watching ${folders.length} folder(s): ${folders.join(', ')}`);
  }

  /** Stop watching; used on quit and before a restart. */
  function stop() {
    libraryWatcher?.close();
    libraryWatcher = null;
  }

  /** Scan the watched folders now (startup auto-scan + manual action). */
  async function scan() {
    const folders = getWatchFolders();
    if (folders.length === 0 || scanRunning) {
      return { found: 0, imported: 0, skipped: 0, failed: 0 };
    }
    scanRunning = true;
    send('watch-status', { event: 'scan-started', folders: folders.length });
    try {
      const res = await scanFoldersForNewTracks(folders, {
        onProgress: (p) => send('watch-status', { event: 'scan-progress', ...p }),
      });
      if (res.imported > 0) send('library-updated');
      send('watch-status', { event: 'scan-done', ...res });
      return res;
    } catch (err) {
      error('[watcher] scan failed:', err.message);
      send('watch-status', { event: 'scan-failed', error: err.message });
      return { found: 0, imported: 0, skipped: 0, failed: 0, error: err.message };
    } finally {
      scanRunning = false;
    }
  }

  /**
   * Mirror one folder-tracked playlist: link what is new, add it to the
   * playlist, and report (never remove) what went missing. A file that moved
   * should not silently leave the playlist.
   */
  async function syncFolderPlaylist(playlistId) {
    const playlist = getPlaylist(playlistId);
    if (!playlist || !playlist.folder_path) {
      return { ok: false, playlistId, error: 'not-a-folder-playlist' };
    }
    const folder = playlist.folder_path;
    const recursive = playlist.folder_recursive === 1;
    if (!fsImpl.existsSync(folder)) {
      return { ok: false, playlistId, folder, error: 'folder-missing' };
    }

    const files = await listAudioFiles([folder], { maxDepth: recursive ? 8 : 0 });

    let linked = 0;
    if (files.length > 0) {
      const known = new Set(getTracksByPaths(files).map((t) => t.file_path));
      for (const file of files.filter((f) => !known.has(f))) {
        try {
          const res = await linkAudioFile(file);
          if (res?.id && !res.duplicate) {
            linked++;
            spawnAnalysis(res.id, file);
          }
        } catch (err) {
          warn(`[folder-playlist] link failed for ${file}:`, err.message);
        }
      }
    }

    const rows = files.length > 0 ? getTracksByPaths(files) : [];
    const byPath = new Map(rows.map((t) => [path.resolve(t.file_path), t]));
    const playlistTracks = getPlaylistTracks(playlistId);
    const plan = planFolderSync({ folderFiles: files, playlistTracks, folder });

    const addIds = plan.add.map((f) => byPath.get(path.resolve(f))?.id).filter(Boolean);
    if (addIds.length > 0) addTracksToPlaylist(playlistId, addIds);
    markPlaylistFolderSynced(playlistId);

    const trackById = new Map(playlistTracks.map((t) => [t.id, t]));
    const missing = plan.missing.map((m) => ({
      ...m,
      title: trackById.get(m.id)?.title ?? '',
      artist: trackById.get(m.id)?.artist ?? '',
    }));

    const result = {
      ok: true,
      playlistId,
      folder,
      recursive,
      found: files.length,
      linked,
      added: addIds.length,
      unchanged: plan.unchanged,
      missing,
    };
    if (linked > 0 || addIds.length > 0) {
      send('library-updated');
      send('folder-playlist-updated', { playlistId, event: 'synced', ...result });
    }
    log(
      `[folder-playlist] #${playlistId} ${folder}: ${files.length} file(s), ` +
        `${linked} linked, ${addIds.length} added, ${missing.length} missing`
    );
    return result;
  }

  /** Refresh every folder-tracked playlist (startup + manual "Refresh all"). */
  async function refreshFolderPlaylists() {
    if (refreshRunning) return [];
    refreshRunning = true;
    const results = [];
    try {
      for (const pl of getFolderPlaylists()) {
        try {
          results.push(await syncFolderPlaylist(pl.id));
        } catch (err) {
          warn(`[folder-playlist] refresh of ${pl.id} failed:`, err.message);
          results.push({ ok: false, playlistId: pl.id, error: err.message });
        }
      }
      return results;
    } finally {
      refreshRunning = false;
    }
  }

  return {
    getWatchFolders,
    isEnabled,
    folderPlaylistFolders,
    playlistsForFile,
    restart,
    stop,
    scan,
    syncFolderPlaylist,
    refreshFolderPlaylists,
    isScanRunning: () => scanRunning,
  };
}
