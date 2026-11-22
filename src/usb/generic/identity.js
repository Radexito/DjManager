import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Who a medium is, independent of where it is mounted.
 *
 * A device is identified by its volume serial, not by a drive letter or a
 * mount point: the same stick gets `D:` on one machine and `/run/media/x/STICK`
 * on another, and a replug can move it. When the filesystem carries no serial
 * (common on FAT sticks written by a player), a marker file on the medium is
 * created once and used instead.
 *
 * `deviceKey` is the value the application stores. It never contains a path.
 */

const MARKER_FILE = 'device.json';

/** Trim a serial and reject the placeholders these tools print instead. */
export function cleanSerial(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^(none|unknown|n\/a|0{4,}|0x0+)$/i.test(text)) return null;
  return text.toUpperCase();
}

/** Absolute path of the marker file. */
export function markerPath(usbRoot) {
  return path.join(usbRoot, '.djmanager', MARKER_FILE);
}

/** The marker record, or null when there is none or it is unreadable. */
export function readMarker(usbRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(markerPath(usbRoot), 'utf8'));
    return data && typeof data.id === 'string' && data.id ? data : null;
  } catch {
    return null;
  }
}

/** Create the marker on a medium that has no serial. Idempotent. */
export function ensureMarker(usbRoot, { now = Date.now } = {}) {
  const existing = readMarker(usbRoot);
  if (existing) return existing;
  const record = { id: crypto.randomUUID(), createdAt: now() };
  try {
    fs.mkdirSync(path.dirname(markerPath(usbRoot)), { recursive: true });
    fs.writeFileSync(markerPath(usbRoot), JSON.stringify(record), 'utf8');
    return record;
  } catch {
    return null;
  }
}

/** The stored identity: serial first, marker second, nothing third. */
export function deviceKey({ serial, markerId } = {}) {
  const clean = cleanSerial(serial);
  if (clean) return `serial:${clean}`;
  if (markerId) return `marker:${markerId}`;
  return null;
}

function flattenLsblk(nodes, out = []) {
  for (const node of nodes ?? []) {
    if (!node || typeof node !== 'object') continue;
    out.push(node);
    if (Array.isArray(node.children)) flattenLsblk(node.children, out);
  }
  return out;
}

const normaliseMount = (value) =>
  path
    .resolve(String(value))
    .replace(/[\\/]+$/, '')
    .toLowerCase();

/** Serial, label and filesystem as the platform reports them for this mount. */
async function platformIdentity(platform, mountPath, exec) {
  if (platform === 'win32') {
    const drive = path.parse(mountPath).root.replace(/[\\/]+$/, '');
    const command = [
      '$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'',
      drive,
      '\'"; $d | Select-Object VolumeSerialNumber,VolumeName,FileSystem | ConvertTo-Json -Compress',
    ].join('');
    const { stdout } = await exec('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ]);
    const data = JSON.parse(stdout);
    return {
      serial: data?.VolumeSerialNumber ?? null,
      label: data?.VolumeName ?? null,
      filesystem: data?.FileSystem ?? null,
    };
  }

  if (platform === 'darwin') {
    const { stdout } = await exec('diskutil', ['info', mountPath]);
    const pick = (pattern) => stdout.match(pattern)?.[1]?.trim() ?? null;
    return {
      serial: pick(/Volume UUID:\s*(.+)/),
      label: pick(/Volume Name:\s*(.+)/),
      filesystem: pick(/File System Personality:\s*(.+)/),
    };
  }

  const { stdout } = await exec('lsblk', ['-J', '-o', 'MOUNTPOINT,SERIAL,LABEL,FSTYPE']);
  const devices = flattenLsblk(JSON.parse(stdout)?.blockdevices);
  const match = devices.find(
    (device) =>
      device?.mountpoint && normaliseMount(device.mountpoint) === normaliseMount(mountPath)
  );
  return match
    ? { serial: match.serial ?? null, label: match.label ?? null, filesystem: match.fstype ?? null }
    : null;
}

/**
 * Resolve the identity of a mounted medium.
 *
 * @param {string} usbRoot mount point
 * @param {object} [options]
 * @param {string} [options.platform] process.platform
 * @param {function(string, string[]): Promise<{stdout: string}>} [options.exec]
 * @param {function(): number} [options.now]
 * @param {boolean} [options.createMarker] false for read-only callers: a poll
 *   must not write to a medium just to learn its identity
 * @returns {Promise<{key: string|null, serial: string|null, label: string|null,
 *   filesystem: string|null, markerId: string|null, mountPath: string,
 *   source: 'serial'|'marker'|'none'}>}
 */
export async function readDeviceIdentity(
  usbRoot,
  {
    platform = process.platform,
    exec = promisify(execFile),
    now = Date.now,
    createMarker = true,
  } = {}
) {
  const mountPath = path.resolve(usbRoot);
  let info = null;
  try {
    info = await platformIdentity(platform, mountPath, exec);
  } catch {
    info = null;
  }

  const serial = cleanSerial(info?.serial);
  const marker = serial
    ? null
    : createMarker
      ? ensureMarker(usbRoot, { now })
      : readMarker(usbRoot);
  const key = deviceKey({ serial, markerId: marker?.id });
  return {
    key,
    serial,
    label: info?.label ?? (path.basename(mountPath) || null),
    filesystem: info?.filesystem ?? null,
    markerId: marker?.id ?? null,
    mountPath,
    source: serial ? 'serial' : marker?.id ? 'marker' : 'none',
  };
}
