import fs from 'node:fs';
import os from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { toM3uRelativePath, writeM3uPlaylist } from '../usb/generic/m3u.js';
import { usbAudioPath } from '../usb/pioneer/paths.js';

/** Mount point of the test USB stick; every playlist and audio path hangs off it. */
const USB = '/media/user/USB';
/** Folder the exporter writes playlists into, a sibling of the audio folder. */
const PLAYLIST_DIR = `${USB}/playlists`;

describe('toM3uRelativePath — playlist in a sibling folder', () => {
  it('goes up out of the playlists folder into the audio folder', () => {
    expect(toM3uRelativePath(PLAYLIST_DIR, `${USB}/music/Artist - Title.mp3`)).toBe(
      '../music/Artist - Title.mp3'
    );
  });

  it('does not hardcode the audio folder name (rename-safe)', () => {
    expect(toM3uRelativePath(PLAYLIST_DIR, `${USB}/audio-files/x.mp3`)).toBe(
      '../audio-files/x.mp3'
    );
    expect(toM3uRelativePath(PLAYLIST_DIR, `${USB}/tracks/deep/x.mp3`)).toBe(
      '../tracks/deep/x.mp3'
    );
  });

  it('result is never absolute — a leading slash makes VLC open file:///music/...', () => {
    const rel = toM3uRelativePath(PLAYLIST_DIR, `${USB}/music/x.mp3`);
    expect(rel.startsWith('/')).toBe(false);
    expect(rel.includes('\\')).toBe(false);
  });
});

describe('toM3uRelativePath — audio file next to the playlist', () => {
  it('returns the bare filename without a ./ prefix', () => {
    expect(toM3uRelativePath(PLAYLIST_DIR, `${PLAYLIST_DIR}/x.mp3`)).toBe('x.mp3');
  });

  it('does not prepend ./ for an audio file in a subfolder of the playlist dir', () => {
    expect(toM3uRelativePath(PLAYLIST_DIR, `${PLAYLIST_DIR}/sub/x.mp3`)).toBe('sub/x.mp3');
  });
});

describe('toM3uRelativePath — awkward but legal filenames', () => {
  it('keeps spaces and the bracket id from the downloader in the entry', () => {
    const name = 'Smitten Limited 10 - Winnebago Warriors - Trailer Trash [qTbFL39SheU].mp3';
    expect(toM3uRelativePath(PLAYLIST_DIR, `${USB}/music/${name}`)).toBe(`../music/${name}`);
  });

  it('keeps unicode characters untouched', () => {
    const name = 'Sigur Rós - Hoppípolla [aB3xY].flac';
    expect(toM3uRelativePath(PLAYLIST_DIR, `${USB}/music/${name}`)).toBe(`../music/${name}`);
    expect(toM3uRelativePath(PLAYLIST_DIR, `${USB}/music/曲 [あ].mp3`)).toBe(
      '../music/曲 [あ].mp3'
    );
  });

  it('keeps a playlist folder name with spaces', () => {
    expect(toM3uRelativePath(`${USB}/my playlists`, `${USB}/music/x.mp3`)).toBe('../music/x.mp3');
  });
});

describe('toM3uRelativePath — Windows-style input', () => {
  it('converts backslash inputs into a forward-slash entry', () => {
    expect(toM3uRelativePath('E:\\usb\\playlists', 'E:\\usb\\music\\a.mp3')).toBe('../music/a.mp3');
  });

  it('handles a Windows drive root used directly as the playlist folder', () => {
    expect(toM3uRelativePath('E:\\', 'E:\\music\\a.mp3')).toBe('music/a.mp3');
  });

  it('handles mixed separators without emitting backslashes', () => {
    const rel = toM3uRelativePath('E:/usb/playlists', 'E:\\usb\\music\\a.mp3');
    expect(rel).toBe('../music/a.mp3');
    expect(rel.includes('\\')).toBe(false);
  });

  it('handles a D: style root playlist folder pointing at a sibling folder', () => {
    expect(toM3uRelativePath('D:\\playlists', 'D:\\music\\a.mp3')).toBe('../music/a.mp3');
  });
});

describe('toM3uRelativePath — stays quiet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes nothing to console.log/console.warn', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    toM3uRelativePath(PLAYLIST_DIR, `${USB}/music/x.mp3`);

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('toM3uRelativePath — the export-all call site', () => {
  const ROOT = 'U:\\';
  const DIR = 'U:\\playlists';

  it('produces a working entry for the value usbAudioPath() hands over', () => {
    const stored = usbAudioPath("Drake - Drake - God's Plan.mp3");
    expect(stored.startsWith('/')).toBe(true);

    const entry = toM3uRelativePath(DIR, path.win32.join(ROOT, stored));
    expect(entry).toBe("../Contents/Drake - Drake - God's Plan.mp3");
    expect(entry.startsWith('/')).toBe(false);
    expect(/^[A-Za-z]:/.test(entry)).toBe(false);
  });

  it('resolves back to the audio file that really sits on the stick', () => {
    const entry = toM3uRelativePath(DIR, path.win32.join(ROOT, usbAudioPath('a.mp3')));
    expect(path.win32.normalize(path.win32.join(DIR, entry))).toBe('U:\\Contents\\a.mp3');
  });
});

describe('writeM3uPlaylist', () => {
  it('writes an extended playlist with paths relative to the file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-m3u-'));
    const audio = path.join(root, 'Contents', 'Artist - Title.mp3');
    fs.mkdirSync(path.dirname(audio), { recursive: true });
    fs.writeFileSync(audio, '');

    const file = writeM3uPlaylist({
      dir: path.join(root, 'playlists'),
      name: 'Warm Up',
      entries: [{ path: audio, duration: 61.4, label: 'Artist - Title' }, audio],
    });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

    expect(lines[0]).toBe('#EXTM3U');
    expect(lines[1]).toBe('#EXTINF:61,Artist - Title');
    expect(lines[2]).toBe('../Contents/Artist - Title.mp3');
    expect(lines[3]).toBe('../Contents/Artist - Title.mp3');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
