import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

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
    // If detection fails, assume we can't check — let user proceed with warning
    return { fs: 'unknown', device: null, mountPoint: mountPath, needsFormat: false };
  }
}

async function detectFilesystemWindows(mountPath) {
  // mountPath is like "E:\" or "E:"
  const drive = mountPath.replace(/[/\\]/g, '').replace(/:$/, '');
  const { stdout } = await execAsync(`fsutil fsinfo volumeinfo ${drive}: 2>&1`, {
    windowsHide: true,
  });
  console.log(`[diag] fsutil volumeinfo ${drive}: stdout:\n${stdout.trim()}`);
  const fsMatch = stdout.match(/File System Name\s*:\s*(\S+)/i);
  const fsName = fsMatch ? fsMatch[1].toLowerCase() : 'unknown';

  // Log drive size so we can tell if FAT32 format will be rejected (> 32 GB limit)
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

  return {
    fs: fsName,
    device: `${drive}:`,
    mountPoint: mountPath,
    needsFormat: !FAT_FILESYSTEMS.has(fsName),
  };
}

async function detectFilesystemMac(mountPath) {
  const { stdout } = await execAsync(`diskutil info "${mountPath}" 2>&1`);
  const fsMatch =
    stdout.match(/Type \(Bundle\)\s*:\s*(\S+)/i) || stdout.match(/File System\s*:\s*(.+)/i);
  const deviceMatch = stdout.match(/Device Node\s*:\s*(\S+)/i);
  const fsName = fsMatch ? fsMatch[1].toLowerCase().replace('msdos', 'fat32') : 'unknown';
  const device = deviceMatch ? deviceMatch[1] : null;
  return {
    fs: fsName,
    device,
    mountPoint: mountPath,
    needsFormat: !FAT_FILESYSTEMS.has(fsName),
  };
}

async function detectFilesystemLinux(mountPath) {
  // Try lsblk first
  try {
    const { stdout: lsblkOut } = await execAsync(`lsblk -o MOUNTPOINT,FSTYPE,NAME -J 2>/dev/null`);
    const data = JSON.parse(lsblkOut);
    const device = findLinuxDevice(data.blockdevices, mountPath);
    if (device) {
      const fsName = (device.fstype || 'unknown').toLowerCase();
      return {
        fs: fsName,
        device: `/dev/${device.name}`,
        mountPoint: mountPath,
        needsFormat: !FAT_FILESYSTEMS.has(fsName),
      };
    }
  } catch {}

  // Fallback: df -T
  const { stdout } = await execAsync(`df -T "${mountPath}" 2>&1`);
  const lines = stdout.trim().split('\n');
  if (lines.length >= 2) {
    const parts = lines[1].trim().split(/\s+/);
    const fsName = (parts[1] || 'unknown').toLowerCase();
    const device = parts[0] || null;
    return {
      fs: fsName,
      device,
      mountPoint: mountPath,
      needsFormat: !FAT_FILESYSTEMS.has(fsName),
    };
  }

  return { fs: 'unknown', device: null, mountPoint: mountPath, needsFormat: false };
}

function findLinuxDevice(devices, mountPath, prefix = '') {
  for (const d of devices || []) {
    const fullName = prefix ? `${prefix}${d.name}` : d.name;
    if (d.mountpoint === mountPath) return { ...d, name: fullName };
    if (d.children) {
      const found = findLinuxDevice(d.children, mountPath, '');
      if (found) return found;
    }
  }
  return null;
}

/**
 * Formats a drive as FAT32. Destructive — caller must confirm first.
 * Calls onProgress(message) during operation.
 */
export async function formatDrive(device, mountPoint, onProgress) {
  const platform = process.platform;
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

async function formatWindows(device, onProgress) {
  // device is like "E:"
  const drive = device.replace(/[/\\]/g, '').replace(/:$/, '');
  onProgress(`Formatting ${drive}: as FAT32…`);
  // Use format command (requires admin). /Q = quick format, /Y = suppress confirmation
  const cmd = `format ${drive}: /FS:FAT32 /Q /V:REKORDBOX /Y`;
  console.log(`[diag] format cmd: ${cmd}`);
  const { stdout, stderr } = await execAsync(cmd, { windowsHide: true, timeout: 120000 });
  console.log(`[diag] format stdout: ${stdout?.trim()}`);
  if (stderr) console.log(`[diag] format stderr: ${stderr?.trim()}`);
  if (stderr) throw new Error(stderr.trim());

  // After format, Windows unmounts and remounts the volume. The drive root is
  // briefly inaccessible — wait until it's ready before returning, otherwise the
  // export starts immediately and gets ENOENT trying to mkdir on the drive root.
  onProgress(`Waiting for ${drive}: to remount…`);
  await waitForDriveReady(drive);
  console.log(`[diag] drive ${drive}: is ready after format`);
}

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

async function formatMac(device, onProgress) {
  onProgress(`Formatting ${device} as FAT32…`);
  // diskutil eraseDisk FAT32 <name> MBRFormat <device>
  const { stdout, stderr } = await execAsync(
    `diskutil eraseDisk FAT32 REKORDBOX MBRFormat "${device}"`,
    { timeout: 120000 }
  );
  if (stderr && !stdout.includes('Finished')) throw new Error(stderr.trim());
}

async function formatLinux(device, mountPoint, onProgress) {
  // First unmount, then format
  onProgress(`Unmounting ${mountPoint}…`);

  // Try to unmount
  try {
    await execAsync(`umount "${mountPoint}" 2>/dev/null || true`);
  } catch {}

  onProgress(`Formatting ${device} as FAT32 (may require sudo)…`);

  // Try pkexec first (graphical sudo), fall back to sudo
  const mkfsCmd = `mkfs.fat -F 32 -n REKORDBOX "${device}"`;
  const cmds = [`pkexec ${mkfsCmd}`, `sudo -n ${mkfsCmd}`, mkfsCmd];

  let lastError;
  for (const cmd of cmds) {
    try {
      await execAsync(cmd, { timeout: 120000 });
      return;
    } catch (err) {
      lastError = err;
      // pkexec/sudo failed, try next
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
