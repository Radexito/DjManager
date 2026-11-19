import fs from 'node:fs';
import path from 'node:path';
import { usbAudioDir, usbAudioPath } from '../../usb/pioneer/paths.js';
import { writeM3uPlaylist } from '../../usb/generic/m3u.js';
import { getAnlzFolder } from '../../usb/pioneer/formats/anlz.js';
import { convertAudio } from '../../audio/ffmpeg.js';
import { fail, failFromError, handle, ok } from './response.js';

/**
 * USB export IPC (tor B, slice 6).
 *
 * Seven channels moved out of `src/main.js`:
 *   check-linked-track-status, get-linked-tracks-basic, check-usb-format,
 *   format-usb, scan-usb-cues, import-usb-cues, export-all
 *
 * The handler bodies are the same code. Two addresses changed:
 *   * `send` is injected instead of a closure over `global.mainWindow`
 *   * `app.getPath` is replaced by an injected `getTempDir`
 *
 * Helper functions that belong to the USB domain move with the channels
 * (copyTrackToUsb, scanUsbCues, applyUsbCues, runPdbExporter, the manifest
 * helpers, ...). Application state and library lookups stay injected, so the
 * module can be driven with fakes instead of the real library.
 */
export function registerUsbIpc({
  ipcMain,
  send = () => {},
  logAudit = () => {},
  getTrackById,
  getLinkedTracksBasic,
  detectFilesystem,
  describeFilesystem,
  formatDrive,
  getSetting,
  copyTrackToUsb,
  loadManifest,
  saveManifest,
  reuseExistingUsbTrack,
  resolveExportSampleInfo,
  writeAnlz,
  writeSettingFiles,
  writePdb,
  sampleInfoFromProbe,
  scanUsbCues,
  applyUsbCues,
  getCuePoints,
  getPlaylist,
  getPlaylistTracks,
  getPlaylists,
  getFfmpegRuntimePath,
  backfillPdbSampleInfo,
  runPdbExporter,
  resolveExportFormat,
  resolveExportTrim,
  exportDurationSec,
  writeExportTags,
  trackToFilename,
  log = (...args) => console.error(...args),
}) {
  if (!ipcMain) throw new Error('registerUsbIpc: ipcMain is required');

  const register = (channel, fn) => handle(ipcMain, channel, fn, { log });

  register('check-linked-track-status', (_, trackIds) => {
    return trackIds.map((id) => {
      const t = getTrackById(id);
      if (!t) return { id, exists: false };
      return { id, exists: !t.is_linked || fs.existsSync(t.file_path) };
    });
  });

  register('get-linked-tracks-basic', () => {
    return getLinkedTracksBasic();
  });

  register('check-usb-format', async (_, mountPath) => {
    const info = await detectFilesystem(mountPath);
    return {
      ...info,
      fsLabel: describeFilesystem(info.fs),
    };
  });

  register('format-usb', async (_, payload = {}) => {
    const { device, mountPoint, confirm } = payload;
    if (confirm !== true) {
      logAudit(`format-usb REFUSED without confirmation: device=${device ?? 'unknown'}`);
      return fail('confirmation-required', 'Formatting a drive requires explicit confirmation', {
        error: 'Formatting a drive requires explicit confirmation',
      });
    }
    logAudit(
      `format-usb requested: device=${device ?? 'unknown'} mount=${mountPoint ?? 'unknown'}`
    );
    try {
      await formatDrive(device, mountPoint, (msg) => send('format-usb-progress', { msg }));
      send('format-usb-progress', null);
      logAudit('format-usb finished');
      return ok();
    } catch (err) {
      send('format-usb-progress', null);
      logAudit(`format-usb failed: ${err.message}`);
      return failFromError(err);
    }
  });

  register('export-explorer-to-usb', async (_, { filePaths, usbRoot, playlistName }) => {
    try {
      const total = filePaths.length;
      send('export-explorer-progress', { msg: `Exporting ${total} tracks to USB…`, pct: 0 });

      const usedNames = new Map();
      const pdbTracks = [];
      const anlzPaths = new Map();

      for (let i = 0; i < filePaths.length; i++) {
        const srcPath = filePaths[i];
        const ext = path.extname(srcPath);

        let meta = {
          title: path.basename(srcPath, ext),
          artist: '',
          album: '',
          bpm: null,
          key_raw: '',
          duration: 0,
          bitrate: 0,
        };
        let sampleRate = null;
        let bitDepth = null;
        try {
          const { ffprobe: runFfprobe } = await import('../../audio/ffmpeg.js');
          const data = await runFfprobe(srcPath);
          const tags = data.format?.tags || {};
          const stream = data.streams?.find((s) => s.codec_type === 'audio') || {};
          const bpmTag = tags.bpm || tags.BPM || tags.TBPM || tags['tbpm'];
          meta = {
            title: tags.title || path.basename(srcPath, ext),
            artist: tags.artist || '',
            album: tags.album || '',
            bpm: bpmTag ? parseFloat(bpmTag) || null : null,
            key_raw: tags.key || tags.KEY || tags.initialkey || tags.INITIALKEY || '',
            duration: parseFloat(data.format?.duration) || 0,
            bitrate: parseInt(stream.bit_rate || data.format?.bit_rate || 0, 10) || 0,
          };
          ({ sampleRate, bitDepth } = sampleInfoFromProbe(data));
        } catch {}

        const rawBase =
          [meta.artist, meta.title].filter(Boolean).join(' - ') || path.basename(srcPath, ext);
        const safeBase = rawBase.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
        let filename = `${safeBase}${ext}`;
        let n = 1;
        while (usedNames.has(filename.toLowerCase())) {
          filename = `${safeBase} (${n++})${ext}`;
        }
        usedNames.set(filename.toLowerCase(), true);

        const destDir = usbAudioDir(usbRoot);
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, filename);
        if (!fs.existsSync(destPath)) fs.copyFileSync(srcPath, destPath);
        const usbFilePath = usbAudioPath(filename);

        try {
          const anlzDat = await writeAnlz({
            usbFilePath,
            sourceFilePath: null,
            beatgrid: null,
            bpm: meta.bpm || 0,
            beatgridOffset: 0,
            usbRoot,
            ffmpegPath: getFfmpegRuntimePath(),
            cuePoints: [],
          });
          anlzPaths.set(i, anlzDat);
        } catch {}

        let fileSize = 0;
        try {
          fileSize = fs.statSync(destPath).size;
        } catch {}

        pdbTracks.push({
          id: i + 1,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          duration: meta.duration,
          bpm: meta.bpm || 0,
          key_raw: meta.key_raw,
          file_path: usbFilePath,
          track_number: i + 1,
          year: '',
          label: '',
          genres: [],
          file_size: fileSize,
          bitrate: meta.bitrate,
          sample_rate: sampleRate,
          bit_depth: bitDepth,
          comments: '',
          rating: 0,
          analyzePath: anlzPaths.get(i) || '',
        });

        const pct = Math.round(((i + 1) / total) * 90);
        send('export-explorer-progress', { msg: `Copying ${i + 1}/${total}: ${filename}`, pct });
      }

      send('export-explorer-progress', { msg: 'Writing PDB database…', pct: 92 });

      const pdbPlaylists = playlistName
        ? [{ id: 1, name: playlistName, track_ids: pdbTracks.map((t) => t.id) }]
        : [];

      const outputPath = path.join(usbRoot, 'PIONEER', 'rekordbox', 'export.pdb');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      writePdb({ tracks: pdbTracks, playlists: pdbPlaylists }, outputPath);

      send('export-explorer-progress', { msg: 'Writing settings files…', pct: 96 });
      try {
        await writeSettingFiles(usbRoot);
      } catch {}

      send('export-explorer-progress', null);
      return ok({ trackCount: pdbTracks.length, usbRoot });
    } catch (err) {
      send('export-explorer-progress', null);
      return failFromError(err);
    }
  });

  async function copyTrackToUsb(track, usbRoot, usedNames, opts = {}) {
    const {
      useNormalized = false,
      targetLufs = null,
      targetDevice = null,
      forceMp3 = false,
      blind = false,
      applyTrim = true,
    } = opts;

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
      const trim = resolveExportTrim(track, usbRoot, finalName, applyTrim);

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

  register(
    'export-all',
    async (
      _event,
      {
        usbRoot,
        playlistIds,
        playlistId,
        useNormalized = false,
        targetDevice = null,
        forceMp3 = false,
        applyTrim = true,
      } = {}
    ) => {
      try {
        const targetLufs = useNormalized ? Number(getSetting('normalize_target_lufs', '-9')) : null;
        const ids = playlistIds?.length ? playlistIds : playlistId ? [playlistId] : null;
        const allPlaylists = ids?.length
          ? ids.map((id) => getPlaylist(id)).filter(Boolean)
          : getPlaylists();

        const trackMap = new Map();
        for (const pl of allPlaylists) {
          for (const t of getPlaylistTracks(pl.id)) {
            if (!trackMap.has(t.id)) trackMap.set(t.id, t);
          }
        }
        const allTracks = [...trackMap.values()];
        const total = allTracks.length;

        const { tracks: existingTracks, playlists: existingPlaylists } = loadManifest(usbRoot);
        const copyTargets = allTracks.filter(
          (t) =>
            !reuseExistingUsbTrack(existingTracks, t.id, new Map(), {
              trimStartMs: applyTrim === false ? null : (t.trim_start_ms ?? null),
              trimEndMs: applyTrim === false ? null : (t.trim_end_ms ?? null),
            })
        );
        const copyTotal = copyTargets.length;

        send('export-all-progress', {
          msg: `Exporting ${total} tracks…`,
          pct: 0,
        });

        const usedNames = new Map();
        for (const et of existingTracks.values()) {
          const name = path.basename(et.file_path || '').toLowerCase();
          if (name) usedNames.set(name, true);
        }

        const usbPaths = new Map();
        const usbMeta = new Map();
        const reusedIds = new Set();
        let copiedCount = 0;
        for (let i = 0; i < allTracks.length; i++) {
          const t = allTracks[i];
          const reused = reuseExistingUsbTrack(existingTracks, t.id, usedNames, {
            trimStartMs: applyTrim === false ? null : (t.trim_start_ms ?? null),
            trimEndMs: applyTrim === false ? null : (t.trim_end_ms ?? null),
          });
          if (reused) {
            usbPaths.set(t.id, reused.path);
            reusedIds.add(t.id);
            if (reused.meta) usbMeta.set(t.id, reused.meta);
          } else {
            const { path: usbPath, meta } = await copyTrackToUsb(t, usbRoot, usedNames, {
              useNormalized,
              targetLufs,
              targetDevice,
              forceMp3,
              applyTrim,
            });
            usbPaths.set(t.id, usbPath);
            if (meta) usbMeta.set(t.id, meta);
            copiedCount += 1;
          }
          const copyMsg = copyTotal
            ? `Copying files… ${copiedCount}/${copyTotal}`
            : 'Copying files… all tracks already on USB';
          send('export-all-progress', {
            msg: copyMsg,
            pct: Math.round(((i + 1) / total) * 35),
          });
        }

        const sampleInfo = await resolveExportSampleInfo(allTracks, {
          reusedIds,
          manifestTracks: existingTracks,
          usbMeta,
        });

        send('export-all-progress', { msg: 'Writing M3U playlists…', pct: 35 });
        const playlistDir = path.join(usbRoot, 'playlists');
        for (const pl of allPlaylists) {
          const tracks = getPlaylistTracks(pl.id);
          const safeName = pl.name.replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').trim();
          const entries = tracks
            .map((t) => {
              const usbPath = usbPaths.get(t.id);
              if (!usbPath) return null;
              return {
                path: path.join(usbRoot, usbPath),
                duration: exportDurationSec(t, applyTrim) ?? -1,
                label: [t.artist, t.title].filter(Boolean).join(' - ') || path.basename(usbPath),
              };
            })
            .filter(Boolean);
          writeM3uPlaylist({ dir: playlistDir, name: safeName, entries });
        }

        send('export-all-progress', { msg: 'Writing beat grids & waveforms…', pct: 50 });
        for (let i = 0; i < allTracks.length; i++) {
          const t = allTracks[i];
          const usbFilePath = usbPaths.get(t.id);
          if (!usbFilePath) continue;
          const cues = getCuePoints(t.id).filter((c) => c.enabled !== 0);
          const trim = resolveExportTrim(t, usbRoot, usbFilePath, cues, applyTrim);
          try {
            await writeAnlz({
              usbFilePath,
              sourceFilePath: trim ? trim.sourceFilePath : t.file_path || null,
              beatgrid: trim ? trim.beatgrid : (t.beatgrid ?? null),
              bpm: t.bpm_override ?? t.bpm ?? 0,
              beatgridOffset: t.beatgrid_offset ?? 0,
              usbRoot,
              ffmpegPath: getFfmpegRuntimePath(),
              cuePoints: trim ? trim.cuePoints : cues,
            });
          } catch (err) {
            console.warn(`ANLZ write failed for track ${t.id}:`, err.message);
          }
          send('export-all-progress', {
            msg: `Beat grids & waveforms… ${i + 1}/${total}`,
            pct: 50 + Math.round(((i + 1) / total) * 20),
          });
        }

        send('export-all-progress', { msg: 'Writing Rekordbox database…', pct: 70 });
        const newPdbTracks = allTracks.map((t) => ({
          id: t.id,
          title: t.title || '',
          artist: t.artist || '',
          album: t.album || '',
          duration: exportDurationSec(t, applyTrim) ?? 0,
          trim_start_ms: applyTrim === false ? null : (t.trim_start_ms ?? null),
          trim_end_ms: applyTrim === false ? null : (t.trim_end_ms ?? null),
          bpm: t.bpm_override ?? t.bpm ?? 0,
          key_raw: t.key_raw || '',
          file_path: usbPaths.get(t.id) || '',
          track_number: t.track_number || 0,
          year: t.year || '',
          label: t.label || '',
          genres: t.genres ? JSON.parse(t.genres) : [],
          file_size: usbMeta.get(t.id)?.fileSize ?? t.file_size ?? 0,
          bitrate: usbMeta.get(t.id)?.bitrate ?? t.bitrate ?? 0,
          sample_rate: sampleInfo.get(t.id)?.sampleRate ?? null,
          bit_depth: sampleInfo.get(t.id)?.bitDepth ?? null,
          comments: t.comments || '',
          rating: t.rating || 0,
          replay_gain: t.replay_gain ?? null,
          analyzePath: (() => {
            const usbFP = usbPaths.get(t.id);
            if (!usbFP) return '';
            const folder = getAnlzFolder(usbFP).replace(/\\/g, '/');
            return folder ? `/${folder}/ANLZ0000.DAT` : '';
          })(),
        }));
        const newPdbPlaylists = allPlaylists.map((pl) => ({
          id: pl.id,
          name: pl.name,
          track_ids: getPlaylistTracks(pl.id)
            .map((t) => t.id)
            .filter((id) => usbPaths.has(id)),
        }));

        const mergedTracks = new Map(existingTracks);
        for (const t of newPdbTracks) mergedTracks.set(t.id, t);

        const mergedPlaylists = new Map(existingPlaylists);
        for (const pl of newPdbPlaylists) mergedPlaylists.set(pl.id, pl);

        await backfillPdbSampleInfo([...mergedTracks.values()], { usbRoot });

        runPdbExporter(
          { usbRoot, tracks: [...mergedTracks.values()], playlists: [...mergedPlaylists.values()] },
          usbRoot
        );
        writeSettingFiles(usbRoot);
        saveManifest(usbRoot, mergedTracks, mergedPlaylists);

        send('export-all-progress', { msg: 'Done!', pct: 100 });
        send('export-all-progress', null);
        return ok({
          trackCount: mergedTracks.size,
          newTrackCount: total,
          playlistCount: mergedPlaylists.size,
          usbRoot,
        });
      } catch (err) {
        send('export-all-progress', null);
        return failFromError(err);
      }
    }
  );

  register('scan-usb-cues', (_, { usbRoot, mode } = {}) => {
    try {
      return scanUsbCues(usbRoot, mode);
    } catch (err) {
      return failFromError(err);
    }
  });

  register('import-usb-cues', (_, { usbRoot, mode } = {}) => {
    try {
      return applyUsbCues(usbRoot, mode);
    } catch (err) {
      return failFromError(err);
    }
  });
}
