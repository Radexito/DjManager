import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const FAT_FILESYSTEMS = new Set(['fat32', 'fat16', 'fat', 'exfat', 'vfat', 'msdos']);

/**
 * Detects the filesystem type and device path for a given mount point.
 * Returns { fs, device, mountPoint, needsFormat } or throws on failure.
 */
export async function detectFilesystem(mountPath) {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      return await detectFilesystemWindows(mountPath);
    } else if (platform === 'darwin') {
      return await detectFilesystemMac(mountPath);
    } else {
      return await detectFilesystemLinux(mountPath);
    }
  } catch {
    return {
      fs: 'unknown',
      device: null,
      mountPoint: mountPath,
      needsFormat: false,
      removable: false,
    };
  }
}

/**
 * Read a drive's filesystem with fsutil and whether it is removable.
 * @param {string} mountPath - drive path, e.g. "E:\"
 * @returns {Promise<{fs: string, device: string|null, mountPoint: string,
 *          needsFormat: boolean, removable: boolean}>}
 */
async function detectFilesystemWindows(mountPath) {
  const drive = mountPath.replace(/[/\\]/g, '').replace(/:$/, '');

  let fsName = 'unknown';
  try {
    const { stdout } = await execAsync(`fsutil fsinfo volumeinfo ${drive}: 2>&1`, {
      windowsHide: true,
    });
    console.log(`[diag] fsutil volumeinfo ${drive}: stdout:\n${stdout.trim()}`);
    const fsMatch = stdout.match(/File System Name\s*:\s*(\S+)/i);
    fsName = fsMatch ? fsMatch[1].toLowerCase() : 'unknown';
  } catch (e) {
    console.log(`[diag] volumeinfo check failed: ${e.message}`);
  }

  try {
    const { stdout: freeOut } = await execAsync(`fsutil volume diskfree ${drive}: 2>&1`, {
      windowsHide: true,
    });
    const totalMatch = freeOut.match(/Total \S+ bytes\s*:\s*([\d,]+)/i);
    if (totalMatch) {
      const totalBytes = parseInt(totalMatch[1].replace(/,/g, ''), 10);
      const totalGB = (totalBytes / 1024 ** 3).toFixed(1);
      const over32 = totalBytes > 32 * 1024 ** 3;
      console.log(
        `[diag] drive ${drive}: total=${totalGB} GB  over32GB=${over32}${over32 ? ' ⚠ Windows format /FS:FAT32 will likely fail' : ''}`
      );
    }
  } catch (e) {
    console.log(`[diag] drive size check failed: ${e.message}`);
  }

  let removable = false;
  try {
    const { stdout: driveTypeOut } = await execAsync(`fsutil fsinfo drivetype ${drive}: 2>&1`, {
      windowsHide: true,
    });
    console.log(`[diag] fsutil drivetype ${drive}: ${driveTypeOut.trim()}`);
    removable = /removable drive/i.test(driveTypeOut);
  } catch (e) {
    console.log(`[diag] drivetype check failed: ${e.message}`);
  }

  return {
    fs: fsName,
    device: `${drive}:`,
    mountPoint: mountPath,
    needsFormat: !FAT_FILESYSTEMS.has(fsName),
    removable,
  };
}

/**
 * Read a volume's filesystem, device node and removability from diskutil.
 * @param {string} mountPath
 * @returns {Promise<{fs: string, device: string|null, mountPoint: string,
 *          needsFormat: boolean, removable: boolean}>}
 */
async function detectFilesystemMac(mountPath) {
  const { stdout } = await execAsync(`diskutil info "${mountPath}" 2>&1`);
  const fsMatch =
    stdout.match(/Type \(Bundle\)\s*:\s*(\S+)/i) || stdout.match(/File System\s*:\s*(.+)/i);
  const deviceMatch = stdout.match(/Device Node\s*:\s*(\S+)/i);
  const fsName = fsMatch ? fsMatch[1].toLowerCase().replace('msdos', 'fat32') : 'unknown';
  const device = deviceMatch ? deviceMatch[1] : null;

  const locationMatch = stdout.match(/Device Location\s*:\s*(\S+)/i);
  const removableMatch = stdout.match(/Removable Media\s*:\s*(\S+)/i);
  const removable =
    (!!locationMatch && /external/i.test(locationMatch[1])) ||
    (!!removableMatch && /removable/i.test(removableMatch[1]));

  return {
    fs: fsName,
    device,
    mountPoint: mountPath,
    needsFormat: !FAT_FILESYSTEMS.has(fsName),
    removable,
  };
}

