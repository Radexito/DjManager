import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import db from '../db/database.js';
import {
  assignMyTag,
  createMyTag,
  deleteMyTag,
  getAssignmentsForTracks,
  getMyTagMasterId,
  getMyTagTree,
  getTagsForTrack,
  listMyTags,
  renameMyTag,
} from '../db/myTagRepository.js';

let trackId;

beforeEach(() => {
  db.prepare('DELETE FROM track_my_tags').run();
  db.prepare('DELETE FROM my_tags').run();
  const info = db
    .prepare("INSERT INTO tracks (title, file_path) VALUES ('Tagged', '/library/tagged.mp3')")
    .run();
  trackId = Number(info.lastInsertRowid);
});

afterEach(() => {
  db.prepare('DELETE FROM track_my_tags').run();
  db.prepare('DELETE FROM my_tags').run();
  db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
});

const revOf = (id) => db.prepare('SELECT rev FROM tracks WHERE id = ?').get(id).rev;

describe('my tags', () => {
  it('builds the tree from flat rows and keeps sibling order', () => {
    const genre = createMyTag({ name: 'Genre' });
    const house = createMyTag({ name: 'House', parentId: genre.id });
    createMyTag({ name: 'Techno', parentId: genre.id });

    const tree = getMyTagTree();
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      name: 'Genre',
      children: [{ name: 'House' }, { name: 'Techno' }],
    });
    expect(house.parentId).toBe(genre.id);
    expect(listMyTags().map((tag) => tag.name)).toEqual(['Genre', 'House', 'Techno']);
  });

  it('bumps the track revision when a tag is assigned or removed', () => {
    const tag = createMyTag({ name: 'Peak Time' });
    const before = revOf(trackId);

    assignMyTag(trackId, tag.id, true);
    const afterAssign = revOf(trackId);
    expect(afterAssign).toBeGreaterThan(before);
    expect(getTagsForTrack(trackId).map((row) => row.name)).toEqual(['Peak Time']);

    assignMyTag(trackId, tag.id, false);
    expect(revOf(trackId)).toBeGreaterThan(afterAssign);
    expect(getTagsForTrack(trackId)).toEqual([]);
  });

  it('bumps the revision of every track assigned to a renamed tag', () => {
    const tag = createMyTag({ name: 'Old name' });
    assignMyTag(trackId, tag.id, true);
    const before = revOf(trackId);

    renameMyTag(tag.id, 'New name');

    expect(revOf(trackId)).toBeGreaterThan(before);
    expect(getTagsForTrack(trackId)[0].name).toBe('New name');
  });

  it('deletes a subtree, its assignments and bumps the affected tracks', () => {
    const genre = createMyTag({ name: 'Genre' });
    const house = createMyTag({ name: 'House', parentId: genre.id });
    assignMyTag(trackId, house.id, true);
    const before = revOf(trackId);

    expect(deleteMyTag(genre.id)).toBe(true);

    expect(revOf(trackId)).toBeGreaterThan(before);
    expect(listMyTags()).toEqual([]);
    expect(getTagsForTrack(trackId)).toEqual([]);
  });

  it('collects assignments for a set of tracks, which the export needs', () => {
    const tag = createMyTag({ name: 'Warm up' });
    assignMyTag(trackId, tag.id, true);

    expect(getAssignmentsForTracks([trackId, 999999])).toEqual([
      { track_id: trackId, tag_id: tag.id },
    ]);
  });

  it('keeps one positive master id for the library', () => {
    const first = getMyTagMasterId();
    expect(first).toBeGreaterThan(0);
    expect(getMyTagMasterId()).toBe(first);
  });
});
