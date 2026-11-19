import fs from 'fs';
import path from 'path';
import { normalizeGraphicsMode } from './launchProfile.js';

/**
 * Startup graphics state, read BEFORE anything else exists.
 *
 * It cannot live in the SQLite settings table: the acceleration decision has to
 * be made at module load, long before initDB() opens the database, and it must
 * survive a crash that happens before the UI ever appears. Same reasoning (and
 * same shape of solution) as db/dbLocation.js.
 *
 * The file now carries three things beyond the mode: the recorded fallback, the
 * crash history used to decide when to fall back, and the report path. Reads are
 * forgiving on purpose — a corrupt or missing file must never stop a launch, it
 * just means "no fallback, no history".
 *
 * Writes are atomic (temp file + rename): the file is read on every start, so a
 * half-written file would look like a permanent decision instead of a transient
 * failure.
 */

const CONFIG_FILENAME = 'graphics.json';
/** Name of the crash report file written next to the graphics config. */
const REPORT_FILENAME = 'graphics-crash-report.json';

/** Oldest entries fall off the end; the file is read at every start. */
export const CRASH_HISTORY_LIMIT = 50;

/** Path of the graphics state file, written next to the user data. */
export function graphicsConfigPath(userDataDir) {
  return path.join(userDataDir, CONFIG_FILENAME);
}

/** Path of the graphics crash report file. */
export function graphicsReportPath(userDataDir) {
  return path.join(userDataDir, REPORT_FILENAME);
}

/** @returns {{ mode: string, fallback: object | null, crashes: object[], reportPath: string }} */
export function defaultGraphicsState() {
  return { mode: 'auto', fallback: null, crashes: [], reportPath: REPORT_FILENAME };
}

/**
 * Keep a recorded fallback only when it is actually active, with sane defaults
 * for the timestamps and reason.
 * @param {*} value whatever was on disk
 * @returns {object|null} null when there is no active fallback
 */
function normalizeFallback(value) {
  if (!value || typeof value !== 'object' || value.active !== true) return null;
  return {
    active: true,
    since: Number.isFinite(value.since) ? value.since : null,
    reason: typeof value.reason === 'string' ? value.reason : '',
    relaunchedAt: Number.isFinite(value.relaunchedAt) ? value.relaunchedAt : null,
  };
}

/**
 * Keep only the fields we understand. An entry written by a newer build must not
 * make an older build fail to start.
 */
function normalizeCrashEntry(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    at: Number.isFinite(value.at) ? value.at : 0,
    type: typeof value.type === 'string' ? value.type : '',
    reason: typeof value.reason === 'string' ? value.reason : '',
    exitCode: Number.isFinite(value.exitCode) ? value.exitCode : null,
    serviceName: typeof value.serviceName === 'string' ? value.serviceName : '',
    appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
    electron: typeof value.electron === 'string' ? value.electron : '',
    os: typeof value.os === 'string' ? value.os : '',
    kernel: typeof value.kernel === 'string' ? value.kernel : '',
    session: typeof value.session === 'string' ? value.session : '',
    gpu: value.gpu && typeof value.gpu === 'object' ? value.gpu : {},
  };
}

/**
 * @param {string} userDataDir
 * @returns {{ mode: string, fallback: object | null, crashes: object[], reportPath: string }}
 */
export function readGraphicsState(userDataDir) {
  const fallback = defaultGraphicsState();
  if (!userDataDir || !path.isAbsolute(userDataDir)) return fallback;

  try {
    const file = graphicsConfigPath(userDataDir);
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const crashes = Array.isArray(parsed?.crashes)
      ? parsed.crashes.map(normalizeCrashEntry).filter(Boolean).slice(-CRASH_HISTORY_LIMIT)
      : [];
    return {
      mode: normalizeGraphicsMode(parsed?.mode),
      fallback: normalizeFallback(parsed?.fallback),
      crashes,
      reportPath:
        typeof parsed?.reportPath === 'string' && parsed.reportPath
          ? parsed.reportPath
          : REPORT_FILENAME,
    };
  } catch {
    return fallback;
  }
}

/** What the launch decision needs at module load, before the database exists. */
export function readGraphicsConfig(userDataDir) {
  const state = readGraphicsState(userDataDir);
  return { mode: state.mode, fallback: state.fallback };
}

/**
 * Atomic write: a crash can interrupt us between any two instructions, and this
 * file is read on every start. Writing to a temp file and renaming means the
 * reader either sees the previous complete state or the new complete state.
 */
export function writeGraphicsState(userDataDir, state) {
  if (!userDataDir || !path.isAbsolute(userDataDir)) return false;
  const file = graphicsConfigPath(userDataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = {
    mode: normalizeGraphicsMode(state?.mode),
    fallback: normalizeFallback(state?.fallback),
    crashes: Array.isArray(state?.crashes)
      ? state.crashes.slice(-CRASH_HISTORY_LIMIT).map(normalizeCrashEntry).filter(Boolean)
      : [],
    reportPath:
      typeof state?.reportPath === 'string' && state.reportPath
        ? state.reportPath
        : REPORT_FILENAME,
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}
