import { describe, it, expect } from 'vitest';
import {
  decodeMountField,
  parseProcMounts,
  isRemovableMount,
  makeLinuxVolumeId,
  detectLinuxVolumes,
  detectWindowsVolumes,
  scanVolumes,
  volumeSignature,
} from '../explorer/volumes.js';

const MOUNTS = [
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  'tmpfs /run tmpfs rw,nosuid,nodev,relatime,mode=755 0 0',
  'overlay /var/lib/docker/overlay2/abc/merged overlay rw,relatime 0 0',
  '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
  '/dev/nvme0n1p1 /boot vfat rw,relatime,fmask=0022 0 0',
  '/dev/sda2 /home ext4 rw,relatime 0 0',
  '/dev/sda1 /run/media/rade\\040xito/Ventoy exfat rw,nosuid,nodev,uid=1000 0 0',
].join('\n');

const fakeFs = (mounts = MOUNTS) => ({
  readFileSync: () => mounts,
  statSync: () => ({ isDirectory: () => true }),
  statfsSync: () => ({ blocks: 100, bsize: 4096 }),
});

describe('parseProcMounts', () => {
  it('reads device, mount point and filesystem type', () => {
    const entries = parseProcMounts(MOUNTS);
    expect(entries).toHaveLength(8);
    expect(entries[4]).toEqual({
      device: '/dev/nvme0n1p2',
      mountPoint: '/',
      fileSystemType: 'ext4',
    });
  });

  it('decodes the octal escapes used for spaces', () => {
    expect(decodeMountField('/run/media/rade\\040xito/Ventoy')).toBe('/run/media/rade xito/Ventoy');
    const ventoy = parseProcMounts(MOUNTS).find((e) => e.device === '/dev/sda1');
    expect(ventoy.mountPoint).toBe('/run/media/rade xito/Ventoy');
  });

  it('ignores blanks, comments and truncated lines', () => {
    expect(parseProcMounts('\n# comment\n/dev/sda1 /media/stick\n')).toEqual([]);
    expect(parseProcMounts('')).toEqual([]);
    expect(parseProcMounts(undefined)).toEqual([]);
  });
});

describe('isRemovableMount', () => {
  it('treats udisks mount points as removable', () => {
    expect(isRemovableMount('/run/media/radexito/Ventoy')).toBe(true);
    expect(isRemovableMount('/media/USB STICK')).toBe(true);
    expect(isRemovableMount('/run/mount/radexito/stick')).toBe(true);
  });

  it('treats an unpartitioned whole disk as removable', () => {
    expect(isRemovableMount('/mnt/whatever', '/dev/sdb')).toBe(true);
    expect(isRemovableMount('/mnt/whatever', '/dev/mmcblk0')).toBe(true);
    expect(isRemovableMount('/mnt/whatever', '/dev/sdb1')).toBe(false);
    expect(isRemovableMount('/mnt/whatever', '/dev/nvme0n1p2')).toBe(false);
  });

  it('does not treat the system mounts as removable', () => {
    expect(isRemovableMount('/')).toBe(false);
    expect(isRemovableMount('/home')).toBe(false);
    expect(isRemovableMount('/boot', '/dev/nvme0n1p1')).toBe(false);
  });
});

