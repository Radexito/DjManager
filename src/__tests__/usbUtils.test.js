import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

// The usbUtils module does: import { exec } from 'child_process'; const execAsync = promisify(exec)
// promisify resolves with { stdout, stderr } only when exec has util.promisify.custom set.
// We wire that up here so execAsync behaves identically to the real promisified exec.
const mockExecAsync = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }));

vi.mock('child_process', () => {
  const execMock = vi.fn();
  // Point util.promisify.custom to our async mock so promisify(execMock) === mockExecAsync
  execMock[Symbol.for('nodejs.util.promisify.custom')] = mockExecAsync;
  return { exec: execMock };
});

// Import after mocks
import { detectFilesystem, describeFilesystem, formatDrive } from '../usb/usbUtils.js';

// ── Platform stub — force Linux branch regardless of host OS ─────────────────
// usbUtils reads process.platform at call time, so stubbing the global works.
const _realProcess = globalThis.process;
beforeEach(() => {
  const mock = Object.create(_realProcess);
  Object.defineProperty(mock, 'platform', { value: 'linux', configurable: true, writable: false });
  vi.stubGlobal('process', mock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Configure execAsync mock to resolve with the given stdout.
 */
function mockExecOutput(stdout, stderr = '') {
  mockExecAsync.mockResolvedValueOnce({ stdout, stderr });
}

function mockExecError(err) {
  mockExecAsync.mockRejectedValueOnce(err);
}

function makeLsblkJson(blockdevices) {
  return JSON.stringify({ blockdevices });
}

// ── detectFilesystem — Linux ──────────────────────────────────────────────────

describe('detectFilesystem — Linux', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('FAT32 filesystem returns needsFormat: false', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sdb1', fstype: 'fat32', mountpoint: '/mnt/usb' }]));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.needsFormat).toBe(false);
    expect(result.fs).toBe('fat32');
  });

  it('exfat filesystem returns needsFormat: false', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sdb1', fstype: 'exfat', mountpoint: '/mnt/usb' }]));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.needsFormat).toBe(false);
    expect(result.fs).toBe('exfat');
  });

  it('btrfs filesystem returns needsFormat: true', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sdb1', fstype: 'btrfs', mountpoint: '/mnt/usb' }]));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.needsFormat).toBe(true);
    expect(result.fs).toBe('btrfs');
  });

  it('ntfs filesystem returns needsFormat: true', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sdc1', fstype: 'ntfs', mountpoint: '/mnt/usb' }]));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.needsFormat).toBe(true);
  });

  it('ext4 filesystem returns needsFormat: true', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sda1', fstype: 'ext4', mountpoint: '/mnt/data' }]));

    const result = await detectFilesystem('/mnt/data');

    expect(result.needsFormat).toBe(true);
  });

  it('returns device path prefixed with /dev/', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sdb1', fstype: 'fat32', mountpoint: '/mnt/usb' }]));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.device).toBe('/dev/sdb1');
  });

  it('returns the correct mountPoint', async () => {
    mockExecOutput(
      makeLsblkJson([{ name: 'sdb1', fstype: 'vfat', mountpoint: '/media/user/USB' }])
    );

    const result = await detectFilesystem('/media/user/USB');

    expect(result.mountPoint).toBe('/media/user/USB');
  });

  it('vfat (FAT32) returns needsFormat: false', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sdb1', fstype: 'vfat', mountpoint: '/mnt/usb' }]));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.needsFormat).toBe(false);
  });

  it('handles nested blockdevice children', async () => {
    const json = makeLsblkJson([
      {
        name: 'sdb',
        fstype: null,
        mountpoint: null,
        children: [{ name: 'sdb1', fstype: 'fat32', mountpoint: '/mnt/usb' }],
      },
    ]);
    mockExecOutput(json);

    const result = await detectFilesystem('/mnt/usb');

    expect(result.needsFormat).toBe(false);
    expect(result.fs).toBe('fat32');
  });

  it('returns needsFormat: false when lsblk fails (detection failure is non-fatal)', async () => {
    mockExecError(new Error('lsblk not found'));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.needsFormat).toBe(false);
    expect(result.fs).toBe('unknown');
  });
});

// ── detectFilesystem — removable-media detection ──────────────────────────────

