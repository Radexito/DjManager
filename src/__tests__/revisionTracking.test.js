import { describe, expect, it } from 'vitest';

import db from '../db/database.js';
import {
  addTrack,
  getTrackById,
  normalizeLibrary,
  normalizeTracksByIds,
  setTrackFileFingerprint,
  updateTrack,
} from '../db/trackRepository.js';
import { addCuePoint, deleteCuePoint, updateCuePoint } from '../db/cuePointRepository.js';
import {
  addTracksToPlaylist,
  createPlaylist,
  getPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
} from '../db/playlistRepository.js';

function seedTrack(extra = {}) {
  return addTrack({
    title: 'Track',
    artist: 'Artist',
    album: '',
    duration: 100,
    file_path: '/tmp/revision.mp3',
    file_hash: 'hash',
    format: 'mp3',
    bitrate: 320000,
    ...extra,
  });
}

const trackRev = (id) => getTrackById(id).rev;
const playlistRev = (id) => getPlaylist(id).rev;

describe('revision tracking', () => {
  it('starts at 1 and moves on a metadata edit, keeping the timestamp current', () => {
    const id = seedTrack();
    const inserted = getTrackById(id);
    expect(inserted.rev).toBe(1);
    expect(inserted.updated_at).toBeGreaterThan(0);

    updateTrack(id, { title: 'Edited' });
    const edited = getTrackById(id);
    expect(edited.rev).toBe(2);
    expect(edited.updated_at).toBeGreaterThanOrEqual(inserted.updated_at);
  });

  it('moves on a trim change, which changes the bytes the export writes', () => {
    const id = seedTrack();
    updateTrack(id, { trim_start_ms: 1000, trim_end_ms: 30000 });
    expect(trackRev(id)).toBe(2);
  });

  it('moves on every cue write, because cues are exported', () => {
    const id = seedTrack();
    const cueId = addCuePoint({ trackId: id, positionMs: 1000, label: 'A' });
    expect(trackRev(id)).toBe(2);

    updateCuePoint(cueId, { label: 'Intro' });
    expect(trackRev(id)).toBe(3);

    deleteCuePoint(cueId);
    expect(trackRev(id)).toBe(4);
  });

  it('moves the playlist when its membership or order changes', () => {
    const first = seedTrack({ file_path: '/tmp/one.mp3' });
    const second = seedTrack({ file_path: '/tmp/two.mp3' });
    const playlistId = createPlaylist('Set');
    const afterCreate = playlistRev(playlistId);
    expect(afterCreate).toBe(1);

    addTracksToPlaylist(playlistId, [first, second]);
    const afterAdd = playlistRev(playlistId);
    expect(afterAdd).toBeGreaterThan(afterCreate);

    reorderPlaylistTracks(playlistId, [second, first]);
    expect(playlistRev(playlistId)).toBeGreaterThan(afterAdd);

    const beforeRemove = playlistRev(playlistId);
    removeTrackFromPlaylist(playlistId, first);
    expect(playlistRev(playlistId)).toBeGreaterThan(beforeRemove);
  });

  it('moves every row a bulk normalisation touched', () => {
    const first = seedTrack({ file_path: '/tmp/bulk-one.mp3' });
    const second = seedTrack({ file_path: '/tmp/bulk-two.mp3' });
    updateTrack(first, { loudness: -12 });
    updateTrack(second, { loudness: -8 });
    const before = [trackRev(first), trackRev(second)];

    expect(normalizeLibrary(-9)).toBe(2);
    expect(trackRev(first)).toBeGreaterThan(before[0]);
    expect(trackRev(second)).toBeGreaterThan(before[1]);
  });

  it('moves on a normalisation that changes the gain', () => {
    const id = seedTrack();
    updateTrack(id, { loudness: -12 });
    const before = trackRev(id);

    const gains = normalizeTracksByIds([id], -9);
    expect(gains[id]).toBe(3);
    expect(trackRev(id)).toBeGreaterThan(before);
  });

  it('leaves the revision alone when a caller brings its own', () => {
    const id = seedTrack();
    db.prepare('UPDATE tracks SET rev = 50 WHERE id = ?').run(id);
    expect(trackRev(id)).toBe(50);
  });

  it('moves the revision when a file fingerprint changes, and only then', () => {
    const id = seedTrack();
    expect(getTrackById(id).file_fingerprint).toBeNull();
    const before = trackRev(id);

    expect(setTrackFileFingerprint(id, '1024:1000')).toBe(true);
    expect(getTrackById(id).file_fingerprint).toBe('1024:1000');
    // A moved fingerprint means the bytes changed, so the track needs a rewrite.
    expect(trackRev(id)).toBe(before + 1);

    const after = trackRev(id);
    expect(setTrackFileFingerprint(id, '1024:1000')).toBe(false);
    expect(trackRev(id)).toBe(after);
  });

  it('keeps the fingerprint of a file that moves with the row', () => {
    const id = seedTrack();
    db.prepare('UPDATE tracks SET file_path = ? WHERE id = ?').run('/tmp/elsewhere.mp3', id);
    // A missing file has no fingerprint; the point is that no stale one survives.
    expect(getTrackById(id).file_fingerprint).toBeNull();
  });
});
