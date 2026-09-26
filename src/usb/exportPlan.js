import path from 'path';
import { exportTrimRange } from '../audio/trackTrim.js';
import { resolveExportFormat } from './deviceFormats.js';
import { reuseExistingUsbTrack } from './exportReuse.js';

/**
 * Export plan — what the USB export is going to do to every file, decided
 * BEFORE any work starts, so the progress UI can tell the user the truth about
 * what is slow instead of calling every phase "copying".
 *
 * Why this exists: with loudness normalization on (the Export All default),
 * `gainDb = targetLufs - track.loudness` is almost never exactly 0, so
 * `copyTrackToUsb()` re-encodes the audio through ffmpeg for virtually every
 * track. Measured on the dev library (2026-09-25): 495 of 496 analysed tracks
 * have a non-zero gain, a 25 ms `fs.copyFileSync()` becomes a ~6 s ffmpeg
 * encode for a 5 minute track and ~64 s for a 92 minute DJ mix. Reporting that
 * as "Copying files…" is what made the export look stuck.
 *
 * The decisions here are computed from exactly the inputs `copyTrackToUsb()`
 * uses (`resolveExportFormat`, `exportTrimRange`, `track.loudness`, the
 * existing manifest for reuse) so the plan cannot disagree with the work.
 *
 * `convert` covers both a real re-encode (gain change and/or format change) and
 * a trim-only stream copy — a trim with no gain and no format change is passed
 * to ffmpeg with `-c copy`, which is fast (measured: 28 ms for a 5 minute
 * track). The reasons say which is which.
 */

export const EXPORT_ACTION = Object.freeze({
  COPY: 'copy',
  CONVERT: 'convert',
  REUSE: 'reuse',
});

export const CONVERT_REASON = Object.freeze({
  LOUDNESS: 'loudness',
  FORMAT: 'format',
  TRIM: 'trim',
});

/** Deterministic order, loudness first — it is the reason that dominates in practice. */
const REASON_ORDER = [CONVERT_REASON.LOUDNESS, CONVERT_REASON.FORMAT, CONVERT_REASON.TRIM];

/** Short form, used in the per-track progress line: `Converting 3/80 (loudness normalization)`. */
const REASON_SHORT = {
  loudness: 'loudness normalization',
  format: 'format change',
  trim: 'trim range',
};

/** Long form, used in the pre-run summary: `62 will be re-encoded for loudness normalization`. */
const REASON_PHRASE = {
  loudness: 'loudness normalization',
  format: 'a format change',
  trim: 'a trim range',
};

/**
 * The trim range the reuse decision is made with — shared by the export loops
 * and this module so the plan and the loop cannot disagree (`applyTrim: false`
 * means "the whole file", so there is nothing to compare against the manifest).
 */
export function exportReuseTrim(track, applyTrim = true) {
  return {
    trimStartMs: applyTrim === false ? null : (track.trim_start_ms ?? null),
    trimEndMs: applyTrim === false ? null : (track.trim_end_ms ?? null),
  };
}

/** One track: reuse of an on-USB file, a plain copy, or an ffmpeg convert (and why). */
function planTrack(track, opts) {
  const id = track.id;

  if (opts.existingTracks?.size) {
    const reused = reuseExistingUsbTrack(
      opts.existingTracks,
      id,
      new Map(),
      exportReuseTrim(track, opts.applyTrim)
    );
    if (reused) {
      return { id, action: EXPORT_ACTION.REUSE, reason: EXPORT_ACTION.REUSE, reasons: [] };
    }
  }

  const targetFormat = resolveExportFormat({
    srcExt: path.extname(track.file_path || ''),
    deviceKey: opts.targetDevice,
    forceMp3: opts.forceMp3,
  });
  const gainDb =
    opts.useNormalized && opts.targetLufs != null && track.loudness != null
      ? opts.targetLufs - track.loudness
      : 0;
  const trim = exportTrimRange(track, opts.applyTrim);

  const reasons = [];
  if (gainDb !== 0) reasons.push(CONVERT_REASON.LOUDNESS);
  if (targetFormat) reasons.push(CONVERT_REASON.FORMAT);
  if (trim) reasons.push(CONVERT_REASON.TRIM);
  reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));

  if (!reasons.length) {
    return { id, action: EXPORT_ACTION.COPY, reason: EXPORT_ACTION.COPY, reasons: [] };
  }
  return { id, action: EXPORT_ACTION.CONVERT, reason: reasons[0], reasons };
}

