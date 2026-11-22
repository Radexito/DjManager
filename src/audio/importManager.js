import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { Worker } from 'worker_threads';
import { ffprobe } from './ffmpeg.js';
import { sampleInfoFromProbe } from './sampleInfo.js';
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
import { listAudioFiles } from '../library/libraryWatcher.js';
import { writeBpmKeyTags } from './id3Writer.js';
import { hasRenderer, sendToRenderer } from '../main/rendererBridge.js';

const execFileAsync = promisify(execFile);

/** How many analysis workers may run at once; each one spawns the analyzer binary. */
const MAX_ANALYSIS_WORKERS = 4;
/** Idle gap (ms) after which the next analysis resets the progress counters instead of continuing the batch. */
const ANALYSIS_BATCH_IDLE_MS = 2000;

/** Analysis workers running right now. */
let analysisActive = 0;
/** Tracks in the current analysis batch, as shown in the progress bar. */
let analysisTotal = 0;
/** Tracks of the current batch that have finished. */
let analysisDone = 0;
/** Time of the last batch change, used to tell a new batch from a resumed one. */
let analysisBatchTouchedAt = 0;

/** Mark the current analysis batch as active now. */
function touchAnalysisBatch() {
  analysisBatchTouchedAt = Date.now();
}

/** Push the analysis counters to the renderer, if one is attached. */
function sendAnalysisProgress() {
  if (!hasRenderer()) return;
  sendToRenderer('analysis-progress', {
    active: analysisActive,
    total: analysisTotal,
    done: analysisDone,
    finished: analysisActive === 0 && analysisQueue.length === 0,
  });
}

const activeAnalysisWorkers = new Map();
let analysisQueue = [];

/**
 * True while an analysis worker is running or waiting for one.
 * The sync engine reads this to stay out of the library while it is written.
 */
export function isAnalysisBusy() {
  return analysisActive > 0 || analysisQueue.length > 0;
}

/**
 * Close out a job exactly once. A cancelled worker is dropped from the batch
 * (total goes down) while a worker that finished is counted as done, so a
 * re-analysed track can never leave the bar stuck part-way.
 */
function finishAnalysis(trackId, { completed = true } = {}) {
  const entry = activeAnalysisWorkers.get(trackId);
  if (!entry || entry.settled) return false;
  entry.settled = true;
  activeAnalysisWorkers.delete(trackId);
  analysisActive = Math.max(0, analysisActive - 1);
  touchAnalysisBatch();
  if (!entry.silent) {
    if (completed) analysisDone++;
    else analysisTotal = Math.max(0, analysisTotal - 1);
    sendAnalysisProgress();
  }
  pumpAnalysis();
  return true;
}

/** Start queued analyses for as long as worker slots are free. */
function pumpAnalysis() {
  while (analysisActive < MAX_ANALYSIS_WORKERS && analysisQueue.length > 0) {
    startAnalysisJob(analysisQueue.shift());
  }
}

/**
 * Forget every queued and running job, so a caller can start from a known
 * state; nothing in the app calls it.
 */
export function resetAnalysisState() {
  for (const entry of activeAnalysisWorkers.values()) entry.worker.terminate?.();
  activeAnalysisWorkers.clear();
  analysisQueue = [];
  analysisActive = 0;
  analysisTotal = 0;
  analysisDone = 0;
  analysisBatchTouchedAt = 0;
}

/**
 * Drop one track's analysis, queued or running, and keep the counters honest.
 * @param {number} trackId
 * @returns {boolean} true when something was cancelled
 */
export function cancelAnalysis(trackId) {
  const queued = analysisQueue.findIndex((job) => job.trackId === trackId);
  if (queued !== -1) {
    const [job] = analysisQueue.splice(queued, 1);
    if (!job.silent) {
      analysisTotal = Math.max(0, analysisTotal - 1);
      sendAnalysisProgress();
    }
    return true;
  }

  const entry = activeAnalysisWorkers.get(trackId);
  if (!entry) return false;
  entry.settled = true;
  activeAnalysisWorkers.delete(trackId);
  analysisActive = Math.max(0, analysisActive - 1);
  if (!entry.silent) {
    analysisTotal = Math.max(0, analysisTotal - 1);
    sendAnalysisProgress();
  }
  entry.worker.terminate();
  pumpAnalysis();
  return true;
}

