import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const RESET_CLEANUP_WORKER = fileURLToPath(new URL('./resetCleanupWorker.js', import.meta.url));
const LEGACY_DB_FILES = ['library.db', 'library.db-shm', 'library.db-wal'];

/**
 * Paths a reset has to remove: the user-data, cache and log directories, plus
 * the legacy database files that older builds kept in the working directory.
 * Duplicates and empty entries are dropped.
 * @param {object} [paths]
 * @param {string} [paths.userDataPath]
 * @param {string} [paths.cachePath]
 * @param {string} [paths.logsPath]
 * @param {string} [paths.cwd] where the legacy database files are looked for
 * @returns {string[]} absolute paths, deduplicated
 */
export function getResetCleanupTargets({
  userDataPath,
  cachePath,
  logsPath,
  cwd = process.cwd(),
} = {}) {
  const targets = [userDataPath, cachePath, logsPath];

  for (const fileName of LEGACY_DB_FILES) {
    targets.push(path.join(cwd, fileName));
  }

  const seen = new Set();
  return targets.filter((target) => {
    if (!target) return false;
    const resolved = path.resolve(target);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

/**
 * Spawn the detached cleanup worker that waits for this process to exit and then
 * deletes the targets, and unref it so it never keeps the app alive.
 * @param {object} opts
 * @param {number} opts.parentPid pid the worker waits for
 * @param {string[]} opts.targets paths to delete
 * @param {function} [opts.spawnImpl] spawn implementation, injectable for tests
 * @param {string} [opts.execPath] node/electron binary to run the worker with
 * @param {string} [opts.scriptPath] worker script
 * @returns {object} the child process handle
 */
export function startResetCleanup({
  parentPid,
  targets,
  spawnImpl = spawn,
  execPath = process.execPath,
  env = process.env,
  scriptPath = RESET_CLEANUP_WORKER,
} = {}) {
  const child = spawnImpl(execPath, [scriptPath, String(parentPid), JSON.stringify(targets)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  child.unref();
  return child;
}
