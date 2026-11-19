import fs from 'fs';

/** Promise that resolves after ms milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a process is still alive, tested with signal 0. EPERM still means it
 * exists, only ESRCH means it is gone.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * Poll every 250 ms until the process is gone — the app has to release its files
 * before they can be deleted.
 * @param {number} pid
 * @returns {Promise<void>}
 */
async function waitForProcessExit(pid) {
  while (isProcessRunning(pid)) {
    await sleep(250);
  }
}

/**
 * Delete a file or directory, retrying up to 20 times at 250 ms intervals:
 * Windows keeps a handle open for a moment after the process exits.
 * @param {string} target
 */
async function removeWithRetries(target) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await sleep(250);
    }
  }
}

/**
 * Worker entry point: read the parent pid and targets from argv, wait for the
 * parent to exit and delete each target in turn.
 * @returns {Promise<void>}
 */
async function main() {
  const parentPid = Number(process.argv[2]);
  const targets = JSON.parse(process.argv[3] ?? '[]');

  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error(`Invalid parent pid: ${process.argv[2]}`);
  }

  if (!Array.isArray(targets)) {
    throw new Error('Reset cleanup targets must be an array');
  }

  await waitForProcessExit(parentPid);

  for (const target of targets) {
    await removeWithRetries(target);
  }
}

await main();
