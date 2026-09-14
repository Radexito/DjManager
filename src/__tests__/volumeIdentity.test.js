import { describe, it, expect } from 'vitest';
import {
  decodeMountField,
  decideExportDestination,
  diffVolumes,
  findVolumeForPath,
  isWindowsDriveRoot,
  makeLinuxVolumeId,
  makeWindowsVolumeId,
  parseProcMounts,
  pathHasRoot,
  planLinkedTrackRekeys,
  resolveVolumePath,
} from '../explorer/volumeIdentity.js';
import { detectVolumes } from '../explorer/drives.js';

const winVolume = (root, serial) => ({
  id: makeWindowsVolumeId({ root, serial }),
  root,
  label: root.replace(/[\\/]+$/, ''),
  platform: 'win32',
});

const linVolume = (root, fileSystemType = 'vfat', totalBytes = 3_100_000_000) => ({
  id: makeLinuxVolumeId({
    fileSystemType,
    label: root.split('/').filter(Boolean).pop() ?? '',
    totalBytes,
  }),
  root,
  label: root,
  platform: 'linux',
});

describe('parseProcMounts', () => {
  it('parses device, mount point and filesystem type', () => {
    const text = [
      '# comment line',
      '',
      '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
      '/dev/sdb1 /run/media/radex/USB vfat rw,nosuid 0 0',
    ].join('\n');

    expect(parseProcMounts(text)).toEqual([
      { device: '/dev/nvme0n1p2', mountPoint: '/', fileSystemType: 'ext4' },
      { device: '/dev/sdb1', mountPoint: '/run/media/radex/USB', fileSystemType: 'vfat' },
    ]);
  });

  it('decodes the octal escapes used for spaces in mount points', () => {
    const text = '/dev/sdb1 /run/media/radex/My\\040Stick vfat rw 0 0';
    const [entry] = parseProcMounts(text);
    expect(entry.mountPoint).toBe('/run/media/radex/My Stick');
    expect(decodeMountField('a\\011b')).toBe('a\tb');
    expect(decodeMountField('plain')).toBe('plain');
  });

  it('ignores lines that do not have at least three fields', () => {
    expect(parseProcMounts('garbage\n\n/dev/sdb1 /mnt vfat 0 0')).toHaveLength(1);
    expect(parseProcMounts()).toEqual([]);
  });
});

describe('pathHasRoot', () => {
  it('matches Linux roots as a path prefix', () => {
    expect(pathHasRoot('/run/media/u/USB/music/a.mp3', '/run/media/u/USB')).toBe(true);
    expect(pathHasRoot('/run/media/u/USB', '/run/media/u/USB')).toBe(true);
    expect(pathHasRoot('/run/media/u/USB2', '/run/media/u/USB')).toBe(false);
  });

  it('matches Windows drive roots case-insensitively and without the separator', () => {
    expect(pathHasRoot('E:\\music\\a.mp3', 'E:\\')).toBe(true);
    expect(pathHasRoot('e:\\music\\a.mp3', 'E:\\')).toBe(true);
    expect(pathHasRoot('E:\\', 'E:\\')).toBe(true);
    expect(pathHasRoot('E:', 'E:\\')).toBe(true);
    expect(pathHasRoot('F:\\music', 'E:\\')).toBe(false);
    expect(isWindowsDriveRoot('E:')).toBe(true);
    expect(isWindowsDriveRoot('/mnt/usb')).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(pathHasRoot('', 'E:\\')).toBe(false);
    expect(pathHasRoot('E:\\', '')).toBe(false);
  });
});

describe('findVolumeForPath', () => {
  it('returns the longest matching root', () => {
    const root = linVolume('/');
    const usb = linVolume('/run/media/u/USB');
    expect(findVolumeForPath('/run/media/u/USB/music/a.mp3', [root, usb])).toBe(usb);
    expect(findVolumeForPath('/home/radex/a.mp3', [root, usb])).toBe(root);
  });

  it('returns null when nothing matches', () => {
    expect(findVolumeForPath('/media/u/USB/a.mp3', [])).toBeNull();
    expect(findVolumeForPath(null, [linVolume('/')])).toBeNull();
  });
});

