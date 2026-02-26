import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';

/**
 * In production (isPackaged=true): spawn the bundled standalone analysis binary
 * (built by PyInstaller in CI — no Python runtime needed on the user's machine).
 *
 * In development: spawn python3 + analysis.py, preferring .venv if present.
 */
function findAnalysisCommand() {
  const ext = process.platform === 'win32' ? '.exe' : '';

  if (workerData.isPackaged) {
    // Packaged app: binary is in resources/ — no Python needed on user machine
    const bin = path.join(workerData.resourcesPath, `analysis${ext}`);
    if (!fs.existsSync(bin)) throw new Error(`Bundled analysis binary not found at: ${bin}`);
    return { exe: bin, args: [] };
  }

  // Dev: use pre-downloaded binary in build-resources/ if available
  const devBin = path.resolve(process.cwd(), 'build-resources', `analysis${ext}`);
  if (fs.existsSync(devBin)) return { exe: devBin, args: [] };

  // Dev fallback: Python + analysis.py (requires .venv or system python3 with mixxx-analyzer)
  const venvPy = path.resolve(process.cwd(), '.venv', 'bin', 'python3');
  const py     = process.env.PYTHON || (fs.existsSync(venvPy) ? venvPy : 'python3');
  const script = path.resolve(process.cwd(), 'python', 'analysis.py');
  return { exe: py, args: [script] };
}

function runAnalysis(filePath) {
  return new Promise((resolve, reject) => {
    const { exe, args } = findAnalysisCommand();

    try {
      const out = execFileSync(exe, [...args, filePath], { encoding: 'utf8', timeout: 120_000 });
      return resolve(parseOutput(out, ''));
    } catch (syncErr) {
      // execFileSync throws on non-zero exit — fall back to async spawn
      const p = spawn(exe, [...args, filePath]);
      let out = '', err = '';
      p.stdout.on('data', c => (out += c));
      p.stderr.on('data', c => (err += c));
      p.on('close', code => {
        const candidate = out.trim() || err.trim();
        if (!candidate && code !== 0)
          return reject(new Error(`analysis exited ${code}: ${err}`));
        resolve(parseOutput(out, err));
      });
      p.on('error', reject);
    }
  });
}

function parseOutput(stdout, stderr) {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) return {};
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  const json  = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    return JSON.parse(json);
  } catch (e) {
    return { py_error: `invalid json from analysis: ${e.message}` };
  }
}

async function analyzeAudio(filePath) {
  let result = {};
  try {
    result = await runAnalysis(filePath);
  } catch (e) {
    result = { py_error: e.message };
  }

  if (result.py_error) console.error('[analysis] error:', result.py_error);

  return {
    bpm:         result.bpm         ?? null,
    key_raw:     result.key_raw     ?? null,
    key_camelot: result.key_camelot ?? null,
    loudness:    result.lufs        ?? null,
    replay_gain: result.replay_gain ?? null,
    intro_secs:  result.intro_secs  ?? null,
    outro_secs:  result.outro_secs  ?? null,
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
