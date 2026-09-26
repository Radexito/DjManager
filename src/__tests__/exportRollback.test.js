import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { planExportRollback, applyExportRollback } from '../usb/exportRollback.js';

// A stick that already carries an export from an earlier run: two tracks and one
// playlist, all of them pre-existing library data that must never be touched.
const PRE_EXISTING = {
  preExistingTrackIds: [10, 11],
  preExistingPlaylistIds: ['pl-old'],
  preExistingAudioPaths: ['/music/Artist - Old One.mp3', '/music/Artist - Reused Two.mp3'],
};

describe('planExportRollback', () => {
  describe('keep', () => {
    it('removes nothing and keeps every file of the run', () => {
      const plan = planExportRollback({
        mode: 'keep',
        createdFiles: [
          { trackId: 20, path: '/music/Artist - New One.mp3' },
          { trackId: 21, path: '/music/Artist - New Two.mp3' },
        ],
        createdAnlzFolders: ['PIONEER/USBANLZ/aaa1'],
        runTrackIds: [10, 20, 21],
        runPlaylistIds: ['pl-old', 'pl-new'],
        ...PRE_EXISTING,
      });

      expect(plan.mode).toBe('keep');
      expect(plan.remove).toBe(false);
      expect(plan.filesToDelete).toEqual([]);
      expect(plan.foldersToDelete).toEqual([]);
      expect(plan.dropTrackIds).toEqual([]);
      expect(plan.dropPlaylistIds).toEqual([]);
      expect(plan.keptFiles).toBe(2);
      // Every track in the run keeps its database entry, reused ones included.
      expect(plan.keptTrackIds).toEqual([10, 20, 21]);
    });
  });

  describe('remove', () => {
    it('removes only the files and folders this run created', () => {
      const plan = planExportRollback({
        mode: 'remove',
        createdFiles: [
          { trackId: 20, path: '/music/Artist - New One.mp3' },
          { trackId: 21, path: '/music/Artist - New Two.mp3' },
        ],
        createdAnlzFolders: ['PIONEER/USBANLZ/aaa1', 'PIONEER/USBANLZ/aaa2'],
        runTrackIds: [10, 20, 21],
        runPlaylistIds: ['pl-old', 'pl-new'],
        ...PRE_EXISTING,
      });

      expect(plan.mode).toBe('remove');
      expect(plan.remove).toBe(true);
      expect(plan.filesToDelete).toEqual([
        '/music/Artist - New One.mp3',
        '/music/Artist - New Two.mp3',
      ]);
      expect(plan.foldersToDelete).toEqual(['PIONEER/USBANLZ/aaa1', 'PIONEER/USBANLZ/aaa2']);
      expect(plan.keptFiles).toBe(0);
    });

    it('keeps the database entries of tracks it reused and drops only new ones', () => {
      const plan = planExportRollback({
        mode: 'remove',
        createdFiles: [{ trackId: 20, path: '/music/Artist - New One.mp3' }],
        runTrackIds: [10, 11, 20],
        runPlaylistIds: ['pl-old', 'pl-new'],
        ...PRE_EXISTING,
      });

      expect(plan.dropTrackIds).toEqual([20]);
      expect(plan.keptTrackIds).toEqual([10, 11]);
      expect(plan.dropPlaylistIds).toEqual(['pl-new']);
      expect(plan.droppedTracks).toBe(1);
      expect(plan.droppedPlaylists).toBe(1);
    });

    it('never deletes a path a pre-existing manifest entry already owns', () => {
      const plan = planExportRollback({
        mode: 'remove',
        createdFiles: [
          { trackId: 11, path: '/music/Artist - Reused Two.mp3' },
          { trackId: 30, path: '/music\\Artist - New Three.mp3' },
        ],
        runTrackIds: [11, 30],
        ...PRE_EXISTING,
      });

      expect(plan.filesToDelete).toEqual(['/music\\Artist - New Three.mp3']);
      expect(plan.keptFiles).toBe(1);
    });

    it('de-duplicates repeated paths and ignores empty entries', () => {
      const plan = planExportRollback({
        mode: 'remove',
        createdFiles: [
          { trackId: 20, path: '/music/New.mp3' },
          '/music/New.mp3',
          { trackId: 21, path: '' },
        ],
        createdAnlzFolders: ['PIONEER/USBANLZ/aaa1', 'PIONEER/USBANLZ/AAA1'],
        runTrackIds: [20, 21],
      });

      expect(plan.filesToDelete).toEqual(['/music/New.mp3']);
      expect(plan.foldersToDelete).toEqual(['PIONEER/USBANLZ/aaa1']);
    });

    it('removes nothing when the run was cancelled before it wrote anything', () => {
      const plan = planExportRollback({
        mode: 'remove',
        createdFiles: [],
        createdAnlzFolders: [],
        runTrackIds: [10, 11, 20],
        runPlaylistIds: ['pl-old', 'pl-new'],
        ...PRE_EXISTING,
      });

      expect(plan.filesToDelete).toEqual([]);
      expect(plan.foldersToDelete).toEqual([]);
      // The two pre-existing tracks keep their entries; the new track never
      // landed, so it is not added to the database either.
      expect(plan.dropTrackIds).toEqual([20]);
      expect(plan.keptTrackIds).toEqual([10, 11]);
      expect(plan.dropPlaylistIds).toEqual(['pl-new']);
    });

    it('treats a fresh stick (no pre-run manifest) as fully removable', () => {
      const plan = planExportRollback({
        mode: 'remove',
        createdFiles: [
          { trackId: 20, path: '/music/New One.mp3' },
          { trackId: 21, path: '/music/New Two.mp3' },
        ],
        createdAnlzFolders: ['PIONEER/USBANLZ/bbb1'],
        runTrackIds: [20, 21],
        runPlaylistIds: ['pl-new'],
      });

      expect(plan.filesToDelete).toHaveLength(2);
      expect(plan.foldersToDelete).toEqual(['PIONEER/USBANLZ/bbb1']);
      expect(plan.dropTrackIds).toEqual([20, 21]);
      expect(plan.dropPlaylistIds).toEqual(['pl-new']);
      expect(plan.keptTrackIds).toEqual([]);
      expect(plan.keptFiles).toBe(0);
    });

    it('defaults to a no-op plan when called with no options', () => {
      const plan = planExportRollback();

      expect(plan.mode).toBe('keep');
      expect(plan.remove).toBe(false);
      expect(plan.filesToDelete).toEqual([]);
      expect(plan.foldersToDelete).toEqual([]);
    });
  });
});