describe('resolveVolumePath', () => {
  const oldVolume = winVolume('E:\\', 0x1a2b3c4d);
  const newRootVolume = winVolume('D:\\', 0x1a2b3c4d);
  const otherVolume = winVolume('E:\\', 0xdeadbeef);

  it('keeps the path when the volume is still at the same root', () => {
    const res = resolveVolumePath('E:\\music\\a.mp3', [oldVolume], [oldVolume]);
    expect(res).toEqual({
      ok: true,
      path: 'E:\\music\\a.mp3',
      volumeId: oldVolume.id,
      root: 'E:\\',
      changed: false,
    });
  });

  it('follows the volume to a new letter', () => {
    const res = resolveVolumePath('E:\\music\\a.mp3', [newRootVolume, otherVolume], [oldVolume]);
    expect(res.ok).toBe(true);
    expect(res.path).toBe('D:\\music\\a.mp3');
    expect(res.changed).toBe(true);
    expect(res.root).toBe('D:\\');
  });

  it('rewrites a bare drive root', () => {
    const res = resolveVolumePath('E:\\', [newRootVolume], [oldVolume]);
    expect(res.path).toBe('D:\\');
  });

  it('fails when the volume is gone instead of reusing a stale path', () => {
    const res = resolveVolumePath('E:\\music', [otherVolume], [oldVolume]);
    expect(res).toEqual({ ok: false, reason: 'volume-missing', volumeId: oldVolume.id });
  });

  it('supports the export form where the pick-time volume is passed explicitly', () => {
    const picked = [{ id: oldVolume.id, root: 'E:\\' }];
    expect(resolveVolumePath('E:\\music\\a.mp3', [newRootVolume], picked).path).toBe(
      'D:\\music\\a.mp3'
    );
  });

  it('keeps a picked subfolder when only the volume root moved', () => {
    // The export flow passes the volume root captured at pick time, so re-rooting
    // must preserve the subfolder the user actually selected (#514).
    const picked = [{ id: oldVolume.id, root: 'E:\\' }];
    expect(resolveVolumePath('E:\\Music', [newRootVolume], picked)).toMatchObject({
      ok: true,
      path: 'D:\\Music',
      changed: true,
    });
  });

  it('reports no-volume when the path belongs to no known volume', () => {
    expect(resolveVolumePath('Z:\\music', [oldVolume], [oldVolume])).toEqual({
      ok: false,
      reason: 'no-volume',
    });
  });

  it('reports no-path for an empty destination', () => {
    expect(resolveVolumePath(null, [oldVolume])).toEqual({ ok: false, reason: 'no-path' });
  });
});

describe('diffVolumes', () => {
  it('reports no change for identical snapshots', () => {
    const volumes = [winVolume('C:\\', 1), winVolume('E:\\', 2)];
    const diff = diffVolumes(
      volumes,
      volumes.map((v) => ({ ...v }))
    );
    expect(diff.changed).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.letterChanged).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
  });

  it('detects added, removed and letter-changed volumes by stable id', () => {
    const c = winVolume('C:\\', 1);
    const stick = winVolume('E:\\', 2);
    const previous = [c, stick];
    const next = [c, winVolume('D:\\', 2), winVolume('F:\\', 3)];

    const diff = diffVolumes(previous, next);
    expect(diff.changed).toBe(true);
    expect(diff.added.map((v) => v.root)).toEqual(['F:\\']);
    expect(diff.removed).toEqual([]);
    expect(diff.letterChanged).toEqual([
      { id: stick.id, from: 'E:\\', to: 'D:\\', volume: next[1] },
    ]);
    expect(diff.unchanged.map((v) => v.root)).toEqual(['C:\\']);
  });

  it('treats a removed volume as removed, not as renamed', () => {
    const stick = winVolume('E:\\', 2);
    const diff = diffVolumes([stick], []);
    expect(diff.removed).toEqual([stick]);
    expect(diff.letterChanged).toEqual([]);
    expect(diff.changed).toBe(true);
  });
});

