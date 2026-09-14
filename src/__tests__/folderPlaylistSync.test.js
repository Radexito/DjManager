// src/__tests__/folderPlaylistSync.test.js
// The pure half of folder-tracked playlists (#267) — no fs, no DB.
import { describe, it, expect } from 'vitest';
import { planFolderSync, isInsideFolder, normalisePath } from '../library/folderPlaylistSync.js';

const FOLDER = '/music/psy';
const inside = (name, dir = FOLDER) => `${dir}/${name}`;

describe('isInsideFolder', () => {
  it('accepts a file directly in the folder', () => {
    expect(isInsideFolder(inside('a.mp3'), FOLDER)).toBe(true);
  });

  it('accepts a file in a sub-folder', () => {
    expect(isInsideFolder(inside('b.mp3', `${FOLDER}/2025`), FOLDER)).toBe(true);
  });

  it('rejects a file outside, including a sibling with the same prefix', () => {
    expect(isInsideFolder('/music/psy2/a.mp3', FOLDER)).toBe(false);
    expect(isInsideFolder('/music/a.mp3', FOLDER)).toBe(false);
  });

  it('rejects the folder itself and empty input', () => {
    expect(isInsideFolder(FOLDER, FOLDER)).toBe(false);
    expect(isInsideFolder(null, FOLDER)).toBe(false);
    expect(isInsideFolder(inside('a.mp3'), null)).toBe(false);
  });

  it('with recursive: false only the folder own files count', () => {
    expect(isInsideFolder(inside('a.mp3'), FOLDER, { recursive: false })).toBe(true);
    expect(isInsideFolder(inside('b.mp3', `${FOLDER}/2025`), FOLDER, { recursive: false })).toBe(
      false
    );
  });
});

describe('normalisePath', () => {
  it('is a no-op for empty input', () => {
    expect(normalisePath('')).toBeNull();
    expect(normalisePath(undefined)).toBeNull();
  });

  it('folds case on Windows only', () => {
    expect(normalisePath('C:\\Music\\A.MP3', 'win32')).toBe(
      normalisePath('c:\\music\\a.mp3', 'win32')
    );
    expect(normalisePath('/Music/A.MP3', 'linux')).not.toBe(normalisePath('/music/a.mp3', 'linux'));
  });
});

describe('planFolderSync', () => {
  const playlistTracks = [
    { id: 1, file_path: inside('old.mp3') }, // file is gone → missing
    { id: 2, file_path: inside('kept.mp3') }, // still there
    { id: 3, file_path: '/elsewhere/manual.mp3' }, // added by hand, not the folder's business
  ];
  const folderFiles = [inside('kept.mp3'), inside('new-b.mp3'), inside('new-a.mp3')];

  it('adds what the folder has and the playlist does not, sorted', () => {
    const plan = planFolderSync({ folderFiles, playlistTracks, folder: FOLDER });
    expect(plan.add).toEqual([inside('new-a.mp3'), inside('new-b.mp3')]);
  });

  it('reports tracks the folder no longer has, but only from that folder', () => {
    const plan = planFolderSync({ folderFiles, playlistTracks, folder: FOLDER });
    expect(plan.missing).toEqual([{ id: 1, file_path: inside('old.mp3') }]);
  });

  it('counts the files that are already mirrored', () => {
    expect(planFolderSync({ folderFiles, playlistTracks, folder: FOLDER }).unchanged).toBe(1);
  });

  it('reports a track from a sub-folder the mirror no longer offers', () => {
    const plan = planFolderSync({
      folderFiles: [],
      playlistTracks: [{ id: 9, file_path: inside('x.mp3', `${FOLDER}/2025`) }],
      folder: FOLDER,
    });
    expect(plan.missing.map((m) => m.id)).toEqual([9]);
  });

  it('dedupes folder files and ignores tracks without a path', () => {
    const plan = planFolderSync({
      folderFiles: [inside('a.mp3'), inside('a.mp3')],
      playlistTracks: [{ id: 5 }, { id: 6, file_path: null }],
      folder: FOLDER,
    });
    expect(plan.add).toEqual([inside('a.mp3')]);
    expect(plan.missing).toEqual([]);
  });

  it('does not report a missing file when only the case differs on Windows', () => {
    const plan = planFolderSync({
      folderFiles: ['C:\\Music\\Psy\\Track.MP3'],
      playlistTracks: [{ id: 7, file_path: 'c:\\music\\psy\\track.mp3' }],
      folder: 'C:\\Music\\Psy',
      platform: 'win32',
    });
    expect(plan.add).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it('handles an empty folder and an empty playlist', () => {
    expect(planFolderSync({ folderFiles: [], playlistTracks: [], folder: FOLDER })).toEqual({
      add: [],
      missing: [],
      unchanged: 0,
    });
  });
});
