import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildManifest,
  emptyManifest,
  getManifestPath,
  loadManifest,
  MANIFEST_VERSION,
  manifestToJson,
  saveManifest,
} from '../usb/pioneer/manifest.js';

let roots = [];

function stick() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'djman-manifest-'));
  roots.push(root);
  return root;
}

function writeV1(root) {
  mkdirSync(path.dirname(getManifestPath(root)), { recursive: true });
  writeFileSync(
    getManifestPath(root),
    JSON.stringify({
      version: 1,
      tracks: [
        { id: 1, file_path: '/Contents/a.mp3', file_size: 100, rev: 3 },
        { id: 2, file_path: '/Contents/b.mp3', file_size: 200 },
      ],
      playlists: [{ id: 10, name: 'Set', track_ids: [1, 2] }],
    })
  );
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('manifest v2', () => {
  it('loads a version 1 file without losing the track mapping', () => {
    const root = stick();
    writeV1(root);

    const manifest = loadManifest(root);
    expect(manifest.version).toBe(1);
    expect([...manifest.tracks.keys()]).toEqual([1, 2]);
    expect(manifest.tracks.get(1).file_path).toBe('/Contents/a.mp3');
    expect(manifest.playlists.get(10).track_ids).toEqual([1, 2]);
    expect(manifest.exportId).toBeNull();
    expect(manifest.ownedFiles.has('/Contents/a.mp3')).toBe(true);
  });

  it('upgrades to version 2 on save and keeps the mapping', () => {
    const root = stick();
    writeV1(root);
    const loaded = loadManifest(root);

    const saved = saveManifest(root, loaded.tracks, loaded.playlists, { previous: loaded });
    expect(saved.version).toBe(MANIFEST_VERSION);
    expect(saved.exportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.lastSync).toBeGreaterThan(0);

    const reread = JSON.parse(readFileSync(getManifestPath(root), 'utf8'));
    expect(reread.version).toBe(2);
    expect(reread.tracks.map((track) => track.id).sort()).toEqual([1, 2]);
    expect(reread.playlists[0].track_ids).toEqual([1, 2]);
    expect(reread.ownedFiles).toEqual(['/Contents/a.mp3', '/Contents/b.mp3']);
  });

  it('keeps the export id stable across exports', () => {
    const root = stick();
    writeV1(root);
    const loaded = loadManifest(root);

    const first = saveManifest(root, loaded.tracks, loaded.playlists, { previous: loaded });
    const second = saveManifest(root, first.tracks, first.playlists, { previous: first });

    expect(second.exportId).toBe(first.exportId);
    expect(loadManifest(root).exportId).toBe(first.exportId);
  });

  it('retires a track that leaves the manifest instead of reusing its id', () => {
    const root = stick();
    writeV1(root);
    const loaded = loadManifest(root);
    const first = saveManifest(root, loaded.tracks, loaded.playlists, { previous: loaded });

    const remaining = new Map(first.tracks);
    remaining.delete(1);
    const second = saveManifest(root, remaining, first.playlists, { previous: first });

    expect(second.tracks.has(1)).toBe(false);
    expect(second.retired.get(1)).toMatchObject({
      id: 1,
      file_path: '/Contents/a.mp3',
      rev: 3,
    });
    expect(second.exportId).toBe(first.exportId);
  });

  it('generates an export id for a medium that never had a manifest', () => {
    const manifest = buildManifest({
      tracks: new Map([[7, { id: 7, file_path: '/Contents/g.mp3' }]]),
      playlists: new Map(),
    });
    expect(manifest.exportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(manifest.ownedFiles.has('/Contents/g.mp3')).toBe(true);
    expect(manifest.retired.size).toBe(0);
  });

  it('round trips every version 2 field through the file', () => {
    const manifest = buildManifest({
      previous: emptyManifest(),
      tracks: new Map([
        [1, { id: 1, file_path: '/Contents/a.mp3', rev: 4, hash: 'abc', file_fingerprint: '9:9' }],
      ]),
      playlists: new Map([[10, { id: 10, name: 'Set', rev: 2, track_ids: [1] }]]),
      exportId: 'fixed-export-id',
      lastSync: 42,
    });
    const json = manifestToJson(manifest);
    expect(json).toMatchObject({
      version: 2,
      exportId: 'fixed-export-id',
      lastSync: 42,
      retired: [],
    });
    expect(json.tracks[0]).toMatchObject({ rev: 4, hash: 'abc', file_fingerprint: '9:9' });
  });
});
