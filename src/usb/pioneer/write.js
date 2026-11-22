import fs from 'node:fs';
import path from 'node:path';

import { usbAudioDir, usbAudioPath } from './paths.js';
import { convertAudio } from '../../audio/ffmpeg.js';
import { writeId3Tags, writeBpmKeyTags } from '../../audio/id3Writer.js';
import {
  exportTrimRange,
  shiftBeatgridForTrim,
  shiftCuePointsForTrim,
} from '../../audio/trackTrim.js';
import { writePdb } from './formats/pdb.js';
import { resolveExportFormat } from './formats/profiles.js';

/**
 * Writing side of a Pioneer medium: copy or re-encode a track, tag the copy and
 * write the playlist database.
 *
 * Every function takes the mount point as an argument, so the same code serves
 * a root-bound manager and a one-off call from a queued export.
 */

export function trackToFilename(track, ext) {
  const rawBase =
    [track.artist, track.title].filter(Boolean).join(' - ') ||
    path.basename(track.file_path || '', ext || path.extname(track.file_path || ''));
  return (
    rawBase.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() +
    (ext || path.extname(track.file_path || ''))
  );
}

export async function copyTrackToUsb(
  track,
  usbRoot,
  usedNames,
  {
    useNormalized = false,
    targetLufs = null,
    targetDevice = null,
    forceMp3 = false,
    blind = false,
    applyTrim = true,
  } = {}
) {
  const srcPath = track.file_path;
  const srcExt = path.extname(srcPath || '');
  const targetFormat = resolveExportFormat({ srcExt, deviceKey: targetDevice, forceMp3 });
  const outExt = targetFormat ? `.${targetFormat}` : srcExt;
  const filename = trackToFilename(track, outExt);
  let finalName = filename;
  let n = 1;
  while (usedNames.has(finalName.toLowerCase())) {
    finalName = filename.replace(outExt, ` (${n++})${outExt}`);
  }
  usedNames.set(finalName.toLowerCase(), true);

  const destDir = usbAudioDir(usbRoot);
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, finalName);

  let meta = null;
  if (!fs.existsSync(destPath) && fs.existsSync(srcPath)) {
    const sourceLoudness = track.loudness;
    const gainDb =
      useNormalized && targetLufs != null && sourceLoudness != null
        ? targetLufs - sourceLoudness
        : 0;
    const sourceBitrateKbps = track.bitrate ? track.bitrate / 1000 : null;
    const trim = exportTrimRange(track, applyTrim);

    if (targetFormat || gainDb !== 0 || trim) {
      await convertAudio(srcPath, destPath, {
        gainDb,
        sourceBitrateKbps,
        format: targetFormat,
        trimStartSec: trim ? trim.startMs / 1000 : null,
        trimEndSec: trim ? trim.endMs / 1000 : null,
      });
      if (targetFormat || trim) {
        const fileSize = fs.statSync(destPath).size;
        const durationSec = trim ? (trim.endMs - trim.startMs) / 1000 : track.duration || null;
        meta = {
          fileSize,
          bitrate: durationSec ? Math.round((fileSize * 8) / durationSec) : track.bitrate || 0,
          reencoded: Boolean(targetFormat || gainDb !== 0),
          format: (targetFormat || srcExt.replace(/^\./, '')).toLowerCase() || null,
        };
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
    await writeExportTags(destPath, track, blind);
  }

  return { path: usbAudioPath(finalName), meta };
}

export function resolveExportTrim(track, usbRoot, usbFilePath, cuePoints = [], applyTrim = true) {
  const range = exportTrimRange(track, applyTrim);
  if (!range) return null;

  const usbAbsPath = usbFilePath ? path.join(usbRoot, usbFilePath.replace(/^[/\\]/, '')) : null;
  return {
    ...range,
    sourceFilePath: usbAbsPath && fs.existsSync(usbAbsPath) ? usbAbsPath : null,
    beatgrid: shiftBeatgridForTrim(track.beatgrid, range.startMs, range.endMs),
    cuePoints: shiftCuePointsForTrim(cuePoints, range.startMs, range.endMs),
  };
}

export function exportDurationSec(track, applyTrim = true) {
  const trim = exportTrimRange(track, applyTrim);
  if (trim) return (trim.endMs - trim.startMs) / 1000;
  return track.duration ?? null;
}

export async function writeExportTags(destPath, track, blind = false) {
  try {
    await writeId3Tags(destPath, {
      title: track.title || null,
      artist: track.artist || null,
      album: track.album || null,
    });
  } catch (err) {
    console.warn(`Tag write failed for ${path.basename(destPath)}:`, err.message);
  }
  if (blind) return;

  const bpm = track.bpm_override ?? track.bpm ?? null;
  const key = track.key_camelot || track.key_raw || null;
  if (bpm == null && !key) return;
  try {
    const res = await writeBpmKeyTags(destPath, { bpm, key, overwrite: true });
    if (res?.ok === false && res.reason && !['no-values', 'already-current'].includes(res.reason)) {
      console.warn(`BPM/key tag write failed for ${path.basename(destPath)}: ${res.reason}`);
    }
  } catch (err) {
    console.warn(`BPM/key tag write failed for ${path.basename(destPath)}:`, err.message);
  }
}

export function runPdbExporter(payload, usbRoot) {
  const outputPath = path.join(usbRoot, 'PIONEER', 'rekordbox', 'export.pdb');
  return writePdb(payload, outputPath);
}
