import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { Worker } from 'worker_threads';
import { ffprobe } from './ffmpeg.js';
import { getFfmpegRuntimePath } from '../deps.js';
import { addTrack, updateTrack, getTrackById, getTrackByHash } from '../db/trackRepository.js';
import { getAnalyzerRuntimePath } from '../deps.js';
import { getSetting } from '../db/settingsRepository.js';

const execFileAsync = promisify(execFile);

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

export function spawnAnalysis(trackId, filePath) {
  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { filePath, trackId, analyzerPath: getAnalyzerRuntimePath() },
  });

  worker.on('error', (err) => {
    console.error(`Analysis worker error for track ID ${trackId}:`, err.message);
  });

  worker.on('exit', (code) => {
    if (code !== 0)
      console.warn(`Analysis worker exited with code ${code} for track ID ${trackId}`);
  });

  worker.on('message', ({ ok, result, error }) => {
    if (!ok) {
      console.error(`Analysis failed for track ID ${trackId}:`, error);
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
    updateTrack(trackId, update);

    // Notify renderer
    if (global.mainWindow) {
      global.mainWindow.webContents.send('track-updated', { trackId, analysis: update });
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

  // Extract embedded album art (best-effort, non-blocking)
  const artworkPath = await extractArtwork(dest, hash);

  const trackId = addTrack({
    title: title || path.basename(filePath, ext),
    artist,
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

  console.log(`Added track ID ${trackId}: ${title || path.basename(filePath, ext)}`);

  spawnAnalysis(trackId, dest);
  return trackId;
}
