import fs from 'node:fs';
import path from 'node:path';

import { isPioneerUsb } from '../pioneer/detect.js';
import { candidateRoots } from './roots.js';

/**
 * Watching for a medium that appears and disappears.
 *
 * A stick is mounted and unmounted while the application runs, and the sidebar
 * has to follow that without a manual refresh. Polling the watch roots is enough
 * and costs almost nothing: the listing is one directory read per root, and the
 * "is this ours" test is a single existence check for the PIONEER folder.
 *
 * The pure parts live here so they can be tested without Electron and without a
 * real stick: which roots to watch, what sits under them, and when a scan
 * differs from the previous one.
 */

/**
 * Mount points to watch: the configured list when there is one, the platform
 * defaults otherwise.
 * @param {object} [options]
 * @param {string[]|string} [options.configured] user-configured roots
 * @returns {string[]}
 */
export function watchRoots({ configured = [], ...candidateOptions } = {}) {
  const list = (Array.isArray(configured) ? configured : [configured])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  return list.length > 0 ? list : candidateRoots(candidateOptions);
}

/**
 * Media sitting directly under the watch roots.
 *
 * A directory counts when `recognise` accepts it, which by default means it
 * carries the PIONEER folder: a stick rekordbox prepared counts too, a plain
 * external disk does not.
 * @param {object} [options]
 * @param {string[]} [options.roots] directories to list
 * @param {Function} [options.readdir]
 * @param {Function} [options.exists]
 * @param {Function} [options.recognise] (mount, {exists}) => boolean
 * @returns {Array<{mount: string, name: string}>}
 */
export function scanMedia({
  roots = [],
  readdir = fs.readdirSync,
  exists = fs.existsSync,
  recognise = isPioneerUsb,
} = {}) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    // On Windows a watch root is the medium itself (a drive letter), on Linux and
    // macOS it is the folder media mount under. Both are handled: the root is
    // tested first, then its children.
    try {
      if (recognise(root, { exists })) {
        // Drive letters end with a separator and have no basename on posix, so the
        // last segment is taken by hand rather than with path.basename.
        const name =
          String(root)
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .pop() || String(root);
        if (!seen.has(root)) {
          seen.add(root);
          found.push({ mount: root, name: name || root });
        }
      }
    } catch {
      // A root that cannot be tested is not a medium by itself.
    }
    let entries = [];
    try {
      entries = readdir(root, { withFileTypes: true });
    } catch {
      // A watch root that is not there (or is not readable) simply has no media.
      continue;
    }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!name) continue;
      const isDirectory = typeof entry === 'string' ? true : entry.isDirectory();
      if (!isDirectory) continue;
      const mount = path.join(root, name);
      if (mount === root || seen.has(mount)) continue;
      let ours = false;
      try {
        ours = Boolean(recognise(mount, { exists }));
      } catch {
        ours = false;
      }
      if (!ours) continue;
      seen.add(mount);
      found.push({ mount, name });
    }
  }
  found.sort((a, b) => a.mount.localeCompare(b.mount));
  return found;
}

/** One line per mount point, used to decide whether a scan changed anything. */
export function mediaSignature(devices = []) {
  return devices.map((device) => device.mount).join('\n');
}

/**
 * Poll the watch roots and report when the set of media changes.
 *
 * The first check always reports, even when the answer is "nothing mounted", so
 * the caller starts from a known state instead of guessing.
 * @param {object} [options]
 * @param {string[]} [options.roots]
 * @param {number} [options.intervalMs]
 * @param {Function} [options.scan] () => devices
 * @param {Function} [options.onChange] (devices) => void
 * @param {Function} [options.setIntervalImpl]
 * @param {Function} [options.clearIntervalImpl]
 * @returns {{start: Function, stop: Function, check: Function, devices: Function, isRunning: Function}}
 */
export function createMediaWatcher({
  roots = [],
  intervalMs = 4000,
  scan = () => scanMedia({ roots }),
  onChange = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let timer = null;
  let devices = [];
  let lastSignature = null;

  function check() {
    const next = scan();
    const signature = mediaSignature(next);
    if (lastSignature === signature) return next;
    lastSignature = signature;
    devices = next;
    onChange(next);
    return next;
  }

  return {
    start() {
      if (timer) return;
      check();
      timer = setIntervalImpl(check, intervalMs);
      // A watcher must never keep the process alive on its own.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      clearIntervalImpl(timer);
      timer = null;
    },
    check,
    devices: () => devices,
    isRunning: () => timer !== null,
  };
}
