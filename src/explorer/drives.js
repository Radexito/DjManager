import fs from 'node:fs';
import path from 'node:path';
import {
  VIRTUAL_FS_TYPES,
  makeLinuxVolumeId,
  makeWindowsVolumeId,
  parseProcMounts,
} from './volumeIdentity.js';

/**
 * Enumerate present Windows drive roots ("C:\", "D:\", ...) without spawning
 * a shell — 26 stat calls, no admin rights needed. Drives that exist but are
 * inaccessible (empty card readers, disconnected network drives) are skipped.
 *
 * @param {{platform?: string, existsSync?: (p: string) => boolean}} [opts]
 *   injectable for tests
 * @returns {string[]} drive roots, e.g. ['C:\\', 'D:\\']
 */
export function detectWindowsDrives({
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return [];
  const roots = [];
  for (let i = 0; i < 26; i++) {
    const root = `${String.fromCharCode(65 + i)}:\\`;
    try {
      if (existsSync(root)) roots.push(root);
    } catch {
      // drive present but not accessible — skip it
    }
  }
  return roots;
}

/**
 * Reads the volume serial number of a Windows drive root. Node reports it as
 * `dev` on Windows (`ino` is the file index), and it stays the same when the
 * letter changes — exactly the identity we need for hot-swap (#514).
 */
function readWindowsVolumeSerial(root, statSync) {
  try {
    const stats = statSync(root);
    const serial = Number(stats?.dev);
    return Number.isFinite(serial) && serial > 0 ? serial : null;
  } catch {
    return null;
  }
}

/**
 * Windows volumes with a stable id: `[{ id, root, label, platform }]`.
 * Falls back to a letter-based id when the drive cannot be stat'ed, so the
 * drive still shows up (it just cannot be followed across a letter change).
 */
export function detectWindowsVolumes({
  platform = process.platform,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
} = {}) {
  if (platform !== 'win32') return [];
  return detectWindowsDrives({ platform, existsSync }).map((root) => ({
    id: makeWindowsVolumeId({ root, serial: readWindowsVolumeSerial(root, statSync) }),
    root,
    label: root.replace(/[\\/]+$/, ''),
    platform,
  }));
}

/**
 * Linux volumes with a stable id: `[{ id, root, label, platform }]`.
 * Mounts are read from /proc/mounts (no blkid / no shell) and pseudo
 * filesystems are filtered out via `VIRTUAL_FS_TYPES`.
 *
 * @param {{mountsText?: string, readMounts?: () => string, statfsSync?: Function}} [opts]
 */
export function detectLinuxVolumes({
  mountsText,
  readMounts = () => fs.readFileSync('/proc/mounts', 'utf8'),
  statfsSync = fs.statfsSync,
} = {}) {
  let text = mountsText;
  if (text === undefined) {
    try {
      text = readMounts();
    } catch {
      // No /proc/mounts (non-Linux kernel or restricted sandbox) — no volumes.
      return [];
    }
  }

  const volumes = [];
  const seen = new Set();
  for (const entry of parseProcMounts(text)) {
    if (VIRTUAL_FS_TYPES.has(entry.fileSystemType)) continue;
    if (!entry.mountPoint.startsWith('/')) continue;

    let totalBytes = 0;
    try {
      const stats = statfsSync(entry.mountPoint);
      totalBytes = Number(stats?.bsize) * Number(stats?.blocks);
    } catch {
      // Unreadable mount (permissions, stale entry) — size stays 0.
    }

    const id = makeLinuxVolumeId({
      fileSystemType: entry.fileSystemType,
      label: path.basename(entry.mountPoint),
      totalBytes,
    });
    if (seen.has(id)) continue;
    seen.add(id);

    volumes.push({
      id,
      root: entry.mountPoint,
      label: entry.device || entry.mountPoint,
      device: entry.device,
      fileSystemType: entry.fileSystemType,
      platform: 'linux',
    });
  }
  return volumes;
}

/**
 * Every volume we can identify on this platform, as `[{ id, root, label, ... }]`.
 * Unknown platforms return an empty list — callers must keep working without it.
 */
export function detectVolumes(opts = {}) {
  const { platform = process.platform, ...rest } = opts;
  if (platform === 'win32') return detectWindowsVolumes({ platform, ...rest });
  if (platform === 'linux') return detectLinuxVolumes(rest);
  return [];
}
