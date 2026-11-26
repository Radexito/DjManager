import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerUsbWatchIpc } from '../main/ipc/usbWatchIpc.js';
import { patchTrackField, slotRoom } from '../usb/pioneer/formats/inPlace.js';
import { writePdb } from '../usb/pioneer/formats/pdb.js';
import { readLibrary } from '../usb/pioneer/formats/pdbRead.js';

const roots = [];

function medium(tracks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medium-edit-'));
  roots.push(root);
  const file = path.join(root, 'PIONEER', 'rekordbox', 'export.pdb');
  writePdb({ usbRoot: root, tracks, playlists: [{ id: 1, name: 'Set', track_ids: [1, 2] }] }, file);
  return { root, file, buffer: fs.readFileSync(file) };
}

function track(id, title) {
  return {
    id,
    title,
    artist: 'Artist',
    album: 'Album',
    duration: 200,
    bpm: 124,
    key_raw: '8A',
    file_path: `/Contents/${id}.mp3`,
    track_number: id,
    year: 2026,
    genres: '["House"]',
    file_size: 1000,
    bitrate: 320000,
    comments: 'note',
    rating: 0,
  };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('editing a track on a medium', () => {
  it('replaces a title that fits the slot and leaves the rest of the file alone', () => {
    const { file, buffer } = medium([track(1, 'Opening'), track(2, 'Closer')]);
    const before = readLibrary(buffer);

    const result = patchTrackField(buffer, { trackId: 2, field: 'title', value: 'Close' });
    expect(result.ok).toBe(true);
    expect(result.bytes.length).toBe(buffer.length);

    const after = readLibrary(result.bytes);
    expect(after.tracks.map((t) => t.id)).toEqual(before.tracks.map((t) => t.id));
    expect(after.tracks[0].title).toBe('Opening');
    expect(after.tracks[1].title).toBe('Close');
    // Everything else about the edited row is untouched.
    const { title: _a, ...restBefore } = before.tracks[1];
    const { title: _b, ...restAfter } = after.tracks[1];
    expect(restAfter).toEqual(restBefore);
    // The playlists still point at the same rows.
    expect(after.tracksByPlaylist.get(1)).toEqual([1, 2]);

    fs.writeFileSync(file, result.bytes);
    expect(readLibrary(fs.readFileSync(file)).tracks[1].title).toBe('Close');
  });

  it('refuses a title longer than the slot instead of truncating it', () => {
    const { buffer } = medium([track(1, 'Opening'), track(2, 'Hi')]);
    const result = patchTrackField(buffer, {
      trackId: 2,
      field: 'title',
      value: 'a much longer title than the one there',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'too-long',
      limit: slotRoom(buffer, { trackId: 2 }),
    });
    expect(readLibrary(buffer).tracks[1].title).toBe('Hi');
  });

  it('edits a comment the same way', () => {
    const { buffer } = medium([track(1, 'Opening')]);
    const result = patchTrackField(buffer, { trackId: 1, field: 'comment', value: 'new' });
    expect(result.ok).toBe(true);
    expect(readLibrary(result.bytes).tracks[0].comment).toBe('new');
  });

  it('reports a track that is not on the medium', () => {
    const { buffer } = medium([track(1, 'Opening')]);
    expect(patchTrackField(buffer, { trackId: 99, value: 'x' })).toEqual({
      ok: false,
      reason: 'track not found',
    });
  });

  it('reports an unknown field', () => {
    const { buffer } = medium([track(1, 'Opening')]);
    expect(patchTrackField(buffer, { trackId: 1, field: 'nope', value: 'x' })).toEqual({
      ok: false,
      reason: 'unknown field nope',
    });
  });
});

describe('the update-usb-track channel', () => {
  function handlers() {
    const map = new Map();
    const ipcMain = { handle: (channel, fn) => map.set(channel, fn) };
    registerUsbWatchIpc({
      ipcMain,
      usbWatch: {
        start() {},
        refresh() {},
        devices: () => [],
        roots: () => [],
        isEnabled: () => true,
      },
    });
    return map;
  }

  it('writes the title to the medium and keeps a backup of the previous file', async () => {
    const { root, file } = medium([track(1, 'Opening'), track(2, 'Closer')]);
    const result = await handlers().get('update-usb-track')(null, {
      mount: root,
      trackId: 2,
      field: 'title',
      value: 'Close',
    });

    expect(result.ok).toBe(true);
    expect(result.backup).toBe('export.pdb.bak');
    expect(readLibrary(fs.readFileSync(file)).tracks[1].title).toBe('Close');
    // The backup still carries what was there before the edit.
    expect(readLibrary(fs.readFileSync(`${file}.bak`)).tracks[1].title).toBe('Closer');
  });

  it('leaves the medium alone when the new text does not fit', async () => {
    const { root, file } = medium([track(1, 'Hi')]);
    const result = await handlers().get('update-usb-track')(null, {
      mount: root,
      trackId: 1,
      field: 'title',
      value: 'a title that is definitely too long for the slot',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too-long');
    expect(readLibrary(fs.readFileSync(file)).tracks[0].title).toBe('Hi');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('answers a mount that holds no database', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'medium-empty-'));
    roots.push(empty);
    const result = await handlers().get('update-usb-track')(null, {
      mount: empty,
      trackId: 1,
      value: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot read/);
  });
});