describe('planLinkedTrackRekeys', () => {
  it('appends the platform separator to naked roots', () => {
    expect(planLinkedTrackRekeys([{ from: 'E:\\', to: 'D:\\' }], '\\')).toEqual([
      { from: 'E:\\', to: 'D:\\', fromPrefix: 'E:\\', toPrefix: 'D:\\' },
    ]);
    expect(planLinkedTrackRekeys([{ from: '/run/media/u/USB', to: '/media/u/USB' }], '/')).toEqual([
      {
        from: '/run/media/u/USB',
        to: '/media/u/USB',
        fromPrefix: '/run/media/u/USB/',
        toPrefix: '/media/u/USB/',
      },
    ]);
  });

  it('keeps a separator that is already there', () => {
    const [plan] = planLinkedTrackRekeys([{ from: '/mnt/usb/', to: 'E:/' }], '/');
    expect(plan).toMatchObject({ fromPrefix: '/mnt/usb/', toPrefix: 'E:/' });
  });

  it('skips empty, identical and duplicate renames', () => {
    const plans = planLinkedTrackRekeys(
      [
        { from: 'E:\\', to: 'D:\\' },
        { from: 'E:\\', to: 'D:\\' },
        { from: '', to: 'D:\\' },
        { from: 'F:\\', to: 'F:\\' },
      ],
      '\\'
    );
    expect(plans).toHaveLength(1);
  });

  it('returns an empty list for no changes', () => {
    expect(planLinkedTrackRekeys([], '\\')).toEqual([]);
    expect(planLinkedTrackRekeys(undefined, '\\')).toEqual([]);
  });
});

describe('decideExportDestination', () => {
  const oldVolume = winVolume('E:\\', 0x1a2b3c4d);
  const reLettered = winVolume('D:\\', 0x1a2b3c4d);
  const otherVolume = winVolume('E:\\', 0xdeadbeef);

  it('refuses an empty destination with a clear message', () => {
    const decision = decideExportDestination({ usbRoot: null }, [oldVolume]);
    expect(decision.ok).toBe(false);
    expect(decision.error).toBe('No export destination selected.');
  });

  it('follows the picked volume to its new letter', () => {
    const decision = decideExportDestination(
      { usbRoot: 'E:\\Music', usbVolumeId: oldVolume.id, usbVolumeRoot: 'E:\\' },
      [reLettered],
      { exists: () => true }
    );
    expect(decision).toEqual({
      ok: true,
      path: 'D:\\Music',
      changed: true,
      volumeId: reLettered.id,
    });
  });

  it('reports an unchanged path when the drive is still there', () => {
    const decision = decideExportDestination(
      { usbRoot: 'E:\\Music', usbVolumeId: oldVolume.id, usbVolumeRoot: 'E:\\' },
      [oldVolume]
    );
    expect(decision).toMatchObject({ ok: true, path: 'E:\\Music', changed: false });
  });

  it('fails loudly when the picked volume is gone, even if the old path still resolves', () => {
    // Another device took over E:\ in the meantime: writing there would export to
    // the wrong disk, so the existence check must NOT rescue this case (#514).
    const decision = decideExportDestination(
      { usbRoot: 'E:\\Music', usbVolumeId: oldVolume.id, usbVolumeRoot: 'E:\\' },
      [otherVolume],
      { exists: () => true }
    );
    expect(decision.ok).toBe(false);
    expect(decision.error).toMatch(/disconnected or reconnected under a different letter/);
  });

  it('falls back to the existence check when no volume identity is available', () => {
    const exists = (p) => p === '\\\\server\\share\\music';
    const atShare = decideExportDestination({ usbRoot: '\\\\server\\share\\music' }, [], {
      exists,
    });
    expect(atShare).toEqual({
      ok: true,
      path: '\\\\server\\share\\music',
      changed: false,
      volumeId: null,
    });

    const gone = decideExportDestination({ usbRoot: '\\\\server\\share\\music' }, [], {
      exists: () => false,
    });
    expect(gone.ok).toBe(false);
    expect(gone.error).toMatch(/destination drive is not available/);
  });

  it('falls back to the existence check for a path outside every known volume', () => {
    const decision = decideExportDestination({ usbRoot: 'Z:\\Music' }, [oldVolume], {
      exists: () => true,
    });
    expect(decision).toMatchObject({ ok: true, path: 'Z:\\Music', changed: false });
  });

  it('works without an existence probe for a remaining volume', () => {
    const decision = decideExportDestination(
      { usbRoot: 'E:\\', usbVolumeId: oldVolume.id, usbVolumeRoot: 'E:\\' },
      [oldVolume]
    );
    expect(decision).toMatchObject({ ok: true, path: 'E:\\' });
  });
});

