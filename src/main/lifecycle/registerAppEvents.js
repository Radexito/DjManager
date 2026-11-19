/**
 * Application-level Electron events that are not part of window creation.
 *
 * `ready` is deliberately not here: it starts the whole bootstrap and belongs
 * next to it, not with the shutdown and crash handlers.
 * @param {object} deps
 * @param {object} deps.app the Electron app
 * @param {object} deps.watcherService the library watcher, stopped on quit
 * @param {object} deps.graphicsCrashService records the crash and decides on the fallback
 * @param {Function} deps.isRelevantCrash filters out clean and externally killed children
 * @returns {void}
 */
export function registerAppEvents({ app, watcherService, graphicsCrashService, isRelevantCrash }) {
  app.on('window-all-closed', () => {
    console.log('All windows closed.');
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    watcherService.stop();
  });

  /**
   * A dead GPU or network-service child process is recorded in
   * `<userData>/graphics.json` with a report next to it, and a crash loop
   * switches the next start to the software profile.
   *
   * Electron gives no stack trace for a dead child process, so the report
   * carries the facts that do exist (type, reason, exit code, service name,
   * versions, environment, GPU, log tail) and says so.
   */
  app.on('child-process-gone', (_event, details) => {
    if (!isRelevantCrash(details)) {
      console.error(
        `[crash] child-process-gone type=${details.type} reason=${details.reason}` +
          ` exitCode=${details.exitCode} name=${details.name || '?'}`
      );
      return;
    }
    graphicsCrashService.handle(details);
  });
}