describe('remove on a stick that already has an export', () => {
  let root = null;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  /** Every file under root, with its bytes hashed. */
  function snapshot(dir) {
    const out = {};
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else
          out[path.relative(dir, full)] = crypto
            .createHash('sha1')
            .update(fs.readFileSync(full))
            .digest('hex');
      }
    };
    walk(dir);
    return out;
  }

  /**
   * Builds a stick carrying an earlier export, plays a cancelled run over it,
   * then applies the remove rollback the way the main process does: delete what
   * the plan lists, write the manifest bytes read before the run back, and
   * rebuild the database from them.
   */
  it('leaves the earlier export byte-identical', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-rollback-e2e-'));
    const manifestPath = path.join(root, 'PIONEER', 'rekordbox', 'export-manifest.json');
    const pdbPath = path.join(root, 'PIONEER', 'rekordbox', 'export.pdb');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.join(root, 'music'), { recursive: true });
    fs.mkdirSync(path.join(root, 'PIONEER', 'USBANLZ', 'oldaaa'), { recursive: true });
    fs.writeFileSync(path.join(root, 'music', 'Old One.mp3'), 'old-audio');
    fs.writeFileSync(path.join(root, 'PIONEER', 'USBANLZ', 'oldaaa', 'ANLZ0000.DAT'), 'old-anlz');
    const oldManifest = JSON.stringify({
      version: 1,
      tracks: [{ id: 10, file_path: '/music/Old One.mp3' }],
      playlists: [{ id: 'pl-old', name: 'Old', track_ids: [10] }],
    });
    fs.writeFileSync(manifestPath, oldManifest, 'utf8');
    fs.writeFileSync(pdbPath, 'old-pdb-bytes');

    const before = snapshot(root);

    // The run: copies one new track, writes its beat grid, merges the manifest
    // and rewrites the database, then gets cancelled.
    fs.writeFileSync(path.join(root, 'music', 'New Two.mp3'), 'new-audio');
    fs.mkdirSync(path.join(root, 'PIONEER', 'USBANLZ', 'newbbb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'PIONEER', 'USBANLZ', 'newbbb', 'ANLZ0000.DAT'), 'new-anlz');
    const session = {
      usbRoot: root,
      manifestBefore: oldManifest,
      pdbBefore: 'old-pdb-bytes',
      createdFiles: [{ trackId: 20, path: '/music/New Two.mp3' }],
      createdAnlzFolders: ['PIONEER/USBANLZ/newbbb'],
      runTrackIds: [10, 20],
      runPlaylistIds: ['pl-old', 'pl-new'],
      preExistingTrackIds: [10],
      preExistingPlaylistIds: ['pl-old'],
      preExistingAudioPaths: ['/music/Old One.mp3'],
    };
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        tracks: [
          { id: 10, file_path: '/music/Old One.mp3' },
          { id: 20, file_path: '/music/New Two.mp3' },
        ],
        playlists: [
          { id: 'pl-old', name: 'Old', track_ids: [10] },
          { id: 'pl-new', name: 'New', track_ids: [20] },
        ],
      }),
      'utf8'
    );
    fs.writeFileSync(pdbPath, 'pdb-bytes-with-the-new-track');

    const plan = planExportRollback({ mode: 'remove', ...session });
    applyExportRollback(root, plan);
    // Both database files go back to the bytes read before the run.
    fs.writeFileSync(manifestPath, session.manifestBefore, 'utf8');
    fs.writeFileSync(pdbPath, session.pdbBefore);

    expect(snapshot(root)).toEqual(before);
    const restored = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(restored.tracks.map((t) => t.id)).toEqual([10]);
    expect(restored.playlists.map((p) => p.id)).toEqual(['pl-old']);
    expect(fs.readFileSync(pdbPath, 'utf8')).toBe('old-pdb-bytes');
  });
});

