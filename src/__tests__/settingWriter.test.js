import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => {
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const mod = { writeFileSync, mkdirSync };
  return { default: mod, ...mod };
});

import {
  crc16xmodem,
  buildSettingFile,
  buildMySettingPayload,
  buildMySetting2Payload,
  buildDevSettingPayload,
  writeSettingFiles,
} from '../usb/settingWriter.js';
import fs from 'fs';

// ── CRC-16/XMODEM ─────────────────────────────────────────────────────────────

describe('crc16xmodem', () => {
  it('returns 0 for empty buffer', () => {
    expect(crc16xmodem(Buffer.alloc(0))).toBe(0);
  });

  it('matches known test vector: "123456789" → 0x31C3', () => {
    // Standard CRC-16/XMODEM check value for ASCII "123456789"
    expect(crc16xmodem(Buffer.from('123456789', 'ascii'))).toBe(0x31c3);
  });

  it('returns a number in the u16 range (0–65535)', () => {
    const crc = crc16xmodem(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xffff);
  });
});

// ── Payload sizes ─────────────────────────────────────────────────────────────

describe('payload builders', () => {
  it('buildMySettingPayload returns exactly 40 bytes', () => {
    expect(buildMySettingPayload().length).toBe(40);
  });

  it('buildMySetting2Payload returns exactly 40 bytes', () => {
    expect(buildMySetting2Payload().length).toBe(40);
  });

  it('buildDevSettingPayload returns exactly 32 bytes', () => {
    expect(buildDevSettingPayload().length).toBe(32);
  });

  it('MYSETTING payload starts with known magic bytes 78 56 34 12', () => {
    const payload = buildMySettingPayload();
    expect(payload[0]).toBe(0x78);
    expect(payload[1]).toBe(0x56);
    expect(payload[2]).toBe(0x34);
    expect(payload[3]).toBe(0x12);
  });

  it('DEVSETTING payload starts with known magic bytes 78 56 34 12', () => {
    const payload = buildDevSettingPayload();
    expect(payload[0]).toBe(0x78);
    expect(payload[1]).toBe(0x56);
    expect(payload[2]).toBe(0x34);
    expect(payload[3]).toBe(0x12);
  });
});

// ── buildSettingFile structure ─────────────────────────────────────────────────

describe('buildSettingFile', () => {
  const payload = Buffer.alloc(40, 0xaa);

  it('total size = 104 header + payload + 4 footer', () => {
    const file = buildSettingFile('PIONEER', payload);
    expect(file.length).toBe(104 + payload.length + 4);
  });

  it('first u32 LE = 0x60 (len_stringdata)', () => {
    const file = buildSettingFile('PIONEER', payload);
    expect(file.readUInt32LE(0)).toBe(0x60);
  });

  it('brand string is written at offset 4', () => {
    const file = buildSettingFile('PIONEER', payload);
    expect(file.toString('ascii', 4, 4 + 7)).toBe('PIONEER');
  });

  it('software field contains "rekordbox" at offset 36', () => {
    const file = buildSettingFile('PIONEER', payload);
    expect(file.toString('ascii', 36, 36 + 9)).toBe('rekordbox');
  });

  it('version field contains "6.6.1" at offset 68', () => {
    const file = buildSettingFile('PIONEER', payload);
    expect(file.toString('ascii', 68, 68 + 5)).toBe('6.6.1');
  });

  it('len_data u32 LE at offset 100 equals payload length', () => {
    const file = buildSettingFile('PIONEER', payload);
    expect(file.readUInt32LE(100)).toBe(payload.length);
  });

  it('footer u16 at offset 104+payloadLen is a valid CRC', () => {
    const file = buildSettingFile('PIONEER', payload);
    const footerCrc = file.readUInt16LE(104 + payload.length);
    expect(footerCrc).toBe(crc16xmodem(payload));
  });

  it('last two bytes are 0x0000', () => {
    const file = buildSettingFile('PIONEER', payload);
    expect(file.readUInt16LE(file.length - 2)).toBe(0x0000);
  });

  it('MYSETTING.DAT total size is 148 bytes (104 + 40 + 4)', () => {
    const file = buildSettingFile('PIONEER', buildMySettingPayload());
    expect(file.length).toBe(148);
  });

  it('DEVSETTING.DAT total size is 140 bytes (104 + 32 + 4)', () => {
    const file = buildSettingFile('PIONEER DJ', buildDevSettingPayload());
    expect(file.length).toBe(140);
  });

  it('DEVSETTING uses "PIONEER DJ" brand', () => {
    const file = buildSettingFile('PIONEER DJ', buildDevSettingPayload());
    expect(file.toString('ascii', 4, 4 + 10)).toBe('PIONEER DJ');
  });
});

// ── writeSettingFiles ─────────────────────────────────────────────────────────

describe('writeSettingFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the PIONEER directory', () => {
    writeSettingFiles('/mnt/usb');
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('PIONEER'), {
      recursive: true,
    });
  });

  it('writes exactly 3 files', () => {
    writeSettingFiles('/mnt/usb');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
  });

  it('writes MYSETTING.DAT', () => {
    writeSettingFiles('/mnt/usb');
    const paths = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(paths.some((p) => p.endsWith('MYSETTING.DAT'))).toBe(true);
  });

  it('writes MYSETTING2.DAT', () => {
    writeSettingFiles('/mnt/usb');
    const paths = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(paths.some((p) => p.endsWith('MYSETTING2.DAT'))).toBe(true);
  });

  it('writes DEVSETTING.DAT', () => {
    writeSettingFiles('/mnt/usb');
    const paths = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(paths.some((p) => p.endsWith('DEVSETTING.DAT'))).toBe(true);
  });

  it('all files are inside usbRoot/PIONEER/', () => {
    writeSettingFiles('/mnt/usb');
    for (const [filePath] of fs.writeFileSync.mock.calls) {
      expect(filePath).toMatch(/\/mnt\/usb[/\\]PIONEER[/\\]/);
    }
  });

  it('MYSETTING.DAT content is a valid 148-byte Buffer', () => {
    writeSettingFiles('/mnt/usb');
    const call = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('MYSETTING.DAT'));
    expect(Buffer.isBuffer(call[1])).toBe(true);
    expect(call[1].length).toBe(148);
  });

  it('DEVSETTING.DAT content is a valid 140-byte Buffer', () => {
    writeSettingFiles('/mnt/usb');
    const call = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('DEVSETTING.DAT'));
    expect(Buffer.isBuffer(call[1])).toBe(true);
    expect(call[1].length).toBe(140);
  });
});
