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
  updateTrackWaveform,
} from '../db/trackRepository.js';
import { getAnalyzerRuntimePath } from '../deps.js';
import { getSetting } from '../db/settingsRepository.js';
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

export function getLibraryBase() {
  const custom = getSetting('library_path');
  return custom || path.join(app.getPath('userData'), 'audio');
}

export function getArtworkBase() {
  return path.join(app.getPath('userData'), 'artwork');
}

function getAudioStoragePath(hash, ext) {
  const base = getLibraryBase();
  const shard = hash.slice(0, 2);
  fs.mkdirSync(path.join(base, shard), { recursive: true });
  return path.join(base, shard, `${hash}${ext}`);
}

async function extractArtwork(srcPath, hash) {
  const artworkBase = getArtworkBase();
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

function getNormalizedStoragePath(hash, ext) {
  const base = getLibraryBase();
  const shard = hash.slice(0, 2);
  fs.mkdirSync(path.join(base, shard), { recursive: true });
  return path.join(base, shard, `${hash}_norm${ext}`);
}

export async function normalizeAudioFile(track, targetLufs) {
  // Always compute gain from the ORIGINAL loudness, not the normalized file's loudness.
  // source_loudness is set once (first normalization) and never overwritten.
  const sourceLoudness = track.source_loudness ?? track.loudness;
  if (sourceLoudness == null) throw new Error('Track has no loudness data');
  const gain = targetLufs - sourceLoudness;
  const ext = path.extname(track.file_path);
  const normalizedPath = getNormalizedStoragePath(track.file_hash, ext);

  await execFileAsync(getFfmpegRuntimePath(), [
    '-y',
    '-i',
    track.file_path,
    '-filter:a',
    `volume=${gain.toFixed(2)}dB`,
    '-c:v',
    'copy',
    normalizedPath,
  ]);

  return normalizedPath;
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
      .then((buf) => updateTrackWaveform(trackId, buf))
      .catch((err) =>
        console.warn(`[waveform] overview failed for track ${trackId}:`, err.message)
      );

    // Include normalized_file_path from DB so renderer knows to switch playback to the normalized file
    const trackAfterUpdate = getTrackById(trackId);
    const normalized_file_path = trackAfterUpdate?.normalized_file_path ?? null;
    console.log(
      `[importManager] track-updated for ${trackId}: normalized_file_path=${normalized_file_path}`
    );

    // Notify renderer
    if (global.mainWindow) {
      global.mainWindow.webContents.send('track-updated', {
        trackId,
        analysis: { ...update, normalized_file_path },
      });
    }

    // Mark this worker as done (silent re-analyses don't affect the counter)
    if (!silent) {
      analysisActive--;
      analysisDone++;
      sendAnalysisProgress();
    }

    // Auto-normalize on import: only when setting is enabled AND this is a fresh (non-normalized) track
    const autoNormalize = getSetting('auto_normalize_on_import', 'false') === 'true';
    const alreadyNormalized = trackAfterUpdate?.normalized_file_path != null;
    if (autoNormalize && !alreadyNormalized && update.loudness != null) {
      const targetLufs = Number(getSetting('normalize_target_lufs', '-9'));
      normalizeAudioFile(trackAfterUpdate, targetLufs)
        .then((normalizedPath) => {
          const dbUpdate = { normalized_file_path: normalizedPath };
          if (trackAfterUpdate.source_loudness == null) dbUpdate.source_loudness = update.loudness;
          updateTrack(trackId, dbUpdate);
          if (global.mainWindow) {
            global.mainWindow.webContents.send('track-updated', {
              trackId,
              analysis: { normalized_file_path: normalizedPath, analyzed: 0 },
            });
          }
          spawnAnalysis(trackId, normalizedPath, { silent: true });
        })
        .catch((err) => {
          console.error(`[auto-normalize] failed for track ${trackId}:`, err.message);
        });
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

export async function importAudioFile(filePath, sourceMeta = {}) {
  console.log(`Importing: ${filePath}`);
  const ext = path.extname(filePath);
  const hash = await hashFile(filePath);

  // Skip import if this file content already exists in the library
  const existing = getTrackByHash(hash);
  if (existing) {
    console.log(`Skipping duplicate: hash ${hash} already exists as track ID ${existing.id}`);
    return existing.id;
  }

  const dest = getAudioStoragePath(hash, ext);

  if (!fs.existsSync(dest)) {
    fs.copyFileSync(filePath, dest);
  }

  const probe = await ffprobe(dest);
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

  // Extract embedded album art (best-effort, non-blocking)
  const artworkPath = await extractArtwork(dest, hash);

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