/**
 * SHA-1 of a file's contents, hex encoded — the library's duplicate and identity key.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function hashFile(filePath) {
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Read a boolean setting, which the settings table stores as the string 'true'/'false'.
 * @param {string} key
 * @returns {boolean} false for anything other than 'true'
 */
function settingFlag(key) {
  return getSetting(key, 'false') === 'true';
}

/**
 * Write one track's analyzed BPM/key into its file tags.
 * Shared by the analysis hook and the manual "Save BPM & Key" action.
 * @param {number} trackId
 * @param {{ overwrite?: boolean }} [opts]  defaults to the metadata_overwrite_tags setting
 * @returns {Promise<{ trackId: number, ok: boolean, reason?: string, wrote?: string[], error?: string }>}
 */
export async function writeBpmKeyTagsForTrack(trackId, { overwrite = null } = {}) {
  const track = getTrackById(trackId);
  if (!track?.file_path) return { trackId, ok: false, reason: 'no-track' };

  const bpm = track.bpm_override ?? track.bpm ?? null;
  const key = track.key_camelot ?? null;
  if (bpm == null && !key) return { trackId, ok: false, reason: 'no-values' };

  const useOverwrite =
    overwrite == null ? settingFlag('metadata_overwrite_tags') : Boolean(overwrite);
  const res = await writeBpmKeyTags(track.file_path, { bpm, key, overwrite: useOverwrite });

  if (res.ok && (res.wrote?.length ?? 0) > 0) {
    try {
      updateTrack(trackId, { file_hash: await hashFile(track.file_path) });
    } catch (err) {
      console.warn(`[metadata] could not refresh file_hash for track ${trackId}:`, err.message);
    }
  }
  return { trackId, ...res };
}

/** Auto-write after analysis — no-op unless the matching target setting is on. */
async function autoWriteBpmKeyTags(trackId) {
  const track = getTrackById(trackId);
  if (!track) return;
  const enabled = track.is_linked
    ? settingFlag('metadata_autowrite_linked')
    : settingFlag('metadata_autowrite_library');
  if (!enabled) return;

  const res = await writeBpmKeyTagsForTrack(trackId);
  if (!res.ok && !['no-values', 'already-current', 'unsupported-format'].includes(res.reason)) {
    console.warn(
      `[metadata] BPM/key tag write skipped for track ${trackId}:`,
      res.reason,
      res.error ?? ''
    );
  }
}

/**
 * Where a library's audio lives when it has no root_path of its own: a folder per
 * library under userData, so two libraries never share files.
 * @param {number} libraryId
 * @returns {string}
 */
function defaultAudioBase(libraryId) {
  if (Number(libraryId) === Number(getDefaultLibraryId()))
    return path.join(app.getPath('userData'), 'audio');
  return path.join(app.getPath('userData'), 'libraries', String(libraryId), 'audio');
}

/**
 * Where a library's artwork lives: a folder per library under userData.
 * @param {number} libraryId
 * @returns {string}
 */
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

/**
 * Artwork folder of a library. Unlike the audio folder this has no stored
 * override, so it is always the per-library default.
 * @param {number} libraryId
 * @returns {string}
 */
export function getArtworkBase(libraryId) {
  return defaultArtworkBase(libraryId);
}

/**
 * Total size of a folder tree in bytes, summed recursively. A folder that cannot
 * be read counts as 0 rather than failing the caller.
 * @param {string} dir
 * @returns {number}
 */
function getDirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {}
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

/**
 * Storage format of a library: 'readable' (artist - title folders) or 'hashed'
 * (sharded by file hash), the latter being the default.
 * @param {number} libraryId
 * @returns {'readable'|'hashed'}
 */
export function getStorageFormat(libraryId) {
  return getLibrary(libraryId)?.storage_format === 'readable' ? 'readable' : 'hashed';
}

