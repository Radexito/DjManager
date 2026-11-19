import { describe, it, expect } from 'vitest';
import path from 'path';

import { USB_AUDIO_DIR, usbAudioDir, usbAudioPath } from '../usb/pioneer/paths.js';

describe('USB audio folder', () => {
  it("matches Rekordbox's folder name", () => {
    expect(USB_AUDIO_DIR).toBe('Contents');
  });

  it('resolves the audio directory under the given usbRoot', () => {
    expect(usbAudioDir('/media/dj/REKORDBOX')).toBe(
      path.join('/media/dj/REKORDBOX', USB_AUDIO_DIR)
    );
    expect(path.basename(usbAudioDir('/media/dj/REKORDBOX'))).toBe('Contents');
  });

  it('builds the USB-relative path of one copied file', () => {
    expect(usbAudioPath('Artist - Title.mp3')).toBe('/Contents/Artist - Title.mp3');
  });

  it('keeps spaces and non-ASCII characters intact', () => {
    const name = 'Beyoncé - Déjà Vu (Extended Mix) 曲 01.flac';
    expect(usbAudioPath(name)).toBe(`/Contents/${name}`);
  });

  it('always uses forward slashes in the USB-relative path', () => {
    expect(usbAudioPath('a.mp3')).not.toContain('\\');
  });
});
