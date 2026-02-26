import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';
import { Worker } from 'worker_threads';
import { ffprobe } from './ffmpeg.js';
import { addTrack, updateTrack } from '../db/trackRepository.js';
import { getAnalyzerRuntimePath } from '../deps.js';
import { getSetting } from '../db/settingsRepository.js';

function hashFile(filePath) {
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function getLibraryBase() {
  const custom = getSetting('library_path');
  return custom || path.join(app.getPath('userData'), 'audio');
}

function getAudioStoragePath(hash, ext) {
  const base = getLibraryBase();
  const shard = hash.slice(0, 2);
  fs.mkdirSync(path.join(base, shard), { recursive: true });
  return path.join(base, shard, `${hash}${ext}`);
}

function parseTags(ffprobeData) {
  const tags = ffprobeData.format?.tags || {};
  return {
    title: tags.title || '',
    artist: tags.artist || '',
    album: tags.album || '',
    genre: tags.genre ? tags.genre.split(',').map(g => g.trim()) : [],
    year: tags.date ? parseInt(tags.date.slice(0, 4)) : null,
    label: tags.label || '',
  };
}

export function spawnAnalysis(trackId, filePath) {
  const worker = new Worker(
    new URL('./analysisWorker.js', import.meta.url),
    { workerData: { filePath, trackId, analyzerPath: getAnalyzerRuntimePath() } }
  );

  worker.on('message', ({ ok, result, error }) => {
    if (!ok) {
      console.error(`Analysis failed for track ID ${trackId}:`, error);
      return;
    }
    console.log(`Analysis finished for track ID ${trackId}:`, result);
    updateTrack(trackId, { ...result, bpm_override: null }); // clear any manual BPM override

    // Notify renderer
    if (global.mainWindow) {
      global.mainWindow.webContents.send('track-updated', { trackId, analysis: { ...result, bpm_override: null } });
    }
  });
}

export async function importAudioFile(filePath) {
  console.log(`Importing: ${filePath}`);
  const ext = path.extname(filePath);
  const hash = await hashFile(filePath);
  const dest = getAudioStoragePath(hash, ext);

  if (!fs.existsSync(dest)) fs.copyFileSync(filePath, dest);

  const probe = await ffprobe(dest);
  const format = probe.format.format_name;
  const duration = Number(probe.format.duration);
  const bitrate = Number(probe.format.bit_rate);

  // Extract tags
  const { title, artist, album, genre, year, label } = parseTags(probe);

  const trackId = addTrack({
    title: title || path.basename(filePath, ext),
    artist,
    album,
    duration,
    file_path: dest,
    format,
    bitrate,
    year,
    label,
    genres: JSON.stringify(genre),
  });

  console.log(`Added track ID ${trackId}: ${title || path.basename(filePath, ext)}`);

  spawnAnalysis(trackId, dest);
  return trackId;
}
