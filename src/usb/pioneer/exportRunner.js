import fs from 'node:fs';
import path from 'node:path';

import { toM3uRelativePath } from '../../usb/generic/m3u.js';
import { getAnlzFolder } from '../../usb/pioneer/formats/anlz.js';
import { readLibrary } from '../../usb/pioneer/formats/pdbRead.js';
import { sha256 } from '../../sync/publication.js';
import { SyncError } from '../../sync/errors.js';

/**
 * The export pipeline as one reusable unit.
 *
 * Manual export and automatic sync run the same code: the difference is who
 * decides the playlist set. Everything it writes goes through the job it is
 * given, so audio and playlist files land as artifacts and the database files
 * are staged and published atomically.
 */

/** Fields of a track row that change the bytes this pipeline writes. */
const FINGERPRINT_TRACK_FIELDS = [
  'id',
  'file_path',
  'title',
  'artist',
  'album',
  'year',
  'label',
  'genres',
  'duration',
  'bitrate',
  'file_size',
  'bpm',
  'bpm_override',
  'key_raw',
  'key_camelot',
  'beatgrid',
  'beatgrid_offset',
  'trim_start_ms',
  'trim_end_ms',
  'rating',
  'comments',
  'replay_gain',
  'loudness',
];

/** Cue fields that reach the player, without the library ids. */
function cueSignature(cues) {
  return cues.map((cue) => ({
    positionMs: Math.round(cue.positionMs ?? 0),
    label: cue.label ?? '',
    color: cue.color ?? '',
    hotCueIndex: cue.hotCueIndex ?? -1,
    enabled: cue.enabled === 0 ? 0 : 1,
  }));
}

/**
 * @param {object} deps everything the pipeline needs from the application
 * @returns {object} plan, fingerprint, run and planFor
 */
