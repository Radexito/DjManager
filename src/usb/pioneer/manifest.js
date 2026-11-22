import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The manifest the exporter keeps next to the playlist database.
 *
 * Version 2 adds what a sync needs and version 1 did not carry: a stable
 * `exportId`, the revision each track and playlist had when it was written, the
 * files this application owns, the tracks that were retired, and when the last
 * sync happened. A version 1 file still loads: its entries keep their fields and
 * the mapping between library tracks and device files survives, and the next
 * save writes version 2.
 */

export const MANIFEST_VERSION = 2;

export function getManifestPath(usbRoot) {
  return path.join(usbRoot, 'PIONEER', 'rekordbox', 'export-manifest.json');
}

/** An empty in-memory manifest, in the same shape a loaded one has. */
export function emptyManifest() {
  return {
    version: MANIFEST_VERSION,
    exportId: null,
    lastSync: null,
    tracks: new Map(),
    playlists: new Map(),
    ownedFiles: new Set(),
    retired: new Map(),
  };
}

function indexById(entries) {
  return new Map(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.id != null)
      .map((entry) => [entry.id, entry])
  );
}

/**
 * Read the manifest, whichever version is on the medium.
 * @param {string} usbRoot
 * @returns {object} tracks and playlists as Maps, plus the version 2 fields
 */
export function loadManifest(usbRoot) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(getManifestPath(usbRoot), 'utf8'));
  } catch {
    return emptyManifest();
  }
  if (!data || typeof data !== 'object') return emptyManifest();

  const tracks = indexById(data.tracks);
  const playlists = indexById(data.playlists);
  const owned = new Set(
    Array.isArray(data.ownedFiles)
      ? data.ownedFiles
      : [...tracks.values()].map((track) => track.file_path).filter(Boolean)
  );
  return {
    version: Number(data.version) || 1,
    exportId: data.exportId ?? null,
    lastSync: data.lastSync ?? null,
    tracks,
    playlists,
    ownedFiles: owned,
    retired: indexById(data.retired),
  };
}

/**
 * Build the version 2 document from the previous one and the current rows.
 *
 * Tracks that were in the previous manifest and are missing now are recorded as
 * retired, with the file they used. Their id is never handed to another track,
 * which is what keeps a device-side reference from silently changing meaning.
 *
 * @param {object} options
 * @param {object} [options.previous] manifest loaded before this export
 * @param {Map|object[]} options.tracks
 * @param {Map|object[]} options.playlists
 * @param {string} [options.exportId] reuse the previous id unless a new medium
 * @param {number} [options.lastSync]
 * @param {Iterable<string>} [options.ownedFiles]
 * @param {object[]} [options.retired] explicit retirements
 */
export function buildManifest({
  previous = emptyManifest(),
  tracks,
  playlists,
  exportId,
  lastSync = Date.now(),
  ownedFiles,
  retired = [],
} = {}) {
  const trackMap = tracks instanceof Map ? tracks : indexById(tracks);
  const playlistMap = playlists instanceof Map ? playlists : indexById(playlists);
  const retiredMap = new Map(previous.retired ?? []);
  for (const id of trackMap.keys()) retiredMap.delete(id);
  for (const [id, row] of previous.tracks ?? new Map()) {
    if (trackMap.has(id) || retiredMap.has(id)) continue;
    retiredMap.set(id, {
      id,
      file_path: row?.file_path ?? null,
      rev: row?.rev ?? null,
      retiredAt: lastSync,
    });
  }
  for (const entry of retired) {
    if (entry?.id != null) retiredMap.set(entry.id, entry);
  }

  const owned = new Set(ownedFiles ?? previous.ownedFiles ?? []);
  for (const row of trackMap.values()) {
    if (row?.file_path) owned.add(row.file_path);
  }

  return {
    version: MANIFEST_VERSION,
    exportId: exportId ?? previous.exportId ?? crypto.randomUUID(),
    lastSync,
    tracks: trackMap,
    playlists: playlistMap,
    ownedFiles: owned,
    retired: retiredMap,
  };
}

/** The JSON document written to the medium. */
export function manifestToJson(manifest) {
  return {
    version: MANIFEST_VERSION,
    exportId: manifest.exportId,
    lastSync: manifest.lastSync,
    tracks: [...manifest.tracks.values()],
    playlists: [...manifest.playlists.values()],
    ownedFiles: [...manifest.ownedFiles].sort(),
    retired: [...manifest.retired.values()],
  };
}

/**
 * Write the manifest, upgrading a version 1 file on the way.
 *
 * The previous document is read from the same root unless the caller passes one.
 * A caller writing into staging passes the manifest it read from the medium, so
 * `exportId` survives the export instead of being regenerated.
 */
export function saveManifest(usbRoot, tracksMap, playlistsMap, options = {}) {
  const previous = options.previous ?? loadManifest(usbRoot);
  const manifest = buildManifest({
    previous,
    tracks: tracksMap,
    playlists: playlistsMap,
    ...options,
  });
  const file = getManifestPath(usbRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifestToJson(manifest), null, 1), 'utf8');
  return manifest;
}
