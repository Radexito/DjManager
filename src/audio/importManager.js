import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { Worker } from 'worker_threads';
import { ffprobe } from './ffmpeg.js';
import { getFfmpegRuntimePath } from '../deps.js';
import {
  addTrack,
  updateTrack,
  getTrackById,
  getTrackByHash,
  getTracksByPaths,
  updateTrackWaveform,
  getTracks,
} from '../db/trackRepository.js';
import { getAnalyzerRuntimePath } from '../deps.js';
import { getSetting } from '../db/settingsRepository.js';
import { moveFileSafe } from '../utils/fsMove.js';
import {
  getLibrary,
  getCurrentLibraryId,
  getDefaultLibraryId,
  setLibraryStorageFormat,
} from '../db/libraryRepository.js';
import { generateCuePoints } from './cueGen.js';
import { getCuePoints, addCuePoint } from '../db/cuePointRepository.js';
import { generateWaveformOverview } from './waveformGenerator.js';

const execFileAsync = promisify(execFile);

// ─── Analysis progress tracking ─────────────────────────────────────────────

let analysisActive = 0; // workers currently running
let analysisTotal = 0; // total spawned in the current batch
let analysisDone = 0; // completed in the current batch

function sendAnalysisProgress() {
  if (!global.mainWindow) return;
  global.mainWindow.webContents.send('analysis-progress', {
    active: analysisActive,
    total: analysisTotal,
    done: analysisDone,
    finished: analysisActive === 0,
  });
}

// Map of trackId → Worker for active analysis jobs (enables cancellation)
const activeAnalysisWorkers = new Map();

export function cancelAnalysis(trackId) {
  const worker = activeAnalysisWorkers.get(trackId);
  if (!worker) return false;
  worker.terminate();
  activeAnalysisWorkers.delete(trackId);
  return true;
}

// ─── File hashing ────────────────────────────────────────────────────────────

function hashFile(filePath) {
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// The oldest library (lowest id — seeded as "Default" by the #390 migration)
// keeps the original, unscoped default paths so existing installs see no
// change on upgrade. Any additional library gets its own scoped default so
// two libraries never silently share a folder.
function defaultAudioBase(libraryId) {
  if (Number(libraryId) === Number(getDefaultLibraryId()))
    return path.join(app.getPath('userData'), 'audio');
  return path.join(app.getPath('userData'), 'libraries', String(libraryId), 'audio');
}

function defaultArtworkBase(libraryId) {
  if (Number(libraryId) === Number(getDefaultLibraryId()))
    return path.join(app.getPath('userData'), 'artwork');
  return path.join(app.getPath('userData'), 'libraries', String(libraryId), 'artwork');
}

/**
 * Root folder for a library's audio files. Falls back to a per-library
 * default scoped by id — never a shared path — unless the library has an
 * explicit root_path set (via "Move Library").
 */
export function getLibraryBase(libraryId) {
  const lib = getLibrary(libraryId);
  return lib?.root_path || defaultAudioBase(libraryId);
}

export function getArtworkBase(libraryId) {
  return defaultArtworkBase(libraryId);
}

function getDirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // not created yet (e.g. brand-new library with no imports)
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* file removed mid-scan */
      }
    }
  }
  return total;
}

/** Total bytes a library's audio + artwork files occupy on disk. */
export function getLibraryDiskUsage(libraryId) {
  return getDirSize(getLibraryBase(libraryId)) + getDirSize(getArtworkBase(libraryId));
}

/**
 * Free bytes remaining on the filesystem/partition backing a library.
 * Walks up to the nearest existing ancestor directory since a brand-new
 * library's folder may not be created on disk yet.
 */
