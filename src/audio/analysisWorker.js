import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';

/**
 * Locate the mixxx-analyzer binary: the path the main process handed to the
 * worker, otherwise the dev build under build-resources/.
 * @returns {{ exe: string, args: string[] }}
 */
function findAnalysisCommand() {
  const ext = process.platform === 'win32' ? '.exe' : '';

  if (workerData.analyzerPath && fs.existsSync(workerData.analyzerPath)) {
    return { exe: workerData.analyzerPath, args: [] };
  }

  const devBin = path.resolve(process.cwd(), 'build-resources', `analysis${ext}`);
  if (fs.existsSync(devBin)) return { exe: devBin, args: [] };

  throw new Error(
    `mixxx-analyzer binary not found. Expected: ${workerData.analyzerPath ?? '(analyzerPath not set)'}`
  );
}

/**
 * Run the analyzer on one file and parse what it printed.
 * @param {string} filePath - absolute path of the audio file
 * @returns {Promise<object>} the analysis result, or `{ error }` when the output was not JSON
 */
function runAnalysis(filePath) {
  return new Promise((resolve, reject) => {
    const { exe, args } = findAnalysisCommand();
    const p = spawn(exe, [...args, '--json', filePath]);
    let out = '',
      err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => {
      if (!out.trim() && code !== 0)
        return reject(new Error(`analysis exited ${code}: ${err.trim()}`));
      resolve(parseOutput(out, err));
    });
    p.on('error', reject);
  });
}

/**
 * Dig the JSON out of the analyzer's output — it may be preceded or followed by
 * log lines — and return the first record of the array.
 * @param {string} stdout
 * @param {string} stderr - used when the analyzer printed nothing to stdout
 * @returns {object} empty object when there was no output at all
 */
function parseOutput(stdout, stderr) {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) return {};
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr[0] ?? {}) : arr;
  } catch (e) {
    return { error: `invalid json from analysis: ${e.message}` };
  }
}

/**
 * Analyse one file and shape the result the way the tracks table wants it,
 * leaving `null` for everything the analyzer did not report. Never throws: a
 * failed run comes back with an `error` field so the worker can still answer.
 * @param {string} filePath
 * @returns {Promise<object>} bpm / key / loudness / replay gain / intro / outro / beatgrid
 */
async function analyzeAudio(filePath) {
  let result = {};
  try {
    result = await runAnalysis(filePath);
  } catch (e) {
    result = { error: e.message };
  }

  if (result.error) console.error('[analysis] error:', result.error);

  const tags = result.tags ?? {};

  return {
    bpm: result.bpm ?? null,
    key_raw: result.key ?? null,
    key_camelot: result.camelot ?? null,
    loudness: result.lufs ?? null,
    replay_gain: result.replayGain ?? null,
    intro_secs: result.introSecs ?? null,
    outro_secs: result.outroSecs ?? null,
    beatgrid: result.beatgrid ? JSON.stringify(result.beatgrid) : null,
    tagFallbacks: {
      title: tags.title ?? null,
      artist: tags.artist ?? null,
      album: tags.album ?? null,
      year: tags.year ?? null,
      label: tags.label ?? null,
      comments: tags.comment ?? null,
    },
  };
}

(async () => {
  try {
    if (!workerData?.filePath) throw new Error('No filePath in workerData');
    const result = await analyzeAudio(workerData.filePath);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
})();
