import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanSerial,
  deviceKey,
  ensureMarker,
  readDeviceIdentity,
  readMarker,
} from '../usb/generic/identity.js';

let roots = [];

function stick() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'djman-identity-'));
  roots.push(root);
  return root;
}

const lsblkExec = (devices) => async (command) => {
  if (command !== 'lsblk') throw new Error(`unexpected command ${command}`);
  return { stdout: JSON.stringify({ blockdevices: devices }) };
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('device identity', () => {
  it('keys on the serial and stays the same when the mount point changes', async () => {
    const first = stick();
    const second = stick();
    const exec = lsblkExec([
      { mountpoint: first, serial: ' 1234abcd ', label: 'STICK', fstype: 'vfat' },
      { mountpoint: second, serial: '1234abcd', label: 'STICK', fstype: 'vfat' },
    ]);

    const a = await readDeviceIdentity(first, { platform: 'linux', exec });
    const b = await readDeviceIdentity(second, { platform: 'linux', exec });

    expect(a).toMatchObject({
      serial: '1234ABCD',
      label: 'STICK',
      filesystem: 'vfat',
      source: 'serial',
    });
    expect(a.key).toBe('serial:1234ABCD');
    expect(b.key).toBe(a.key);
  });

  it('tells two devices with the same label apart by serial', async () => {
    const first = stick();
    const second = stick();
    const exec = lsblkExec([
      { mountpoint: first, serial: 'AAA111', label: 'DJ', fstype: 'vfat' },
      { mountpoint: second, serial: 'BBB222', label: 'DJ', fstype: 'vfat' },
    ]);

    const a = await readDeviceIdentity(first, { platform: 'linux', exec });
    const b = await readDeviceIdentity(second, { platform: 'linux', exec });
    expect(a.label).toBe('DJ');
    expect(b.label).toBe('DJ');
    expect(a.key).not.toBe(b.key);
  });

  it('falls back to a marker file when the filesystem has no serial', async () => {
    const root = stick();
    const exec = lsblkExec([{ mountpoint: root, serial: null, label: 'STICK', fstype: 'vfat' }]);

    const first = await readDeviceIdentity(root, { platform: 'linux', exec });
    expect(first.source).toBe('marker');
    expect(first.key).toMatch(/^marker:[0-9a-f-]{36}$/);
    expect(readMarker(root)).toMatchObject({ id: first.markerId });

    // A later read, even with the platform tool failing, keeps the same key.
    const second = await readDeviceIdentity(root, {
      platform: 'linux',
      exec: async () => {
        throw new Error('lsblk is not available');
      },
    });
    expect(second.key).toBe(first.key);
  });

  it('reads the Windows volume serial and name', async () => {
    const root = 'D:\\';
    const exec = async (command) => {
      expect(command).toBe('powershell');
      return {
        stdout: JSON.stringify({
          VolumeSerialNumber: '1A2B3C4D',
          VolumeName: 'DJMUSB',
          FileSystem: 'FAT32',
        }),
      };
    };
    const identity = await readDeviceIdentity(root, { platform: 'win32', exec });
    expect(identity).toMatchObject({
      key: 'serial:1A2B3C4D',
      label: 'DJMUSB',
      filesystem: 'FAT32',
    });
  });

  it('reads the macOS volume UUID', async () => {
    const exec = async (command) => {
      expect(command).toBe('diskutil');
      return {
        stdout: [
          '   Volume Name:               STICK',
          '   Volume UUID:               1234-ABCD',
          '   File System Personality:   MS-DOS FAT32',
        ].join('\n'),
      };
    };
    const identity = await readDeviceIdentity('/Volumes/STICK', { platform: 'darwin', exec });
    expect(identity).toMatchObject({
      key: 'serial:1234-ABCD',
      label: 'STICK',
      filesystem: 'MS-DOS FAT32',
    });
  });

  it('rejects the placeholder serials these tools print', () => {
    for (const value of ['', 'none', 'N/A', '00000000', '0x00000000', null]) {
      expect(cleanSerial(value)).toBeNull();
    }
    expect(cleanSerial(' ab12 ')).toBe('AB12');
  });

  it('does not create a marker when the caller is only reading', async () => {
    const root = stick();
    const exec = lsblkExec([{ mountpoint: root, serial: null, label: 'STICK', fstype: 'vfat' }]);

    const identity = await readDeviceIdentity(root, {
      platform: 'linux',
      exec,
      createMarker: false,
    });
    expect(identity.key).toBeNull();
    expect(readMarker(root)).toBeNull();
  });

  it('creates the marker once', () => {
    const root = stick();
    const first = ensureMarker(root, { now: () => 5 });
    const second = ensureMarker(root, { now: () => 9 });
    expect(second.id).toBe(first.id);
    expect(deviceKey({ markerId: first.id })).toBe(`marker:${first.id}`);
  });
});
