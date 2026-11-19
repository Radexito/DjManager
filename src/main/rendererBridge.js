/**
 * The one way a main-process module talks to the renderer (tor B, step 2).
 *
 * Before this file, `src/audio/importManager.js` reached for `global.mainWindow`
 * in eight places. That is a hidden dependency on a global the app happens to
 * set: a caller could not provide it without touching the global namespace, and
 * a second window would silently get none of the events. The window now lives on
 * the runtime object, and this module is the only thing that knows how to send
 * to it.
 *
 * `bindRuntime` is called once, at module load of `src/main.js`. Until then every
 * send is a no-op, which is what the old `if (global.mainWindow)` guards did.
 */

let runtimeRef = null;

/**
 * Point the bridge at the runtime object that holds the main window. Called once
 * when src/main.js loads; before that every send is a no-op.
 * @param {object} runtime object with a `mainWindow` property
 */
export function bindRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('bindRuntime: a runtime object is required');
  }
  runtimeRef = runtime;
}

/**
 * The runtime object this process is bound to, or null before src/main.js loads.
 */
export function getRuntime() {
  return runtimeRef;
}

/** The live window, or null when there is none (yet, or anymore). */
export function getRendererWindow() {
  const win = runtimeRef?.mainWindow;
  if (!win) return null;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return null;
  return win;
}

/** Whether a live renderer window is currently bound. */
export function hasRenderer() {
  return getRendererWindow() !== null;
}

/**
 * Send one event to the renderer. Callers pass the payload shape they always
 * did; a missing window drops the event instead of throwing, because every
 * caller treats progress reporting as best-effort.
 */
export function sendToRenderer(channel, payload) {
  const win = getRendererWindow();
  if (!win) return false;
  win.webContents.send(channel, payload);
  return true;
}
