import fs from 'fs';
import path from 'path';

// Canonical audio extensions DjManager imports (mirrors the File Explorer set).
export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.opus',
]);

/** True when the path looks like an importable audio file. */
export function isAudioPath(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath ?? '').toLowerCase());
}

/**
 * Recursively list audio files under the given folders (depth-limited so a
 * symlink loop or a giant tree can never hang the scan).
 * @param {string[]} folders
 * @returns {Promise<string[]>}
 */
export async function listAudioFiles(folders = [], { maxDepth = 8, fsImpl = fs } = {}) {
  const found = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsImpl.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable / vanished directory — skip quietly
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue; // skip dot-dirs (.git, caches)
        await walk(full, depth + 1);
      } else if (entry.isFile() && isAudioPath(entry.name)) {
        found.push(full);
      }
    }
  }

  for (const folder of folders) {
    if (!folder) continue;
    await walk(folder, 0);
  }
  return found;
}

/**
 * Watch ingest folders for new audio files (#256).
 *
 * `fs.watch(..., { recursive: true })` emits an event per touched path; events
 * are debounced per file and the file must exist (and be non-empty) before
 * `onNewFile` fires — that filters out the partial writes a copy produces.
 *
 * @param {{ folders?: string[], onNewFile: (filePath: string) => any,
 *           debounceMs?: number, onError?: (err: Error, folder?: string) => void,
 *           fsImpl?: typeof fs, watchImpl?: typeof fs.watch }} opts
 * @returns {{ close: () => void, folders: string[] }}
 */
export function createLibraryWatcher({
  folders = [],
  onNewFile,
  debounceMs = 2000,
  onError,
  fsImpl = fs,
  watchImpl = fs.watch,
} = {}) {
  const watchers = [];
  const timers = new Map(); // filePath → timeout
  let closed = false;

  const reportError = (err, folder) => {
    if (onError) onError(err, folder);
    else console.warn('[watcher]', folder ? `${folder}:` : '', err.message);
  };

  const handleFile = async (filePath) => {
    if (closed) return;
    try {
      if (!fsImpl.existsSync(filePath)) return;
      const stat = fsImpl.statSync(filePath);
      if (!stat.isFile() || stat.size === 0) return;
    } catch (err) {
      reportError(err, filePath);
      return;
    }
    try {
      await onNewFile(filePath);
    } catch (err) {
      reportError(err, filePath);
    }
  };

  const schedule = (filePath) => {
    const pending = timers.get(filePath);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      timers.delete(filePath);
      handleFile(filePath);
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(filePath, timer);
  };

  for (const folder of folders) {
    if (!folder) continue;
    if (!fsImpl.existsSync(folder)) {
      reportError(new Error('folder does not exist'), folder);
      continue;
    }
    try {
      const watcher = watchImpl(folder, { recursive: true }, (_event, filename) => {
        if (closed || !filename) return;
        const full = path.join(folder, filename.toString());
        if (!isAudioPath(full)) return;
        schedule(full);
      });
      watcher.on?.('error', (err) => reportError(err, folder));
      watchers.push(watcher);
    } catch (err) {
      reportError(err, folder);
    }
  }

  return {
    folders: [...folders],
    close() {
      if (closed) return;
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          /* already gone */
        }
      }
      watchers.length = 0;
    },
  };
}
