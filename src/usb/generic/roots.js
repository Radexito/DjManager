import fs from 'node:fs';
import path from 'node:path';

/**
 * Mount points worth looking at for a connected USB medium.
 *
 * The list is intentionally shallow: a device mounted somewhere deep is not
 * going to be found by guessing, and the caller usually has a hint from the
 * user anyway. Platform differences are kept here so no format has to know
 * where the operating system puts its mounts.
 * @param {object} [options]
 * @param {string} [options.platform] process.platform
 * @param {object} [options.env] environment holding USER
 * @param {Function} [options.readdir] injectable directory reader
 * @param {Function} [options.exists] injectable existence check
 * @returns {string[]} absolute paths of mount points that exist
 */
export function candidateRoots({
  platform = process.platform,
  env = process.env,
  readdir = fs.readdirSync,
  exists = fs.existsSync,
} = {}) {
  const roots = [];
  const add = (dir) => {
    try {
      if (exists(dir)) roots.push(dir);
    } catch {
      /* an unreadable mount point is simply skipped */
    }
  };
  const addChildren = (dir) => {
    let entries = [];
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const isDir = typeof entry === 'string' ? true : entry.isDirectory();
      if (isDir) roots.push(path.join(dir, typeof entry === 'string' ? entry : entry.name));
    }
  };

  if (platform === 'win32') {
    for (let code = 68; code <= 90; code += 1) add(`${String.fromCharCode(code)}:\\`);
    return roots;
  }

  if (platform === 'darwin') {
    addChildren('/Volumes');
    return roots;
  }

  const user = env.USER || env.LOGNAME || '';
  if (user) {
    addChildren(`/run/media/${user}`);
    addChildren(`/media/${user}`);
  }
  addChildren('/media');
  addChildren('/mnt');
  return roots;
}
