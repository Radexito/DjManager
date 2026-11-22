import { describe, expect, it, vi } from 'vitest';

import { buildPreview, planHash } from '../sync/preview.js';

const track = { id: 1, title: 'A', rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' };
const other = { id: 2, title: 'B', rev: 1, file_path: '/lib/b.mp3', file_fingerprint: '2:2' };
const playlist = { id: 10, name: 'Set', rev: 3, trackIds: [1], tracks: [track] };

function states(entries) {
  return new Map(entries.map((entry) => [entry.track_id, entry]));
}

describe('sync preview', () => {
  it('reports copy, update and playlist actions when mirror is off, and no removals', () => {
    const preview = buildPreview({
      playlists: [playlist],
      trackStates: states([
        { track_id: 1, rev: 1, file_path: '/lib/a.mp3', file_fingerprint: '1:1' },
      ]),
      playlistStates: new Map(),
      mirror: false,
    });

    expect(preview.actions.map((action) => action.type).sort()).toEqual(['playlist', 'update']);
    expect(preview.summary).toEqual({ update: 1, playlist: 1 });
    expect(preview.actions.some((action) => action.type === 'remove')).toBe(false);
  });

  it('removes only files this application owns when mirror is on', () => {
    const preview = buildPreview({
      playlists: [playlist],
      trackStates: states([
        { track_id: 1, rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' },
        { track_id: 2, rev: 1, file_path: '/Contents/b.mp3', file_fingerprint: '2:2' },
        { track_id: 3, rev: 1, file_path: '/Contents/foreign.mp3', file_fingerprint: null },
      ]),
      playlistStates: new Map([[10, { rev: 3, signature: '1' }]]),
      mirror: true,
      ownedFiles: new Set(['/Contents/b.mp3']),
    });

    const removed = preview.actions.filter((action) => action.type === 'remove');
    expect(removed).toEqual([{ type: 'remove', trackId: 2, filePath: '/Contents/b.mp3' }]);
    // The foreign file is not even mentioned: it is not ours to remove.
    expect(preview.actions.some((action) => action.trackId === 3)).toBe(false);
  });

  it('keeps a track a player has cues for', () => {
    const protect = vi.fn(() => 'device-cues');
    const preview = buildPreview({
      playlists: [playlist],
      trackStates: states([
        { track_id: 1, rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' },
        { track_id: 2, rev: 1, file_path: '/Contents/b.mp3', file_fingerprint: '2:2' },
      ]),
      playlistStates: new Map([[10, { rev: 3, signature: '1' }]]),
      mirror: true,
      ownedFiles: new Set(['/Contents/b.mp3']),
      protect,
    });

    expect(protect).toHaveBeenCalledWith(2, expect.objectContaining({ track_id: 2 }));
    expect(preview.actions).toContainEqual({
      type: 'keep',
      trackId: 2,
      filePath: '/Contents/b.mp3',
      reason: 'device-cues',
    });
  });

  it('is empty when nothing changed, which is what a second sync must see', () => {
    const preview = buildPreview({
      playlists: [playlist],
      trackStates: states([
        { track_id: 1, rev: 2, file_path: '/lib/a.mp3', file_fingerprint: '1:1' },
      ]),
      playlistStates: new Map([[10, { rev: 3, signature: '1' }]]),
      mirror: true,
      ownedFiles: new Set(['/Contents/b.mp3']),
    });
    expect(preview.actions).toEqual([]);
    expect(preview.summary).toEqual({});
  });

  it('hashes the action list, order included', () => {
    expect(planHash([{ type: 'copy', trackId: 1 }])).toBe(planHash([{ type: 'copy', trackId: 1 }]));
    expect(planHash([{ type: 'copy', trackId: 1 }])).not.toBe(
      planHash([{ type: 'copy', trackId: 2 }])
    );
  });

  it('ignores a track that sits in two selected playlists when counting copies', () => {
    const preview = buildPreview({
      playlists: [
        { id: 10, name: 'A', rev: 1, trackIds: [1], tracks: [track] },
        { id: 11, name: 'B', rev: 1, trackIds: [1, 2], tracks: [track, other] },
      ],
      trackStates: new Map(),
      playlistStates: new Map(),
    });
    expect(preview.actions.filter((action) => action.type === 'copy')).toHaveLength(2);
    expect(preview.actions.filter((action) => action.type === 'playlist')).toHaveLength(2);
  });
});
