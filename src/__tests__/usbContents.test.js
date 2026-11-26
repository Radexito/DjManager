import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readMedium } from '../usb/pioneer/contents.js';
import { buildExtPdbBuffer } from '../usb/pioneer/formats/extPdb.js';
import { writePdb } from '../usb/pioneer/formats/pdb.js';
import { saveManifest } from '../usb/pioneer/manifest.js';

let roots = [];

function medium() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-medium-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'PIONEER', 'rekordbox'), { recursive: true });
  return root;
}

function track(id, title, artist) {
  return {
    id,
    title,
    artist,
    album: 'Album',
    duration: 200,
    bpm: 124,
    key_raw: '8A',
    file_path: `/Contents/${id} - ${title}.mp3`,
    track_number: id,
    year: '2026',
    label: 'Label',
    genres: '["House"]',
    file_size: 1000,
    bitrate: 320000,
    comments: '',
    rating: 0,
    replay_gain: null,
  };
}

function writeMedium(root, { tracks, playlists, tags = [], trackTags = [], duplicateTags = [] }) {
  writePdb(
    { usbRoot: root, tracks, playlists, artwork: [] },
    path.join(root, 'PIONEER', 'rekordbox', 'export.pdb')
  );
  if (tags.length > 0) {
    fs.writeFileSync(
      path.join(root, 'PIONEER', 'rekordbox', 'exportExt.pdb'),
      buildExtPdbBuffer({ tags: [...tags, ...duplicateTags], trackTags, masterTagId: 4242 })
    );
  }
  const trackMap = new Map(tracks.map((row) => [row.id, row]));
  const playlistMap = new Map(playlists.map((row) => [row.id, row]));
  saveManifest(root, trackMap, playlistMap);
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('reading a medium', () => {
  it('reports the tracks, the playlists and their membership', () => {
    const root = medium();
    writeMedium(root, {
      tracks: [track(1, 'Opening', 'Artist'), track(2, 'Closer', 'Artist')],
      playlists: [
        { id: 7, name: 'Set', track_ids: [1, 2] },
        { id: 8, name: 'Warm up', track_ids: [1] },
        { id: 9, name: 'Empty', track_ids: [] },
      ],
    });

    const contents = readMedium(root);

    expect(contents).not.toBeNull();
    expect(contents.trackCount).toBe(2);
    expect(contents.playlistCount).toBe(3);
    expect(contents.ours).toBe(true);
    expect(contents.playlists.map((playlist) => [playlist.name, playlist.trackCount])).toEqual([
      ['Set', 2],
      ['Warm up', 1],
      ['Empty', 0],
    ]);
    expect(contents.playlists[0].tracks).toMatchObject([
      { id: 1, title: 'Opening', artist: 'Artist', album: 'Album' },
      { id: 2, title: 'Closer', artist: 'Artist', album: 'Album' },
    ]);

    // The table draws these columns, so the medium has to answer them.
    const [first] = contents.playlists[0].tracks;
    for (const field of ['bpm', 'duration', 'rating', 'year']) {
      expect(typeof first[field]).toBe('number');
    }
    expect(first.bpm).toBe(124);
    expect(first.duration).toBe(200);
  });

  it('reads the tag tree, with categories over their own tags', () => {
    const root = medium();
    writeMedium(root, {
      tracks: [track(1, 'Opening', 'Artist')],
      playlists: [],
      tags: [
        { id: 1, name: 'Genre', position: 0, isCategory: true },
        { id: 2, name: 'Components', position: 1, isCategory: true },
        { id: 3, name: 'Trap', categoryId: 1, position: 0 },
        { id: 4, name: 'Beat', categoryId: 2, position: 0 },
        { id: 5, name: 'Vocal', categoryId: 2, position: 1 },
      ],
    });

    const contents = readMedium(root);

    expect(contents.tagCount).toBe(3);
    expect(
      contents.tags.map((category) => [category.name, category.tags.map((tag) => tag.name)])
    ).toEqual([
      ['Genre', ['Trap']],
      ['Components', ['Beat', 'Vocal']],
    ]);
  });

  it('keeps a tag whose category is missing instead of dropping it', () => {
    const root = medium();
    writeMedium(root, {
      tracks: [track(1, 'Opening', 'Artist')],
      playlists: [],
      tags: [
        { id: 1, name: 'Genre', position: 0, isCategory: true },
        { id: 2, name: 'Loose', categoryId: 99, position: 0 },
      ],
    });

    expect(
      readMedium(root).tags.map((category) => [category.name, category.tags.map((tag) => tag.name)])
    ).toEqual([
      ['Genre', []],
      ['Uncategorised', ['Loose']],
    ]);
  });

  it('collapses a tag row that the export wrote more than once', () => {
    const root = medium();
    const genre = { id: 1, name: 'Genre', position: 0, isCategory: true };
    const trap = { id: 3, name: 'Trap', categoryId: 1, position: 0 };
    writeMedium(root, {
      tracks: [track(1, 'Opening', 'Artist')],
      playlists: [],
      tags: [genre, trap],
      // What a medium written by a second export pass looks like: the same rows
      // again, same ids. The tree is the set of tags, not the file's row count.
      duplicateTags: [genre, trap, genre, trap],
    });

    const contents = readMedium(root);

    expect(contents.tags).toHaveLength(1);
    expect(contents.tags[0].tags).toHaveLength(1);
    expect(contents.tagCount).toBe(1);
  });

  it('names the tracks carrying a tag, and where their files are', () => {
    const root = medium();
    writeMedium(root, {
      tracks: [track(1, 'Opening', 'Artist'), track(2, 'Closer', 'Artist')],
      playlists: [],
      tags: [
        { id: 1, name: 'Genre', position: 0, isCategory: true },
        { id: 3, name: 'Trap', categoryId: 1, position: 0 },
      ],
      trackTags: [
        { trackId: 1, tagId: 3 },
        { trackId: 2, tagId: 3 },
      ],
    });

    const contents = readMedium(root);
    const tag = contents.tags[0].tags[0];

    expect(tag.name).toBe('Trap');
    expect(tag.trackCount).toBe(2);
    expect(tag.tracks.map((row) => row.title)).toEqual(['Opening', 'Closer']);
    // The player opens a path, not an id, and a medium is a mounted directory.
    expect(tag.tracks[0].file_path).toBe(path.join(root, 'Contents', '1 - Opening.mp3'));
  });

  it('answers null for a folder that carries no playlist database', () => {
    const root = medium();
    expect(readMedium(root)).toBeNull();
    expect(readMedium('')).toBeNull();
  });
});
