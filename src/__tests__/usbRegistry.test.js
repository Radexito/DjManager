import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CAPABILITY,
  USB_FORMATS,
  UsbFormatError,
  detectUsbFormat,
  openUsbDevice,
} from '../usb/index.js';
import { candidateRoots } from '../usb/generic/roots.js';
import { hasPioneerDatabase, isPioneerUsb } from '../usb/pioneer/detect.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'djman-usb-'));
}

/** A directory that looks like a prepared Pioneer stick. */
function pioneerRoot() {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'PIONEER', 'rekordbox'), { recursive: true });
  return root;
}

describe('isPioneerUsb', () => {
  it('recognises the PIONEER folder', () => {
    expect(isPioneerUsb(pioneerRoot())).toBe(true);
  });

  it('rejects a plain folder', () => {
    expect(isPioneerUsb(tempDir())).toBe(false);
    expect(isPioneerUsb('')).toBe(false);
  });

  it('reports whether the playlist database is there', () => {
    const root = pioneerRoot();
    expect(hasPioneerDatabase(root)).toBe(false);
    fs.writeFileSync(path.join(root, 'PIONEER', 'rekordbox', 'export.pdb'), '');
    expect(hasPioneerDatabase(root)).toBe(true);
  });
});

describe('detectUsbFormat', () => {
  it('names the pioneer layout', () => {
    expect(detectUsbFormat(pioneerRoot())).toBe('pioneer');
  });

  it('returns null for a folder no format claims', () => {
    expect(detectUsbFormat(tempDir())).toBeNull();
    expect(detectUsbFormat('')).toBeNull();
  });

  it('consults whatever registry it is handed, so a second format can be added', () => {
    const formats = {
      fake: { id: 'fake', matches: () => true, open: () => ({ format: 'fake' }) },
    };
    expect(detectUsbFormat(tempDir(), formats)).toBe('fake');
    expect(detectUsbFormat(pioneerRoot(), formats)).toBe('fake');
  });
});

describe('openUsbDevice', () => {
  it('opens a pioneer stick through the manager', async () => {
    const root = pioneerRoot();
    const device = await openUsbDevice(root);

    expect(device.format).toBe('pioneer');
    expect(device.root).toBe(root);
    expect(device.capabilities).toEqual({
      library: CAPABILITY.write,
      cues: CAPABILITY.readWrite,
      settings: CAPABILITY.write,
    });
    expect(typeof device.write.database).toBe('function');
    expect(typeof device.read.cues).toBe('function');
  });

  it('opens a second format registered alongside pioneer', async () => {
    const opened = [];
    const formats = {
      ...USB_FORMATS,
      traktor: {
        id: 'traktor',
        matches: (root) => root.endsWith('TRAKTOR'),
        open: (root) => {
          opened.push(root);
          return { format: 'traktor', root, capabilities: {}, read: {}, write: {} };
        },
      },
    };
    const root = path.join(tempDir(), 'TRAKTOR');
    fs.mkdirSync(root, { recursive: true });

    const device = await openUsbDevice(root, { formats });
    expect(device.format).toBe('traktor');
    expect(opened).toEqual([root]);
  });

  it('refuses a folder no format recognises', async () => {
    await expect(openUsbDevice(tempDir())).rejects.toBeInstanceOf(UsbFormatError);
  });
});

describe('candidateRoots', () => {
  it('walks drive letters on Windows', () => {
    const roots = candidateRoots({
      platform: 'win32',
      env: {},
      exists: (p) => p === 'D:\\' || p === 'E:\\',
    });
    expect(roots).toEqual(['D:\\', 'E:\\']);
  });

  it('reads /Volumes on macOS', () => {
    const roots = candidateRoots({
      platform: 'darwin',
      env: {},
      exists: () => true,
      readdir: () => [{ name: 'REKORDBOX', isDirectory: () => true }],
    });
    expect(roots).toEqual(['/Volumes/REKORDBOX']);
  });

  it('looks under the user mount points on Linux', () => {
    const seen = [];
    const roots = candidateRoots({
      platform: 'linux',
      env: { USER: 'dj' },
      exists: () => true,
      readdir: (dir) => {
        seen.push(dir);
        return dir === '/run/media/dj' ? [{ name: 'STICK', isDirectory: () => true }] : [];
      },
    });
    expect(seen).toContain('/run/media/dj');
    expect(roots).toContain('/run/media/dj/STICK');
  });
});

describe('USB_FORMATS', () => {
  it('registers pioneer with a predicate and a factory', () => {
    expect(Object.keys(USB_FORMATS)).toEqual(['pioneer']);
    expect(typeof USB_FORMATS.pioneer.matches).toBe('function');
    expect(typeof USB_FORMATS.pioneer.open).toBe('function');
  });
});
