import os from 'node:os';
import { handle } from './response.js';

/**
 * Graphics IPC channels, the first domain lifted out of `src/main.js`.
 *
 * WHY THIS SHAPE: the plan's tor B splits `main.js` into a composition root plus
 * per-domain IPC modules, and a big-bang move of 3400 lines cannot be reviewed.
 * This is the smallest slice that proves the pattern end to end: the handlers
 * keep their exact channel names, payloads and return shapes, while the module
 * itself no longer depends on Electron singletons or on `main.js` module scope,
 * so it can be driven with a fake `ipcMain`.
 *
 * Every dependency is injected on purpose. Reading `app`, the state files or the
 * logger through globals is what made the old file untestable.
 */
export function registerGraphicsIpc({
  ipcMain,
  graphicsUserDataDir,
  readGraphicsState,
  writeGraphicsState,
  buildCrashReport,
  readLogTail,
  getLogDir,
  getVersion,
  relaunchApp,
  platform = process.platform,
  kernel = os.release(),
  session = process.env.XDG_SESSION_TYPE ?? (process.env.WAYLAND_DISPLAY ? 'wayland' : ''),
}) {
  if (!ipcMain) throw new Error('registerGraphicsIpc: ipcMain is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('get-graphics-state', () => {
    const state = readGraphicsState(graphicsUserDataDir());
    const fallbackActive = state.fallback?.active === true;
    const activeProfile =
      fallbackActive && state.mode !== 'enabled' && state.mode !== 'disabled'
        ? 'fallback'
        : state.mode;
    return {
      mode: state.mode,
      activeProfile,
      notice: activeProfile === 'fallback' ? 'gpu-crash' : null,
      crashCount: state.crashes.length,
      lastCrashAt: state.crashes.at(-1)?.at ?? null,
    };
  });

  register('get-graphics-report', () => {
    const state = readGraphicsState(graphicsUserDataDir());
    return buildCrashReport({
      state,
      logTail: readLogTail(getLogDir()),
      environment: {
        app: getVersion(),
        electron: process.versions.electron ?? '',
        platform,
        kernel,
        osRelease: kernel,
        session,
      },
    });
  });

  register('set-graphics-mode', (_, payload) => {
    const mode = payload?.mode;
    if (!['auto', 'enabled', 'disabled'].includes(mode)) {
      return { ok: false, error: `Unknown graphics mode: ${mode}` };
    }

    const userData = graphicsUserDataDir();
    const state = readGraphicsState(userData);
    const fallbackActive = state.fallback?.active === true;

    if (mode === 'enabled' && fallbackActive && payload?.confirmRisk !== true) {
      return {
        ok: false,
        requiresConfirmation: true,
        error:
          'Hardware acceleration was disabled after a GPU crash. Re-enabling it may crash the app again.',
      };
    }

    const nextState = {
      ...state,
      mode,
      fallback: mode === 'auto' ? null : state.fallback,
    };
    const saved = writeGraphicsState(userData, nextState);
    return saved ? { ok: true } : { ok: false, error: 'Could not save graphics settings.' };
  });

  register('relaunch-app', () => {
    relaunchApp();
  });
}
