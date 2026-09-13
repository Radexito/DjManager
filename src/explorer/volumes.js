import fs from 'node:fs';
import path from 'node:path';

/**
 * Volume listing for the Explorer's drive pane.
 *
 * Windows hands out drive letters, Linux hands out mount points, and neither
 * list is static: a stick plugged in while the app runs must appear, and one
 * that is unplugged must disappear. Both platforms are normalised into the same
 * shape here so the renderer has one list to render and one signature to watch:
 *
 *   { id, root, label, fileSystemType, removable, system, device, totalBytes }
 *
 * `id` is stable across a remount (filesystem type + label + size on Linux, the
 * root itself on Windows), so the watcher can tell "the same stick came back"
 * apart from "a different stick arrived", and linked-track identity can follow
 * a volume instead of a path.
 *
 * Plain string and fs work on purpose: no Electron imports, and every fs call is
 * injectable, so this is unit testable without touching the real filesystem.
 */

/**
 * Filesystem types that carry no browsable volume identity: kernel pseudo
 * filesystems, container overlays and snap/squashfs images. Kept in sync with
 * the filtering in `volumeIdentity.js` on the hot-swap branch (#514).
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
  'fuse.gvfsd-fuse',
  'fuse.portal',
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
  'swap',
  'sysfs',
  'tmpfs',
  'tracefs',
]);

/**
 * Mount points that mean "something removable was mounted for this user".
 * udisks2 uses /run/media/<user>/<label>, older distros and manual mounts use
 * /media/<label> and /run/mount/<user>/<label>.
 */
const REMOVABLE_MOUNT_PREFIXES = ['/run/media/', '/media/', '/run/mount/'];

/** /proc/mounts escapes spaces, tabs and backslashes as octal. */
const MOUNT_FIELD_ESCAPES = { '011': '\t', '012': '\n', '040': ' ', 134: '\\' };

/** Decodes the octal escapes /proc/mounts uses in device and mount point. */
export function decodeMountField(field) {
  return String(field ?? '').replace(
    /\\([0-7]{3})/g,
    (match, octal) => MOUNT_FIELD_ESCAPES[octal] ?? match
  );
}

/**
 * Parses the contents of /proc/mounts (or an /etc/mtab copy) into plain entries.
 *
 * @returns {Array<{device: string, mountPoint: string, fileSystemType: string}>}
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

/** True for a mount point whose contents belong to a removable device. */
export function isRemovableMount(mountPoint, device = '') {
  const root = String(mountPoint ?? '');
  if (REMOVABLE_MOUNT_PREFIXES.some((prefix) => root.startsWith(prefix))) return true;
  // A whole disk with no partition table (bare card reader, some sticks) is
  // mounted straight from /dev/sdX or /dev/mmcblkX by udisks.
  return /^\/dev\/(?:sd[a-z]|mmcblk\d+)$/.test(String(device ?? ''));
}

/**
 * Stable id for a Linux volume: filesystem type, label (the mount point
 * basename, which udev takes from the stick itself) and total size. The same
 * stick keeps its id when it is remounted somewhere else. Two identical sticks
 * mounted at once are indistinguishable, a documented limitation, not a crash.
 */
export function makeLinuxVolumeId({ fileSystemType, label, totalBytes } = {}) {
  const type = String(fileSystemType ?? 'unknown').toLowerCase();
  const size = Number(totalBytes) > 0 ? Number(totalBytes) : 0;
  return `linux:${type}:${String(label ?? '')}:${size}`;
}

/** Stable id for a Windows volume. Without a serial the letter is all we have. */
export function makeWindowsVolumeId({ root } = {}) {
  return `win32:root:${String(root ?? '').toUpperCase()}`;
}

/** Total size in bytes of a mount point, or 0 when it cannot be read. */
function readTotalBytes(statfsSync, root) {
  if (typeof statfsSync !== 'function') return 0;
  try {
    const stat = statfsSync(root);
    const blocks = Number(stat?.blocks);
    const blockSize = Number(stat?.bsize);
    if (!Number.isFinite(blocks) || !Number.isFinite(blockSize)) return 0;
    const total = blocks * blockSize;
    return Number.isFinite(total) && total > 0 ? total : 0;
  } catch {
    return 0;
  }
}

