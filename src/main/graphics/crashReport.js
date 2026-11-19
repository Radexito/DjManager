import fs from 'fs';
import path from 'path';

/**
 * Crash report: what a human (and the "Show more" panel) gets after a GPU
 * failure.
 *
 * Electron does not expose a stack trace for a dead child process, so the report
 * carries only what really exists: type, reason, exit code, service name,
 * versions, environment, GPU facts and the tail of the log around the crash. The
 * missing stack trace is stated in the report instead of invented.
 */

export const LOG_TAIL_LINES = 200;

/**
 * Last `maxLines` lines of the newest `app-*.log` in `logDir`.
 *
 * Reads a bounded tail instead of the whole file: logs rotate daily and a long
 * session can produce a lot of text, while a report only needs the end.
 */
export function readLogTail(logDir, maxLines = LOG_TAIL_LINES, maxBytes = 256 * 1024) {
  if (!logDir || !path.isAbsolute(logDir)) return '';
  try {
    const files = fs
      .readdirSync(logDir)
      .filter((name) => /^app-.*\.log$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(logDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return '';
    const file = path.join(logDir, files[0].name);
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      return lines.slice(-maxLines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Condense the stored crash entries into counts and the distinct types, reasons
 * and exit codes, keeping the time of the first and last one.
 * @param {object[]} crashes
 * @returns {{ count: number, firstAt: number|null, lastAt: number|null, types: string[],
 *   reasons: string[], exitCodes: number[] }}
 */
function summarizeCrashes(crashes) {
  const list = Array.isArray(crashes) ? crashes : [];
  if (list.length === 0) {
    return { count: 0, firstAt: null, lastAt: null, types: [], reasons: [], exitCodes: [] };
  }
  return {
    count: list.length,
    firstAt: list[0].at ?? null,
    lastAt: list[list.length - 1].at ?? null,
    types: [...new Set(list.map((entry) => entry.type).filter(Boolean))],
    reasons: [...new Set(list.map((entry) => entry.reason).filter(Boolean))],
    exitCodes: [...new Set(list.map((entry) => entry.exitCode).filter((code) => code !== null))],
  };
}

/**
 * @param {object} input
 * @param {object} input.state      graphics state as read from disk
 * @param {object} [input.entry]    the crash that triggered the report
 * @param {string} [input.logTail]  text of the log around the crash
 * @param {object} [input.environment] extra facts (app, electron, platform...)
 */
export function buildCrashReport({ state, entry = null, logTail = '', environment = {} } = {}) {
  const crashes = Array.isArray(state?.crashes) ? state.crashes : [];
  const summary = summarizeCrashes(crashes);
  return {
    generatedAt: Date.now(),
    appVersion: String(environment.app ?? entry?.appVersion ?? ''),
    electron: String(environment.electron ?? entry?.electron ?? ''),
    platform: String(environment.platform ?? entry?.os ?? ''),
    kernel: String(environment.kernel ?? entry?.kernel ?? ''),
    osRelease: String(environment.osRelease ?? ''),
    session: String(environment.session ?? entry?.session ?? ''),
    mode: String(state?.mode ?? 'auto'),
    fallback: state?.fallback ?? null,
    summary,
    lastCrash: entry,
    crashes,
    gpu: entry?.gpu ?? {},
    stackTraceAvailable: false,
    stackTraceNote:
      'Electron does not expose stack traces for child processes; type, reason and exit code are the available facts.',
    logTail,
  };
}

/** Human-readable version for the "Show more" panel. */
export function renderCrashReport(report) {
  const summary = report?.summary ?? { count: 0 };
  const lines = [
    `Graphics crash report`,
    `Generated: ${new Date(report?.generatedAt ?? Date.now()).toISOString()}`,
    `App: ${report?.appVersion || '?'} | Electron: ${report?.electron || '?'}`,
    `Platform: ${report?.platform || '?'} (${report?.kernel || '?'}) | Session: ${report?.session || '?'}`,
    `Mode: ${report?.mode || 'auto'} | Fallback: ${report?.fallback?.active ? `active since ${new Date(report.fallback.since ?? 0).toISOString()} (${report.fallback.reason || 'unknown'})` : 'not active'}`,
    `Crashes recorded: ${summary.count}`,
  ];
  if (summary.count > 0) {
    lines.push(`First: ${summary.firstAt ? new Date(summary.firstAt).toISOString() : '?'}`);
    lines.push(`Last: ${summary.lastAt ? new Date(summary.lastAt).toISOString() : '?'}`);
    lines.push(`Types: ${(summary.types ?? []).join(', ') || '?'}`);
    lines.push(`Reasons: ${(summary.reasons ?? []).join(', ') || '?'}`);
    lines.push(`Exit codes: ${(summary.exitCodes ?? []).join(', ') || '?'}`);
  }
  if (report?.lastCrash) {
    const crash = report.lastCrash;
    lines.push(
      `Last crash: type=${crash.type} reason=${crash.reason} exitCode=${crash.exitCode ?? 'n/a'} service=${crash.serviceName || 'n/a'}`
    );
  }
  lines.push(`Stack trace: not available (${report?.stackTraceNote ?? ''})`);
  if (report?.logTail) {
    lines.push('', '--- log tail ---', report.logTail);
  }
  return lines.join('\n');
}

/**
 * Write the JSON report next to graphics.json. Returns the path written, or null
 * when the write failed (the caller only needs it for an IPC reply later).
 */
export function writeCrashReport(filePath, report) {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
    return filePath;
  } catch {
    return null;
  }
}
