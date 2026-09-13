import fs from 'node:fs';
import path from 'node:path';

/**
 * Writing a prepared track back into the export it lives in.
 *
 * Preparing a track edits the app's own copy of its analysis (cue points in the
 * database, beat grid and BPM on the track row). When that track sits inside one
 * of our exports, the export is what a deck reads, so the same edit has to be
 * written there too: the ANLZ files first, then the export manifest, which is
 * what the Explorer reads an export through (#504).
 *
 * Only exports carrying our own manifest are written to. A Rekordbox stick made
 * elsewhere keeps its analysis in folders we did not name, so guessing at them
 * would leave the real files untouched and add stray ones beside them.
 */

/** How a track is spelled inside an export: '/music/track.mp3'. */
export function usbRelativePath(exportRoot, filePath) {
  if (!exportRoot || !filePath) return null;
  const relative = path.relative(exportRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return `/${relative.split(path.sep).join('/')}`;
}

/**
 * The manifest entry for a track. Our exports store the library id, which is the
 * reliable key; the exported path is the fallback for older manifests.
 */
export function manifestEntryFor(manifest, { id, usbFilePath } = {}) {
  const tracks = Array.isArray(manifest?.tracks) ? manifest.tracks : [];
  if (id != null) {
    const byId = tracks.find((t) => t.id === id);
    if (byId) return byId;
  }
  return tracks.find((t) => t.file_path === usbFilePath) ?? null;
}

/**
 * The fields a prepare session can change, copied onto a manifest entry.
 * Returns the new manifest and whether anything actually moved.
 */
export function applyTrackEdit(manifest, entry, track = {}) {
  const next = { ...entry };
  if (track.bpm_override != null) next.bpm = track.bpm_override;
  else if (track.bpm != null) next.bpm = track.bpm;
  if (track.key_raw) next.key_raw = track.key_raw;
  if (track.duration != null) next.duration = track.duration;
  if (track.title) next.title = track.title;
  if (track.artist != null) next.artist = track.artist;
  if (track.album != null) next.album = track.album;

  const changed = Object.keys(next).some((key) => next[key] !== entry[key]);
  if (!changed) return { manifest, changed: false };

  return {
    manifest: { ...manifest, tracks: manifest.tracks.map((t) => (t === entry ? next : t)) },
    changed: true,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.exportRoot export root the track lives in
 * @param {string} opts.filePath the track's file as the library knows it
 * @param {object} opts.track track row (bpm, bpm_override, key_raw, duration, …)
 * @param {Array} opts.cuePoints enabled cue points of that track
 * @param {Function} opts.writeAnlz the ANLZ writer
 * @param {string} [opts.ffmpegPath]
 * @param {object} [opts.fsImpl] injectable filesystem
 * @returns {Promise<{ok: boolean, reason?: string, usbFilePath?: string,
 *   manifestUpdated?: boolean, error?: string}>}
 */
export async function writeTrackBackToExport({
  exportRoot,
  filePath,
  track,
  cuePoints = [],
  writeAnlz,
  ffmpegPath,
  fsImpl = fs,
}) {
  if (!exportRoot || !filePath || !track?.id) return { ok: false, reason: 'incomplete' };

  const manifestPath = path.join(exportRoot, 'PIONEER', 'rekordbox', 'export-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'no-manifest' };
  }
  if (!Array.isArray(manifest?.tracks)) return { ok: false, reason: 'no-manifest' };

  const entry = manifestEntryFor(manifest, {
    id: track.id,
    usbFilePath: usbRelativePath(exportRoot, filePath),
  });
  if (!entry) return { ok: false, reason: 'not-in-export' };

  // The export decides where the track sits on the drive, not the library path.
  const usbFilePath = entry.file_path;
  await writeAnlz({
    usbFilePath,
    sourceFilePath: filePath,
    beatgrid: track.beatgrid ?? null,
    bpm: track.bpm_override ?? track.bpm ?? 0,
    beatgridOffset: track.beatgrid_offset ?? 0,
    usbRoot: exportRoot,
    ffmpegPath,
    cuePoints,
  });

  const { manifest: updated, changed } = applyTrackEdit(manifest, entry, track);
  if (changed) {
    const tmpPath = `${manifestPath}.tmp`;
    fsImpl.writeFileSync(tmpPath, JSON.stringify(updated), 'utf8');
    fsImpl.renameSync(tmpPath, manifestPath);
  }

  return { ok: true, usbFilePath, manifestUpdated: changed };
}