describe('detectFilesystem — removable detection (Linux)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags a device with rm:true as removable', async () => {
    mockExecOutput(
      makeLsblkJson([{ name: 'sdb1', fstype: 'fat32', mountpoint: '/mnt/usb', rm: true }])
    );

    const result = await detectFilesystem('/mnt/usb');

    expect(result.removable).toBe(true);
  });

  it('flags a device with tran:"usb" as removable even if rm is unset', async () => {
    mockExecOutput(
      makeLsblkJson([{ name: 'sdb1', fstype: 'fat32', mountpoint: '/mnt/usb', tran: 'usb' }])
    );

    const result = await detectFilesystem('/mnt/usb');

    expect(result.removable).toBe(true);
  });

  it('does NOT flag a fixed internal drive (rm:false, tran:"nvme") as removable', async () => {
    mockExecOutput(
      makeLsblkJson([
        { name: 'nvme0n1p1', fstype: 'ext4', mountpoint: '/', rm: false, tran: 'nvme' },
      ])
    );

    const result = await detectFilesystem('/');

    expect(result.removable).toBe(false);
  });

  it('does NOT flag as removable when rm/tran are absent', async () => {
    mockExecOutput(makeLsblkJson([{ name: 'sda1', fstype: 'ext4', mountpoint: '/mnt/data' }]));

    const result = await detectFilesystem('/mnt/data');

    expect(result.removable).toBe(false);
  });

  it('inherits parent rm/tran onto a matched child partition', async () => {
    const json = makeLsblkJson([
      {
        name: 'sdb',
        fstype: null,
        mountpoint: null,
        rm: true,
        tran: 'usb',
        children: [{ name: 'sdb1', fstype: 'fat32', mountpoint: '/mnt/usb' }],
      },
    ]);
    mockExecOutput(json);

    const result = await detectFilesystem('/mnt/usb');

    expect(result.removable).toBe(true);
  });

  it('defaults to removable: false when detection fails entirely', async () => {
    mockExecError(new Error('lsblk not found'));

    const result = await detectFilesystem('/mnt/usb');

    expect(result.removable).toBe(false);
  });
});

// ── formatDrive — refuses to format non-removable media ────────────────────────

describe('formatDrive — removable-media safety gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws and never runs the format command when the target is not removable', async () => {
    // detectFilesystem() re-check inside formatDrive resolves via this lsblk call
    mockExecOutput(
      makeLsblkJson([{ name: 'sda1', fstype: 'ext4', mountpoint: '/', rm: false, tran: 'sata' }])
    );

    const onProgress = vi.fn();
    await expect(formatDrive('/dev/sda1', '/', onProgress)).rejects.toThrow(/removable/i);

    // Only the removable-check lsblk call should have happened — no mkfs/format call.
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
  });

  it('proceeds to format when the target is confirmed removable', async () => {
    mockExecOutput(
      makeLsblkJson([{ name: 'sdb1', fstype: 'fat32', mountpoint: '/mnt/usb', rm: true }])
    );
    // umount call inside formatLinux
    mockExecOutput('');
    // mkfs.fat call (pkexec attempt succeeds)
    mockExecOutput('');

    const onProgress = vi.fn();
    await expect(formatDrive('/dev/sdb1', '/mnt/usb', onProgress)).resolves.toBeUndefined();

    expect(onProgress).toHaveBeenCalledWith('Format complete.');
  });
});

// ── describeFilesystem ────────────────────────────────────────────────────────

describe('describeFilesystem', () => {
  it('maps fat32 → FAT32', () => {
    expect(describeFilesystem('fat32')).toBe('FAT32');
  });

  it('maps vfat → FAT32', () => {
    expect(describeFilesystem('vfat')).toBe('FAT32');
  });

  it('maps exfat → exFAT', () => {
    expect(describeFilesystem('exfat')).toBe('exFAT');
  });

  it('maps ntfs → NTFS', () => {
    expect(describeFilesystem('ntfs')).toBe('NTFS');
  });

  it('maps ext4 → ext4', () => {
    expect(describeFilesystem('ext4')).toBe('ext4');
  });

  it('maps btrfs → btrfs', () => {
    expect(describeFilesystem('btrfs')).toBe('btrfs');
  });

  it('uppercases unknown filesystems', () => {
    expect(describeFilesystem('zfs')).toBe('ZFS');
  });

  it('handles undefined gracefully', () => {
    expect(describeFilesystem(undefined)).toBe('Unknown');
  });
});