/**
 * Read a mount's filesystem and device from lsblk, falling back to df when lsblk
 * does not list the mount point.
 * @param {string} mountPath
 * @returns {Promise<{fs: string, device: string|null, mountPoint: string,
 *          needsFormat: boolean, removable: boolean}>}
 */
async function detectFilesystemLinux(mountPath) {
  try {
    const { stdout: lsblkOut } = await execAsync(
      `lsblk -o MOUNTPOINT,FSTYPE,NAME,RM,TRAN -J 2>/dev/null`
    );
    const data = JSON.parse(lsblkOut);
    const device = findLinuxDevice(data.blockdevices, mountPath);
    if (device) {
      const fsName = (device.fstype || 'unknown').toLowerCase();
      const removable = isRemovableLinuxDevice(device);
      return {
        fs: fsName,
        device: `/dev/${device.name}`,
        mountPoint: mountPath,
        needsFormat: !FAT_FILESYSTEMS.has(fsName),
        removable,
      };
    }
  } catch {}

  const { stdout } = await execAsync(`df -T "${mountPath}" 2>&1`);
  const lines = stdout.trim().split('\n');
  if (lines.length >= 2) {
    const parts = lines[1].trim().split(/\s+/);
    const fsName = (parts[1] || 'unknown').toLowerCase();
    const device = parts[0] || null;
    const removable = await isRemovableLinuxDeviceNode(device);
    return {
      fs: fsName,
      device,
      mountPoint: mountPath,
      needsFormat: !FAT_FILESYSTEMS.has(fsName),
      removable,
    };
  }

  return {
    fs: 'unknown',
    device: null,
    mountPoint: mountPath,
    needsFormat: false,
    removable: false,
  };
}

/**
 * Find the lsblk entry mounted at a path, walking the children recursively; the
 * parent's rm/tran are carried down because partitions leave them unset.
 * @param {Array<object>} devices - lsblk blockdevices entries
 * @param {string} mountPath
 * @param {{rm?: boolean, tran?: string}} [parentInfo]
 * @returns {object|null}
 */
function findLinuxDevice(devices, mountPath, parentInfo = {}) {
  for (const d of devices || []) {
    const info = { rm: d.rm ?? parentInfo.rm, tran: d.tran ?? parentInfo.tran };
    if (d.mountpoint === mountPath) return { ...d, ...info };
    if (d.children) {
      const found = findLinuxDevice(d.children, mountPath, info);
      if (found) return found;
    }
  }
  return null;
}

/**
 * True for removable media: lsblk either flags it removable or reaches it over USB.
 * @param {object} device - lsblk entry
 * @returns {boolean}
 */
function isRemovableLinuxDevice(device) {
  const rm = device.rm;
  const isRemovableFlag = rm === true || rm === 1 || rm === '1';
  const isUsbTransport = typeof device.tran === 'string' && device.tran.toLowerCase() === 'usb';
  return isRemovableFlag || isUsbTransport;
}

/**
 * True when the kernel's /sys/block/<disk>/removable flag says the device is
 * removable; false when that cannot be read.
 * @param {string} devicePath - e.g. "/dev/sdb1"
 * @returns {Promise<boolean>}
 */
