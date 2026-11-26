import fs from 'node:fs';
import path from 'node:path';

import { readTagTree } from './formats/extRead.js';
import { readLibrary } from './formats/pdbRead.js';
import { loadManifest } from './manifest.js';

/**
 * What a medium actually carries, read from the medium itself.
 *
 * The library database and the tag tree are the source: they are what the player
 * shows, and they stay readable whether or not this application wrote the stick.
 * The manifest is only used for "when did we last write this", never for
 * contents, because a stick exported by rekordbox has none.
 */

export const PDB_REL = 'PIONEER/rekordbox/export.pdb';
export const EXT_PDB_REL = 'PIONEER/rekordbox/exportExt.pdb';

function toAbsolute(root, rel) {
  return path.join(root, ...String(rel).split('/'));
}

/**
 * Read one medium.
 * @param {string} root mount point
 * @param {object} [deps]
 * @param {Function} [deps.readFile]
 * @param {Function} [deps.exists]
 * @param {Function} [deps.loadManifestImpl]
 * @returns {object|null} null when the root carries no playlist database
 */
export function readMedium(
  root,
  { readFile = fs.readFileSync, exists = fs.existsSync, loadManifestImpl = loadManifest } = {}
) {
  if (!root) return null;
  const pdbPath = toAbsolute(root, PDB_REL);
  let library;
  try {
    library = readLibrary(readFile(pdbPath));
  } catch {
    return null;
  }

  let manifest = null;
  try {
    manifest = loadManifestImpl(root);
  } catch {
    manifest = null;
  }

  // A track row stores ids for artist and album; the readable names live in
  // their own tables, which is what the player shows.
  const artistName = new Map(library.artists.map((artist) => [artist.id, artist.name]));
  const albumName = new Map(library.albums.map((album) => [album.id, album.name]));
  const nameOf = (track) => ({
    id: track.id,
    title: track.title,
    artist: artistName.get(track.artistId) ?? '',
    album: albumName.get(track.albumId) ?? '',
    // The rest of the row the table already knows how to render.
    bpm: track.bpm,
    duration: track.duration,
    rating: track.rating,
    year: track.year,
  });

  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  const playlists = library.playlists.map((playlist) => {
    const trackIds = library.tracksByPlaylist.get(playlist.id) ?? [];
    return {
      id: playlist.id,
      name: playlist.name,
      isFolder: Boolean(playlist.isFolder),
      trackCount: trackIds.length,
      tracks: trackIds
        .map((id) => tracksById.get(id))
        .filter(Boolean)
        .map(nameOf),
    };
  });

  let tags = [];
  const extPath = toAbsolute(root, EXT_PDB_REL);
  try {
    if (exists(extPath)) tags = readTagTree(readFile(extPath));
  } catch {
    tags = [];
  }

  return {
    root,
    exportId: manifest?.exportId ?? null,
    lastSync: manifest?.lastSync ?? null,
    ours: Boolean(manifest?.exportId),
    trackCount: library.tracks.length,
    playlistCount: playlists.length,
    tagCount: tags.reduce((sum, category) => sum + category.tags.length, 0),
    tracks: library.tracks.map((track) => ({
      ...nameOf(track),
      filePath: track.filePath,
    })),
    playlists,
    tags,
  };
}