/**
 * @param {Array<object>} tracks - the deduplicated tracks the export will write
 * @param {{
 *   useNormalized?: boolean, targetLufs?: number|null, targetDevice?: string|null,
 *   forceMp3?: boolean, applyTrim?: boolean,
 *   existingTracks?: Map<string, object>|null - the USB manifest, for reuse decisions
 * }} [opts] - the same options the export handlers pass to `copyTrackToUsb()`
 * @returns {{ tracks: Array<{ id: string, action: string, reason: string, reasons: string[] }>,
 *   byId: Map<string, object>,
 *   totals: { total: number, copy: number, convert: number, reuse: number, byReason: { loudness: number, format: number, trim: number } } }}
 */
export function planExportActions(tracks, opts = {}) {
  const options = {
    useNormalized: false,
    targetLufs: null,
    targetDevice: null,
    forceMp3: false,
    applyTrim: true,
    existingTracks: null,
    ...opts,
  };

  const planned = [];
  const byId = new Map();
  const totals = {
    total: 0,
    copy: 0,
    convert: 0,
    reuse: 0,
    byReason: { loudness: 0, format: 0, trim: 0 },
  };

  for (const track of tracks || []) {
    const entry = planTrack(track, options);
    planned.push(entry);
    byId.set(entry.id, entry);
    totals.total += 1;
    totals[entry.action] += 1;
    for (const reason of entry.reasons) totals.byReason[reason] += 1;
  }

  return { tracks: planned, byId, totals };
}

/** `1:23`, `45s`, `1:02:03` — elapsed time for a phase that is taking a while. */
export function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (Math.floor(totalSec / 60))
    return `${Math.floor(totalSec / 60)}:${String(s).padStart(2, '0')}`;
  return `${totalSec}s`;
}

function withElapsed(msg, elapsedMs) {
  return elapsedMs == null ? msg : `${msg} · ${formatElapsed(elapsedMs)}`;
}

/**
 * The pre-run message — the cost, up front.
 * `Exporting 80 tracks (62 will be re-encoded for loudness normalization)…`
 * `Exporting 80 tracks (64 will be re-encoded: 62 for loudness normalization, 5 for a format change)…`
 * `Exporting 80 tracks (no re-encoding needed)…`
 * `Exporting 80 tracks (all already on the USB)…`
 */
export function describeExportPlan(plan) {
  const { total, convert, copy, byReason } = plan.totals;
  const head = `Exporting ${total} track${total === 1 ? '' : 's'}`;
  if (!total) return `${head}…`;

  let suffix;
  if (convert) {
    const contributing = REASON_ORDER.filter((r) => byReason[r] > 0);
    const single = contributing.length === 1 && byReason[contributing[0]] === convert;
    suffix = single
      ? `(${convert} will be re-encoded for ${REASON_PHRASE[contributing[0]]})`
      : `(${convert} will be re-encoded: ${contributing
          .map((r) => `${byReason[r]} for ${REASON_PHRASE[r]}`)
          .join(', ')})`;
  } else if (copy) {
    suffix = '(no re-encoding needed)';
  } else {
    suffix = '(all already on the USB)';
  }

  return `${head} ${suffix}…`;
}

/** `Copying 12/20 · 45s` */
export function describeCopyProgress({ done, total, elapsedMs = null }) {
  return withElapsed(`Copying ${done}/${total}`, elapsedMs);
}

/** `Converting 12/62 (loudness normalization) · 3:05` */
export function describeConvertProgress({ done, total, reasons = [], elapsedMs = null }) {
  const label =
    reasons
      .map((r) => REASON_SHORT[r])
      .filter(Boolean)
      .join(' + ') || 're-encoding';
  return withElapsed(`Converting ${done}/${total} (${label})`, elapsedMs);
}
