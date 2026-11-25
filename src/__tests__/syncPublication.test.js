import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SyncJournal, lastCommit, readJournal, unfinishedJobs } from '../sync/journal.js';
import { generationDir, journalPath, stagingRoot } from '../sync/paths.js';
import {
  describePublishFailure,
  describeStaged,
  moveStagedArtifact,
  pruneGenerations,
  publishStaged,
  recoverJob,
  sha256,
  writeStagedBuffer,
} from '../sync/publication.js';

let roots = [];

function stick() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-publish-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function seedTarget(root, relPath, content) {
  const abs = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const read = (root, relPath) => fs.readFileSync(path.join(root, ...relPath.split('/')), 'utf8');

describe('sync journal', () => {
  it('appends durable events and continues the sequence after reopening', () => {
    const root = stick();
    const journal = new SyncJournal({ usbRoot: root, jobId: 'job-1', now: () => 10 });
    journal.append('job-start', { trigger: 'manual' });
    journal.append('phase', { phase: 'copy' });

    const reopened = new SyncJournal({ usbRoot: root, jobId: 'job-1', now: () => 20 });
    reopened.append('committed', { fingerprint: 'abc' });

    const events = readJournal(root, 'job-1');
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.at(-1)).toMatchObject({ event: 'committed', fingerprint: 'abc', at: 20 });
  });

  it('ignores a torn last line, which is the event that was in flight', () => {
    const root = stick();
    const journal = new SyncJournal({ usbRoot: root, jobId: 'job-2' });
    journal.append('job-start', {});
    fs.appendFileSync(journalPath(root, 'job-2'), '{"seq":2,"event":"pha');

    const events = readJournal(root, 'job-2');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('job-start');
  });

  it('reports the newest commit and the jobs that published without one', () => {
    const root = stick();
    const older = new SyncJournal({ usbRoot: root, jobId: 'job-a', now: () => 5 });
    older.append('published', { relPath: 'PIONEER/rekordbox/export.pdb' });
    older.append('committed', { fingerprint: 'old' });

    const newer = new SyncJournal({ usbRoot: root, jobId: 'job-b', now: () => 9 });
    newer.append('committed', { fingerprint: 'new' });

    const interrupted = new SyncJournal({ usbRoot: root, jobId: 'job-c', now: () => 7 });
    interrupted.append('publishing', { relPath: 'PIONEER/rekordbox/export.pdb', sha256: 'x' });

    expect(lastCommit(root)).toMatchObject({ fingerprint: 'new', jobId: 'job-b' });
    expect(unfinishedJobs(root).map((job) => job.jobId)).toEqual(['job-c']);
  });
});

