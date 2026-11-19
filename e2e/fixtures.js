import { _electron as electron } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CLI_FLAGS } from '../src/main/cliFlags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, '..');

/** Total size of /dev/shm, or null on a platform that has no such mount. */
function shmTotalBytes() {
  try {
    const { bsize, blocks } = fs.statfsSync('/dev/shm');
    return bsize * blocks;
  } catch {
    return null;
  }
}

/**
 * Switches the launcher has to pass, and only where they are actually needed.
 *
 * --no-sandbox: Chromium refuses to start its sandbox as root, which is how the
 * act container runs. A normal user session has a working sandbox, so it is not
 * weakened there.
 *
 * --disable-dev-shm-usage: Docker mounts /dev/shm at 64 MB by default, too small
 * for Chromium's shared frame buffers. GitHub runners give it roughly half the
 * RAM, so the switch is only added when the mount really is that small.
 *
 * The Ozone transport is deliberately absent. Chromium picks the platform before
 * the main script runs, so the command line is the only place it could be forced,
 * and CI has no Wayland display to pick anyway; `launchProfile.js` records the
 * same conclusion. A Wayland host that needs it gets
 * ELECTRON_OZONE_PLATFORM_HINT from the launcher instead.
 */
function launchSwitches() {
  const switches = [];
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    switches.push('--no-sandbox');
  }
  const shm = shmTotalBytes();
  if (shm !== null && shm < 256 * 1024 * 1024) {
    switches.push('--disable-dev-shm-usage');
  }
  console.log(
    `[launch] chromium switches: ${switches.length ? switches.join(' ') : '(none)'}` +
      ` (uid=${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}` +
      `, /dev/shm=${shm === null ? 'absent' : `${Math.round(shm / 1048576)} MB`})`
  );
  return switches;
}

/**
 * Launch the Electron app against the pre-built renderer.
 * Requires `npm run build-renderer` to have run first.
 * @param {object} [options]
 * @param {object} [options.env] extra environment variables for the app
 * @param {string[]} [options.args] extra command line flags for the app
 */
export async function launchApp({ env: extraEnv = {}, args: extraArgs = [] } = {}) {
  const app = await electron.launch({
    args: [
      ...launchSwitches(),
      CLI_FLAGS.loadBuiltRenderer,
      CLI_FLAGS.noDepsBootstrap,
      CLI_FLAGS.noFallbackRelaunch,
      ...extraArgs,
      appRoot,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: ':memory:',
      ...extraEnv,
    },
  });

  const electronProcess = app.process();
  for (const stream of [electronProcess.stdout, electronProcess.stderr]) {
    stream?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) console.log(`[app] ${line.trim()}`);
      }
    });
  }

  const window = await app.firstWindow();

  await app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) win.setBounds({ width: 1440, height: 900 });
  });

  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