describe('applyExportRollback', () => {
  let root = null;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function makeStick({ withEarlierExport }) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-rollback-'));
    fs.mkdirSync(path.join(root, 'music'), { recursive: true });
    fs.writeFileSync(path.join(root, 'music', 'Old One.mp3'), 'old-audio');
    if (withEarlierExport) {
      fs.mkdirSync(path.join(root, 'PIONEER', 'USBANLZ', 'oldaaa'), { recursive: true });
      fs.writeFileSync(path.join(root, 'PIONEER', 'USBANLZ', 'oldaaa', 'ANLZ0000.DAT'), 'old-anlz');
    }
    fs.writeFileSync(path.join(root, 'music', 'New One.mp3'), 'new-audio');
    fs.mkdirSync(path.join(root, 'PIONEER', 'USBANLZ', 'newbbb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'PIONEER', 'USBANLZ', 'newbbb', 'ANLZ0000.DAT'), 'new-anlz');
    return root;
  }

  it('deletes this run additions and leaves the earlier export byte-identical', () => {
    const stick = makeStick({ withEarlierExport: true });
    const before = {
      oldAudio: fs.readFileSync(path.join(stick, 'music', 'Old One.mp3'), 'utf8'),
      oldAnlz: fs.readFileSync(
        path.join(stick, 'PIONEER', 'USBANLZ', 'oldaaa', 'ANLZ0000.DAT'),
        'utf8'
      ),
    };

    const plan = planExportRollback({
      mode: 'remove',
      createdFiles: [{ trackId: 20, path: '/music/New One.mp3' }],
      createdAnlzFolders: ['PIONEER/USBANLZ/newbbb'],
      runTrackIds: [10, 20],
      preExistingTrackIds: [10],
      preExistingAudioPaths: ['/music/Old One.mp3'],
    });
    const summary = applyExportRollback(stick, plan);

    expect(summary).toEqual({ removedFiles: 1, removedFolders: 1, failures: [] });
    expect(fs.existsSync(path.join(stick, 'music', 'New One.mp3'))).toBe(false);
    expect(fs.existsSync(path.join(stick, 'PIONEER', 'USBANLZ', 'newbbb'))).toBe(false);
    // Pre-existing library data survives untouched, byte for byte.
    expect(fs.readFileSync(path.join(stick, 'music', 'Old One.mp3'), 'utf8')).toBe(before.oldAudio);
    expect(
      fs.readFileSync(path.join(stick, 'PIONEER', 'USBANLZ', 'oldaaa', 'ANLZ0000.DAT'), 'utf8')
    ).toBe(before.oldAnlz);
  });

  it('is a no-op for the keep plan', () => {
    const stick = makeStick({ withEarlierExport: true });
    const plan = planExportRollback({
      mode: 'keep',
      createdFiles: [{ trackId: 20, path: '/music/New One.mp3' }],
    });

    const summary = applyExportRollback(stick, plan);

    expect(summary).toEqual({ removedFiles: 0, removedFolders: 0, failures: [] });
    expect(fs.existsSync(path.join(stick, 'music', 'New One.mp3'))).toBe(true);
  });

  it('skips files and folders that are already gone without failing the rollback', () => {
    const stick = makeStick({ withEarlierExport: false });
    const plan = planExportRollback({
      mode: 'remove',
      createdFiles: [{ trackId: 20, path: '/music/Missing.mp3' }],
      createdAnlzFolders: ['PIONEER/USBANLZ/does-not-exist'],
      runTrackIds: [20],
    });

    const summary = applyExportRollback(stick, plan);

    expect(summary.removedFiles).toBe(0);
    expect(summary.removedFolders).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  it('removes every file this run created and nothing else', () => {
    const stick = makeStick({ withEarlierExport: true });
    fs.writeFileSync(path.join(stick, 'music', 'New Two.mp3'), 'new-audio-2');
    const plan = planExportRollback({
      mode: 'remove',
      createdFiles: [
        { trackId: 20, path: '/music/New One.mp3' },
        { trackId: 21, path: '/music/New Two.mp3' },
      ],
      createdAnlzFolders: ['PIONEER/USBANLZ/newbbb'],
      runTrackIds: [10, 20, 21],
      preExistingTrackIds: [10],
      preExistingAudioPaths: ['/music/Old One.mp3'],
    });

    const summary = applyExportRollback(stick, plan);

    expect(summary.removedFiles).toBe(2);
    expect(fs.existsSync(path.join(stick, 'music', 'New One.mp3'))).toBe(false);
    expect(fs.existsSync(path.join(stick, 'music', 'New Two.mp3'))).toBe(false);
    expect(fs.existsSync(path.join(stick, 'music', 'Old One.mp3'))).toBe(true);
  });
});
