import { spawn } from 'child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 22050; // Hz — sufficient for waveform resolution
const MS_PER_COL = 10; // milliseconds per scroll waveform column
const SAMPLES_PER_COL = Math.round((SAMPLE_RATE * MS_PER_COL) / 1000); // 220 samples/col
const PREVIEW_RATIO = 10; // PWAV is 1/10th resolution (100ms per column)
const PREVIEW_SAMPLES_PER_COL = SAMPLES_PER_COL * PREVIEW_RATIO;

// ─── Simple IIR low-pass filter helper (currently inlined per-column) ─────────

// ─── Core waveform computation ────────────────────────────────────────────────

function computeColumns(samples) {
  const numCols = Math.floor(samples.length / SAMPLES_PER_COL);
  const numPreviewCols = Math.floor(samples.length / PREVIEW_SAMPLES_PER_COL);

  // PWV3: scroll waveform — 1 byte: (whiteness[0-7] << 5) | height[0-31]
  const pwv3 = Buffer.alloc(numCols);
  // PWV5: color scroll — 2 bytes: (blueH[5b] | blueW[1b] | redH[5b] | redW[1b]) packed u16be
  const pwv5 = Buffer.alloc(numCols * 2);
  // PWAV: preview — 1 byte: (whiteness << 5) | height, 100ms resolution
  const pwav = Buffer.alloc(numPreviewCols);

  for (let col = 0; col < numCols; col++) {
    const start = col * SAMPLES_PER_COL;
    const end = start + SAMPLES_PER_COL;

    let sumSq = 0;
    let peak = 0;
    let bassSum = 0;
    let trebleSum = 0;

    // Simple frequency split: bass = avg of abs values (low-pass approximation)
    // treble = high-frequency content = |sample| - smoothed bass
    let runningAvg = Math.abs(samples[start] || 0);

    for (let i = start; i < end; i++) {
      const s = samples[i] || 0;
      const abs = Math.abs(s);
      sumSq += s * s;
      if (abs > peak) peak = abs;

      // EMA low-pass (bass: alpha=0.1 → ~20ms cutoff)
      runningAvg = 0.1 * abs + 0.9 * runningAvg;
      bassSum += runningAvg;
      trebleSum += Math.max(0, abs - runningAvg);
    }

    const rms = Math.sqrt(sumSq / SAMPLES_PER_COL);
    const transientRatio = rms > 0.001 ? Math.min(peak / (rms + 0.001), 4) : 0;

    // PWV3 byte
    const height = Math.min(31, Math.round(rms * 62)); // 0–31
    const whiteness = Math.min(7, Math.round(transientRatio * 2)); // 0–7
    pwv3[col] = ((whiteness & 7) << 5) | (height & 31);

    // PWV5 u16be: bits 15-11=blueH, 10=blueW, 9-5=redH, 4=redW, 3-0=0
    const bassRms = Math.min(31, Math.round((bassSum / SAMPLES_PER_COL) * 124));
    const trebleRms = Math.min(31, Math.round((trebleSum / SAMPLES_PER_COL) * 124));
    const bW = whiteness > 3 ? 1 : 0;
    const rW = whiteness > 5 ? 1 : 0;
    const u16 =
      ((bassRms & 31) << 11) | ((bW & 1) << 10) | ((trebleRms & 31) << 5) | ((rW & 1) << 4);
    pwv5.writeUInt16BE(u16, col * 2);
  }

  // PWAV: lower resolution
  for (let col = 0; col < numPreviewCols; col++) {
    const start = col * PREVIEW_SAMPLES_PER_COL;
    const end = start + PREVIEW_SAMPLES_PER_COL;
    let sumSq = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i] || 0;
      sumSq += s * s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    const rms = Math.sqrt(sumSq / PREVIEW_SAMPLES_PER_COL);
    const transientRatio = rms > 0.001 ? Math.min(peak / (rms + 0.001), 4) : 0;
    const height = Math.min(31, Math.round(rms * 62));
    const whiteness = Math.min(7, Math.round(transientRatio * 2));
    pwav[col] = ((whiteness & 7) << 5) | (height & 31);
  }

  return { pwv3, pwv5, pwav, numCols, numPreviewCols };
}

// ─── ffmpeg PCM extraction ────────────────────────────────────────────────────

function extractPcm(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i',
      filePath,
      '-f',
      'f32le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-loglevel',
      'error',
      'pipe:1',
    ]);

    const chunks = [];
    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', () => {}); // suppress stderr
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      const raw = Buffer.concat(chunks);
      // Convert raw f32le bytes → Float32Array
      const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      resolve(floats);
    });
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate waveform data from an audio file.
 *
 * @param {string} filePath - Absolute path to the audio file
 * @returns {Promise<{pwv3: Buffer, pwv5: Buffer, pwav: Buffer, numCols: number, numPreviewCols: number}>}
 */
export async function generateWaveform(filePath) {
  const samples = await extractPcm(filePath);
  return computeColumns(samples);
}
