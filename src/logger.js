/**
 * File logger for DJ Manager.
 *
 * - Writes to <userData>/logs/app-YYYY-MM-DD.log
 * - Keeps the last LOG_RETENTION_DAYS log files; older ones are deleted on init
 * - Patches console.log / console.warn / console.error in the main process
 *   so all existing log calls are automatically captured
 * - Exposes `log(level, ...args)` for explicit use
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * How many days of log files are kept: a week of sessions is enough to cover a bug
 * report filed the morning after, without letting the logs dir grow without bound.
 */
const LOG_RETENTION_DAYS = 7;

/** Append stream of the current main-process log file, null until initLogger runs. */
let logStream = null;
/** Directory holding the log files, set by initLogger. */
let logDir = null;
/** Append stream of the renderer console log, null until initRendererLogger runs. */
let rendererLogStream = null;

/** Zero-pad a number to two digits. */
function pad(n) {
  return String(n).padStart(2, '0');
}

/** Today's local date as YYYY-MM-DD, the suffix of the log file name. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local timestamp for a log line: `YYYY-MM-DD HH:MM:SS.mmm`. */
function timestamp() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Render console arguments as one line: errors expand to message plus stack,
 * other objects are JSON-encoded (falling back to String when they cannot be
 * serialized), and everything else is stringified.
 * @param {any[]} args
 * @returns {string}
 */
function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
}

/**
 * Write one line to stdout and to the current log file.
 * @param {string} level e.g. "info", "warn", "error"
 * @param {...any} args
 */
export function log(level, ...args) {
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${formatArgs(args)}\n`;
  process.stdout.write(line);
  logStream?.write(line);
}

/** Route console.log / warn / error through the log file as well as the original console, so existing calls are captured. */
function patchConsole() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    const line = `[${timestamp()}] [INFO]  ${formatArgs(args)}\n`;
    origLog(...args);
    logStream?.write(line);
  };
  console.warn = (...args) => {
    const line = `[${timestamp()}] [WARN]  ${formatArgs(args)}\n`;
    origWarn(...args);
    logStream?.write(line);
  };
  console.error = (...args) => {
    const line = `[${timestamp()}] [ERROR] ${formatArgs(args)}\n`;
    origError(...args);
    logStream?.write(line);
  };
}

/**
 * Delete log files with this prefix whose mtime is older than the retention
 * window. Failures are swallowed: pruning must never block startup.
 * @param {string} prefix file name prefix, e.g. "app-"
 */
function pruneOldLogs(prefix) {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.log')) continue;
      const full = path.join(logDir, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {}
}

/**
 * Open today's log file under `<userData>/logs`, prune old ones, write a banner
 * with the app version and platform, and start capturing the console.
 * @returns {string} path of the log file
 */
export function initLogger() {
  logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  pruneOldLogs('app-');

  const logFile = path.join(logDir, `app-${today()}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });

  logStream.write(`\n${'='.repeat(60)}\n`);
  logStream.write(
    `[${timestamp()}] [INFO]  DJ Manager started — version ${app.getVersion()} platform=${process.platform} arch=${process.arch}\n`
  );

  patchConsole();

  return logFile;
}

/** The log directory, or null before initLogger has run. */
export function getLogDir() {
  return logDir;
}

/**
 * Separate log file capturing the renderer's DevTools console (forwarded via
 * webContents 'console-message'), so a bug reporter's browser-side errors are
 * distinguishable from main-process logs without cross-referencing timestamps.
 */
export function initRendererLogger() {
  pruneOldLogs('renderer-console-');

  const logFile = path.join(logDir, `renderer-console-${today()}.log`);
  rendererLogStream = fs.createWriteStream(logFile, { flags: 'a' });

  rendererLogStream.write(`\n${'='.repeat(60)}\n`);
  rendererLogStream.write(
    `[${timestamp()}] [INFO]  DJ Manager renderer console log started — version ${app.getVersion()}\n`
  );

  return logFile;
}

/**
 * Append one renderer console line to the renderer log file.
 * @param {string} level DevTools level, e.g. "log", "warning", "error"
 * @param {string} message
 */
export function logRendererMessage(level, message) {
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}\n`;
  rendererLogStream?.write(line);
}