export function getLibraryFreeSpace(libraryId) {
  let dir = getLibraryBase(libraryId);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export function getStorageFormat(libraryId) {
  return getLibrary(libraryId)?.storage_format === 'readable' ? 'readable' : 'hashed';
}

// Windows/macOS/Linux all reject at least these characters in filenames.
function sanitizeForFilename(s) {
  const cleaned = (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'Unknown';
}

/**
 * Where a track's audio file should live, given the library's current storage
 * format setting. `meta.artist`/`meta.title` are only used for 'readable'
 * mode — true duplicate content is already caught by the file-hash check in
 * importAudioFile before this is called, so a filename collision here means
 * a *different* track happens to share the same artist/title and just needs
 * a disambiguating suffix.
 */
function getAudioStoragePath(hash, ext, meta = {}, libraryId) {
  const base = getLibraryBase(libraryId);
  if (getStorageFormat(libraryId) === 'readable') {
    const artist = sanitizeForFilename(meta.artist);
    const title = sanitizeForFilename(meta.title);
    const artistDir = path.join(base, artist);
    fs.mkdirSync(artistDir, { recursive: true });
    let candidate = path.join(artistDir, `${artist} - ${title}${ext}`);
    for (let n = 2; fs.existsSync(candidate); n++) {
      candidate = path.join(artistDir, `${artist} - ${title} (${n})${ext}`);
    }
    return candidate;
  }
  const shard = hash.slice(0, 2);
  fs.mkdirSync(path.join(base, shard), { recursive: true });
  return path.join(base, shard, `${hash}${ext}`);
}

/**
 * Re-lay-out one library's tracks to match `newFormat`, reusing the same
 * move-with-EXDEV-fallback approach as moving a library. Reported progress
 * mirrors the move-library IPC event shape. Other libraries are untouched —
 * storage format is per-library, not global.
 */
export function convertStorageFormat(libraryId, newFormat) {
  if (newFormat !== 'hashed' && newFormat !== 'readable') {
    throw new Error(`Unknown storage format: ${newFormat}`);
  }
  if (newFormat === getStorageFormat(libraryId)) return { moved: 0, total: 0 };

  const tracks = getTracks({ limit: 999999, libraryIds: [libraryId] });
  const total = tracks.length;
  let moved = 0;

  const oldBase = getLibraryBase(libraryId);
  // Persist first so getAudioStoragePath() (called below via getStorageFormat())
  // computes every destination in the new layout.
  setLibraryStorageFormat(libraryId, newFormat);

  for (const track of tracks) {
    const oldPath = track.file_path;
    // Linked tracks live wherever the user put them, outside app-managed
    // storage, and have no file_hash — storage format doesn't apply to them.
    if (!track.is_linked && fs.existsSync(oldPath)) {
      const ext = path.extname(oldPath);
      const newPath = getAudioStoragePath(
        track.file_hash,
        ext,
        { artist: track.artist, title: track.title },
        libraryId
      );
      if (newPath !== oldPath) {
        moveFileSafe(oldPath, newPath);
        updateTrack(track.id, { file_path: newPath });
        // Keep the track list and any open Edit Details panel in sync —
        // pass through the existing `analyzed` flag so this doesn't
        // masquerade as a completed analysis for not-yet-analyzed tracks.
        if (global.mainWindow) {
          global.mainWindow.webContents.send('track-updated', {
            trackId: track.id,
            analysis: { file_path: newPath, analyzed: track.analyzed },
          });
        }
      }
    }
    moved++;
    if (global.mainWindow) {
      global.mainWindow.webContents.send('convert-storage-format-progress', {
        moved,
        total,
        pct: Math.round((moved / total) * 100),
      });
    }
  }

  // Remove now-empty shard/artist dirs left behind (best-effort)
  try {
    for (const entry of fs.readdirSync(oldBase)) {
      const d = path.join(oldBase, entry);
      if (fs.statSync(d).isDirectory() && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    }
  } catch {
    /* ignore */
  }

  return { moved, total };
}

/**
 * Move (or, for a linked track, import a copy of) one track into a different
 * library. Updates the same track row in place so playlist membership, cue
 * points, and rating all carry over untouched — only file_path/library_id
 * (and is_linked, for a linked source) change.
 */
export async function moveTrackToLibrary(trackId, targetLibraryId) {
  const track = getTrackById(trackId);
  if (!track) throw new Error('Track not found');
  const targetLib = getLibrary(targetLibraryId);
  if (!targetLib) throw new Error('Target library not found');
  if (!track.is_linked && Number(track.library_id) === Number(targetLibraryId)) {
    return { ok: true, moved: false };
  }

  const oldPath = track.file_path;
  if (!fs.existsSync(oldPath)) {
    throw new Error('Source file not found on disk');
  }
  const wasLinked = !!track.is_linked;
  const ext = path.extname(oldPath);
  const hash = track.file_hash || (await hashFile(oldPath));

  // If this exact content is already owned by the destination library, just
  // point at that copy rather than duplicating it.
  const dupe = getTrackByHash(hash);
  if (dupe && dupe.id !== trackId && Number(dupe.library_id) === Number(targetLibraryId)) {
    updateTrack(trackId, {
      file_path: dupe.file_path,
      file_hash: hash,
      library_id: targetLibraryId,
      is_linked: 0,
    });
    return { ok: true, moved: true, newPath: dupe.file_path, mergedWithExisting: true };
  }

  const dest = getAudioStoragePath(
    hash,
    ext,
    { artist: track.artist, title: track.title },
    targetLibraryId
  );

  if (dest !== oldPath) {
    if (wasLinked) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(oldPath, dest);
    } else {
      moveFileSafe(oldPath, dest);
    }
  }

  const artworkPath =
    wasLinked && !track.artwork_path ? await extractArtwork(dest, hash, targetLibraryId) : null;

  updateTrack(trackId, {
    file_path: dest,
    file_hash: hash,
    library_id: targetLibraryId,
    is_linked: 0,
    ...(artworkPath ? { artwork_path: artworkPath, has_artwork: 1 } : {}),
  });

  return { ok: true, moved: true, newPath: dest };
}

async function extractArtwork(srcPath, hash, libraryId) {
  const artworkBase = getArtworkBase(libraryId);
  fs.mkdirSync(artworkBase, { recursive: true });
  const artworkPath = path.join(artworkBase, `${hash}.jpg`);
  if (fs.existsSync(artworkPath)) return artworkPath;
  try {
    await execFileAsync(getFfmpegRuntimePath(), [
      '-y',
      '-i',
      srcPath,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-frames:v',
      '1',
      artworkPath,
    ]);
    return fs.existsSync(artworkPath) ? artworkPath : null;
  } catch {
    return null;
  }
}

function parseTags(ffprobeData) {
  const tags = ffprobeData.format?.tags || {};
  const bpmTag = tags.bpm || tags.BPM || tags.TBPM || tags['tbpm'];
  return {
    title: tags.title || '',
    artist: tags.artist || '',
    album: tags.album || '',
    genre: tags.genre ? tags.genre.split(',').map((g) => g.trim()) : [],
    year: tags.date ? parseInt(tags.date.slice(0, 4)) : null,
    label: tags.label || '',
    bpm: bpmTag ? parseFloat(bpmTag) || null : null,
  };
}

export function spawnAnalysis(trackId, filePath, { silent = false } = {}) {
  // Cancel any existing analysis for this track before spawning a new one
  cancelAnalysis(trackId);

  // Track this worker in the batch counter; reset totals when starting fresh.
  // Silent re-analyses (e.g. post-normalization) don't affect the progress bar.
  if (!silent) {
    if (analysisActive === 0) {
      analysisTotal = 0;
      analysisDone = 0;
    }
    analysisActive++;
    analysisTotal++;
    sendAnalysisProgress();
  }

  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { filePath, trackId, analyzerPath: getAnalyzerRuntimePath() },
  });

  activeAnalysisWorkers.set(trackId, worker);

  worker.on('error', (err) => {
    activeAnalysisWorkers.delete(trackId);
    console.error(`Analysis worker error for track ID ${trackId}:`, err.message);
    if (!silent) {
      analysisActive--;
      analysisDone++;
      sendAnalysisProgress();
    }
  });

  worker.on('exit', (code) => {
    activeAnalysisWorkers.delete(trackId);
    if (code !== 0)
      console.warn(`Analysis worker exited with code ${code} for track ID ${trackId}`);
  });

  worker.on('message', ({ ok, result, error }) => {
    if (!ok) {
      console.error(`Analysis failed for track ID ${trackId}:`, error);
      if (!silent) {
        analysisActive--;
        analysisDone++;
        sendAnalysisProgress();
      }
      return;
    }
    console.log(`Analysis finished for track ID ${trackId}:`, result);

    const { tagFallbacks, ...analysisFields } = result;

    // Apply tag fallbacks — only fill fields that ffprobe left null/empty
    const mergedTags = {};
    if (tagFallbacks) {
      const existing = getTrackById(trackId);
      for (const [key, val] of Object.entries(tagFallbacks)) {
        if (val != null && val !== '' && (existing?.[key] == null || existing[key] === '')) {
          mergedTags[key] = val;
        }
      }
    }

    const update = { ...analysisFields, bpm_override: null, ...mergedTags };

    // Re-apply normalization if configured — prevents re-analysis from wiping manual gain
    const normTarget = getSetting('normalize_target_lufs', null);
    if (normTarget != null && update.loudness != null) {
      const parsed = Number(normTarget);
      if (Number.isFinite(parsed)) {
        update.replay_gain = Math.round((parsed - update.loudness) * 10) / 10;
      }
    }

    updateTrack(trackId, update);

    // Generate waveform overview for in-app seek bar (fire-and-forget — does not
    // block analysis progress or track-updated event)
    generateWaveformOverview(filePath, getFfmpegRuntimePath())
      .then((buf) => {
        updateTrackWaveform(trackId, buf);
        if (global.mainWindow) {
          global.mainWindow.webContents.send('waveform-ready', { trackId });
        }
      })
      .catch((err) =>
        console.warn(`[waveform] overview failed for track ${trackId}:`, err.message)
      );

    // Notify renderer
    if (global.mainWindow) {
      global.mainWindow.webContents.send('track-updated', { trackId, analysis: update });
    }

    // Mark this worker as done (silent re-analyses don't affect the counter)
    if (!silent) {
      analysisActive--;
      analysisDone++;
      sendAnalysisProgress();
    }

    // Auto-generate cue points: only when setting is enabled and track has no cue points yet
    const autoCue = getSetting('auto_cue_on_import', 'false') === 'true';
    if (autoCue) {
      try {
        const existing = getCuePoints(trackId);
        if (existing.length === 0) {
          const freshTrack = getTrackById(trackId);
          const generated = generateCuePoints(freshTrack);
          generated.forEach((cue) => addCuePoint({ trackId, ...cue }));
          console.log(`[auto-cue] generated ${generated.length} cue points for track ${trackId}`);
          if (global.mainWindow) {
            global.mainWindow.webContents.send('cue-points-updated', { trackId });
          }
        }
      } catch (err) {
        console.error(`[auto-cue] failed for track ${trackId}:`, err.message);
      }
    }
  });
}