describe('detectVolumes (real platform)', () => {
  it('returns an array of absolute mounts on this machine without throwing', () => {
    const volumes = detectVolumes();
    expect(Array.isArray(volumes)).toBe(true);
    for (const volume of volumes) {
      expect(volume.root.startsWith('/')).toBe(true);
      expect(typeof volume.id).toBe('string');
      expect(volume.id.length).toBeGreaterThan(0);
    }
    expect(findVolumeForPath(process.cwd(), volumes)).not.toBeNull();
  });
});

describe('volume ids', () => {
  it('uses the volume serial in hex on Windows', () => {
    expect(makeWindowsVolumeId({ root: 'E:\\', serial: 0x1a2b3c4d })).toBe('win32:vol:1a2b3c4d');
    expect(makeWindowsVolumeId({ root: 'E:\\', serial: 0 })).toBe('win32:root:E:\\');
    expect(makeWindowsVolumeId({ root: 'e:\\' })).toBe('win32:root:E:\\');
  });

  it('keeps the Linux id stable across mount points', () => {
    const a = makeLinuxVolumeId({ fileSystemType: 'VFAT', label: 'USB', totalBytes: 1000 });
    const b = makeLinuxVolumeId({ fileSystemType: 'vfat', label: 'USB', totalBytes: 1000 });
    expect(a).toBe(b);
    expect(a).toBe('linux:vfat:USB:1000');
    expect(makeLinuxVolumeId({})).toBe('linux:unknown::0');
  });
});

describe('detectVolumes', () => {
  it('returns [] on platforms without identity support', () => {
    expect(detectVolumes({ platform: 'darwin' })).toEqual([]);
  });

  it('builds Windows volumes from the detected roots and their serials', () => {
    const existsSync = (p) => p === 'C:\\' || p === 'E:\\';
    const statSync = (p) => ({ dev: p === 'E:\\' ? 4242 : 1 });
    const volumes = detectVolumes({ platform: 'win32', existsSync, statSync });

    expect(volumes.map((v) => v.root)).toEqual(['C:\\', 'E:\\']);
    expect(volumes[1]).toMatchObject({ id: 'win32:vol:1092', label: 'E:' });
  });

  it('falls back to a letter id when the volume cannot be stat-ed', () => {
    const existsSync = (p) => p === 'E:\\';
    const statSync = () => {
      throw new Error('access denied');
    };
    expect(detectVolumes({ platform: 'win32', existsSync, statSync })[0].id).toBe(
      'win32:root:E:\\'
    );
  });

  it('parses Linux mounts, filters pseudo filesystems and reads sizes via statfs', () => {
    const mountsText = [
      'proc /proc proc rw 0 0',
      'tmpfs /run tmpfs rw 0 0',
      '/dev/nvme0n1p2 / ext4 rw 0 0',
      '/dev/sdb1 /run/media/radex/USB vfat rw 0 0',
    ].join('\n');
    const statfsSync = () => ({ bsize: 512, blocks: 1000 });

    const volumes = detectVolumes({ platform: 'linux', mountsText, statfsSync });
    expect(volumes.map((v) => v.root)).toEqual(['/', '/run/media/radex/USB']);
    expect(volumes[1]).toMatchObject({
      id: 'linux:vfat:USB:512000',
      device: '/dev/sdb1',
      fileSystemType: 'vfat',
      platform: 'linux',
    });
  });

  it('keeps working when /proc/mounts cannot be read', () => {
    const readMounts = () => {
      throw new Error('ENOENT');
    };
    expect(detectVolumes({ platform: 'linux', readMounts })).toEqual([]);
  });
});
