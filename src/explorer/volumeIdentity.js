/**
 * Pure helpers for stable volume identity and drive-list diffing (#514).
 *
 * Windows hands out drive letters dynamically, so a USB stick that is unplugged
 * and plugged back in (or plugged in after another stick) can come back under a
 * different letter. Anything that remembers a path by letter goes stale: the
 * Explorer shows a dead folder, linked tracks grey out and an export writes to
 * whatever device now owns the old letter.
 *
 * Volumes are keyed here by a stable id instead, and paths are translated
 * between the previous and the current root on demand.
 *
 * Plain string logic on purpose: no Node or Electron imports, so it is unit
 * testable without touching the filesystem and safe to import anywhere.
 */

/**
 * Filesystem types that carry no removable-volume identity: kernel pseudo
 * filesystems, container overlays and snap/squashfs images. Kept in sync with
 * the filtering in `detectLinuxVolumes()`.
 */
export const VIRTUAL_FS_TYPES = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'overlay',
  'proc',
  'pstore',
  'ramfs',
  'rpc_pipefs',
  'securityfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs',
]);

const MOUNT_FIELD_ESCAPES = { '011': '\t', '012': '\n', '040': ' ', 134: '\\' };

/** Decodes the octal escapes /proc/mounts uses for spaces, tabs and backslashes. */
export function decodeMountField(field) {
  return String(field ?? '').replace(
    /\\([0-7]{3})/g,
    (match, octal) => MOUNT_FIELD_ESCAPES[octal] ?? match
  );
}

/**
 * Parses /proc/mounts (or an /etc/mtab copy) into plain entries.
 * Returns `[{ device, mountPoint, fileSystemType }]`.
 */
export function parseProcMounts(text) {
  const entries = [];
  if (!text) return entries;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    entries.push({
      device: decodeMountField(parts[0]),
      mountPoint: decodeMountField(parts[1]),
      fileSystemType: parts[2],
    });
  }
  return entries;
}

/** True for roots shaped like a Windows drive ("E:", "E:\", "E:/"). */
export function isWindowsDriveRoot(root) {
  return /^[a-zA-Z]:[\\/]?$/.test(String(root ?? ''));
}

/**
 * True when `targetPath` is the root itself or lives below it. Windows roots are
 * compared case-insensitively (and with or without the trailing separator).
 */
export function pathHasRoot(targetPath, root) {
  if (!targetPath || !root) return false;
  const caseInsensitive = isWindowsDriveRoot(root);
  const path = caseInsensitive ? String(targetPath).toLowerCase() : String(targetPath);
  const normalizedRoot = caseInsensitive ? String(root).toLowerCase() : String(root);

  if (path === normalizedRoot) return true;
  if (path === normalizedRoot.replace(/[\\/]+$/, '')) return true;

  const prefix =
    normalizedRoot.endsWith('/') || normalizedRoot.endsWith('\\')
      ? normalizedRoot
      : `${normalizedRoot}${caseInsensitive ? '\\' : '/'}`;
  return path.startsWith(prefix);
}

/**
 * Finds the volume whose root contains `targetPath`. The longest matching root
 * wins, so a USB mount point beats the filesystem root on Linux.
 */
export function findVolumeForPath(targetPath, volumes = []) {
  if (!targetPath) return null;
  let best = null;
  for (const volume of volumes) {
    if (!volume || !volume.root) continue;
    if (!pathHasRoot(targetPath, volume.root)) continue;
    if (!best || String(volume.root).length > String(best.root).length) best = volume;
  }
  return best;
}

function reRootPath(targetPath, fromRoot, toRoot) {
  if (fromRoot === toRoot) return targetPath;
  return String(toRoot) + String(targetPath).slice(String(fromRoot).length);
}

/**
 * Re-resolves a path against the volumes that are present right now.
 *
 * `previousVolumes` describes how the path was picked (for the export flow this
 * is `[{ id: usbVolumeId, root: usbRoot }]`); the matching volume is looked up by
 * stable id so it can be followed to its current root.
 *
 * @returns {{ ok: true, path: string, volumeId: string, root: string, changed: boolean }
 *   | { ok: false, reason: 'no-path' | 'no-volume' | 'volume-missing', volumeId?: string }}
 */
export function resolveVolumePath(
  targetPath,
  currentVolumes = [],
  previousVolumes = currentVolumes
) {
  if (!targetPath) return { ok: false, reason: 'no-path' };

  const previous = findVolumeForPath(targetPath, previousVolumes);
  if (previous) {
    const current = currentVolumes.find((volume) => volume && volume.id === previous.id) ?? null;
    if (!current) {
      // The volume that owned the path is not present any more. Callers must not
      // fall back to the raw path: another device may occupy it by now.
      return { ok: false, reason: 'volume-missing', volumeId: previous.id };
    }
    const path = reRootPath(targetPath, previous.root, current.root);
    return {
      ok: true,
      path,
      volumeId: current.id,
      root: current.root,
      changed: path !== targetPath,
    };
  }

  const match = findVolumeForPath(targetPath, currentVolumes);
  if (!match) return { ok: false, reason: 'no-volume' };
  return { ok: true, path: targetPath, volumeId: match.id, root: match.root, changed: false };
}

/**
 * Decides which directory an export may write to right now (#514).
 *
 * The dialog picks a folder and remembers the volume it lived on; by the time the
 * export starts the drive may have been replugged under another letter. This
 * returns the resolved path, or a refusal with a user-facing message.
 *
 * @param {{usbRoot?: string, usbVolumeId?: string|null, usbVolumeRoot?: string|null}} target
 *   the destination as the renderer remembers it
 * @param {object[]} currentVolumes volumes present right now (`detectVolumes()`)
 * @param {{exists?: (p: string) => boolean}} [opts] existence probe used when the
 *   path cannot be tied to a known volume
 * @returns {{ ok: true, path: string, changed: boolean, volumeId: string|null }
 *   | { ok: false, error: string }}
 */
