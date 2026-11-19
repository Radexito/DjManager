/**
 * Extensions the app treats as audio, in one place.
 *
 * The explorer lists them, the recursive walk collects them and the USB export
 * filters them, so three copies would drift the moment one format is added.
 */
export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.opus',
]);