export async function importAudioFile(filePath, sourceMeta = {}, libraryId = null) {
  console.log(`Importing: ${filePath}`);
  const targetLibraryId = libraryId ?? getCurrentLibraryId();
  const ext = path.extname(filePath);
  const hash = await hashFile(filePath);

  // Skip import if this file content already exists in the library
  const existing = getTrackByHash(hash);
  if (existing) {
    console.log(`Skipping duplicate: hash ${hash} already exists as track ID ${existing.id}`);
    return existing.id;
  }

  // Probe the SOURCE file (not yet copied) — 'readable' storage format needs
  // artist/title to name the destination file, so tags must be known before
  // getAudioStoragePath() is called.
  const probe = await ffprobe(filePath);
  const format = ext.slice(1).toLowerCase();
  const duration = Number(probe.format.duration);
  const bitrate = Number(probe.format.bit_rate);

  // Extract tags
  const { title, artist, album, genre, year, label, bpm } = parseTags(probe);

  // Fallback: parse "Artist - Title" from filename when artist tag is absent
  const basename = path.basename(filePath, ext);
  let resolvedArtist = artist;
  let resolvedTitle = title;
  if (!artist) {
    const dashIdx = basename.indexOf(' - ');
    if (dashIdx !== -1) {
      resolvedArtist = basename.slice(0, dashIdx).trim();
      resolvedTitle = resolvedTitle || basename.slice(dashIdx + 3).trim();
    }
  }

  // Last-resort fallback: use channel/uploader name as artist when still empty
  if (!resolvedArtist && sourceMeta.channel) {
    resolvedArtist = sourceMeta.channel;
  }

  const dest = getAudioStoragePath(
    hash,
    ext,
    { artist: resolvedArtist, title: resolvedTitle || basename },
    targetLibraryId
  );

  if (!fs.existsSync(dest)) {
    fs.copyFileSync(filePath, dest);
  }

  // Extract embedded album art (best-effort, non-blocking)
  const artworkPath = await extractArtwork(dest, hash, targetLibraryId);

  const trackId = addTrack({
    title: resolvedTitle || basename,
    artist: resolvedArtist,
    album,
    duration,
    file_path: dest,
    file_hash: hash,
    format,
    bitrate,
    year,
    label,
    bpm,
    genres: JSON.stringify(genre),
    library_id: targetLibraryId,
    source_url: sourceMeta.source_url ?? null,
    source_platform: sourceMeta.source_platform ?? null,
    source_quality: sourceMeta.source_quality ?? null,
    source_link: sourceMeta.source_link ?? null,
    has_artwork: artworkPath ? 1 : 0,
    artwork_path: artworkPath ?? null,
  });

  console.log(`Added track ID ${trackId}: ${resolvedTitle || basename}`);

  spawnAnalysis(trackId, dest);
  return trackId;
}