export function decideExportDestination(
  { usbRoot, usbVolumeId = null, usbVolumeRoot = null } = {},
  currentVolumes = [],
  { exists } = {}
) {
  if (!usbRoot) return { ok: false, error: 'No export destination selected.' };

  // The volume root captured at pick time matters because the stored path can
  // point at a subfolder: re-rooting must start from the volume root, otherwise
  // `E:\Music` would collapse to `D:\` instead of becoming `D:\Music`.
  const previousVolumes = usbVolumeId
    ? [{ id: usbVolumeId, root: usbVolumeRoot || usbRoot }]
    : currentVolumes;
  const resolved = resolveVolumePath(usbRoot, currentVolumes, previousVolumes);

  if (resolved.ok) {
    return {
      ok: true,
      path: resolved.path,
      changed: resolved.changed,
      volumeId: resolved.volumeId ?? null,
    };
  }

  if (resolved.reason === 'volume-missing') {
    // The volume that owned this path is gone. Never fall back to the raw path:
    // another device may already have taken the old letter.
    return {
      ok: false,
      error:
        'Export failed: the drive was disconnected or reconnected under a different letter. ' +
        'Re-select the destination drive and try again.',
    };
  }

  // `no-volume`: the path could not be tied to a volume at all (volume identity
  // is unavailable on this platform, or the folder is a UNC/network share). There
  // is nothing to follow, so keep the plain existence check exports used before.
  if (typeof exists === 'function' && exists(usbRoot)) {
    return { ok: true, path: usbRoot, changed: false, volumeId: null };
  }

  return {
    ok: false,
    error: 'Export failed: the destination drive is not available. Re-connect it and try again.',
  };
}

/**
 * Compares two volume snapshots (matched by stable id).
 *
 * @returns {{
 *   added: object[], removed: object[], unchanged: object[],
 *   letterChanged: { id: string, from: string, to: string, volume: object }[],
 *   changed: boolean
 * }}
 */
export function diffVolumes(previousVolumes = [], nextVolumes = []) {
  const previousById = new Map(previousVolumes.map((volume) => [volume.id, volume]));
  const nextById = new Map(nextVolumes.map((volume) => [volume.id, volume]));

  const added = [];
  const removed = [];
  const unchanged = [];
  const letterChanged = [];

  for (const volume of nextVolumes) {
    if (!previousById.has(volume.id)) added.push(volume);
  }

  for (const previous of previousVolumes) {
    const current = nextById.get(previous.id);
    if (!current) {
      removed.push(previous);
    } else if (current.root !== previous.root) {
      letterChanged.push({
        id: previous.id,
        from: previous.root,
        to: current.root,
        volume: current,
      });
    } else {
      unchanged.push(current);
    }
  }

  return {
    added,
    removed,
    unchanged,
    letterChanged,
    changed: added.length > 0 || removed.length > 0 || letterChanged.length > 0,
  };
}

/**
 * Turns the letter changes reported by `diffVolumes()` into concrete prefixes
 * for re-keying stored linked-track paths (#514).
 *
 * A linked track keeps its absolute path, so when its drive comes back under a
 * different letter every stored row is stale. The prefixes carry a trailing
 * separator so a root like `E:\` cannot swallow `E:\Extra\...` — matching the
 * naked root would corrupt paths that live beside the volume.
 *
 * @param {{from: string, to: string}[]} letterChanged entries from `diffVolumes()`
 * @param {string} [separator] platform path separator (`path.sep`)
 * @returns {{ from: string, to: string, fromPrefix: string, toPrefix: string }[]}
 */
export function planLinkedTrackRekeys(letterChanged = [], separator = '/') {
  const sep = String(separator || '/');
  const endsWithSep = (value) => value.endsWith('/') || value.endsWith('\\');
  const plans = [];
  const seen = new Set();

  for (const change of letterChanged) {
    const from = String(change?.from ?? '');
    const to = String(change?.to ?? '');
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);

    plans.push({
      from,
      to,
      fromPrefix: endsWithSep(from) ? from : from + sep,
      toPrefix: endsWithSep(to) ? to : to + sep,
    });
  }

  return plans;
}

/**
 * Stable id for a Windows volume. The volume serial number survives a letter
 * change; the raw root is only a fallback for volumes we cannot stat (e.g. an
 * inaccessible card reader), which then cannot be followed across a swap.
 */
export function makeWindowsVolumeId({ root, serial } = {}) {
  const value = Number(serial);
  if (serial !== null && serial !== undefined && Number.isFinite(value) && value > 0) {
    return `win32:vol:${value.toString(16)}`;
  }
  return `win32:root:${String(root ?? '').toUpperCase()}`;
}

/**
 * Stable id for a Linux volume. Derived from the filesystem type, the label
 * (mount point basename, which udev usually takes from the stick itself) and the
 * total size, so the same stick keeps its id when it is remounted elsewhere.
 * Two identical sticks mounted at the same time are indistinguishable - a
 * documented limitation, not a crash.
 */
export function makeLinuxVolumeId({ fileSystemType, label, totalBytes } = {}) {
  const type = String(fileSystemType ?? 'unknown').toLowerCase();
  const size = Number(totalBytes) > 0 ? Number(totalBytes) : 0;
  return `linux:${type}:${String(label ?? '')}:${size}`;
}
