import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { detectExports } from '../explorer/exportDetection.js';

/**
 * Minimal in-memory filesystem for the injected fsImpl. Any write attempt
 * throws, which doubles as the read-only guarantee check for the detector.
 */
function makeFs({ files = {}, dirs = [] } = {}) {
  const fileMap = new Map(Object.entries(files));
  const dirSet = new Set(dirs);
  const join = (...p) => path.join(...p);

  return {
    // absolute path helpers used by the tests
    path: join,
    existsSync: (p) => fileMap.has(p) || dirSet.has(p),
    statSync: (p) => {
      if (fileMap.has(p)) return { isFile: () => true, isDirectory: () => false };
      if (dirSet.has(p)) return { isFile: () => false, isDirectory: () => true };
      const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
      err.code = 'ENOENT';
      throw err;
    },
    readdirSync: (p) => {
      if (!dirSet.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      const names = [];
      for (const f of fileMap.keys()) if (path.dirname(f) === p) names.push(path.basename(f));
      for (const d of dirSet) if (path.dirname(d) === p && d !== p) names.push(path.basename(d));
      return names;
    },
    readFileSync: (p) => {
      if (!fileMap.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return fileMap.get(p);
    },
    writeFileSync: () => {
      throw new Error('writeFileSync must never be called - detection is read-only');
    },
    mkdirSync: () => {
      throw new Error('mkdirSync must never be called - detection is read-only');
    },
    rmSync: () => {
      throw new Error('rmSync must never be called - detection is read-only');
    },
    unlinkSync: () => {
      throw new Error('unlinkSync must never be called - detection is read-only');
    },
    renameSync: () => {
      throw new Error('renameSync must never be called - detection is read-only');
    },
  };
}

const ROOT = '/media/stick';
const manifestPath = path.join(ROOT, 'PIONEER', 'rekordbox', 'export-manifest.json');

const MANIFEST = JSON.stringify({
  version: 1,
  tracks: [
    { id: 1, title: 'Warehouse', artist: 'A', file_path: '/music/Warehouse.mp3' },
    { id: 2, title: 'Second', artist: 'B', file_path: '/music/Second.mp3' },
    { id: 3, title: 'Unused', artist: 'C', file_path: '/music/Unused.mp3' },
  ],
  playlists: [
    { id: 'pl-1', name: 'Warmup', track_ids: [1, 2] },
    { id: 'pl-2', name: 'Peak', track_ids: [3] },
  ],
});

describe('detectExports', () => {
  it('returns [] for an empty drive', () => {
    expect(detectExports(ROOT, makeFs({ dirs: [ROOT] }))).toEqual([]);
  });

  it('returns [] for a missing/invalid root', () => {
    expect(detectExports('', makeFs())).toEqual([]);
    expect(detectExports(null, makeFs())).toEqual([]);
    expect(detectExports(undefined, makeFs())).toEqual([]);
  });

  describe('Rekordbox', () => {
    it('parses its own export-manifest.json for counts and playlist entries', () => {
      const fsImpl = makeFs({
        dirs: [ROOT, path.dirname(manifestPath)],
        files: {
          [path.join(ROOT, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
          [manifestPath]: MANIFEST,
        },
      });

      const [rb] = detectExports(ROOT, fsImpl);
      expect(rb.software).toBe('rekordbox');
      expect(rb.label).toBe('Rekordbox');
      expect(rb.parsed).toBe(true);
      expect(rb.trackCount).toBe(3);
      expect(rb.playlists).toBe(2);
      expect(rb.note).toBeNull();
      expect(rb.entries).toHaveLength(2);
      expect(rb.entries[0]).toMatchObject({ id: 'pl-1', name: 'Warmup', trackCount: 2 });
      expect(rb.entries[0].tracks).toEqual([
        { id: 1, title: 'Warehouse', artist: 'A', file_path: '/music/Warehouse.mp3' },
        { id: 2, title: 'Second', artist: 'B', file_path: '/music/Second.mp3' },
      ]);
      expect(rb.entries[1]).toMatchObject({ name: 'Peak', trackCount: 1 });
    });

    it('detects a foreign Rekordbox stick via DEVSETTING.DAT with no parsed counts', () => {
      const fsImpl = makeFs({
        dirs: [ROOT],
        files: { [path.join(ROOT, 'DEVSETTING.DAT')]: 'binary' },
      });

      const [rb] = detectExports(ROOT, fsImpl);
      expect(rb.software).toBe('rekordbox');
      expect(rb.parsed).toBe(false);
      expect(rb.trackCount).toBeNull();
      expect(rb.playlists).toBeNull();
      expect(rb.entries).toEqual([]);
      expect(rb.note).toMatch(/PDB parser/);
    });

    it('detects via MYSETTING.DAT at the stick root', () => {
      const fsImpl = makeFs({
        dirs: [ROOT],
        files: { [path.join(ROOT, 'MYSETTING.DAT')]: 'binary' },
      });
      expect(detectExports(ROOT, fsImpl).map((e) => e.software)).toEqual(['rekordbox']);
    });

    it('detects export.pdb with a corrupt manifest without throwing', () => {
      const fsImpl = makeFs({
        dirs: [ROOT, path.dirname(manifestPath)],
        files: {
          [path.join(ROOT, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
          [manifestPath]: '{ not json',
        },
      });

      const [rb] = detectExports(ROOT, fsImpl);
      expect(rb.parsed).toBe(false);
      expect(rb.trackCount).toBeNull();
    });

    it('drops playlist track ids missing from the manifest instead of inventing them', () => {
      const fsImpl = makeFs({
        dirs: [ROOT, path.dirname(manifestPath)],
        files: {
          [path.join(ROOT, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
          [manifestPath]: JSON.stringify({
            tracks: [{ id: 1, title: 'Only', artist: 'A', file_path: '/music/Only.mp3' }],
            playlists: [{ id: 'pl-1', name: 'Mixed', track_ids: [1, 999] }],
          }),
        },
      });

      const [rb] = detectExports(ROOT, fsImpl);
      expect(rb.trackCount).toBe(1);
      expect(rb.entries[0].trackCount).toBe(1);
      expect(rb.entries[0].tracks).toHaveLength(1);
    });
  });

  describe('Serato', () => {
    it('detects _Serato_ and counts .crate files as playlists', () => {
      const serato = path.join(ROOT, '_Serato_');
      const subcrates = path.join(serato, 'Subcrates');
      const fsImpl = makeFs({
        dirs: [ROOT, serato, subcrates],
        files: {
          [path.join(subcrates, 'House.crate')]: 'binary',
          [path.join(subcrates, 'Techno.crate')]: 'binary',
          [path.join(subcrates, 'notes.txt')]: 'text',
        },
      });

      const [s] = detectExports(ROOT, fsImpl);
      expect(s.software).toBe('serato');
      expect(s.playlists).toBe(2);
      expect(s.trackCount).toBeNull();
      expect(s.entries).toEqual([]);
      expect(s.note).toMatch(/Serato database parser/);
    });

    it('reports no playlist count when Subcrates is absent', () => {
      const fsImpl = makeFs({
        dirs: [ROOT, path.join(ROOT, '_Serato_')],
      });

      const [s] = detectExports(ROOT, fsImpl);
      expect(s.software).toBe('serato');
      expect(s.playlists).toBeNull();
      expect(s.trackCount).toBeNull();
    });
  });

  it('detects Engine DJ and Traktor folders without inventing counts', () => {
    const fsImpl = makeFs({
      dirs: [ROOT, path.join(ROOT, 'Engine Library'), path.join(ROOT, 'Traktor')],
    });

    const detected = detectExports(ROOT, fsImpl);
    // Detected in stable order: Rekordbox, Serato, Engine DJ, Traktor
    expect(detected.map((e) => e.software)).toEqual(['engine-dj', 'traktor']);
    for (const e of detected) {
      expect(e.trackCount).toBeNull();
      expect(e.playlists).toBeNull();
      expect(e.entries).toEqual([]);
      expect(e.note).toMatch(/not implemented yet/);
    }
  });

  it('lists every export on a drive in a stable software order', () => {
    const serato = path.join(ROOT, '_Serato_');
    const fsImpl = makeFs({
      dirs: [
        ROOT,
        path.join(ROOT, 'PIONEER', 'rekordbox'),
        serato,
        path.join(serato, 'Subcrates'),
        path.join(ROOT, 'Engine Library'),
        path.join(ROOT, 'Traktor'),
      ],
      files: {
        [path.join(ROOT, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
        [manifestPath]: MANIFEST,
        [path.join(serato, 'Subcrates', 'Tech.crate')]: 'binary',
      },
    });

    expect(detectExports(ROOT, fsImpl).map((e) => e.software)).toEqual([
      'rekordbox',
      'serato',
      'engine-dj',
      'traktor',
    ]);
  });

  it('never writes to the drive (read-only guarantee)', () => {
    const fsImpl = makeFs({
      dirs: [ROOT, path.join(ROOT, 'PIONEER', 'rekordbox')],
      files: {
        [path.join(ROOT, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
        [manifestPath]: MANIFEST,
      },
    });

    // The fake fs throws from every write method, so reaching the assertion
    // below proves detection performed zero mutating filesystem calls.
    expect(() => detectExports(ROOT, fsImpl)).not.toThrow();
    expect(detectExports(ROOT, fsImpl)).toHaveLength(1);
  });
});
