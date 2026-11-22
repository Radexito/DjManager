import { afterEach, describe, expect, it } from 'vitest';

import db from '../db/database.js';
import {
  getLastPlan,
  getSelection,
  saveLastPlan,
  saveSelection,
} from '../db/selectionRepository.js';

const DEVICE = 'serial:SELECT1234';

afterEach(() => {
  db.prepare('DELETE FROM device_selection WHERE device_key = ?').run(DEVICE);
  db.prepare('DELETE FROM device_last_plan WHERE device_key = ?').run(DEVICE);
});

describe('device selection', () => {
  it('replaces the stored playlist set and ignores duplicate or empty ids', () => {
    expect(saveSelection(DEVICE, [10, 11, 11, 0, null])).toEqual([10, 11]);
    expect(getSelection(DEVICE).playlists).toEqual([10, 11]);

    saveSelection(DEVICE, [12]);
    expect(getSelection(DEVICE)).toEqual({ playlists: [12], kinds: ['playlist'] });
  });

  it('answers an empty selection for a device that never had one', () => {
    expect(getSelection('serial:UNKNOWN')).toEqual({ playlists: [], kinds: [] });
  });

  it('keeps the applied plan so the next preview can explain itself', () => {
    const actions = [
      { type: 'copy', trackId: 1 },
      { type: 'remove', trackId: 2, filePath: '/Contents/b.mp3' },
    ];
    saveLastPlan({
      deviceKey: DEVICE,
      hash: 'abc',
      actions,
      summary: { copy: 1, remove: 1 },
      now: () => 99,
    });

    expect(getLastPlan(DEVICE)).toEqual({
      hash: 'abc',
      actions,
      summary: { copy: 1, remove: 1 },
      appliedAt: 99,
    });
  });

  it('overwrites the last plan in place', () => {
    saveLastPlan({ deviceKey: DEVICE, hash: 'one', actions: [], summary: {} });
    saveLastPlan({ deviceKey: DEVICE, hash: 'two', actions: [], summary: {} });
    expect(getLastPlan(DEVICE).hash).toBe('two');
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM device_last_plan WHERE device_key = ?')
      .get(DEVICE);
    expect(rows.n).toBe(1);
  });
});
