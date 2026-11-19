import fs from 'fs';

/**
 * Delete normalized audio files left over from exports made before #260 and
 * clear their database entries in one pass. A file that cannot be removed is
 * logged and skipped: a stale path is better than a failed startup.
 * @param {object} deps injected collaborators
 * @param {Function} deps.getLegacyNormalizedTracks tracks carrying a legacy path
 * @param {Function} deps.clearLegacyNormalizedPaths drops those paths from the database
 * @param {object} [deps.fsImpl] filesystem, for tests
 * @param {object} [deps.log] logger, defaults to the console
 * @returns {{cleanupNormalizedFiles: Function}} legacy cleanup
 */
export function createLegacyCleanupService({
  getLegacyNormalizedTracks,
  clearLegacyNormalizedPaths,
  fsImpl = fs,
  log = console,
}) {
  /**
   * Remove the files and clear the paths.
   * @returns {{deleted: number, cleared: number}} counts of both actions
   */
  function cleanupNormalizedFiles() {
    const tracks = getLegacyNormalizedTracks();
    if (tracks.length === 0) return { deleted: 0, cleared: 0 };

    let deleted = 0;
    for (const t of tracks) {
      try {
        if (fsImpl.existsSync(t.normalized_file_path)) {
          fsImpl.unlinkSync(t.normalized_file_path);
          deleted++;
        }
      } catch (err) {
        log.warn(
          `[cleanup] could not delete legacy normalized file ${t.normalized_file_path}:`,
          err.message
        );
      }
    }

    clearLegacyNormalizedPaths();
    log.log(
      `[cleanup] removed ${deleted} legacy normalized file(s), cleared ${tracks.length} DB entries`
    );
    return { deleted, cleared: tracks.length };
  }

  return { cleanupNormalizedFiles };
}
