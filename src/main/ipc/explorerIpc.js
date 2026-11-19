import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_EXTENSIONS } from '../audioExtensions.js';
import { allowExplorerBase, isExplorerPathAllowed } from '../runtime.js';
import { handle } from './response.js';

/**
 * File explorer IPC (tor B, slice 5).
 *
 * Five channels moved out of `src/main.js`: pick a folder, list a directory,
 * read track metadata for the details pane, and the recursive walk with its
 * cancel. Bodies are the same code; what changed is where the state and the
 * side effects come from.
 *
 * `activeRecursiveWalker` now lives on the runtime object - it is shared mutable
 * state, and the previous module-scope binding is exactly what kept this domain
 * inside main.js. The dialog and ffprobe arrive as functions, so a caller can
 * answer them without Electron or a binary.
 */
export function registerExplorerIpc({
  ipcMain,
  runtime,
  send = () => {},
  showOpenDialog,
  getMainWindow,
  runFfprobe,
}) {
  if (!ipcMain) throw new Error('registerExplorerIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });
  if (!runtime) throw new Error('registerExplorerIpc: runtime is required');

  register('select-explorer-folder', async () => {
    const result = await showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
      title: 'Select Folder to Browse',
    });
    if (result.canceled || !result.filePaths.length) return null;
    const folderPath = result.filePaths[0];
    allowExplorerBase(runtime, folderPath);
    return folderPath;
  });

  register('browse-directory', (_, dirPath) => {
    if (!isExplorerPathAllowed(runtime, dirPath)) {
      allowExplorerBase(runtime, dirPath);
    }
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const dirs = [];
      const files = [];
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.push({ name: entry.name, path: fullPath });
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTENSIONS.has(ext)) {
            let size = 0;
            try {
              size = fs.statSync(fullPath).size;
            } catch {}
            files.push({ name: entry.name, path: fullPath, size });
          }
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));
      return { dirs, files };
    } catch (err) {
      return { dirs: [], files: [], error: err.message };
    }
  });

  register('get-explorer-track-metadata', async (_, filePath) => {
    try {
      const data = await runFfprobe(filePath);
      const tags = data.format?.tags || {};
      const stream = data.streams?.find((s) => s.codec_type === 'audio') || {};
      const bpmTag = tags.bpm || tags.BPM || tags.TBPM || tags['tbpm'];
      const keyTag = tags.key || tags.KEY || tags.initialkey || tags.INITIALKEY || null;
      return {
        title: tags.title || path.basename(filePath, path.extname(filePath)),
        artist: tags.artist || '',
        album: tags.album || '',
        year: tags.date ? parseInt(tags.date.slice(0, 4)) : null,
        label: tags.label || '',
        genre: tags.genre ? tags.genre.split(',').map((g) => g.trim()) : [],
        bpm: bpmTag ? parseFloat(bpmTag) || null : null,
        key_raw: keyTag,
        duration: parseFloat(data.format?.duration) || null,
        bitrate: parseInt(stream.bit_rate || data.format?.bit_rate || 0, 10) || null,
      };
    } catch (err) {
      return {
        title: path.basename(filePath, path.extname(filePath)),
        artist: '',
        album: '',
        bpm: null,
        key_raw: null,
        duration: null,
        bitrate: null,
        error: err.message,
      };
    }
  });

  register('explorer-start-recursive', (_, dirPath) => {
    if (runtime.activeRecursiveWalker) runtime.activeRecursiveWalker.cancelled = true;
    const walker = { cancelled: false };
    runtime.activeRecursiveWalker = walker;

    allowExplorerBase(runtime, dirPath);

    async function walk(d) {
      if (walker.cancelled) return;
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      const batch = [];
      const dirs = [];
      for (const entry of entries) {
        if (walker.cancelled) return;
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.push(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTENSIONS.has(ext)) {
            let size = 0;
            try {
              size = fs.statSync(fullPath).size;
            } catch {}
            batch.push({ name: entry.name, path: fullPath, size });
          }
        }
      }
      if (batch.length > 0 && !walker.cancelled) {
        send('explorer-recursive-batch', batch);
      }
      for (const subdir of dirs) {
        if (walker.cancelled) return;
        await new Promise((r) => setImmediate(r));
        await walk(subdir);
      }
    }

    walk(dirPath).then(() => {
      if (!walker.cancelled) send('explorer-recursive-done', null);
    });

    return { ok: true };
  });

  register('explorer-cancel-recursive', () => {
    if (runtime.activeRecursiveWalker) runtime.activeRecursiveWalker.cancelled = true;
    runtime.activeRecursiveWalker = null;
  });
}
