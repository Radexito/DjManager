import fs from 'fs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid) {
  while (isProcessRunning(pid)) {
    await sleep(250);
  }
}

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