async function isRemovableLinuxDeviceNode(devicePath) {
  if (!devicePath) return false;
  const base = devicePath.replace(/^\/dev\//, '').replace(/[0-9]+$/, '');
  if (!base) return false;
  try {
    const val = fs.readFileSync(`/sys/block/${base}/removable`, 'utf8').trim();
    return val === '1';
  } catch {
    return false;
  }
}

/**
 * Formats a drive as FAT32. Destructive — caller must confirm first.
 * Calls onProgress(message) during operation.
 */
export async function formatDrive(device, mountPoint, onProgress) {
  const platform = process.platform;

  const info = await detectFilesystem(mountPoint);
  if (!info.removable) {
    throw new Error(
      `Refusing to format ${device}: it was not confirmed to be removable media. ` +
        `Internal/fixed drives cannot be formatted.`
    );
  }

  onProgress('Starting format…');

  if (platform === 'win32') {
    await formatWindows(device, onProgress);
  } else if (platform === 'darwin') {
    await formatMac(device, onProgress);
  } else {
    await formatLinux(device, mountPoint, onProgress);
  }

  onProgress('Format complete.');
}

/**
 * Format a drive as FAT32 labelled REKORDBOX with the Windows format command, then
 * wait until the drive answers again.
 * @param {string} device - drive path, e.g. "E:\"
 * @param {Function} onProgress
 */
async function formatWindows(device, onProgress) {
  const drive = device.replace(/[/\\]/g, '').replace(/:$/, '');
  onProgress(`Formatting ${drive}: as FAT32…`);
  const cmd = `format ${drive}: /FS:FAT32 /Q /V:REKORDBOX /Y`;
  console.log(`[diag] format cmd: ${cmd}`);
  const { stdout, stderr } = await execAsync(cmd, { windowsHide: true, timeout: 120000 });
  console.log(`[diag] format stdout: ${stdout?.trim()}`);
  if (stderr) console.log(`[diag] format stderr: ${stderr?.trim()}`);
  if (stderr) throw new Error(stderr.trim());

  onProgress(`Waiting for ${drive}: to remount…`);
  await waitForDriveReady(drive);
  console.log(`[diag] drive ${drive}: is ready after format`);
}

/**
 * Poll until the drive can be listed, which is when Windows has finished
 * remounting it after a format.
 * @param {string} drive - drive letter, e.g. "E"
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<void>} rejects when the drive never comes back
 */
async function waitForDriveReady(drive, timeoutMs = 15000) {
  const root = `${drive}:\\`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.readdirSync(root);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `Drive ${drive}: was not accessible within ${timeoutMs / 1000}s after format. ` +
      `Try ejecting and re-inserting the drive, then export again.`
  );
}

/**
 * Erase a disk as FAT32 labelled REKORDBOX with diskutil.
 * @param {string} device - device node, e.g. "/dev/disk4"
 * @param {Function} onProgress
 */
async function formatMac(device, onProgress) {
  onProgress(`Formatting ${device} as FAT32…`);
  const { stdout, stderr } = await execAsync(
    `diskutil eraseDisk FAT32 REKORDBOX MBRFormat "${device}"`,
    { timeout: 120000 }
  );
  if (stderr && !stdout.includes('Finished')) throw new Error(stderr.trim());
}

/**
 * Unmount and mkfs.fat a device as FAT32, trying pkexec then non-interactive sudo
 * before plain mkfs, since formatting needs root.
 * @param {string} device - device node, e.g. "/dev/sdb"
 * @param {string} mountPoint
 * @param {Function} onProgress
 */
async function formatLinux(device, mountPoint, onProgress) {
  onProgress(`Unmounting ${mountPoint}…`);

  try {
    await execAsync(`umount "${mountPoint}" 2>/dev/null || true`);
  } catch {}

  onProgress(`Formatting ${device} as FAT32 (may require sudo)…`);

  const mkfsCmd = `mkfs.fat -F 32 -n REKORDBOX "${device}"`;
  const cmds = [`pkexec ${mkfsCmd}`, `sudo -n ${mkfsCmd}`, mkfsCmd];

  let lastError;
  for (const cmd of cmds) {
    try {
      await execAsync(cmd, { timeout: 120000 });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Format failed — root access required.\n` +
      `Run manually: sudo mkfs.fat -F 32 -n REKORDBOX "${device}"\n` +
      `Then re-run the export.\n\nDetails: ${lastError?.message}`
  );
}

/**
 * Returns a human-readable filesystem label for display.
 */
export function describeFilesystem(fsName) {
  const known = {
    ntfs: 'NTFS',
    ext4: 'ext4',
    ext3: 'ext3',
    ext2: 'ext2',
    apfs: 'APFS',
    hfs: 'HFS+',
    'hfs+': 'HFS+',
    btrfs: 'btrfs',
    xfs: 'XFS',
    fat32: 'FAT32',
    fat16: 'FAT16',
    fat: 'FAT',
    exfat: 'exFAT',
    vfat: 'FAT32',
    msdos: 'FAT32',
  };
  return known[fsName?.toLowerCase()] || fsName?.toUpperCase() || 'Unknown';
}

/** Normalises separators so Windows-style paths behave on every platform. */
