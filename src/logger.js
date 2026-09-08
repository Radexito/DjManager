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

const LOG_RETENTION_DAYS = 7;

let logStream = null;
let logDir = null;
let rendererLogStream = null;

function pad(n) {
  return String(n).padStart(2, '0');
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timestamp() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

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

export function log(level, ...args) {
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${formatArgs(args)}\n`;
  process.stdout.write(line);
  logStream?.write(line);
}

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

function pruneOldLogs(prefix) {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.log')) continue;
      const full = path.join(logDir, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {
    /* best-effort */
  }
}

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

export function logRendererMessage(level, message) {
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}\n`;
  rendererLogStream?.write(line);
}
