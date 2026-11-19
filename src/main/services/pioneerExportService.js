import fs from 'node:fs';

import { candidateRoots } from '../../usb/generic/roots.js';
import { createPioneerUsb } from '../../usb/pioneer/index.js';
import { exportDurationSec, trackToFilename, writeExportTags } from '../../usb/pioneer/write.js';
import {
  getCuePoints,
  addCuePoint,
  updateCuePoint,
  deleteCuePoint,
} from '../../db/cuePointRepository.js';
import { getTrackById } from '../../db/trackRepository.js';

/**
 * Application layer for USB cue handling.
 *
 * The medium itself is handled by `createPioneerUsb`; what stays here is the
 * part that touches the application: writing cue rows into the library database
 * and telling the renderer about it. Keeping the two apart is what lets the USB
 * manager be tested against a fake stick with no database behind it.
 */
export function createPioneerExportService({ app, send = () => {} } = {}) {
  const device = (root) =>
    createPioneerUsb({
      root,
      deps: { resolveTrack: getTrackById, getExistingCues: getCuePoints },
    });

  /**
   * Cue points the medium carries for tracks that still exist in the library.
   * @param {string} usbRoot mount point
   * @param {string} [mode] extend or replace
   * @returns {object} rows to add, update, skip and remove, plus a summary
   */
  function scanUsbCues(usbRoot, mode = 'extend') {
    return device(usbRoot).read.cues({ mode });
  }

  /**
   * Apply the scan: insert missing cues, move slots the hardware moved and, in
   * replace mode only, drop the cues the stick does not carry.
   * @param {string} usbRoot mount point
   * @param {string} [mode] extend or replace
   * @returns {object} how many rows were added, updated, skipped and removed
   */
  function applyUsbCues(usbRoot, mode = 'extend') {
    const scan = scanUsbCues(usbRoot, mode);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let removed = 0;
    for (const t of scan.tracks) {
      for (const cue of t.add) {
        addCuePoint({
          trackId: t.trackId,
          positionMs: Math.round(cue.positionMs),
          label: cue.label || '',
          color: cue.color || '#00b4d8',
          hotCueIndex: cue.hotCueIndex,
        });
        added += 1;
      }
      for (const cue of t.update) {
        updateCuePoint(cue.existingId, {
          positionMs: Math.round(cue.positionMs),
          ...(cue.label ? { label: cue.label } : {}),
          ...(cue.color ? { color: cue.color } : {}),
        });
        updated += 1;
      }
      for (const cue of t.remove) {
        deleteCuePoint(cue.id);
        removed += 1;
      }
      skipped += t.skip.length;
    }
    if (added + updated + removed > 0) send('cue-points-updated');
    return {
      ok: true,
      usbRoot,
      mode: scan.mode,
      added,
      updated,
      skipped,
      removed,
      tracks: scan.summary.tracks,
    };
  }

  const seenCueUsbRoots = new Set();

  /** Roots that already produced a notification, so a connected stick is announced once. */
  function detectCueUsb() {
    for (const root of candidateRoots()) {
      if (seenCueUsbRoots.has(root)) continue;
      if (!fs.existsSync(device(root).manifest.path())) continue;
      seenCueUsbRoots.add(root);
      try {
        const scan = scanUsbCues(root);
        if (scan.summary.add + scan.summary.update > 0) {
          send('usb-cues-detected', { usbRoot: root, summary: scan.summary });
        }
      } catch (err) {
        console.warn('[usb-cues] detection scan failed:', err.message);
      }
    }
  }

  /** Watch for prepared sticks and announce the cues they carry. */
  function startUsbCueWatch() {
    detectCueUsb();
    const timer = setInterval(detectCueUsb, 15000);
    if (timer.unref) timer.unref();
    app.on('will-quit', () => clearInterval(timer));
  }

  return {
    trackToFilename,
    exportDurationSec,
    writeExportTags,
    copyTrackToUsb: (track, usbRoot, usedNames, options) =>
      device(usbRoot).write.track(track, usedNames, options),
    resolveExportTrim: (track, usbRoot, usbFilePath, cuePoints, applyTrim) =>
      device(usbRoot).resolveExportTrim(track, usbFilePath, cuePoints, applyTrim),
    runPdbExporter: (payload, usbRoot) => device(usbRoot).write.database(payload),
    getManifestPath: (usbRoot) => device(usbRoot).manifest.path(),
    loadManifest: (usbRoot) => device(usbRoot).manifest.load(),
    saveManifest: (usbRoot, tracks, playlists) => device(usbRoot).manifest.save(tracks, playlists),
    scanUsbCues,
    applyUsbCues,
    detectCueUsb,
    startUsbCueWatch,
    candidateUsbRoots: () => candidateRoots(),
  };
}
