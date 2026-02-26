import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';

function findAnalysisCommand() {
  const ext = process.platform === 'win32' ? '.exe' : '';

  // Runtime-downloaded binary (userData/bin/analysis)
  if (workerData.analyzerPath && fs.existsSync(workerData.analyzerPath)) {
    return { exe: workerData.analyzerPath, args: [] };
  }

  // Dev convenience: build-resources/
  const devBin = path.resolve(process.cwd(), 'build-resources', `analysis${ext}`);
  if (fs.existsSync(devBin)) return { exe: devBin, args: [] };

  throw new Error(
    `mixxx-analyzer binary not found. Expected: ${workerData.analyzerPath ?? '(analyzerPath not set)'}`
  );
}

function runAnalysis(filePath) {
  return new Promise((resolve, reject) => {
    const { exe, args } = findAnalysisCommand();
    const p = spawn(exe, [...args, '--json', filePath]);
    let out = '', err = '';
    p.stdout.on('data', c => (out += c));
    p.stderr.on('data', c => (err += c));
    p.on('close', code => {
      if (!out.trim() && code !== 0)
        return reject(new Error(`analysis exited ${code}: ${err.trim()}`));
      resolve(parseOutput(out, err));
    });
    p.on('error', reject);
  });
}

function parseOutput(stdout, stderr) {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) return {};
  const start = raw.indexOf('[');
  const end   = raw.lastIndexOf(']');
  const json  = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr[0] ?? {} : arr;
  } catch (e) {
    return { error: `invalid json from analysis: ${e.message}` };
  }
}

async function analyzeAudio(filePath) {
  let result = {};
  try {
    result = await runAnalysis(filePath);
  } catch (e) {
    result = { error: e.message };
  }

  if (result.error) console.error('[analysis] error:', result.error);

  return {
    bpm:         result.bpm         ?? null,
    key_raw:     result.key         ?? null,
    key_camelot: result.camelot     ?? null,
    loudness:    result.lufs        ?? null,
    replay_gain: result.replayGain  ?? null,
    intro_secs:  result.introSecs   ?? null,
    outro_secs:  result.outroSecs   ?? null,
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