export function createPioneerExportRunner(deps) {
  const {
    getSetting,
    getPlaylist,
    getPlaylists,
    getPlaylistTracks,
    getCuePoints,
    loadManifest,
    saveManifest,
    reuseExistingUsbTrack,
    copyTrackToUsb,
    resolveExportTrim,
    exportDurationSec,
    resolveExportSampleInfo,
    backfillPdbSampleInfo,
    writeAnlz,
    writeSettingFiles,
    runPdbExporter,
    getFfmpegRuntimePath,
    send,
  } = deps;

  /**
   * Snapshot the work an export of these playlists represents.
   * @param {object} [options]
   * @returns {{options: object, playlists: object[], tracks: object[], cues: Map<number, object[]>}}
   */
  function plan({
    playlistIds,
    playlistId,
    useNormalized = false,
    targetDevice = null,
    forceMp3 = false,
    applyTrim = true,
  } = {}) {
    const ids = playlistIds?.length ? playlistIds : playlistId ? [playlistId] : null;
    const selected = ids?.length
      ? ids.map((id) => getPlaylist(id)).filter(Boolean)
      : getPlaylists();

    const trackMap = new Map();
    const playlists = selected.map((playlist) => {
      const tracks = getPlaylistTracks(playlist.id);
      for (const track of tracks) {
        if (!trackMap.has(track.id)) trackMap.set(track.id, track);
      }
      return { id: playlist.id, name: playlist.name, tracks };
    });

    const tracks = [...trackMap.values()];
    const cues = new Map();
    for (const track of tracks) {
      cues.set(
        track.id,
        (getCuePoints(track.id) ?? []).filter((cue) => cue.enabled !== 0)
      );
    }

    return {
      options: {
        useNormalized,
        targetLufs: useNormalized ? Number(getSetting('normalize_target_lufs', '-9')) : null,
        targetDevice,
        forceMp3,
        applyTrim,
      },
      playlists,
      tracks,
      cues,
    };
  }

  /**
   * A digest of everything that changes the files an export writes.
   * Two plans with the same fingerprint produce the same medium, which is what
   * lets an automatic sync decide that it has nothing to do without touching it.
   */
  function fingerprint(snapshot) {
    const payload = {
      version: 1,
      options: snapshot.options,
      playlists: snapshot.playlists.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        tracks: playlist.tracks.map((track) => track.id),
      })),
      tracks: snapshot.tracks.map((track) => {
        const row = {};
        for (const field of FINGERPRINT_TRACK_FIELDS) row[field] = track[field] ?? null;
        row.cues = cueSignature(snapshot.cues.get(track.id) ?? []);
        return row;
      }),
    };
    return sha256(Buffer.from(JSON.stringify(payload), 'utf8'));
  }

  const progress = (job, msg, pct) => {
    job.report(msg, pct);
    send?.('export-all-progress', { msg, pct });
  };

  /** Playlist files are written into staging, then moved as artifacts. */
  function stagePlaylists({ job, snapshot, usbPaths, usbRoot }) {
    const relDir = 'playlists';
    const finalDir = path.join(usbRoot, relDir);
    for (const playlist of snapshot.playlists) {
      const safeName = playlist.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
      const lines = ['#EXTM3U'];
      for (const track of playlist.tracks) {
        const usbPath = usbPaths.get(track.id);
        if (!usbPath) continue;
        const duration = exportDurationSec(track, snapshot.options.applyTrim);
        const label =
          [track.artist, track.title].filter(Boolean).join(' - ') || path.basename(usbPath);
        if (Number.isFinite(duration)) lines.push(`#EXTINF:${Math.floor(duration)},${label}`);
        lines.push(toM3uRelativePath(finalDir, path.join(usbRoot, usbPath)));
      }
      job.stageBuffer(`${relDir}/${safeName}.m3u`, Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
    }
  }

  function verifyPdb(expectedTracks) {
    return (absPath) => {
      let library = null;
      try {
        library = readLibrary(fs.readFileSync(absPath));
      } catch (err) {
        throw new SyncError('pdb-verify-failed', `Staged PDB cannot be read: ${err.message}`, {
          relPath: 'PIONEER/rekordbox/export.pdb',
        });
      }
      if (!library?.tracks || library.tracks.length !== expectedTracks) {
        throw new SyncError(
          'pdb-verify-failed',
          `Staged PDB carries ${library?.tracks?.length ?? 0} tracks, expected ${expectedTracks}`,
          { relPath: 'PIONEER/rekordbox/export.pdb' }
        );
      }
    };
  }

  function verifyJson(absPath, relPath) {
    try {
      JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (err) {
      throw new SyncError('json-verify-failed', `Staged file is not valid JSON: ${err.message}`, {
        relPath,
      });
    }
  }

  /**
   * Run an export on a job.
   * @param {object} args
   * @param {object} args.job the sync job that owns the medium
   * @param {object} args.plan snapshot from `plan()`
   * @returns {Promise<{fingerprint: string, summary: object}>}
   */
  async function run({ job, plan: snapshot }) {
    const usbRoot = job.usbRoot;
    const { options } = snapshot;
    const total = snapshot.tracks.length;

    job.enter('copy', { pct: 0, msg: `Exporting ${total} tracks…` });

    const { tracks: existingTracks, playlists: existingPlaylists } = loadManifest(usbRoot);
    const trimOf = (track) => ({
      trimStartMs: options.applyTrim === false ? null : (track.trim_start_ms ?? null),
      trimEndMs: options.applyTrim === false ? null : (track.trim_end_ms ?? null),
    });
    const copyTargets = snapshot.tracks.filter(
      (track) => !reuseExistingUsbTrack(existingTracks, track.id, new Map(), trimOf(track))
    );
    const copyTotal = copyTargets.length;

    const usedNames = new Map();
    for (const entry of existingTracks.values()) {
      const name = path.basename(entry.file_path || '').toLowerCase();
      if (name) usedNames.set(name, true);
    }

    const usbPaths = new Map();
    const usbMeta = new Map();
    const reusedIds = new Set();
    let copiedCount = 0;

    for (let i = 0; i < snapshot.tracks.length; i++) {
      job.checkpoint();
      const track = snapshot.tracks[i];
      const reused = reuseExistingUsbTrack(existingTracks, track.id, usedNames, trimOf(track));
      if (reused) {
        usbPaths.set(track.id, reused.path);
        reusedIds.add(track.id);
        if (reused.meta) usbMeta.set(track.id, reused.meta);
      } else {
        // copyTrackToUsb resolves its audio folder against the root it is given,
        // so staging gets the same layout as the medium. The move is one rename.
        const copied = await copyTrackToUsb(track, job.staging, usedNames, options);
        usbPaths.set(track.id, copied.path);
        if (copied.meta) usbMeta.set(track.id, copied.meta);
        const relPath = copied.path.replace(/^[/\\]/, '');
        if (fs.existsSync(job.stagePath(relPath))) {
          job.commitArtifact(relPath);
        } else {
          // A missing source file keeps its old behaviour: the row is written,
          // the audio is simply not there. Failing the whole export over one
          // unreadable track would be worse than the report the library shows.
          console.warn(`Export skipped a missing source file: ${track.file_path}`);
        }
        copiedCount += 1;
      }
      const copyMsg = copyTotal
        ? `Copying files… ${copiedCount}/${copyTotal}`
        : 'Copying files… all tracks already on USB';
      progress(job, copyMsg, Math.round(((i + 1) / Math.max(total, 1)) * 35));
    }

    const sampleInfo = await resolveExportSampleInfo(snapshot.tracks, {
      reusedIds,
      manifestTracks: existingTracks,
      usbMeta,
    });

    progress(job, 'Writing M3U playlists…', 35);
    stagePlaylists({ job, snapshot, usbPaths, usbRoot });
    job.commitArtifactTree('playlists');

    job.enter('analysis', { pct: 50, msg: 'Writing beat grids & waveforms…' });
    for (let i = 0; i < snapshot.tracks.length; i++) {
      job.checkpoint();
      const track = snapshot.tracks[i];
      const usbFilePath = usbPaths.get(track.id);
      if (!usbFilePath) continue;
      const cues = snapshot.cues.get(track.id) ?? [];
      const trim = resolveExportTrim(track, usbRoot, usbFilePath, cues, options.applyTrim);
      try {
        await writeAnlz({
          usbFilePath,
          sourceFilePath: trim ? trim.sourceFilePath : track.file_path || null,
          beatgrid: trim ? trim.beatgrid : (track.beatgrid ?? null),
          bpm: track.bpm_override ?? track.bpm ?? 0,
          beatgridOffset: track.beatgrid_offset ?? 0,
          usbRoot,
          ffmpegPath: getFfmpegRuntimePath(),
          cuePoints: trim ? trim.cuePoints : cues,
        });
      } catch (err) {
        console.warn(`ANLZ write failed for track ${track.id}:`, err.message);
      }
      progress(
        job,
        `Beat grids & waveforms… ${i + 1}/${total}`,
        50 + Math.round(((i + 1) / Math.max(total, 1)) * 20)
      );
    }

    job.enter('database', { pct: 70, msg: 'Writing Rekordbox database…' });

    const newPdbTracks = snapshot.tracks.map((track) => ({
      id: track.id,
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      duration: exportDurationSec(track, options.applyTrim) ?? 0,
      trim_start_ms: options.applyTrim === false ? null : (track.trim_start_ms ?? null),
      trim_end_ms: options.applyTrim === false ? null : (track.trim_end_ms ?? null),
      bpm: track.bpm_override ?? track.bpm ?? 0,
      key_raw: track.key_raw || '',
      file_path: usbPaths.get(track.id) || '',
      track_number: track.track_number || 0,
      year: track.year || '',
      label: track.label || '',
      genres: track.genres ? JSON.parse(track.genres) : [],
      file_size: usbMeta.get(track.id)?.fileSize ?? track.file_size ?? 0,
      bitrate: usbMeta.get(track.id)?.bitrate ?? track.bitrate ?? 0,
      sample_rate: sampleInfo.get(track.id)?.sampleRate ?? null,
      bit_depth: sampleInfo.get(track.id)?.bitDepth ?? null,
      comments: track.comments || '',
      rating: track.rating || 0,
      replay_gain: track.replay_gain ?? null,
      analyzePath: (() => {
        const usbPath = usbPaths.get(track.id);
        if (!usbPath) return '';
        const folder = getAnlzFolder(usbPath).replace(/\\/g, '/');
        return folder ? `/${folder}/ANLZ0000.DAT` : '';
      })(),
    }));

    const newPdbPlaylists = snapshot.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      track_ids: playlist.tracks.map((track) => track.id).filter((id) => usbPaths.has(id)),
    }));

    const mergedTracks = new Map(existingTracks);
    for (const track of newPdbTracks) mergedTracks.set(track.id, track);

    const mergedPlaylists = new Map(existingPlaylists);
    for (const playlist of newPdbPlaylists) mergedPlaylists.set(playlist.id, playlist);

    await backfillPdbSampleInfo([...mergedTracks.values()], { usbRoot });

    // Every metadata file is written into staging first. Publishing verifies the
    // PDB by reading it back, then renames each file over the live one.
    runPdbExporter(
      { usbRoot, tracks: [...mergedTracks.values()], playlists: [...mergedPlaylists.values()] },
      job.staging
    );
    writeSettingFiles(job.staging);
    saveManifest(job.staging, mergedTracks, mergedPlaylists);

    const pdbRel = 'PIONEER/rekordbox/export.pdb';
    const manifestRel = 'PIONEER/rekordbox/export-manifest.json';
    const entries = [
      { ...job.describeStaged(pdbRel), verify: verifyPdb(mergedTracks.size) },
      job.describeStaged('PIONEER/MYSETTING.DAT'),
      job.describeStaged('PIONEER/MYSETTING2.DAT'),
      job.describeStaged('PIONEER/DEVSETTING.DAT'),
      {
        ...job.describeStaged(manifestRel),
        verify: (absPath) => verifyJson(absPath, manifestRel),
      },
    ];
    job.publish(entries);

    return {
      fingerprint: fingerprint(snapshot),
      summary: {
        trackCount: mergedTracks.size,
        newTrackCount: snapshot.tracks.length,
        playlistCount: mergedPlaylists.size,
        usbRoot,
      },
    };
  }

  /**
   * Describe the work an automatic sync would do on a medium.
   *
   * The scope is what the manifest already carries: automatic sync keeps the
   * playlists the user exported before in step, and never invents a selection.
   * A medium without a manifest, or one whose playlists are all gone, is left
   * alone.
   * @param {string} usbRoot
   * @returns {{fingerprint: string, execute: function}|null}
   */
  function planFor(usbRoot) {
    const { playlists } = loadManifest(usbRoot);
    const ids = [...playlists.keys()].filter((id) => getPlaylist(id));
    if (ids.length === 0) return null;
    const snapshot = plan({ playlistIds: ids });
    if (snapshot.tracks.length === 0) return null;
    return {
      fingerprint: fingerprint(snapshot),
      execute: (job) => run({ job, plan: snapshot }),
    };
  }

  return { plan, fingerprint, run, planFor };
}