describe('detectLinuxVolumes', () => {
  it('lists real filesystems and drops the virtual ones', () => {
    const volumes = detectLinuxVolumes({ platform: 'linux', ...fakeFs() });

    expect(volumes.map((v) => v.root)).toEqual([
      '/',
      '/boot',
      '/home',
      '/run/media/rade xito/Ventoy',
    ]);
  });

  it('marks the system root, the removable stick and its label', () => {
    const volumes = detectLinuxVolumes({ platform: 'linux', ...fakeFs() });
    const root = volumes.find((v) => v.root === '/');
    const stick = volumes.find((v) => v.removable);

    expect(root.system).toBe(true);
    expect(root.id).toBe('linux:system');
    expect(stick.root).toBe('/run/media/rade xito/Ventoy');
    expect(stick.label).toBe('Ventoy');
    expect(stick.fileSystemType).toBe('exfat');
    expect(stick.device).toBe('/dev/sda1');
    expect(stick.totalBytes).toBe(409600);
    expect(stick.id).toBe('linux:exfat:Ventoy:409600');
  });

  it('stable id survives a remount at another mount point', () => {
    const first = makeLinuxVolumeId({
      fileSystemType: 'ext4',
      label: 'Ventoy',
      totalBytes: 409600,
    });
    const second = makeLinuxVolumeId({
      fileSystemType: 'ext4',
      label: 'Ventoy',
      totalBytes: 409600,
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^linux:/);
  });

  it('skips mounts that are not there right now', () => {
    const volumes = detectLinuxVolumes({
      platform: 'linux',
      readFileSync: () => MOUNTS,
      statSync: (p) => {
        if (p === '/home') throw new Error('ENOENT');
        return { isDirectory: () => true };
      },
      statfsSync: () => ({ blocks: 1, bsize: 1 }),
    });
    expect(volumes.map((v) => v.root)).not.toContain('/home');
  });

  it('never throws when /proc/mounts cannot be read', () => {
    const volumes = detectLinuxVolumes({
      platform: 'linux',
      readFileSync: () => {
        throw new Error('EACCES');
      },
      statSync: () => ({ isDirectory: () => true }),
      statfsSync: () => ({}),
    });
    expect(volumes).toEqual([]);
  });

  it('returns nothing on other platforms', () => {
    expect(detectLinuxVolumes({ platform: 'win32', ...fakeFs() })).toEqual([]);
  });

  it('still lists a volume when its size cannot be read', () => {
    const volumes = detectLinuxVolumes({
      platform: 'linux',
      readFileSync: () => MOUNTS,
      statSync: () => ({ isDirectory: () => true }),
      statfsSync: () => {
        throw new Error('ENOTSUP');
      },
    });
    const stick = volumes.find((v) => v.removable);
    expect(stick.totalBytes).toBe(0);
    expect(stick.id).toBe('linux:exfat:Ventoy:0');
  });
});

describe('detectWindowsVolumes / scanVolumes', () => {
  const existsSync = (p) => p === 'C:\\' || p === 'E:\\';

  it('lists present drive letters as volumes', () => {
    const volumes = detectWindowsVolumes({ platform: 'win32', existsSync, systemRoot: 'C:\\' });
    expect(volumes.map((v) => v.root)).toEqual(['C:\\', 'E:\\']);
    expect(volumes[0]).toMatchObject({ label: 'C:', system: true, removable: false });
    expect(volumes[1]).toMatchObject({ label: 'E:', system: false });
    expect(volumes[0].id).toBe('win32:root:C:\\');
  });

  it('skips letters that exist but cannot be opened', () => {
    const volumes = detectWindowsVolumes({
      platform: 'win32',
      existsSync: (p) => {
        if (p === 'D:\\') throw new Error('EIO');
        return p === 'C:\\' || p === 'D:\\';
      },
      systemRoot: 'C:\\',
    });
    expect(volumes.map((v) => v.root)).toEqual(['C:\\']);
  });

  it('scanVolumes returns drives and volumes together on Windows', () => {
    const snapshot = scanVolumes({ platform: 'win32', homeDir: 'C:\\Users\\radek', existsSync });
    expect(snapshot.drives).toEqual(['C:\\', 'E:\\']);
    expect(snapshot.volumes.map((v) => v.root)).toEqual(['C:\\', 'E:\\']);
  });

  it('scanVolumes on Linux returns mount points and no drive letters', () => {
    const snapshot = scanVolumes({ platform: 'linux', homeDir: '/home/radexito', ...fakeFs() });
    expect(snapshot.drives).toEqual([]);
    expect(snapshot.volumes.length).toBe(4);
  });
});

describe('volumeSignature', () => {
  const base = [
    { id: 'linux:system', root: '/' },
    { id: 'linux:exfat:Ventoy:409600', root: '/run/media/radexito/Ventoy' },
  ];

  it('is stable for the same volumes in another order', () => {
    expect(volumeSignature(base)).toBe(volumeSignature([...base].reverse()));
  });

  it('changes when a volume appears, disappears or is remounted', () => {
    const withExtra = [...base, { id: 'linux:vfat:STICK:8192', root: '/run/media/u/STICK' }];
    expect(volumeSignature(withExtra)).not.toBe(volumeSignature(base));

    expect(volumeSignature(base.slice(0, 1))).not.toBe(volumeSignature(base));

    const remounted = [base[0], { id: base[1].id, root: '/home/radexito/Ventoy' }];
    expect(volumeSignature(remounted)).not.toBe(volumeSignature(base));
  });

  it('handles an empty list', () => {
    expect(volumeSignature([])).toBe('');
    expect(volumeSignature()).toBe('');
  });
});
