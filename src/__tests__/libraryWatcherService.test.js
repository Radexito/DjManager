import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryWatcherService } from '../main/libraryWatcherService.js';

let root;

/**
 * Creates the watcher service with stub settings, repositories and a fake watcher factory.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} The service, sent messages, created watchers and the stub deps.
 */
function build(overrides = {}) {
  const sent = [];
  const watchers = [];

  const deps = {
    getSetting: vi.fn((key, def) => {
      if (key === 'watch_folders') return JSON.stringify(['/ingest']);
      if (key === 'watch_enabled') return 'true';
      return def;
    }),
    getFolderPlaylists: vi.fn(() => []),
    getPlaylist: vi.fn((id) => ({
      id,
      folder_path: path.join(root, 'folder'),
      folder_recursive: 0,
    })),
    getPlaylistTracks: vi.fn(() => []),
    getTracksByPaths: vi.fn(() => []),
    listAudioFiles: vi.fn(async () => []),
    linkAudioFile: vi.fn(async (file) => ({ id: 7, duplicate: false, file })),
    importAudioFile: vi.fn(async () => 9),
    spawnAnalysis: vi.fn(),
    addTrackToPlaylist: vi.fn(),
    addTracksToPlaylist: vi.fn(),
    markPlaylistFolderSynced: vi.fn(),
    planFolderSync: vi.fn(() => ({ add: [], missing: [], unchanged: 0 })),
    isInsideFolder: vi.fn(() => false),
    scanFoldersForNewTracks: vi.fn(async () => ({ found: 1, imported: 1, skipped: 0, failed: 0 })),
    createLibraryWatcher: vi.fn((opts) => {
      const w = { opts, close: vi.fn() };
      watchers.push(w);
      return w;
    }),
    send: (channel, data) => sent.push([channel, data]),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };

  const service = createLibraryWatcherService(deps);
  return { service, sent, watchers, deps };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsvc-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('createLibraryWatcherService', () => {
  describe('settings', () => {
    it('reads watch folders and ignores anything that is not a list of paths', () => {
      const { service } = build({
        getSetting: vi.fn(() => '["/a", "", 3, null, "/b"]'),
      });
      expect(service.getWatchFolders()).toEqual(['/a', '/b']);
    });

    it('returns an empty list for corrupt JSON instead of throwing', () => {
      const { service } = build({ getSetting: vi.fn(() => '{not json') });
      expect(service.getWatchFolders()).toEqual([]);
    });

    it('treats only the literal "true" as enabled', () => {
      const on = build({ getSetting: vi.fn(() => 'true') });
      expect(on.service.isEnabled()).toBe(true);

      const off = build({ getSetting: vi.fn(() => 'false') });
      expect(off.service.isEnabled()).toBe(false);
    });
  });

  describe('folder playlists', () => {
    it('lists folder-backed playlists only', () => {
      const { service } = build({
        getFolderPlaylists: vi.fn(() => [
          { id: 1, folder_path: '/a' },
          { id: 2, folder_path: null },
        ]),
      });
      expect(service.folderPlaylistFolders()).toEqual(['/a']);
    });

    it('matches a file to its playlists using the playlist recursion flag', () => {
      const { service, deps } = build({
        getFolderPlaylists: vi.fn(() => [{ id: 1, folder_path: '/a', folder_recursive: 1 }]),
        isInsideFolder: vi.fn(() => true),
      });

      expect(service.playlistsForFile('/a/b/c.mp3')).toHaveLength(1);
      expect(deps.isInsideFolder).toHaveBeenCalledWith('/a/b/c.mp3', '/a', { recursive: true });
    });
  });

  describe('restart', () => {
    it('does nothing when there is no folder to watch', () => {
      const { service, deps } = build({
        getSetting: vi.fn((key, def) => (key === 'watch_enabled' ? 'false' : def)),
        getFolderPlaylists: vi.fn(() => []),
      });

      service.restart();

      expect(deps.createLibraryWatcher).not.toHaveBeenCalled();
    });

    it('watches the union of ingest folders and playlist folders', () => {
      const { service, deps } = build({
        getFolderPlaylists: vi.fn(() => [{ id: 1, folder_path: '/shown' }]),
      });

      service.restart();

      const folders = deps.createLibraryWatcher.mock.calls[0][0].folders;
      expect(folders).toEqual(['/ingest', '/shown']);
    });

    it('closes the previous watcher before building a new one', () => {
      const { service, watchers } = build();

      service.restart();
      service.restart();

      expect(watchers).toHaveLength(2);
      expect(watchers[0].close).toHaveBeenCalled();
    });

    it('skips ingest folders when the ingest list is switched off', () => {
      const { service, deps } = build({
        getSetting: vi.fn((key, def) => (key === 'watch_enabled' ? 'false' : def)),
        getFolderPlaylists: vi.fn(() => [{ id: 1, folder_path: '/shown' }]),
      });

      service.restart();

      expect(deps.createLibraryWatcher.mock.calls[0][0].folders).toEqual(['/shown']);
    });

    it('links a new file that belongs to a folder playlist instead of importing it', async () => {
      const { service, deps, sent, watchers } = build({
        isInsideFolder: vi.fn(() => true),
        getFolderPlaylists: vi.fn(() => [{ id: 3, folder_path: '/shown', folder_recursive: 0 }]),
      });

      service.restart();
      await watchers[0].opts.onNewFile('/shown/new.mp3');

      expect(deps.linkAudioFile).toHaveBeenCalledWith('/shown/new.mp3');
      expect(deps.importAudioFile).not.toHaveBeenCalled();
      expect(deps.addTrackToPlaylist).toHaveBeenCalledWith(3, 7);
      expect(deps.spawnAnalysis).toHaveBeenCalledWith(7, '/shown/new.mp3');
      expect(sent).toContainEqual(['library-updated', undefined]);
    });

    it('imports a new file that belongs to no playlist', async () => {
      const { service, deps, watchers } = build();

      service.restart();
      await watchers[0].opts.onNewFile('/random/new.mp3');

      expect(deps.importAudioFile).toHaveBeenCalledWith('/random/new.mp3', {});
      expect(deps.linkAudioFile).not.toHaveBeenCalled();
    });

    it('does not spawn analysis for a file that was already known', async () => {
      const { service, deps, watchers } = build({
        isInsideFolder: vi.fn(() => true),
        getFolderPlaylists: vi.fn(() => [{ id: 3, folder_path: '/shown', folder_recursive: 0 }]),
        linkAudioFile: vi.fn(async () => ({ id: 7, duplicate: true })),
      });

      service.restart();
      await watchers[0].opts.onNewFile('/shown/dup.mp3');

      expect(deps.spawnAnalysis).not.toHaveBeenCalled();
    });

    it('stops the watcher on stop', () => {
      const { service, watchers } = build();
      service.restart();
      service.stop();
      expect(watchers[0].close).toHaveBeenCalled();
    });
  });

  describe('scan', () => {
    it('reports the scan lifecycle and updates the library when something arrived', async () => {
      const { service, sent } = build();

      const res = await service.scan();

      expect(res).toEqual({ found: 1, imported: 1, skipped: 0, failed: 0 });
      expect(sent[0]).toEqual(['watch-status', { event: 'scan-started', folders: 1 }]);
      expect(sent.some(([ch]) => ch === 'library-updated')).toBe(true);
      expect(sent.at(-1)[1]).toMatchObject({ event: 'scan-done' });
    });

    it('refuses a second scan while one is running', async () => {
      let release;
      const { service, deps } = build({
        scanFoldersForNewTracks: vi.fn(
          () =>
            new Promise(
              (resolve) =>
                (release = () => resolve({ found: 0, imported: 0, skipped: 0, failed: 0 }))
            )
        ),
      });

      const first = service.scan();
      await expect(service.scan()).resolves.toEqual({
        found: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
      });
      expect(service.isScanRunning()).toBe(true);

      release();
      await first;
      expect(service.isScanRunning()).toBe(false);
      expect(deps.scanFoldersForNewTracks).toHaveBeenCalledTimes(1);
    });

    it('turns a scan failure into a status event and an empty result', async () => {
      const { service, sent } = build({
        scanFoldersForNewTracks: vi.fn(async () => {
          throw new Error('disk gone');
        }),
      });

      const res = await service.scan();

      expect(res).toMatchObject({ imported: 0, error: 'disk gone' });
      expect(sent.at(-1)[1]).toMatchObject({ event: 'scan-failed', error: 'disk gone' });
      expect(service.isScanRunning()).toBe(false);
    });
  });

  describe('syncFolderPlaylist', () => {
    it('refuses a playlist that is not folder-backed', async () => {
      const { service } = build({ getPlaylist: vi.fn(() => ({ id: 1, folder_path: null })) });
      await expect(service.syncFolderPlaylist(1)).resolves.toMatchObject({
        ok: false,
        error: 'not-a-folder-playlist',
      });
    });

    it('reports a folder that disappeared', async () => {
      const { service } = build({
        getPlaylist: vi.fn(() => ({ id: 1, folder_path: path.join(root, 'gone') })),
      });
      await expect(service.syncFolderPlaylist(1)).resolves.toMatchObject({
        ok: false,
        error: 'folder-missing',
      });
    });

    it('links unknown files, adds them to the playlist and reports the result', async () => {
      const folder = path.join(root, 'folder');
      fs.mkdirSync(folder);
      const file = path.join(folder, 'a.mp3');

      const { service, deps, sent } = build({
        getPlaylist: vi.fn(() => ({ id: 1, folder_path: folder, folder_recursive: 0 })),
        listAudioFiles: vi.fn(async () => [file]),
        getTracksByPaths: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValueOnce([{ id: 5, file_path: file }]),
        planFolderSync: vi.fn(() => ({ add: [file], missing: [], unchanged: 0 })),
      });

      const res = await service.syncFolderPlaylist(1);

      expect(res).toMatchObject({ ok: true, found: 1, linked: 1, added: 1 });
      expect(deps.linkAudioFile).toHaveBeenCalledWith(file);
      expect(deps.addTracksToPlaylist).toHaveBeenCalledWith(1, [5]);
      expect(deps.markPlaylistFolderSynced).toHaveBeenCalledWith(1);
      expect(sent.some(([ch]) => ch === 'folder-playlist-updated')).toBe(true);
    });

    it('reports missing tracks with their title so the dialog can show them', async () => {
      const folder = path.join(root, 'folder');
      fs.mkdirSync(folder);

      const { service } = build({
        getPlaylist: vi.fn(() => ({ id: 1, folder_path: folder, folder_recursive: 0 })),
        listAudioFiles: vi.fn(async () => []),
        getPlaylistTracks: vi.fn(() => [{ id: 4, title: 'Gone', artist: 'Someone' }]),
        planFolderSync: vi.fn(() => ({
          add: [],
          missing: [{ id: 4, file_path: '/old.mp3' }],
          unchanged: 0,
        })),
      });

      const res = await service.syncFolderPlaylist(1);

      expect(res.missing).toEqual([
        { id: 4, file_path: '/old.mp3', title: 'Gone', artist: 'Someone' },
      ]);
    });

    it('never removes anything it did not add', async () => {
      const folder = path.join(root, 'folder');
      fs.mkdirSync(folder);

      const { service, deps } = build({
        getPlaylist: vi.fn(() => ({ id: 1, folder_path: folder, folder_recursive: 0 })),
        listAudioFiles: vi.fn(async () => []),
        planFolderSync: vi.fn(() => ({
          add: [],
          missing: [{ id: 4, file_path: '/old.mp3' }],
          unchanged: 0,
        })),
      });

      await service.syncFolderPlaylist(1);

      expect(deps.addTracksToPlaylist).not.toHaveBeenCalled();
      expect(deps.linkAudioFile).not.toHaveBeenCalled();
    });
  });

  describe('refreshFolderPlaylists', () => {
    it('syncs every folder playlist and keeps going when one fails', async () => {
      const { service } = build({
        getFolderPlaylists: vi.fn(() => [{ id: 1 }, { id: 2 }]),
        getPlaylist: vi.fn((id) =>
          id === 1
            ? { id: 1, folder_path: path.join(root, 'missing') }
            : { id: 2, folder_path: null }
        ),
      });

      const results = await service.refreshFolderPlaylists();

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.ok === false)).toBe(true);
    });
  });
});