export async function linkAudioFile(filePath, libraryId = null) {
  const targetLibraryId = libraryId ?? getCurrentLibraryId();
  const byPath = getTracksByPaths([filePath]);
  if (byPath.length > 0) return { id: byPath[0].id, duplicate: true };

  const basename = path.basename(filePath, path.extname(filePath));
  let title = basename;
  let artist = null;
  let album = null;
  let duration = 0;
  let format = path.extname(filePath).slice(1).toLowerCase();
  let bitrate = null;
  let year = null;
  let label = null;
  let bpm = null;
  let genre = [];

  try {
    const meta = await ffprobe(filePath);
    const tags = meta.format?.tags ?? {};
    title = tags.title || tags.TITLE || '';
    artist = tags.artist || tags.ARTIST || null;
    album = tags.album || tags.ALBUM || null;
    duration = parseFloat(meta.format?.duration ?? 0);
    bitrate = parseInt(meta.format?.bit_rate ?? 0, 10) || null;
    year = parseInt(tags.date || tags.year || '', 10) || null;
    label = tags.label || tags.publisher || null;
    bpm = parseFloat(tags.bpm || tags.BPM || '') || null;
    const g = tags.genre || tags.GENRE || '';
    genre = g ? [g] : [];
  } catch {}

  // Fallback: parse "Artist - Title" from filename when tags are absent
  if (!artist) {
    const dashIdx = basename.indexOf(' - ');
    if (dashIdx !== -1) {
      artist = basename.slice(0, dashIdx).trim();
      if (!title) title = basename.slice(dashIdx + 3).trim();
    }
  }

  const trackId = addTrack({
    title: title || basename,
    artist,
    album,
    duration,
    file_path: filePath,
    file_hash: null,
    format,
    bitrate,
    year,
    label,
    bpm,
    genres: JSON.stringify(genre),
    source_url: null,
    source_platform: null,
    source_quality: null,
    source_link: null,
    has_artwork: 0,
    artwork_path: null,
    is_linked: 1,
    library_id: targetLibraryId,
  });

  spawnAnalysis(trackId, filePath);
  return { id: trackId, duplicate: false };
}
