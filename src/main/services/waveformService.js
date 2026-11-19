/**
 * Waveform upkeep in the main process: fill in missing overview waveforms after
 * analysis and regenerate the high-resolution detail waveform after an edit.
 * Progress and completion both leave through the renderer bridge, which no-ops
 * while there is no window.
 * @param {object} deps injected collaborators
 * @param {Function} deps.getTracks every track in the library
 * @param {Function} deps.updateTrackWaveform stores an overview waveform
 * @param {Function} deps.updateTrackDetailHires stores a detail hires waveform
 * @param {Function} deps.generateWaveformOverview builds an overview from a file
 * @param {Function} deps.generateEditorWaveform builds the detail waveform
 * @param {Function} deps.getFfmpegRuntimePath resolves the ffmpeg binary
 * @param {Function} deps.send renderer bridge
 * @param {object} [deps.log] logger, defaults to the console
 * @returns {{generateMissingOverviews: Function, regenerateHires: Function}} waveform upkeep
 */
export function createWaveformService({
  getTracks,
  updateTrackWaveform,
  updateTrackDetailHires,
  generateWaveformOverview,
  generateEditorWaveform,
  getFfmpegRuntimePath,
  send,
  log = console,
}) {
  /**
   * Generate an overview for every analyzed track that has none, reporting
   * progress as each one finishes. A failing track is logged and skipped so one
   * bad file does not stop the batch.
   * @returns {Promise<number>} how many overviews were generated
   */
  async function generateMissingOverviews() {
    const tracks = getTracks({ limit: 999999 });
    const missing = tracks.filter((t) => t.analyzed === 1 && t.waveform_overview == null);
    if (missing.length === 0) return 0;

    log.log(`[waveform] generating overviews for ${missing.length} tracks…`);
    let completed = 0;

    const sendProgress = (done = false) => {
      send('waveform-gen-progress', { completed, total: missing.length, done });
    };

    for (const track of missing) {
      try {
        const buf = await generateWaveformOverview(track.file_path, getFfmpegRuntimePath());
        updateTrackWaveform(track.id, buf);
      } catch (err) {
        log.warn(`[waveform] failed for track ${track.id}:`, err.message);
      }
      completed++;
      sendProgress();
    }

    sendProgress(true);
    log.log(`[waveform] done — generated ${completed} overviews`);
    return completed;
  }

  /**
   * Regenerate the high-resolution detail waveform in the background and tell
   * the renderer once it is stored. Failures are only logged, because the track
   * itself is fine without the detail waveform.
   * @param {number} trackId
   * @param {string} filePath
   * @returns {Promise<boolean>} whether the waveform was stored
   */
  function regenerateHires(trackId, filePath) {
    return generateEditorWaveform(filePath, getFfmpegRuntimePath())
      .then(({ detailHires }) => {
        updateTrackDetailHires(trackId, detailHires);
        send('waveform-ready', { trackId });
        return true;
      })
      .catch((err) => {
        log.warn(`[waveform] hires detail regen failed for track ${trackId}:`, err.message);
        return false;
      });
  }

  return { generateMissingOverviews, regenerateHires };
}
