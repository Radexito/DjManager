import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Print platform, version and the length and existence of every key path at
 * startup. A long userData path is the usual cause of Windows MAX_PATH
 * failures, so any path at or over the limit is flagged.
 * @param {object} deps injected values
 * @param {string} deps.userDataPath the app's userData directory
 * @param {string} deps.appVersion running version
 * @param {Function} [deps.exists] existence check, for tests
 * @param {Function} [deps.log] line logger, defaults to the console
 * @returns {Array<{label: string, path: string, length: number, exists: boolean, tooLong: boolean}>} inspected paths
 */
export function logStartupDiagnostics({
  userDataPath,
  appVersion,
  platform = process.platform,
  release = os.release(),
  osVersion = os.version(),
  arch = process.arch,
  exists = (target) => fs.existsSync(target),
  log = console.log,
  maxPath = 260,
}) {
  const binDir = path.join(userDataPath, 'bin');
  const keyPaths = {
    userData: userDataPath,
    bin: binDir,
    'ffmpeg.exe': path.join(binDir, 'ffmpeg', 'ffmpeg.exe'),
    'ffprobe.exe': path.join(binDir, 'ffmpeg', 'ffprobe.exe'),
    'analysis.exe': path.join(binDir, 'analysis.exe'),
    'yt-dlp.exe': path.join(binDir, 'yt-dlp.exe'),
  };

  log('[diag] ── startup diagnostics ─────────────────────────────');
  log(`[diag] os.platform   = ${platform}`);
  log(`[diag] os.release    = ${release}`);
  log(`[diag] os.version    = ${osVersion}`);
  log(`[diag] process.arch  = ${arch}`);
  log(`[diag] app.version   = ${appVersion}`);
  log('[diag] key paths (length / exists):');

  const inspected = [];
  for (const [label, target] of Object.entries(keyPaths)) {
    const present = exists(target);
    const tooLong = target.length >= maxPath;
    inspected.push({ label, path: target, length: target.length, exists: present, tooLong });
    log(
      `[diag]   ${label.padEnd(14)} len=${target.length}${tooLong ? ' ⚠ NEAR/OVER MAX_PATH' : ''} exists=${present}  ${target}`
    );
  }

  log('[diag] ─────────────────────────────────────────────────────');
  return inspected;
}
