import os from 'node:os';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { listTrash, moveToTrash, pruneTrash, trashRoot } from '../sync/trash.js';

let roots = [];

function stick() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'djman-trash-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('device trash', () => {
  it('moves a file out of the library folder but keeps its bytes', () => {
    const root = stick();
    const source = path.join(root, 'Contents', 'Artist - Track.mp3');
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, 'audio-bytes');

    const result = moveToTrash({
      usbRoot: root,
      syncId: 'job-1',
      relPath: '/Contents/Artist - Track.mp3',
    });

    expect(result.moved).toBe(true);
    expect(result.trashPath).toBe('.device-trash/job-1/Contents/Artist - Track.mp3');
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(path.join(root, ...result.trashPath.split('/')), 'utf8')).toBe(
      'audio-bytes'
    );
  });

  it('answers moved:false for a file that is already gone', () => {
    const root = stick();
    expect(moveToTrash({ usbRoot: root, syncId: 'job-1', relPath: '/Contents/gone.mp3' })).toEqual({
      moved: false,
      relPath: '/Contents/gone.mp3',
    });
  });

  it('drops only folders older than the retention window', () => {
    const root = stick();
    const oldDir = path.join(trashRoot(root), 'old-job');
    const newDir = path.join(trashRoot(root), 'new-job');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const past = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(oldDir, past, past);

    const result = pruneTrash({ usbRoot: root, retentionMs: 7 * 86_400_000 });

    expect(result.removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(listTrash(root).map((entry) => entry.name)).toEqual(['new-job']);
  });

  it('is a no-op on a medium with no trash folder', () => {
    const root = stick();
    expect(pruneTrash({ usbRoot: root })).toEqual({ removed: 0 });
    expect(listTrash(root)).toEqual([]);
  });
});