describe('staged publication', () => {
  it('replaces the target atomically and keeps the previous generation', () => {
    const root = stick();
    seedTarget(root, 'PIONEER/rekordbox/export.pdb', 'OLD');
    const journal = new SyncJournal({ usbRoot: root, jobId: 'job-1' });
    const staging = stagingRoot(root, 'job-1');

    const entry = writeStagedBuffer(staging, 'PIONEER/rekordbox/export.pdb', Buffer.from('NEW'));
    publishStaged({
      usbRoot: root,
      jobId: 'job-1',
      staging,
      entries: [entry],
      journal,
    });

    expect(read(root, 'PIONEER/rekordbox/export.pdb')).toBe('NEW');
    expect(
      fs.readFileSync(
        path.join(generationDir(root, 'job-1'), 'PIONEER/rekordbox/export.pdb'),
        'utf8'
      )
    ).toBe('OLD');
    expect(readJournal(root, 'job-1').map((event) => event.event)).toEqual([
      'verified',
      'publishing',
      'backup',
      'published',
    ]);
    expect(fs.existsSync(path.join(staging, 'PIONEER/rekordbox/export.pdb'))).toBe(false);
  });

  it('refuses an empty, missing or changed staged file and leaves the target alone', () => {
    const root = stick();
    seedTarget(root, 'PIONEER/rekordbox/export.pdb', 'OLD');
    const staging = stagingRoot(root, 'job-1');

    const empty = writeStagedBuffer(staging, 'a.pdb', Buffer.alloc(0));
    expect(() =>
      publishStaged({ usbRoot: root, jobId: 'job-1', staging, entries: [empty] })
    ).toThrowError(/empty/);

    const entry = writeStagedBuffer(staging, 'b.pdb', Buffer.from('NEW'));
    fs.writeFileSync(path.join(staging, 'b.pdb'), 'TAMPERED');
    expect(() =>
      publishStaged({ usbRoot: root, jobId: 'job-1', staging, entries: [entry] })
    ).toThrowError(/changed/);

    expect(() =>
      publishStaged({
        usbRoot: root,
        jobId: 'job-1',
        staging,
        entries: [{ relPath: 'gone.pdb' }],
      })
    ).toThrowError(/gone/);

    expect(read(root, 'PIONEER/rekordbox/export.pdb')).toBe('OLD');
  });

  it('runs the verifier before anything is renamed', () => {
    const root = stick();
    seedTarget(root, 'PIONEER/rekordbox/export.pdb', 'OLD');
    const staging = stagingRoot(root, 'job-1');
    const entry = writeStagedBuffer(staging, 'PIONEER/rekordbox/export.pdb', Buffer.from('BROKEN'));

    expect(() =>
      publishStaged({
        usbRoot: root,
        jobId: 'job-1',
        staging,
        entries: [
          {
            ...entry,
            verify: () => {
              throw new Error('not a database');
            },
          },
        ],
      })
    ).toThrowError(/not a database/);
    expect(read(root, 'PIONEER/rekordbox/export.pdb')).toBe('OLD');
  });

  it('verifies the bytes it writes and leaves the target alone when they do not match', () => {
    const root = stick();
    seedTarget(root, 'PIONEER/rekordbox/export.pdb', 'OLD');
    const staging = stagingRoot(root, 'job-1');
    const entry = writeStagedBuffer(staging, 'PIONEER/rekordbox/export.pdb', Buffer.from('NEW'));
    // The writer's promise no longer describes the file: the copy is where a
    // digest can be checked against the bytes that are actually written, and it
    // has to stop before the target is replaced.
    const tampered = { ...entry, sha256: sha256(Buffer.from('OTHER')) };

    expect(() =>
      publishStaged({ usbRoot: root, jobId: 'job-1', staging, entries: [tampered] })
    ).toThrowError(/changed/);

    expect(read(root, 'PIONEER/rekordbox/export.pdb')).toBe('OLD');
    expect(fs.existsSync(path.join(staging, 'PIONEER/rekordbox/export.pdb'))).toBe(true);
    const leftovers = fs
      .readdirSync(path.join(root, 'PIONEER', 'rekordbox'))
      .filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('journals the digest of the bytes that landed', () => {
    const root = stick();
    const staging = stagingRoot(root, 'job-1');
    const entry = writeStagedBuffer(staging, 'PIONEER/rekordbox/export.pdb', Buffer.from('NEW'));
    const journal = new SyncJournal({ usbRoot: root, jobId: 'job-1' });

    publishStaged({ usbRoot: root, jobId: 'job-1', staging, entries: [entry], journal });

    const published = readJournal(root, 'job-1').find((event) => event.event === 'published');
    expect(published.sha256).toBe(sha256(Buffer.from('NEW')));
    expect(published.size).toBe(3);
    expect(read(root, 'PIONEER/rekordbox/export.pdb')).toBe('NEW');
  });

  it('restores the previous generation when a target is missing after a crash', () => {
    const root = stick();
    const target = seedTarget(root, 'PIONEER/rekordbox/export.pdb', 'OLD');
    const backup = path.join(generationDir(root, 'job-1'), 'PIONEER', 'rekordbox', 'export.pdb');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, 'OLD');
    const journal = new SyncJournal({ usbRoot: root, jobId: 'job-1' });
    journal.append('publishing', {
      relPath: 'PIONEER/rekordbox/export.pdb',
      sha256: 'aaaaaaaa',
    });
    fs.rmSync(target);

    const events = readJournal(root, 'job-1');
    recoverJob({ usbRoot: root, jobId: 'job-1', events, journal });

    expect(fs.readFileSync(target, 'utf8')).toBe('OLD');
    expect(fs.existsSync(backup)).toBe(true);
    expect(readJournal(root, 'job-1').map((event) => event.event)).toEqual([
      'publishing',
      'restored',
      'abandoned',
    ]);
  });

  it('accepts a target that already carries the new bytes as published', () => {
    const root = stick();
    const staging = stagingRoot(root, 'job-1');
    const entry = writeStagedBuffer(staging, 'PIONEER/rekordbox/export.pdb', Buffer.from('NEW'));
    // Simulate the rename landing and the process dying before the journal line.
    seedTarget(root, 'PIONEER/rekordbox/export.pdb', 'NEW');
    const journal = new SyncJournal({ usbRoot: root, jobId: 'job-1' });
    journal.append('publishing', { relPath: entry.relPath, sha256: entry.sha256 });

    recoverJob({
      usbRoot: root,
      jobId: 'job-1',
      events: readJournal(root, 'job-1'),
      journal,
    });

    expect(readJournal(root, 'job-1').map((event) => event.event)).toEqual([
      'publishing',
      'published',
      'abandoned',
    ]);
  });

  it('keeps only the newest generation', () => {
    const root = stick();
    const first = path.join(generationDir(root, 'job-old'), 'PIONEER');
    const second = path.join(generationDir(root, 'job-new'), 'PIONEER');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(first, 'export.pdb'), 'old');
    fs.writeFileSync(path.join(second, 'export.pdb'), 'new');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.dirname(first), past, past);

    pruneGenerations(root, 1);

    expect(fs.existsSync(path.dirname(first))).toBe(false);
    expect(fs.existsSync(path.dirname(second))).toBe(true);
  });

  it('moves artifacts into place and journals them separately from published files', () => {
    const root = stick();
    const staging = stagingRoot(root, 'job-1');
    writeStagedBuffer(staging, 'Contents/Artist - Title.mp3', Buffer.from('audio'));
    const journal = new SyncJournal({ usbRoot: root, jobId: 'job-1' });

    moveStagedArtifact({
      usbRoot: root,
      staging,
      relPath: 'Contents/Artist - Title.mp3',
      journal,
    });

    expect(read(root, 'Contents/Artist - Title.mp3')).toBe('audio');
    expect(readJournal(root, 'job-1').map((event) => event.event)).toEqual(['artifact']);
  });

  it('turns a file held open into a message that names what to close', () => {
    const locked = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const described = describePublishFailure(locked, 'PIONEER/rekordbox/export.pdb');
    expect(described).toMatchObject({ code: 'file-locked', extra: { cause: 'EPERM' } });
    expect(described.message).toContain('rekordbox');
    expect(described.message).toContain('PIONEER/rekordbox/export.pdb');

    const other = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    expect(describePublishFailure(other, 'x')).toBe(other);
  });

  it('describes a file a writer produced itself', () => {
    const root = stick();
    const staging = stagingRoot(root, 'job-1');
    const abs = path.join(staging, 'PIONEER', 'rekordbox', 'export.pdb');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'PDB');

    expect(describeStaged(staging, 'PIONEER/rekordbox/export.pdb')).toMatchObject({
      relPath: 'PIONEER/rekordbox/export.pdb',
      size: 3,
    });
  });
});
