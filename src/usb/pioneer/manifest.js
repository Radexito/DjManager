import fs from 'node:fs';
import path from 'node:path';

/**
 * The manifest the exporter keeps next to the playlist database.
 *
 * It records what this application last wrote to the stick, which the database
 * cannot answer on its own: rows are addressed by ids the library assigns.
 * Reading it back is how an incremental export knows which tracks are already
 * there and which playlists it has to rewrite.
 */

export function getManifestPath(usbRoot) {
  return path.join(usbRoot, 'PIONEER', 'rekordbox', 'export-manifest.json');
}

export function loadManifest(usbRoot) {
  const p = getManifestPath(usbRoot);
  if (!fs.existsSync(p)) return { tracks: new Map(), playlists: new Map() };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      tracks: new Map((data.tracks || []).map((t) => [t.id, t])),
      playlists: new Map((data.playlists || []).map((pl) => [pl.id, pl])),
    };
  } catch {
    return { tracks: new Map(), playlists: new Map() };
  }
}

export function saveManifest(usbRoot, tracksMap, playlistsMap) {
  const p = getManifestPath(usbRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      tracks: [...tracksMap.values()],
      playlists: [...playlistsMap.values()],
    }),
    'utf8'
  );
}