/**
 * Make a string safe to use as a file or folder name by replacing the characters
 * Windows rejects; an empty result becomes "Unknown".
 * @param {string} s
 * @returns {string}
 */
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
  setLibraryStorageFormat(libraryId, newFormat);

  for (const track of tracks) {
    const oldPath = track.file_path;
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
        if (hasRenderer()) {
          sendToRenderer('track-updated', {
            trackId: track.id,
            analysis: { file_path: newPath, analyzed: track.analyzed },
          });
        }
      }
    }
    moved++;
    if (hasRenderer()) {
      sendToRenderer('convert-storage-format-progress', {
        moved,
        total,
        pct: Math.round((moved / total) * 100),
      });
    }
  }

  try {
    for (const entry of fs.readdirSync(oldBase)) {
      const d = path.join(oldBase, entry);
      if (fs.statSync(d).isDirectory() && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    }
  } catch {}

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

/**
 * Pull the first embedded cover out of a file into `<hash>.jpg`, reusing the one
 * already there. Returns null when the file has no artwork, or when ffmpeg
 * cannot write it.
 * @param {string} srcPath
 * @param {string} hash
 * @param {number} libraryId
 * @returns {Promise<string|null>} path of the artwork file
 */
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

/**
 * Map ffprobe's tags to the track columns, accepting the lower/upper case names
 * the different containers report, with the genre split on commas.
 * @param {object} ffprobeData
 * @returns {{title: string, artist: string, album: string, genre: string[],
 *            year: number|null, label: string, bpm: number|null}}
 */
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

/**
 * Queue an analysis. A fresh analysis replaces any pending or running one for
 * the same track, and the batch counters reset when the queue is empty.
 */
export function spawnAnalysis(trackId, filePath, { silent = false } = {}) {
  cancelAnalysis(trackId);

  analysisQueue.push({ trackId, filePath, silent });

  if (!silent) {
    if (analysisActive === 0 && analysisQueue.length === 1) {
      if (Date.now() - analysisBatchTouchedAt > ANALYSIS_BATCH_IDLE_MS) {
        analysisTotal = 0;
        analysisDone = 0;
      }
    }
    analysisTotal++;
  }
  touchAnalysisBatch();
  sendAnalysisProgress();
  pumpAnalysis();
}

/** Run one queued analysis in a worker thread. */
function startAnalysisJob({ trackId, filePath, silent }) {
  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { filePath, trackId, analyzerPath: getAnalyzerRuntimePath() },
  });

  activeAnalysisWorkers.set(trackId, { worker, silent, settled: false });
  analysisActive++;
  sendAnalysisProgress();

  worker.on('error', (err) => {
    console.error(`Analysis worker error for track ID ${trackId}:`, err.message);
    finishAnalysis(trackId);
  });

  worker.on('exit', (code) => {
    if (code !== 0)
      console.warn(`Analysis worker exited with code ${code} for track ID ${trackId}`);
    finishAnalysis(trackId);
  });

  worker.on('message', ({ ok, result, error }) => {
    if (!ok) {
      console.error(`Analysis failed for track ID ${trackId}:`, error);
      finishAnalysis(trackId);
      return;
    }
    console.log(`Analysis finished for track ID ${trackId}:`, result);

    const { tagFallbacks, ...analysisFields } = result;

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

    const normTarget = getSetting('normalize_target_lufs', null);
    if (normTarget != null && update.loudness != null) {
      const parsed = Number(normTarget);
      if (Number.isFinite(parsed)) {
        update.replay_gain = Math.round((parsed - update.loudness) * 10) / 10;
      }
    }

    updateTrack(trackId, update);

    autoWriteBpmKeyTags(trackId).catch((err) =>
      console.warn(`[metadata] BPM/key tag write failed for track ${trackId}:`, err.message)
    );

    generateWaveformOverview(filePath, getFfmpegRuntimePath())
      .then((buf) => {
        updateTrackWaveform(trackId, buf);
        if (hasRenderer()) {
          sendToRenderer('waveform-ready', { trackId });
        }
      })
      .catch((err) =>
        console.warn(`[waveform] overview failed for track ${trackId}:`, err.message)
      );

    if (hasRenderer()) {
      sendToRenderer('track-updated', { trackId, analysis: update });
    }

    finishAnalysis(trackId);

    const autoCue = getSetting('auto_cue_on_import', 'false') === 'true';
    if (autoCue) {
      try {
        const existing = getCuePoints(trackId);
        if (existing.length === 0) {
          const freshTrack = getTrackById(trackId);
          const generated = generateCuePoints(freshTrack);
          generated.forEach((cue) => addCuePoint({ trackId, ...cue }));
          console.log(`[auto-cue] generated ${generated.length} cue points for track ${trackId}`);
          if (hasRenderer()) {
            sendToRenderer('cue-points-updated', { trackId });
          }
        }
      } catch (err) {
        console.error(`[auto-cue] failed for track ${trackId}:`, err.message);
      }
    }
  });
}

