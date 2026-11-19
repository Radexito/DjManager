import fs from 'node:fs';
import path from 'node:path';

/** Normalises separators so Windows-style paths behave on every platform. */
function toPosixPath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Builds a single M3U entry: the audio file expressed RELATIVE to the directory
 * that holds the .m3u file, always with forward slashes.
 *
 * Players resolve M3U entries against the playlist's own directory. Writing the
 * USB-root path (`/music/Artist - Title.mp3`) makes VLC interpret it as an
 * absolute host path (`file:///music/...`) and fail with "unable to open the
 * MRL". So a playlist in `<usb>/playlists/x.m3u` referencing
 * `<usb>/music/a.mp3` must contain `../music/a.mp3`, and an audio file sitting
 * next to the playlist must contain `a.mp3` (no `./` prefix, which some players
 * dislike).
 *
 * Nothing here assumes the name of the audio folder, so renaming it is safe.
 *
 * @param {string} m3uDirAbs - absolute directory containing the .m3u file
 * @param {string} usbAudioPathAbs - absolute path of the audio file on the stick
 * @returns {string} forward-slashed path relative to `m3uDirAbs`
 */
export function toM3uRelativePath(m3uDirAbs, usbAudioPathAbs) {
  const rel = path.relative(toPosixPath(m3uDirAbs), toPosixPath(usbAudioPathAbs));
  return rel.replace(/\\/g, '/');
}

/**
 * Write an extended M3U playlist into its own folder.
 *
 * Entries may be plain absolute paths or objects carrying the duration and
 * label that make the playlist readable in players that show track info.
 * @param {{dir: string, name: string, entries: Array<string|{path: string, duration?: number, label?: string}>}} options
 * @returns {string} path of the file written
 */
export function writeM3uPlaylist({ dir, name, entries }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.m3u`);
  const lines = ['#EXTM3U'];
  for (const entry of entries) {
    const item = typeof entry === 'string' ? { path: entry } : entry;
    if (Number.isFinite(item.duration)) {
      lines.push(`#EXTINF:${Math.floor(item.duration)},${item.label ?? path.basename(item.path)}`);
    }
    lines.push(toM3uRelativePath(dir, item.path));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}
