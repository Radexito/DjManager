import { CRASH_HISTORY_LIMIT } from './graphicsConfig.js';

/**
 * Crash recorder: turns Electron's `child-process-gone` event into a durable
 * history entry and decides when the history justifies falling back.
 *
 * Why this file has no Electron imports: every decision here has to be provable
 * without booting the app. Electron passes us nothing but `details`; versions,
 * GPU data and platform facts are injected by the caller (`main.js`), so tests
 * can pin them.
 *
 * Two facts from the Electron 44 typings shape the design:
 *   - `details.type` never says `GPUV2`; GPU crashes arrive as `GPU`.
 *   - The network service is not a type of its own: it arrives as `Utility`
 *     with `serviceName` containing `network.mojom.NetworkService`.
 */

/**
 * SIGTERM delivered from outside. `kill`, a systemd stop, a closed terminal or a
 * test harness all arrive the same way: reason `killed`, exit code 15. That is a
 * shutdown, not a crash, and it must never trigger the fallback.
 */
export function isExternalTermination(details) {
  return Boolean(details) && details.reason === 'killed' && Number(details.exitCode) === 15;
}

/** A single GPU or network-service crash is worth recording; anything else is noise. */
export function isRelevantCrash(details) {
  if (!details) return false;
  if (isExternalTermination(details)) return false;
  if (details.type === 'GPU') return true;
  if (details.type === 'Renderer') return details.reason !== 'clean-exit';
  return details.type === 'Utility' && /network/i.test(String(details.serviceName ?? ''));
}

/** Two relevant crashes inside five minutes mean the current profile is not working. */
export const FALLBACK_THRESHOLD = 2;
export const FALLBACK_WINDOW_MS = 300_000;

/**
 * Build the entry that goes into graphics.json. Everything optional degrades to
 * an empty string or null: a missing field must never be the reason the history
 * stops being written.
 */
export function buildCrashEntry({
  details,
  now,
  platform = process.platform,
  env = {},
  versions = {},
  gpu = {},
} = {}) {
  const serviceName = String(details?.serviceName ?? '');
  return {
    at: Number.isFinite(now) ? now : Date.now(),
    type: String(details?.type ?? ''),
    reason: String(details?.reason ?? ''),
    exitCode: Number.isFinite(details?.exitCode) ? details.exitCode : null,
    serviceName,
    appVersion: String(versions.app ?? ''),
    electron: String(versions.electron ?? ''),
    os: String(versions.os ?? platform),
    kernel: String(versions.kernel ?? ''),
    session: String(env.XDG_SESSION_TYPE ?? (env.WAYLAND_DISPLAY ? 'wayland' : '')),
    gpu: gpu && typeof gpu === 'object' ? gpu : {},
  };
}

/**
 * Pure reducer: append the entry, keep the newest `limit`. Returns a new state so
 * the caller can decide what to persist without mutating what it read.
 */
export function appendCrash(state, entry, limit = CRASH_HISTORY_LIMIT) {
  const crashes = Array.isArray(state?.crashes) ? state.crashes : [];
  const next = [...crashes, entry].slice(-limit);
  return { ...state, crashes: next };
}

/**
 * Whether the recorded history crosses the fallback threshold.
 *
 * Counted from timestamps on disk, not from an in-memory counter, because the
 * whole point is to survive the restart that follows a crash loop. `mode:
 * enabled` is the user saying "I accept the risk", so it is never overridden.
 */
export function shouldFallback(
  state,
  { now = Date.now(), threshold = FALLBACK_THRESHOLD, windowMs = FALLBACK_WINDOW_MS } = {}
) {
  if (state?.mode === 'enabled') return false;
  if (state?.fallback?.active === true) return false;
  const crashes = Array.isArray(state?.crashes) ? state.crashes : [];
  const inWindow = crashes.filter(
    (entry) => Number.isFinite(entry?.at) && now - entry.at <= windowMs
  );
  return inWindow.length >= threshold;
}

/**
 * Freeze the fallback decision into the state that the next launch reads.
 *
 * `relaunchedAt` is what stops a restart loop: the restarted process starts in
 * the fallback profile, and a crash there is recorded but never relaunches again.
 */
export function markFallback(state, { now = Date.now(), reason = 'gpu-crash-loop' } = {}) {
  return {
    ...state,
    fallback: { active: true, since: now, reason, relaunchedAt: now },
  };
}

/**
 * One call for the crash handler: validate, build, append, and report whether
 * this crash pushed the history over the threshold. Persisting is the caller's
 * job; this function stays free of the filesystem so it is trivial to test.
 */
export function recordCrash(state, options = {}) {
  const { details, now, ...rest } = options;
  if (!isRelevantCrash(details)) {
    return { state, entry: null, fallbackNow: false };
  }
  const entry = buildCrashEntry({ details, now, ...rest });
  const next = appendCrash(state, entry);
  return { state: next, entry, fallbackNow: shouldFallback(next, { now: entry.at }) };
}
