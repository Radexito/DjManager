/**
 * sampleInfo.js — #561: the real sample rate and bit depth of a track's audio.
 *
 * The Rekordbox export used to describe every track as 44 100 Hz / 16 bit
 * because the values were never captured anywhere. This module is the capture
 * path, used in three places:
 *
 * 1. Import (importManager) — the ffprobe that already runs on every import is
 *    mapped onto the two columns, for the managed copy and the linked file.
 * 2. Export of a library track (resolveTrackSampleInfo) — a track imported
 *    before this change has no values, so the file is probed once and the
 *    answer stored back, which is why later exports skip the probe.
 * 3. Export of a PDB row that still has nothing (backfillPdbSampleInfo) — rows
 *    carried over from an older export manifest are probed from the file that
 *    actually lands on the stick.
 *
 * "Unknown" is always null here. A missing, empty or zero ffprobe field is NOT
 * 44 100 / 16 — lossy streams (mp3, aac) report no bit depth at all and are
 * simply not recorded. The last-resort 44 100/16 lives in pdbWriter.js
 * (DEFAULT_SAMPLE_RATE / DEFAULT_BIT_DEPTH) and is only reached when a row still
 * has nothing after all of this, which the export logs per track.
 */
import fs from 'fs';
import path from 'path';
import { ffprobe } from './ffmpeg.js';
import { setTrackSampleInfo } from '../db/trackRepository.js';
import { DEFAULT_SAMPLE_RATE, DEFAULT_BIT_DEPTH } from '../usb/pdbWriter.js';

/** Positive integers only — 0, '', null and NaN all mean "not reported". */
function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Map a raw `ffprobe(filePath)` result onto the two columns.
 *
 * - `sampleRate` — `sample_rate` of the first audio stream, in Hz
 * - `bitDepth`   — `bits_per_raw_sample` (the real precision, e.g. 24 for a
 *                  24 bit flac) preferred, `bits_per_sample` as fallback
 *                  (the latter is what pcm and most containers report)
 * - `codec`      — `codec_name` of that stream, used to decide whether a file
 *                  whose depth ffprobe does not report is 16 bit by definition
 *
 * @param {object} probe - parsed ffprobe JSON (may be null/partial)
 * @returns {{ sampleRate: number|null, bitDepth: number|null, codec: string|null }}
 */
export function sampleInfoFromProbe(probe) {
  const stream = (probe?.streams || []).find((s) => s.codec_type === 'audio') || null;
  return {
    sampleRate: positiveInt(stream?.sample_rate),
    bitDepth: positiveInt(stream?.bits_per_raw_sample) ?? positiveInt(stream?.bits_per_sample),
    codec: stream?.codec_name ? String(stream.codec_name).toLowerCase() : null,
  };
}

/**
 * Bit depth of a file written in `format`, given the source file's depth.
 *
 * Codecs in this set always write 16 bit: mp3 and aac are lossy, and the export
 * converts wav/aiff with ffmpeg's `pcm_s16le` / `pcm_s16be` (see FORMAT_CODEC
 * in ffmpeg.js) — note that this is NOT the "wav/aiff keep the source depth"
 * rule one would expect from the container. Everything else (flac, or a gain
 * re-encode inside the source container) is left at the source depth, because
 * ffmpeg does not change the bit depth on those paths. A null source depth
 * stays null (unknown).
 *
 * The `pcm_s16*` entries exist so the same rule can classify an ffprobe
 * `codec_name` (see backfillPdbSampleInfo).
 */
const FIXED_16BIT_FORMATS = new Set(['mp3', 'aac', 'wav', 'aiff', 'pcm_s16le', 'pcm_s16be']);

export function bitDepthForFormat(format, sourceBitDepth) {
  if (FIXED_16BIT_FORMATS.has(String(format || '').toLowerCase())) return 16;
  return positiveInt(sourceBitDepth);
}

