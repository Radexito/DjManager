import { createMediaWatcher, scanMedia, watchRoots } from '../usb/generic/watch.js';

/**
 * The USB half of the sidebar: notice when a medium appears or disappears and
 * tell the renderer.
 *
 * Both knobs are settings, so a user whose sticks mount somewhere unusual can
 * point the watcher at the right folders without a rebuild:
 *
 * - `usb_watch_enabled` (`1` by default): the whole feature can be turned off.
 * - `usb_watch_roots`: a JSON array of directories, or a comma separated list.
 *   Empty means "the platform defaults", which are the folders the operating
 *   system is known to mount removable media under.
 *
 * The service owns one watcher and one list of devices. Starting it twice is a
 * no-op, and a settings change is picked up by the next scan because the roots
 * are resolved inside the scan rather than captured at start.
 */

export const USB_WATCH_ENABLED_SETTING = 'usb_watch_enabled';
export const USB_WATCH_ROOTS_SETTING = 'usb_watch_roots';
export const USB_DEVICES_EVENT = 'usb-devices-changed';
export const DEFAULT_USB_WATCH_INTERVAL_MS = 4000;

/**
 * Read the configured roots out of a setting value.
 *
 * Accepts what a settings field is likely to hold: a JSON array, or a list
 * separated by commas, semicolons or newlines.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseWatchRoots(raw) {
  if (Array.isArray(raw)) return raw.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const text = raw.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry ?? '').trim()).filter(Boolean);
      }
    } catch {
      // Falls through to the separator form, which is the friendlier mistake.
    }
  }
  return text
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * @param {object} deps
 * @param {Function} deps.getSetting (key, fallback) => unknown
 * @param {Function} [deps.send] (channel, payload) => void
 * @param {number} [deps.intervalMs]
 * @param {Function} [deps.scanMediaImpl] injectable scan, for tests
 * @param {Function} [deps.createWatcher] injectable watcher, for tests
 * @returns {object}
 */
export function createUsbWatchService({
  getSetting,
  send = () => {},
  intervalMs = DEFAULT_USB_WATCH_INTERVAL_MS,
  scanMediaImpl = scanMedia,
  createWatcher = createMediaWatcher,
} = {}) {
  let watcher = null;
  let devices = [];

  const isEnabled = () => String(getSetting(USB_WATCH_ENABLED_SETTING, '1')) !== '0';
  const roots = () =>
    watchRoots({ configured: parseWatchRoots(getSetting(USB_WATCH_ROOTS_SETTING, '')) });
  const scan = () => scanMediaImpl({ roots: roots() });

  function publish(list) {
    devices = list;
    send(USB_DEVICES_EVENT, list);
  }

  function ensureWatcher() {
    if (!watcher) {
      watcher = createWatcher({
        intervalMs,
        scan,
        onChange: publish,
      });
    }
    return watcher;
  }

  function start() {
    if (!isEnabled()) {
      stop();
      publish([]);
      return devices;
    }
    ensureWatcher().start();
    return devices;
  }

  function stop() {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
  }

  function restart() {
    stop();
    return start();
  }

  /** Scan now, which is what a settings change or a manual refresh needs. */
  function refresh() {
    if (!isEnabled()) {
      stop();
      publish([]);
      return devices;
    }
    return ensureWatcher().check();
  }

  return {
    start,
    stop,
    restart,
    refresh,
    devices: () => devices,
    roots,
    isEnabled,
  };
}