/**
 * Mounted filesystems on Linux, newest listing first seen wins for a path that
 * is mounted twice.
 *
 * @param {{platform?: string, readFileSync?: Function, statSync?: Function,
 *          statfsSync?: Function, procMountsPath?: string}} [opts] injectable for tests
 * @returns {Array<{id: string, root: string, label: string, fileSystemType: string,
 *   removable: boolean, system: boolean, device: string, totalBytes: number}>}
 */
export function detectLinuxVolumes({
  platform = process.platform,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
  statfsSync = fs.statfsSync,
  procMountsPath = '/proc/mounts',
} = {}) {
  if (platform !== 'linux') return [];

  let text = '';
  try {
    text = readFileSync(procMountsPath, 'utf8');
  } catch {
    return [];
  }

  const volumes = [];
  const seen = new Set();
  for (const entry of parseProcMounts(text)) {
    const root = entry.mountPoint;
    if (!root || root[0] !== '/') continue;
    if (seen.has(root)) continue;
    if (VIRTUAL_FS_TYPES.has(String(entry.fileSystemType ?? '').toLowerCase())) continue;

    // Only mounts that are actually there right now: a stale /proc entry or a
    // disconnected network share would otherwise sit in the pane and fail on click.
    try {
      if (typeof statSync === 'function' && !statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }

    seen.add(root);
    const system = root === '/';
    const label = path.basename(root) || root;
    const removable = isRemovableMount(root, entry.device);
    const totalBytes = readTotalBytes(statfsSync, root);

    volumes.push({
      id: system
        ? 'linux:system'
        : makeLinuxVolumeId({ fileSystemType: entry.fileSystemType, label, totalBytes }),
      root,
      label,
      fileSystemType: entry.fileSystemType,
      removable,
      system,
      device: entry.device,
      totalBytes,
    });
  }
  return volumes;
}

/**
 * Windows drive roots as volume objects, so both platforms hand the renderer
 * the same shape. `systemRoot` marks the drive the app runs from.
 */
export function detectWindowsVolumes({
  platform = process.platform,
  existsSync = fs.existsSync,
  systemRoot = null,
} = {}) {
  if (platform !== 'win32') return [];
  const volumes = [];
  for (let i = 0; i < 26; i++) {
    const root = `${String.fromCharCode(65 + i)}:\\`;
    try {
      if (!existsSync(root)) continue;
    } catch {
      continue; // present but inaccessible: card reader, disconnected share
    }
    volumes.push({
      id: makeWindowsVolumeId({ root }),
      root,
      label: root.replace(/[\\/]+$/, ''),
      fileSystemType: null,
      removable: false,
      system: systemRoot != null && root.toUpperCase() === String(systemRoot).toUpperCase(),
      device: null,
      totalBytes: 0,
    });
  }
  return volumes;
}

/**
 * Volume list for the current platform, plus the Windows drive roots the
 * Explorer's drive picker has always used.
 *
 * @returns {{drives: string[], volumes: object[], root: string|null}}
 */
export function scanVolumes({ platform = process.platform, homeDir, ...opts } = {}) {
  if (platform === 'win32') {
    const systemRoot = homeDir ? path.parse(homeDir).root || 'C:\\' : null;
    const volumes = detectWindowsVolumes({ platform, systemRoot, ...opts });
    const drives = volumes.map((volume) => volume.root);
    if (systemRoot && !drives.includes(systemRoot)) drives.unshift(systemRoot);
    return { drives, volumes, root: systemRoot };
  }
  return { drives: [], volumes: detectLinuxVolumes({ platform, ...opts }), root: '/' };
}

/**
 * Signature of a volume list, used by the watcher to spot a change: it covers
 * what a user notices (a volume appearing, disappearing or coming back under a
 * different mount point) while ignoring anything that only changes in place.
 */
export function volumeSignature(volumes = []) {
  return volumes
    .map((volume) => `${volume?.id ?? ''}@${volume?.root ?? ''}`)
    .sort()
    .join('|');
}
