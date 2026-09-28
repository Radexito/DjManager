// src/library/folderSyncProgress.js
// #516 — the folder sync's own counter.
//
// The app-wide analysis counter cannot report this sync honestly: it counts
// analysis worker batches, and because linking was slow and strictly sequential
// every spawn looked like a fresh batch, so a 118 file folder showed 1/1, 2/2,
// 3/3 … This tracker counts the sync's own files instead.

/** Ordered phases of one sync run. */
export const FOLDER_SYNC_PHASES = ['linking', 'adding', 'done'];

/** Emissions are throttled so a large folder cannot flood the IPC channel. */
export const FOLDER_SYNC_PROGRESS_MIN_MS = 600;

/**
 * Build the counter for one `syncFolderPlaylist` run.
 *
 * @param {{ playlistId?: string|number|null, emit?: (data: object|null) => void,
 *           throttleMs?: number, now?: () => number }} [opts]
 */
export function createFolderSyncProgress({
  playlistId = null,
  emit,
  throttleMs = FOLDER_SYNC_PROGRESS_MIN_MS,
  now = () => Date.now(),
} = {}) {
  let phase = 'linking';
  let total = 0;
  let done = 0;
  let started = false;
  let lastEmitAt = null;

  const snapshot = (file) => {
    const payload = {
      playlistId,
      phase,
      // Never report more progress than there is work — a caller that steps
      // more times than it declared cannot push `done` past `total`.
      done: Math.min(done, total),
      total,
    };
    if (file !== undefined) payload.file = file;
    return payload;
  };

  const flush = (file) => {
    started = true;
    lastEmitAt = now();
    emit?.(snapshot(file));
  };

  return {
    /** Arm the counter with the number of new files this run has to bring in. */
    start(count = 0) {
      total = Math.max(0, Math.floor(count) || 0);
      done = 0;
      phase = 'linking';
      flush();
    },

    /** One file settled — linked, duplicate or failed: all three are work done. */
    step(file) {
      done += 1;
      if (lastEmitAt === null || now() - lastEmitAt >= throttleMs) flush(file);
    },

    /** Move to the next phase; emits even inside the throttle window. */
    setPhase(next) {
      if (!FOLDER_SYNC_PHASES.includes(next)) return;
      phase = next;
      flush();
    },

    /**
     * Terminal event with `done === total`, then the clearing event the other
     * progress streams use (`null`). `done` is forced to `total` so the final
     * frame is never a half-count; it is followed by the clearing event in the
     * same tick, so an aborted run's line disappears rather than lingering.
     * A run that never reported anything emits nothing at all.
     */
    finish() {
      if (!started) return;
      phase = 'done';
      done = total;
      flush();
      lastEmitAt = null;
      emit?.(null);
    },
  };
}
