import { describe, expect, it, vi } from 'vitest';

import {
  collectActions,
  playlistSignature,
  refreshFileFingerprints,
} from '../sync/changeTracker.js';

const track = { id: 1, title: 'A', rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '10:100' };
const trackState = { track_id: 1, rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '10:100' };
const playlist = { id: 10, name: 'Set', rev: 3, trackIds: [1, 2] };
const playlistState = { playlist_id: 10, rev: 3, signature: '1,2' };

describe('change tracker', () => {
  it('reports nothing and writes nothing when the library did not change', () => {
    const actions = collectActions({
      tracks: [track],
      trackStates: new Map([[1, trackState]]),
      playlists: [playlist],
      playlistStates: new Map([[10, playlistState]]),
    });
    expect(actions).toEqual([]);

    const save = vi.fn();
    const readFingerprint = vi.fn(() => '10:100');
    const result = refreshFileFingerprints({
      tracks: [{ ...track }],
      readFingerprint,
      save,
    });
    expect(result).toEqual({ updated: 0, changed: [] });
    expect(save).not.toHaveBeenCalled();
    expect(readFingerprint).toHaveBeenCalledTimes(1);
  });

  it('asks for a copy of a track the device does not carry', () => {
    const actions = collectActions({ tracks: [track], trackStates: new Map() });
    expect(actions).toEqual([{ type: 'copy', trackId: 1, title: 'A' }]);
  });

  it('asks for an update when a revision or the file moved', () => {
    expect(
      collectActions({
        tracks: [{ ...track, rev: 3 }],
        trackStates: new Map([[1, trackState]]),
      })[0]
    ).toMatchObject({ type: 'update', trackId: 1, reasons: ['rev'] });

    expect(
      collectActions({
        tracks: [{ ...track, file_fingerprint: '11:200' }],
        trackStates: new Map([[1, trackState]]),
      })[0]
    ).toMatchObject({ type: 'update', reasons: ['file'] });
  });

  it('ignores the device path in the state, which is not the library path', () => {
    // What recordExportState stores is the path on the medium. The library row
    // holds a local path, so a comparison would report every track as changed
    // on every preview.
    const onDevice = {
      track_id: 1,
      rev: 2,
      file_path: '/Contents/A.mp3',
      file_fingerprint: '10:100',
    };
    expect(collectActions({ tracks: [track], trackStates: new Map([[1, onDevice]]) })).toEqual([]);
  });

  it('detects playlists that are new or whose order changed', () => {
    expect(collectActions({ playlists: [playlist], playlistStates: new Map() })[0]).toMatchObject({
      type: 'playlist',
      playlistId: 10,
      reason: 'new',
    });

    expect(
      collectActions({
        playlists: [{ ...playlist, trackIds: [2, 1] }],
        playlistStates: new Map([[10, playlistState]]),
      })[0]
    ).toMatchObject({ type: 'playlist', playlistId: 10, reason: 'changed' });
  });

  it('writes a fingerprint only when the file moved', () => {
    const save = vi.fn();
    const rows = [{ ...track }, { id: 2, rev: 1, file_path: '/lib/b.mp3', file_fingerprint: null }];
    const result = refreshFileFingerprints({
      tracks: rows,
      readFingerprint: (filePath) => (filePath === '/lib/b.mp3' ? '20:200' : '10:100'),
      save,
    });

    expect(result.updated).toBe(1);
    expect(result.changed).toEqual([2]);
    expect(save).toHaveBeenCalledWith(2, '20:200');
    expect(rows[1].file_fingerprint).toBe('20:200');
  });

  it('signs a playlist by its order', () => {
    expect(playlistSignature([1, 2, 3])).toBe('1,2,3');
    expect(playlistSignature([3, 2, 1])).not.toBe(playlistSignature([1, 2, 3]));
  });
});
