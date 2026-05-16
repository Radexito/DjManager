import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const RESET_CLEANUP_WORKER = fileURLToPath(new URL('./resetCleanupWorker.js', import.meta.url));
const LEGACY_DB_FILES = ['library.db', 'library.db-shm', 'library.db-wal'];

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