/** Absolute path of a PDB row's file on the stick, or null when it is not there. */
function resolveUsbFilePath(filePath, usbRoot) {
  if (!filePath) return null;
  // A PDB path is relative to the stick root (`/music/x.mp3` on every platform,
  // which path.isAbsolute() would read as absolute here), so it is joined to
  // usbRoot the same way the export itself does.
  const abs = usbRoot ? path.join(usbRoot, filePath.replace(/^[/\\]+/, '')) : filePath;
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Real sample rate / bit depth of ONE library track.
 *
 * Uses the stored columns and only probes what is missing, so a track that
 * already has both values is never probed. Whatever the probe reports is stored
 * back through `save` (only the values that were missing), so the probe happens
 * once per track. Failures are logged and never thrown: an export must not die
 * because one file could not be read.
 *
 * @param {object} track - tracks row (needs id, file_path, sample_rate, bit_depth)
 * @param {{ probe?: Function, save?: Function, log?: Function }} [deps] - injectable for tests
 * @returns {Promise<{ sampleRate: number|null, bitDepth: number|null, probed: boolean }>}
 */
export async function resolveTrackSampleInfo(
  track,
  { probe = ffprobe, save = setTrackSampleInfo, log = console.warn } = {}
) {
  let sampleRate = positiveInt(track?.sample_rate);
  let bitDepth = positiveInt(track?.bit_depth);
  if (sampleRate && bitDepth) return { sampleRate, bitDepth, probed: false };

  if (!track?.file_path) {
    log(`[#561] track ${track?.id ?? '?'} has no file path — sample rate / bit depth stay unknown`);
    return { sampleRate, bitDepth, probed: false };
  }

  try {
    const probed = sampleInfoFromProbe(await probe(track.file_path));
    sampleRate = sampleRate ?? probed.sampleRate;
    bitDepth = bitDepth ?? probed.bitDepth;
    if (sampleRate || bitDepth) {
      try {
        save(track.id, { sampleRate, bitDepth });
      } catch (err) {
        log(`[#561] could not store sample rate / bit depth for track ${track.id}: ${err.message}`);
      }
    } else {
      log(`[#561] ffprobe reported nothing usable for ${track.file_path}`);
    }
  } catch (err) {
    log(`[#561] ffprobe failed for ${track.file_path}: ${err.message}`);
  }

  return { sampleRate, bitDepth, probed: true };
}

/**
 * #561 — the values that describe the file that actually LANDS on the stick,
 * for every track of one export.
 *
 * - a track copied byte for byte (or trimmed with a stream copy) keeps the
 *   library file's values;
 * - a track ffmpeg re-encoded gets the source sample rate (ffmpeg is not asked
 *   to resample on any export path) and the depth the target codec writes;
 * - a track REUSED from an earlier export keeps what the manifest recorded for
 *   that file (the export that wrote it resolved those); nothing here describes
 *   it, so a manifest entry without values is left empty for the post-merge
 *   backfill to probe on the stick.
 *
 * @param {object[]} tracks - library rows for this export
 * @param {{ reusedIds?: Set, manifestTracks?: Map, usbMeta?: Map, probe?: Function, save?: Function, log?: Function }} [opts]
 *   - `reusedIds` — ids whose file was already on the stick (a reused file keeps
 *     what the manifest recorded for it, since nothing here describes that file)
 *   - `manifestTracks` — the loaded export manifest, keyed by library track id
 *   - `usbMeta` — copyTrackToUsb() overrides, set when the landed file was
 *     re-encoded or trimmed
 * @returns {Promise<Map<number, { sampleRate: number|null, bitDepth: number|null }>>}
 */
export async function resolveExportSampleInfo(
  tracks,
  { reusedIds = new Set(), manifestTracks = new Map(), usbMeta = new Map(), probe, save, log } = {}
) {
  const out = new Map();
  for (const track of tracks) {
    if (reusedIds.has(track.id)) {
      const row = manifestTracks.get(track.id);
      out.set(track.id, {
        sampleRate: positiveInt(row?.sample_rate),
        bitDepth: positiveInt(row?.bit_depth),
      });
      continue;
    }

    const info = await resolveTrackSampleInfo(track, { probe, save, log });
    const meta = usbMeta.get(track.id) || null;
    if (meta?.reencoded) {
      out.set(track.id, {
        sampleRate: info.sampleRate,
        bitDepth: bitDepthForFormat(meta.format, info.bitDepth),
      });
    } else {
      out.set(track.id, { sampleRate: info.sampleRate, bitDepth: info.bitDepth });
    }
  }
  return out;
}

/**
 * #561 — fill in the two columns for PDB rows that have no values, right before
 * the PDB is written.
 *
 * Every row is expected to carry what its file is, but rows that come from an
 * older export manifest never got it. Those are probed from the file on the
 * stick (the file the deck will play, trim/format change included) and the
 * answers are kept in the rows, so the manifest remembers them and the probe
 * happens once per track. A row whose file cannot be read keeps whatever it had
 * (nothing, for the rows this is meant to fix) and is logged: pdbWriter then
 * falls back to DEFAULT_SAMPLE_RATE / DEFAULT_BIT_DEPTH.
 *
 * Never throws and never touches the file system when every row already has
 * both values.
 *
 * @param {object[]} rows - PDB track rows (read/written in place)
 * @param {{ usbRoot?: string|null, probe?: Function, log?: Function }} [opts]
 * @returns {Promise<{ probed: number, unresolved: number }>}
 */
export async function backfillPdbSampleInfo(
  rows,
  { usbRoot = null, probe = ffprobe, log = console.warn } = {}
) {
  let probed = 0;
  let unresolved = 0;

  for (const row of rows) {
    let sampleRate = positiveInt(row?.sample_rate);
    let bitDepth = positiveInt(row?.bit_depth);
    if (sampleRate && bitDepth) {
      row.sample_rate = sampleRate;
      row.bit_depth = bitDepth;
      continue;
    }

    const filePath = resolveUsbFilePath(row?.file_path, usbRoot);
    if (filePath) {
      probed += 1;
      try {
        const info = sampleInfoFromProbe(await probe(filePath));
        sampleRate = sampleRate ?? info.sampleRate;
        // A codec that is 16 bit by definition (mp3, aac, pcm_s16*) is not a
        // guess even when ffprobe reports no depth for it.
        bitDepth = bitDepth ?? info.bitDepth ?? bitDepthForFormat(info.codec, null);
      } catch (err) {
        log(`[#561] ffprobe failed for ${filePath}: ${err.message}`);
      }
    }

    if (!sampleRate || !bitDepth) {
      unresolved += 1;
      log(
        `[#561] ${row?.file_path || `track ${row?.id}`}: sample rate / bit depth unknown, ` +
          `writing ${DEFAULT_SAMPLE_RATE} Hz / ${DEFAULT_BIT_DEPTH} bit`
      );
    }

    if (row) {
      row.sample_rate = sampleRate;
      row.bit_depth = bitDepth;
    }
  }

  return { probed, unresolved };
}