/**
 * Import one audio file into a library: skip it when its hash is already known,
 * copy it to the library's storage path, read its tags, insert the row and queue
 * an analysis.
 * @param {string} filePath - the file to import
 * @param {object} [sourceMeta] - download origin (channel, source_url, quality…)
 * @param {number|null} [libraryId] - defaults to the current library
 * @returns {Promise<number>} id of the track, new or already present
 */
export async function importAudioFile(filePath, sourceMeta = {}, libraryId = null) {
  console.log(`Importing: ${filePath}`);
  const targetLibraryId = libraryId ?? getCurrentLibraryId();
  const ext = path.extname(filePath);
  const hash = await hashFile(filePath);

  const existing = getTrackByHash(hash);
  if (existing) {
    console.log(`Skipping duplicate: hash ${hash} already exists as track ID ${existing.id}`);
    return existing.id;
  }

  const probe = await ffprobe(filePath);
  const format = ext.slice(1).toLowerCase();
  const duration = Number(probe.format.duration);
  const bitrate = Number(probe.format.bit_rate);
  const { sampleRate, bitDepth } = sampleInfoFromProbe(probe);

  const { title, artist, album, genre, year, label, bpm } = parseTags(probe);

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
    sample_rate: sampleRate,
    bit_depth: bitDepth,
  });

  console.log(`Added track ID ${trackId}: ${resolvedTitle || basename}`);

  spawnAnalysis(trackId, dest);
  return trackId;
}

/**
 * #256 — scan the configured ingest folders and import anything new.
 * Files already in the database (matched by path) are skipped without hashing;
 * `importAudioFile` additionally de-duplicates by content hash, so a re-scan is
 * always safe. Importing triggers analysis (and, if enabled, the #474 tag write).
 *
 * @param {string[]} folders
 * @param {{ libraryId?: number|null, onProgress?: (p: {done:number,total:number}) => void }} [opts]
 * @returns {Promise<{ found: number, imported: number, skipped: number, failed: number }>}
 */
export async function scanFoldersForNewTracks(folders = [], { libraryId = null, onProgress } = {}) {
  const files = await listAudioFiles(folders);
  if (files.length === 0) return { found: 0, imported: 0, skipped: 0, failed: 0 };

  const knownPaths = new Set(getTracksByPaths(files).map((t) => t.file_path));
  const pending = files.filter((f) => !knownPaths.has(f));

  let imported = 0;
  let failed = 0;
  for (const file of pending) {
    try {
      const id = await importAudioFile(file, {}, libraryId);
      if (id) imported++;
    } catch (err) {
      failed++;
      console.warn(`[scan] import failed for ${file}:`, err.message);
    }
    onProgress?.({ done: imported + failed, total: pending.length });
  }

  console.log(
    `[scan] ${folders.length} folder(s): ${files.length} audio file(s), ${pending.length} new, ` +
      `${imported} imported, ${failed} failed`
  );
  return { found: files.length, imported, skipped: files.length - pending.length, failed };
}

/**
 * Register a file where it already is, without copying it into the library; the
 * audio folder is not touched and the row is marked as linked.
 * @param {string} filePath
 * @param {number|null} [libraryId] - defaults to the current library
 * @returns {Promise<{id: number, duplicate: boolean}>} duplicate when that path is already a track
 */
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
  let sampleRate = null;
  let bitDepth = null;

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
    ({ sampleRate, bitDepth } = sampleInfoFromProbe(meta));
  } catch {}

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
    sample_rate: sampleRate,
    bit_depth: bitDepth,
  });

  spawnAnalysis(trackId, filePath);
  return { id: trackId, duplicate: false };
}
