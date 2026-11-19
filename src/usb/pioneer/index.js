import fs from 'node:fs';
import path from 'node:path';

import { CAPABILITY } from '../generic/contract.js';
import { getAnlzFolder } from './formats/anlz.js';
import { readLibrary } from './formats/pdbRead.js';
import { writeSettingFiles } from './formats/settings.js';
import { getManifestPath, loadManifest, saveManifest } from './manifest.js';
import { usbAudioDir, usbAudioPath } from './paths.js';
import { scanUsbCues } from './read.js';
import {
  copyTrackToUsb,
  exportDurationSec,
  resolveExportTrim,
  runPdbExporter,
  trackToFilename,
  writeExportTags,
} from './write.js';

/** Database location, relative to the mount point. */
const DATABASE_PATH = path.join('PIONEER', 'rekordbox', 'export.pdb');

/**
 * A mounted Pioneer medium, with everything the format can do behind one object.
 *
 * The manager binds the mount point once. Reading the library of cue points and
 * writing tracks, tags, settings and the database all go through it, so callers
 * stop threading `usbRoot` through every call and the layout of the medium stays
 * inside this folder.
 *
 * Library lookups are injected rather than imported: the format knows the files
 * on the medium, the application knows its own database, and this keeps the two
 * apart.
 * @param {object} options
 * @param {string} options.root mount point of the medium
 * @param {object} [options.deps]
 * @param {(id: number) => object|null} [options.deps.resolveTrack] library lookup used when reading cues
 * @param {(id: number) => object[]} [options.deps.getExistingCues] cue rows already stored for a track
 * @returns {import('../generic/contract.js').UsbDevice & object}
 */
export function createPioneerUsb({ root, deps = {} } = {}) {
  if (!root) throw new Error('createPioneerUsb: a mount point is required');

  const resolveTrack = deps.resolveTrack ?? (() => null);
  const getExistingCues = deps.getExistingCues ?? (() => []);

  return {
    format: 'pioneer',
    root,
    capabilities: {
      library: CAPABILITY.write,
      cues: CAPABILITY.readWrite,
      settings: CAPABILITY.write,
    },
    paths: {
      audioDir: () => usbAudioDir(root),
      audioPath: (filename) => usbAudioPath(filename),
      anlzFolder: (usbFilePath) => getAnlzFolder(usbFilePath),
      database: () => path.join(root, DATABASE_PATH),
    },
    manifest: {
      path: () => getManifestPath(root),
      load: () => loadManifest(root),
      save: (tracks, playlists) => saveManifest(root, tracks, playlists),
    },
    read: {
      /** Cue points the medium carries, paired with what the library already has. */
      cues: ({ mode = 'extend' } = {}) =>
        scanUsbCues({ root, mode, resolveTrack, getExistingCues }),
      /**
       * The library the database on the medium describes: tracks, artists,
       * albums, keys, colours, playlists and their track order.
       * @returns {object|null} null when the medium carries no database yet
       */
      library: () => {
        const file = path.join(root, DATABASE_PATH);
        if (!fs.existsSync(file)) return null;
        return readLibrary(fs.readFileSync(file));
      },
    },
    write: {
      /** Copy or re-encode one track and tag the copy. */
      track: (track, usedNames, options) => copyTrackToUsb(track, root, usedNames, options),
      /** Write title/artist/album and, unless blind, BPM and key into an exported file. */
      tags: (destPath, track, blind) => writeExportTags(destPath, track, blind),
      /** Write the playlist database players read. */
      database: (payload) => runPdbExporter(payload, root),
      /** Write the per-device settings files. */
      settings: () => writeSettingFiles(root),
    },
    /** Length in seconds of the audio an export writes for this track. */
    exportDurationSec: (track, applyTrim) => exportDurationSec(track, applyTrim),
    /** Trim range the export applies, or null when the whole file is written. */
    resolveExportTrim: (track, usbFilePath, cuePoints, applyTrim) =>
      resolveExportTrim(track, root, usbFilePath, cuePoints, applyTrim),
    /** File name an exported track gets on the medium. */
    trackToFilename: (track, ext) => trackToFilename(track, ext),
  };
}
