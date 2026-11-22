import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { readJournal, readJournalFile, listJournals } from '../sync/journal.js';
import { generationDir, lockPath } from '../sync/paths.js';
import { readLibrary } from '../usb/pioneer/formats/pdbRead.js';
import { writePdb } from '../usb/pioneer/formats/pdb.js';

/**
 * Crash safety, measured by killing a real job.
 *
 * The old generation is a one-track database, the job writes two. At every kill
 * point the database on the medium must be one of those two, and readable: a
 * partial file would fail `readLibrary`, which is the same reader the exporter
 * uses to verify before publishing.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const child = path.join(here, 'fixtures', 'syncCrashChild.js');

let roots = [];

function stick() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-crash-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function seedOldGeneration(root) {
  writePdb(
    {
      usbRoot: root,
      tracks: [
        {
          id: 50,
          title: 'Previous',
          artist: 'Artist',
          album: 'Album',
          duration: 100,
          bpm: 120,
          key_raw: '7A',
          file_path: '/Contents/previous.mp3',
          track_number: 1,
          year: '2025',
          label: 'Label',
          genres: ['House'],
          file_size: 900,
          bitrate: 320_000,
          sample_rate: 44_100,
          bit_depth: 16,
          comments: '',
          rating: 0,
        },
      ],
      playlists: [{ id: 1, name: 'Crash set', track_ids: [50] }],
    },
    path.join(root, 'PIONEER', 'rekordbox', 'export.pdb')
  );
}

function runChild(root, killPoint) {
  return spawnSync(process.execPath, [child, root, killPoint], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function databaseTrackCount(root) {
  const file = path.join(root, 'PIONEER', 'rekordbox', 'export.pdb');
  if (!fs.existsSync(file)) return 0;
  return readLibrary(fs.readFileSync(file)).tracks.length;
}

/** Latest event of the newest journal, or null when no journal exists. */
function latestEvent(root) {
  const journals = listJournals(root);
  if (journals.length === 0) return null;
  const newest = journals.at(-1);
  return readJournalFile(newest.file).at(-1) ?? null;
}

const KILL_POINTS = ['plan', 'copy-staged', 'database-staged', 'publish-first', 'publish-all'];

describe('crash-safe publication', () => {
  it('leaves a readable database at every kill point', () => {
    for (const killPoint of KILL_POINTS) {
      const root = stick();
      seedOldGeneration(root);

      const childResult = runChild(root, killPoint);

      expect(childResult.signal, `kill point ${killPoint}`).toBe('SIGKILL');
      const count = databaseTrackCount(root);
      expect([1, 2], `database at kill point ${killPoint}`).toContain(count);
      if (killPoint === 'publish-first' || killPoint === 'publish-all') {
        expect(count).toBe(2);
      } else {
        expect(count).toBe(1);
      }

      const last = latestEvent(root);
      expect(last?.event, `journal at kill point ${killPoint}`).not.toBe('committed');
      expect(fs.existsSync(lockPath(root))).toBe(true);
    }
  });

  it('completes after an interruption, without guessing what was written', () => {
    const root = stick();
    seedOldGeneration(root);

    expect(runChild(root, 'database-staged').signal).toBe('SIGKILL');
    expect(fs.existsSync(lockPath(root))).toBe(true);
    expect(databaseTrackCount(root)).toBe(1);

    const restart = runChild(root, 'none');
    expect(restart.status).toBe(0);
    expect(JSON.parse(restart.stdout.trim())).toMatchObject({ ok: true });

    expect(databaseTrackCount(root)).toBe(2);
    const journals = fs.readdirSync(path.join(root, '.djmanager', 'journal'));
    expect(journals).toHaveLength(2);

    const abandoned = journals
      .flatMap((name) => readJournal(root, name.replace(/\.jsonl$/, '')))
      .filter((event) => event.event === 'abandoned');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].reason).toBe('interrupted');

    const committed = journals
      .flatMap((name) => readJournal(root, name.replace(/\.jsonl$/, '')))
      .filter((event) => event.event === 'committed');
    expect(committed).toHaveLength(1);
    expect(committed[0].fingerprint).toBe('child-fingerprint');

    // The generation the interrupted job kept is still the old database.
    const generations = fs.readdirSync(path.join(root, '.djmanager', 'generations'));
    expect(generations).toHaveLength(1);
    const previous = path.join(
      generationDir(root, generations[0]),
      'PIONEER',
      'rekordbox',
      'export.pdb'
    );
    expect(readLibrary(fs.readFileSync(previous)).tracks).toHaveLength(1);

    expect(fs.existsSync(lockPath(root))).toBe(false);
    expect(fs.existsSync(path.join(root, '.djmanager', 'staging'))).toBe(true);
    expect(fs.readdirSync(path.join(root, '.djmanager', 'staging'))).toEqual([]);
  });

  it('keeps the previous database when the process dies after the first publish', () => {
    const root = stick();
    seedOldGeneration(root);

    expect(runChild(root, 'publish-first').signal).toBe('SIGKILL');
    expect(databaseTrackCount(root)).toBe(2);

    const restart = runChild(root, 'none');
    expect(restart.status).toBe(0);
    expect(databaseTrackCount(root)).toBe(2);

    const journals = fs.readdirSync(path.join(root, '.djmanager', 'journal'));
    const abandoned = journals.flatMap((name) =>
      readJournal(root, name.replace(/\.jsonl$/, '')).filter((event) => event.event === 'abandoned')
    );
    expect(abandoned).toHaveLength(1);
  });
});
