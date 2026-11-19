import path from 'node:path';

/** Folder on the stick that holds the exported audio, next to PIONEER/. */
export const USB_AUDIO_DIR = 'Contents';

/** Absolute path of the audio folder on a mounted stick. */
export function usbAudioDir(usbRoot) {
  return path.join(usbRoot, USB_AUDIO_DIR);
}

/** USB-relative path of one track's audio file, e.g. `/Contents/Artist - Title.mp3`. */
export function usbAudioPath(filename) {
  return `/${USB_AUDIO_DIR}/${filename}`;
}
