import os from 'os';

/**
 * Turn a dead child process into a recorded crash: persist the state, write a
 * report beside it, and restart with acceleration off when the crash loop
 * threshold is crossed and automatic fallback is allowed.
 *
 * Electron gives no stack trace for a dead child process, so the report carries
 * the facts that do exist (type, reason, exit code, service name, versions,
 * environment, GPU, log tail) and says so.
 * @param {object} deps injected collaborators
 * @param {object} deps.app Electron app handle
 * @param {Function} deps.readGraphicsState reads the persisted graphics state
 * @param {Function} deps.writeGraphicsState persists the graphics state
 * @param {Function} deps.graphicsReportPath report path for a userData dir
 * @param {Function} deps.buildCrashReport assembles the report text
 * @param {Function} deps.writeCrashReport writes the report to disk
 * @param {Function} deps.readLogTail reads the end of the main log
 * @param {Function} deps.getLogDir resolves the log directory
 * @param {Function} deps.recordCrash folds a crash into the state
 * @param {Function} deps.markFallback records that the fallback profile was used
 * @param {Function} deps.shouldAllowAutomaticFallback decides whether a relaunch may happen
 * @param {Function} deps.relaunchApp restarts the app
 * @param {Function} [deps.now] clock, for tests
 * @param {object} [deps.env] environment, for tests
 * @param {Function} [deps.cliArgs] command line arguments, for tests
 * @param {object} [deps.log] logger, defaults to the console
 * @returns {{snapshot: Function, handle: Function}} crash recorder
 */
export function createGraphicsCrashService(deps) {
  const {
    app,
    readGraphicsState,
    writeGraphicsState,
    graphicsReportPath,
    buildCrashReport,
    writeCrashReport,
    readLogTail,
    getLogDir,
    recordCrash,
    markFallback,
    shouldAllowAutomaticFallback,
    relaunchApp,
    now = () => Date.now(),
    env = process.env,
    cliArgs = () => process.argv.slice(1),
    log = console,
  } = deps;

  /**
   * GPU facts for the crash report. A rejected call when the GPU is already
   * off is normal, so every failure degrades to nulls.
   * @returns {Promise<{info: *, status: *}>} GPU info and feature status
   */
  async function snapshot() {
    try {
      const [info, status] = await Promise.all([
        app.getGPUInfo('basic').catch(() => null),
        Promise.resolve(app.getGPUFeatureStatus()).catch(() => null),
      ]);
      return { info, status };
    } catch {
      return {};
    }
  }

  /**
   * Record one crash and, when the loop threshold is crossed, restart with
   * acceleration off. Recording never throws: a crash that cannot be recorded
   * is logged, because the alternative is losing the window for good.
   * @param {object} details child-process-gone payload
   * @returns {Promise<object>} what was recorded, or the error
   */
  async function handle(details) {
    try {
      const userData = app.getPath('userData');
      const gpu = await snapshot();
      const {
        state: nextState,
        entry,
        fallbackNow,
      } = recordCrash(readGraphicsState(userData), {
        details,
        now: now(),
        platform: process.platform,
        env,
        versions: {
          app: app.getVersion(),
          electron: process.versions.electron ?? '',
          os: process.platform,
          kernel: os.release(),
        },
        gpu,
      });

      const stateToPersist = fallbackNow ? markFallback(nextState, { now: entry.at }) : nextState;
      writeGraphicsState(userData, stateToPersist);
      writeCrashReport(
        graphicsReportPath(userData),
        buildCrashReport({
          state: stateToPersist,
          entry,
          logTail: readLogTail(getLogDir()),
          environment: {
            app: app.getVersion(),
            electron: process.versions.electron ?? '',
            platform: process.platform,
            kernel: os.release(),
            osRelease: os.release(),
            session: env.XDG_SESSION_TYPE ?? (env.WAYLAND_DISPLAY ? 'wayland' : ''),
          },
        })
      );
      log.error(
        `[crash] recorded type=${details.type} reason=${details.reason}` +
          ` exitCode=${details.exitCode} fallbackNow=${fallbackNow}`
      );

      const mayRestart = shouldAllowAutomaticFallback({ env, cliArgs: cliArgs() });
      const restarted = Boolean(fallbackNow && mayRestart);
      if (restarted) {
        log.error('[crash] GPU crash loop detected, restarting with acceleration off');
        relaunchApp();
      }
      return { state: stateToPersist, entry, fallbackNow, restarted };
    } catch (error) {
      log.error('[crash] failed to record crash:', error?.message ?? error);
      return { error };
    }
  }

  return { snapshot, handle };
}
