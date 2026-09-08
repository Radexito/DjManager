import { describe, it, expect } from 'vitest';
import { DEVICE_PROFILES, resolveExportFormat } from '../usb/deviceFormats.js';

describe('resolveExportFormat', () => {
  it('returns null when no device and no forceMp3 (keep source format)', () => {
    expect(resolveExportFormat({ srcExt: '.wav', deviceKey: null, forceMp3: false })).toBeNull();
  });

  it('returns null when the device already supports the source format', () => {
    expect(
      resolveExportFormat({ srcExt: '.mp3', deviceKey: 'xdj-rx2', forceMp3: false })
    ).toBeNull();
  });

  it('converts an unsupported format to the highest-quality supported one', () => {
    // XDJ-RX2 doesn't support flac — should fall back down the quality order to wav
    expect(resolveExportFormat({ srcExt: '.flac', deviceKey: 'xdj-rx2', forceMp3: false })).toBe(
      'wav'
    );
  });

  it('keeps flac for devices that support it', () => {
    expect(
      resolveExportFormat({ srcExt: '.flac', deviceKey: 'cdj-3000', forceMp3: false })
    ).toBeNull();
  });

  it('falls back to mp3 for an unknown device key', () => {
    // unknown keys are treated as "no device" -> no conversion
    expect(
      resolveExportFormat({ srcExt: '.wav', deviceKey: 'not-a-real-device', forceMp3: false })
    ).toBeNull();
  });

  it('forceMp3 overrides device logic and converts everything except existing mp3', () => {
    expect(resolveExportFormat({ srcExt: '.flac', deviceKey: 'cdj-3000', forceMp3: true })).toBe(
      'mp3'
    );
    expect(
      resolveExportFormat({ srcExt: '.mp3', deviceKey: 'cdj-3000', forceMp3: true })
    ).toBeNull();
  });

  it('is case-insensitive and tolerates missing leading dot', () => {
    expect(
      resolveExportFormat({ srcExt: 'MP3', deviceKey: 'xdj-rx2', forceMp3: false })
    ).toBeNull();
    expect(resolveExportFormat({ srcExt: 'FLAC', deviceKey: 'xdj-rx2', forceMp3: false })).toBe(
      'wav'
    );
  });

  it('every device profile lists at least one supported format', () => {
    for (const key of Object.keys(DEVICE_PROFILES)) {
      expect(DEVICE_PROFILES[key].supported.length).toBeGreaterThan(0);
    }
  });
});
