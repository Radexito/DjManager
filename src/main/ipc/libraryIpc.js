/**
 * Library and database IPC (tor B, slice 9).
 *
 * Fourteen channels moved out of `src/main.js`:
 *   get-library-path, move-library, list-libraries, get-library-size,
 *   list-libraries-with-free-space, get-current-library-id,
 *   set-current-library-id, create-library, rename-library,
 *   get-library-storage-format, convert-storage-format, get-db-path,
 *   get-db-size, move-database.
 *
 * Every repository call and filesystem helper arrives as a parameter; the
 * module itself imports nothing but `node:fs` and `node:path`. The one place
 * the old code reached for `global.mainWindow` directly — `move-library`
 * pushing progress — goes through the injected `send` like every other module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError, handle } from './response.js';

/**
 * Register the library and database channels: paths, free space, the library
 * list and CRUD, storage format conversion, and moving the library or the
 * database file. Long moves report progress through `send`.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {function(string, ...any): void} [deps.send] renderer sender
 * @param {string} deps.userDataDir Electron user-data directory
 * @param {object} deps.runtime media server runtime
 * @param {object} [deps.fsImpl] filesystem implementation to use instead of node:fs
 * @throws {Error} when ipcMain is missing
 */
export function registerLibraryIpc({
  ipcMain,
  send = () => {},
  userDataDir,
  runtime,
  allowExplorerBase = () => {},

  getLibraryBase,
  getArtworkBase,
  getTracks,
  updateTrack,
  setLibraryRootPath,
  listLibraries,
  getLibraryDiskUsage,
  getLibraryFreeSpace,
  getCurrentLibraryId,
  setCurrentLibraryId,
  createLibrary,
  renameLibrary,
  getStorageFormat,
  convertStorageFormat,

  getDbPath,
  closeDB,
  setDbPath,
  relaunchApp,

  moveFileSafe,
  fsImpl = fs,
}) {
  if (!ipcMain) throw new Error('registerLibraryIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  const current = (libraryId) => libraryId ?? getCurrentLibraryId();

  register('get-library-path', (_, libraryId) => getLibraryBase(current(libraryId)));

  register('move-library', async (_, newDir, libraryId) => {
    const id = current(libraryId);
    const oldBase = getLibraryBase(id);

    if (!newDir || newDir === oldBase)
      throw new AppError('same-directory', 'Same directory selected.');

    if (!fsImpl.existsSync(newDir)) fsImpl.mkdirSync(newDir, { recursive: true });

    const tracks = getTracks({ limit: 999999, libraryIds: [id] });
    const total = tracks.length;
    let moved = 0;

    for (const track of tracks) {
      const oldPath = track.file_path;
      if (!fsImpl.existsSync(oldPath)) {
        moved++;
        continue;
      }

      const rel = path.relative(oldBase, oldPath);
      const newPath = path.join(newDir, rel);
      fsImpl.mkdirSync(path.dirname(newPath), { recursive: true });
      moveFileSafe(oldPath, newPath);
      updateTrack(track.id, { file_path: newPath });
      moved++;

      const pct = Math.round((moved / total) * 100);
      send('move-library-progress', { moved, total, pct });
      send('track-updated', {
        trackId: track.id,
        analysis: { file_path: newPath, analyzed: track.analyzed },
      });
    }

    try {
      for (const entry of fsImpl.readdirSync(oldBase)) {
        const dir = path.join(oldBase, entry);
        if (fsImpl.statSync(dir).isDirectory() && fsImpl.readdirSync(dir).length === 0) {
          fsImpl.rmdirSync(dir);
        }
      }
      if (fsImpl.readdirSync(oldBase).length === 0) fsImpl.rmdirSync(oldBase);
    } catch {}

    setLibraryRootPath(id, newDir);
    allowExplorerBase(runtime, newDir);
    return { moved, total };
  });

  register('list-libraries', () =>
    listLibraries().map((lib) => ({ ...lib, effective_root_path: getLibraryBase(lib.id) }))
  );

  register('get-library-size', (_, libraryId) => getLibraryDiskUsage(current(libraryId)));

  register('list-libraries-with-free-space', () =>
    listLibraries().map((lib) => ({
      ...lib,
      effective_root_path: getLibraryBase(lib.id),
      free_bytes: getLibraryFreeSpace(lib.id),
    }))
  );

  register('get-current-library-id', () => getCurrentLibraryId());
  register('set-current-library-id', (_, id) => setCurrentLibraryId(id));

  register('create-library', (_, opts) => {
    const lib = createLibrary(opts);
    for (const base of [getLibraryBase(lib.id), getArtworkBase(lib.id)]) {
      allowExplorerBase(runtime, base);
    }
    return lib;
  });

  register('rename-library', (_, id, name) => renameLibrary(id, name));

  register('get-library-storage-format', (_, libraryId) => getStorageFormat(current(libraryId)));
  register('convert-storage-format', (_, libraryId, newFormat) =>
    convertStorageFormat(current(libraryId), newFormat)
  );

  register('get-db-path', () => getDbPath(userDataDir));

  register('get-db-size', () => {
    try {
      return fsImpl.statSync(getDbPath(userDataDir)).size;
    } catch {
      return 0;
    }
  });

  register('move-database', async (_, newDir) => {
    const oldPath = getDbPath(userDataDir);
    const newPath = path.join(newDir, path.basename(oldPath));
    if (newPath === oldPath) throw new AppError('same-location', 'Same location selected.');
    if (!fsImpl.existsSync(newDir)) fsImpl.mkdirSync(newDir, { recursive: true });

    closeDB();
    for (const suffix of ['', '-wal', '-shm']) {
      const src = oldPath + suffix;
      if (fsImpl.existsSync(src)) moveFileSafe(src, newPath + suffix);
    }
    setDbPath(userDataDir, newPath);
    relaunchApp();
  });
}
