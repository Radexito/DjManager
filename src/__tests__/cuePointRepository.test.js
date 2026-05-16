import { describe, it, expect, afterEach } from 'vitest';
import db from '../db/database.js';
import { addTrack } from '../db/trackRepository.js';
import {
  getCuePoints,
  addCuePoint,
  updateCuePoint,
  deleteCuePoint,
  deleteAllCuePoints,
  deleteAllCuePointsLibrary,
} from '../db/cuePointRepository.js';

const TRACK = {
  title: 'Test Track',
  artist: 'Artist',
  album: '',
  duration: 180,
  file_path: '/tmp/t.mp3',
  file_hash: 'abc123',
  format: 'mp3',
  bitrate: 320000,
};

afterEach(() => {
  db.prepare('DELETE FROM cue_points').run();
  db.prepare('DELETE FROM tracks').run();
});

describe('getCuePoints', () => {
  it('returns empty array when track has no cue points', () => {
    const id = addTrack(TRACK);
    expect(getCuePoints(id)).toEqual([]);
  });

  it('returns cue points ordered by position_ms', () => {
    const id = addTrack(TRACK);
    addCuePoint({ trackId: id, positionMs: 5000, label: 'B', color: '#ff0000', hotCueIndex: -1 });
    addCuePoint({ trackId: id, positionMs: 1000, label: 'A', color: '#00ff00', hotCueIndex: 0 });
    const pts = getCuePoints(id);
    expect(pts).toHaveLength(2);
    expect(pts[0].position_ms).toBe(1000);
    expect(pts[1].position_ms).toBe(5000);
  });
});

describe('addCuePoint', () => {
  it('inserts a cue point and returns its id', () => {
    const trackId = addTrack(TRACK);
    const cueId = addCuePoint({
      trackId,
      positionMs: 2000,
      label: 'Drop',
      color: '#ff9900',
      hotCueIndex: 1,
    });
    expect(typeof cueId).toBe('number');
    const pts = getCuePoints(trackId);
    expect(pts).toHaveLength(1);
    expect(pts[0].label).toBe('Drop');
    expect(pts[0].color).toBe('#ff9900');
    expect(pts[0].hot_cue_index).toBe(1);
    expect(pts[0].position_ms).toBe(2000);
  });

  it('uses default values when optional fields are omitted', () => {
    const trackId = addTrack(TRACK);
    addCuePoint({ trackId, positionMs: 0 });
    const [pt] = getCuePoints(trackId);
    expect(pt.label).toBe('');
    expect(pt.color).toBe('#00b4d8');
    expect(pt.hot_cue_index).toBe(-1);
  });
});

describe('updateCuePoint', () => {
  it('updates label', () => {
    const trackId = addTrack(TRACK);
    const cueId = addCuePoint({ trackId, positionMs: 0 });
    updateCuePoint(cueId, { label: 'Intro' });
    expect(getCuePoints(trackId)[0].label).toBe('Intro');
  });

  it('updates color', () => {
    const trackId = addTrack(TRACK);
    const cueId = addCuePoint({ trackId, positionMs: 0 });
    updateCuePoint(cueId, { color: '#cc00ff' });
    expect(getCuePoints(trackId)[0].color).toBe('#cc00ff');
  });

  it('updates hotCueIndex', () => {
    const trackId = addTrack(TRACK);
    const cueId = addCuePoint({ trackId, positionMs: 0, hotCueIndex: -1 });
    updateCuePoint(cueId, { hotCueIndex: 3 });
    expect(getCuePoints(trackId)[0].hot_cue_index).toBe(3);
  });

  it('updates enabled flag', () => {
    const trackId = addTrack(TRACK);
    const cueId = addCuePoint({ trackId, positionMs: 0 });
    updateCuePoint(cueId, { enabled: false });
    expect(getCuePoints(trackId)[0].enabled).toBe(0);
    updateCuePoint(cueId, { enabled: true });
    expect(getCuePoints(trackId)[0].enabled).toBe(1);
  });

  it('is a no-op when no fields are provided', () => {
    const trackId = addTrack(TRACK);
    const cueId = addCuePoint({ trackId, positionMs: 0, label: 'X' });
    updateCuePoint(cueId, {});
    expect(getCuePoints(trackId)[0].label).toBe('X');
  });
});

describe('deleteCuePoint', () => {
  it('removes a single cue point by id', () => {
    const trackId = addTrack(TRACK);
    const cueId = addCuePoint({ trackId, positionMs: 1000 });
    addCuePoint({ trackId, positionMs: 2000 });
    deleteCuePoint(cueId);
    const pts = getCuePoints(trackId);
    expect(pts).toHaveLength(1);
    expect(pts[0].position_ms).toBe(2000);
  });
});

describe('deleteAllCuePoints', () => {
  it('removes all cue points for a track', () => {
    const trackId = addTrack(TRACK);
    addCuePoint({ trackId, positionMs: 1000 });
    addCuePoint({ trackId, positionMs: 2000 });
    deleteAllCuePoints(trackId);
    expect(getCuePoints(trackId)).toHaveLength(0);
  });

  it('does not affect cue points of other tracks', () => {
    const t1 = addTrack(TRACK);
    const t2 = addTrack({ ...TRACK, file_hash: 'xyz', file_path: '/tmp/t2.mp3' });
    addCuePoint({ trackId: t1, positionMs: 1000 });
    addCuePoint({ trackId: t2, positionMs: 2000 });
    deleteAllCuePoints(t1);
    expect(getCuePoints(t1)).toHaveLength(0);
    expect(getCuePoints(t2)).toHaveLength(1);
  });
});

describe('deleteAllCuePointsLibrary', () => {
  it('returns affected track ids and deletes all cue points', () => {
    const t1 = addTrack(TRACK);
    const t2 = addTrack({ ...TRACK, file_hash: 'xyz', file_path: '/tmp/t2.mp3' });
    addCuePoint({ trackId: t1, positionMs: 1000 });
    addCuePoint({ trackId: t2, positionMs: 2000 });
    const affected = deleteAllCuePointsLibrary();
    expect(affected.sort()).toEqual([t1, t2].sort());
    expect(getCuePoints(t1)).toHaveLength(0);
    expect(getCuePoints(t2)).toHaveLength(0);
  });

  it('returns empty array when no cue points exist', () => {
    expect(deleteAllCuePointsLibrary()).toEqual([]);
  });
});
