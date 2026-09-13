import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { camelotFromText, detectExports, findExportRoot } from '../explorer/exportDetection.js';

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
        {
          id: 1,
          title: 'Warehouse',
          artist: 'A',
          album: '',
          duration: null,
          bpm: null,
          key: '',
          key_camelot: null,
          file_path: '/music/Warehouse.mp3',
          analyze_path: '',
          absolute_path: path.join(ROOT, '/music/Warehouse.mp3'),
        },
        {
          id: 2,
          title: 'Second',
          artist: 'B',
          album: '',
          duration: null,
          bpm: null,
          key: '',
          key_camelot: null,
          file_path: '/music/Second.mp3',
          analyze_path: '',
          absolute_path: path.join(ROOT, '/music/Second.mp3'),
        },
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

describe('findExportRoot', () => {
  const STICK = '/run/media/radexito/Ventoy';
  const EXPORT = path.join(STICK, 'dj-export');
  const NESTED = path.join(EXPORT, 'id3', 'music');
  const manifest = path.join(EXPORT, 'PIONEER', 'rekordbox', 'export-manifest.json');

  // Detection keys off the PIONEER markers; the manifest only adds the counts.
  const fsWithExport = (root) =>
    makeFs({
      dirs: [STICK, root, path.dirname(manifest), NESTED],
      files: {
        [path.join(root, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
        [manifest]: MANIFEST,
      },
    });

  it('finds the export when the folder itself is the export root', () => {
    const found = findExportRoot(EXPORT, { fsImpl: fsWithExport(EXPORT) });
    expect(found.root).toBe(EXPORT);
    expect(found.exports).toHaveLength(1);
    expect(found.exports[0].software).toBe('rekordbox');
  });

  it('walks up so a folder inside the export still resolves', () => {
    const found = findExportRoot(NESTED, { fsImpl: fsWithExport(EXPORT) });
    expect(found.root).toBe(EXPORT);
  });

  it('returns the nearest export, not an outer one', () => {
    const outer = '/media/outer';
    const inner = path.join(outer, 'inner');
    const innerManifest = path.join(inner, 'PIONEER', 'rekordbox', 'export-manifest.json');
    const outerManifest = path.join(outer, 'PIONEER', 'rekordbox', 'export-manifest.json');
    const fsImpl = makeFs({
      dirs: [outer, inner, path.dirname(innerManifest), path.dirname(outerManifest)],
      files: {
        [path.join(inner, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
        [path.join(outer, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
        [innerManifest]: MANIFEST,
        [outerManifest]: MANIFEST,
      },
    });

    expect(findExportRoot(inner, { fsImpl }).root).toBe(inner);
  });

  it('returns null when nothing above the folder is an export', () => {
    expect(
      findExportRoot('/home/radexito/music', { fsImpl: makeFs({ dirs: ['/home/radexito/music'] }) })
    ).toBeNull();
  });

  it('gives up after maxDepth levels', () => {
    const deep = path.join(STICK, 'a', 'b', 'c');
    const fsImpl = makeFs({
      dirs: [STICK, deep, EXPORT, path.dirname(manifest)],
      files: { [path.join(EXPORT, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary' },
    });
    expect(findExportRoot(deep, { fsImpl, maxDepth: 1 })).toBeNull();
  });

  it('handles empty and missing input', () => {
    expect(findExportRoot('', { fsImpl: makeFs() })).toBeNull();
    expect(findExportRoot(null, { fsImpl: makeFs() })).toBeNull();
    expect(findExportRoot(undefined, { fsImpl: makeFs() })).toBeNull();
  });
});

describe('camelotFromText', () => {
  it('converts the text keys a manifest carries', () => {
    expect(camelotFromText('F# minor')).toBe('11A');
    expect(camelotFromText('A minor')).toBe('8A');
    expect(camelotFromText('C# minor')).toBe('12A');
    expect(camelotFromText('C major')).toBe('8B');
    expect(camelotFromText('F major')).toBe('7B');
    expect(camelotFromText('E minor')).toBe('9A');
    expect(camelotFromText('Eb minor')).toBe('2A');
    expect(camelotFromText('Db major')).toBe('3B');
  });

  it('passes a key that is already Camelot through', () => {
    expect(camelotFromText('11A')).toBe('11A');
    expect(camelotFromText('8b')).toBe('8B');
  });

  it('returns null when there is nothing to convert', () => {
    expect(camelotFromText('')).toBeNull();
    expect(camelotFromText('   ')).toBeNull();
    expect(camelotFromText(null)).toBeNull();
    expect(camelotFromText(undefined)).toBeNull();
    expect(camelotFromText('H minor')).toBeNull();
  });

  it('reads a manifest key into the library format', () => {
    const fsImpl = makeFs({
      dirs: [ROOT, path.dirname(manifestPath)],
      files: {
        [path.join(ROOT, 'PIONEER', 'rekordbox', 'export.pdb')]: 'binary',
        [manifestPath]: JSON.stringify({
          version: '1',
          tracks: [
            {
              id: 1,
              title: 'Warehouse',
              artist: 'A',
              duration: 200,
              bpm: 128,
              key_raw: 'F# minor',
              file_path: '/music/Warehouse.mp3',
            },
          ],
          playlists: [{ id: 'pl-1', name: 'Set', track_ids: [1] }],
        }),
      },
    });

    const rb = detectExports(ROOT, fsImpl).find((e) => e.software === 'rekordbox');
    expect(rb.entries[0].tracks[0].key).toBe('F# minor');
    expect(rb.entries[0].tracks[0].key_camelot).toBe('11A');
  });
});
