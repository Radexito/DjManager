/**
 * Launch profile: the single place that decides how Chromium starts.
 *
 * Why a pure function: `app.disableHardwareAcceleration()` and every Chromium
 * switch only take effect if they are set in the main script BEFORE the `ready`
 * event, so this decision happens at module load. Keeping the decision free of
 * Electron and of the filesystem means the whole platform x mode matrix can be
 * exercised without booting the app.
 *
 * Modes (user-facing, stored in graphics.json):
 *   auto      hardware acceleration on, Chromium's own defaults
 *   enabled   same as auto, but a future automatic fallback must be ignored
 *   disabled  hardware acceleration off plus the Linux stability switches
 */

import { CLI_FLAGS } from '../cliFlags.js';

export const GRAPHICS_MODES = Object.freeze(['auto', 'enabled', 'disabled']);

/**
 * Switches the Linux build used to apply unconditionally. They keep the GPU
 * process out of the picture entirely and work around the pidfd/sandbox
 * failures documented in main.js; they belong to the "acceleration off"
 * profiles only, otherwise "enabled" would be a fiction.
 *
 * No `no-zygote` here. Measured 2026-11-04 in a root container (the act runner
 * runs as root, like a Docker image): the renderer dies with exit code 133 and
 * `FATAL: Running as root without --no-sandbox is not supported`, even though
 * --no-sandbox is on the command line, because the no-zygote launch path does
 * not carry that switch to the child. Drop it and the same launch is clean.
 */
export const LINUX_GPU_SAFE_SWITCHES = Object.freeze([
  'disable-gpu',
  'disable-gpu-sandbox',
  'no-sandbox',
]);

/**
 * Measured 2026-11-02 on KDE Wayland + Radeon 680M (radeonsi/Mesa), Electron
 * 44.5.1: with GPU compositing on, the window never presents a single frame —
 * the DOM is fully rendered (2095 chars of sidebar text, WebGL reports
 * "WebGL 1.0"), but `Page.captureScreenshot` times out and the user sees a
 * black window. Same build with acceleration off paints normally, and with
 * acceleration on under X11 it also paints. So the failure is Ozone/Wayland GPU
 * compositing, not the app: keep the GPU for raster/canvas/WebGL and composite
 * in software until Electron/Mesa fix the presentation path.
 */
export const LINUX_COMPOSITING_SWITCHES = Object.freeze(['disable-gpu-compositing']);

/** Coerce an unknown mode to one of GRAPHICS_MODES, falling back to "auto". */
export function normalizeGraphicsMode(value) {
  return GRAPHICS_MODES.includes(value) ? value : 'auto';
}

/** Manual escape hatch for an install that cannot start with the GPU alive. */
export function isGpuSafeRequested({ env = {}, cliArgs = [] } = {}) {
  return String(env.DJMAN_GPU_SAFE ?? '') === '1' || cliArgs.includes('--gpu-safe');
}

/**
 * Whether a GPU crash may switch the app to the fallback profile by itself.
 * Disabled when the operator passed --no-fallback-relaunch.
 */
export function shouldAllowAutomaticFallback({ cliArgs = [] } = {}) {
  return !cliArgs.includes(CLI_FLAGS.noFallbackRelaunch);
}

/**
 * @param {object} input
 * @param {string} input.platform        process.platform
 * @param {object} [input.env]           process.env
 * @param {object} [input.config]        result of readGraphicsConfig()
 * @param {string[]} [input.cliArgs]     process.argv.slice(1)
 */
export function resolveLaunchProfile({ platform, env = {}, config = {}, cliArgs = [] } = {}) {
  const mode = normalizeGraphicsMode(config?.mode);
  const isLinux = platform === 'linux';
  const gpuSafe = isGpuSafeRequested({ env, cliArgs });
  const fallbackActive = config?.fallback?.active === true;
  const accelerationDisabled =
    mode === 'disabled' || gpuSafe || (mode === 'auto' && fallbackActive);

  const switches = [];
  if (accelerationDisabled) {
    if (isLinux) {
      for (const name of LINUX_GPU_SAFE_SWITCHES) switches.push({ name });
      for (const name of LINUX_COMPOSITING_SWITCHES) switches.push({ name });
    }
  } else if (isLinux) {
    for (const name of LINUX_COMPOSITING_SWITCHES) switches.push({ name });
  }

  return {
    mode,
    gpuSafe,
    hardwareAcceleration: !accelerationDisabled,
    switches,
    allowAutomaticFallback: shouldAllowAutomaticFallback({ env, cliArgs }),
  };
}
