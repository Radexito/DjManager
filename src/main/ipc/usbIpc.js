import fs from 'node:fs';
import path from 'node:path';
import { usbAudioDir, usbAudioPath } from '../../usb/pioneer/paths.js';
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
  writeAnlz,
  writeSettingFiles,
  writePdb,
  sampleInfoFromProbe,
  scanUsbCues,
  applyUsbCues,
  getFfmpegRuntimePath,
  exportRunner,
  syncService,
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

  register(
    'export-all',
    async (
      _,
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
      if (!usbRoot) {
        send('export-all-progress', null);
        return fail('missing-usb-root', 'A mount point is required');
      }
      try {
        const snapshot = exportRunner.plan({
          playlistIds,
          playlistId,
          useNormalized,
          targetDevice,
          forceMp3,
          applyTrim,
        });
        const finished = await syncService.runJob({
          usbRoot,
          trigger: 'manual',
          fingerprint: exportRunner.fingerprint(snapshot),
          execute: (job) => exportRunner.run({ job, plan: snapshot }),
        });
        send('export-all-progress', null);
        return ok({ ...(finished.summary ?? {}) });
      } catch (err) {
        send('export-all-progress', null);
        if (err?.code) return fail(err.code, err.message, err.extra ?? {});
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
