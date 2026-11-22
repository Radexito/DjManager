import { spawn } from 'child_process';

/** Rate ffmpeg downsamples to for the waveform pass: enough for a column every 6.7 ms. */
const SAMPLE_RATE = 22050;
/** Scroll-waveform columns per second (PWV3/PWV5/PWV7): one column every ~6.7 ms. */
const COLS_PER_SEC = 150;
const SAMPLES_PER_COL = Math.round(SAMPLE_RATE / COLS_PER_SEC);

/** Column rate of the hires detail waveform (#262): four times the export rate, for the zoomed detail view. */
const COLS_PER_SEC_HIRES = 600;
const SAMPLES_PER_COL_HIRES = Math.round(SAMPLE_RATE / COLS_PER_SEC_HIRES);

/** Columns in the PWAV preview strip — fixed by the format, not by the track length. */
export const PWAV_COLS = 400;
/** Columns in the PWV2 overview — fixed by the format that CDJ-900 generation reads. */
export const PWV2_COLS = 100;
/** Columns in the PWV4 overview, each six bytes, so the section body is always 7200 bytes. */
export const PWV4_COLS = 1200;
/** Columns in the PWV6 overview, each three bytes, so the section body is always 3600 bytes. */
export const PWV6_COLS = 1200;

/** Smoothing of the first low-pass on |sample|; at 22 kHz its corner sits near the 105 Hz that separates bass from mid. */
const ALPHA_BASS = 0.03;
/** Smoothing of the second low-pass; its ~1 kHz corner is where mid ends, and the gap between the two EMAs is the mid band. */
const ALPHA_MID = 0.28;

/**
 * Compute RMS, peak, and approximate frequency-band energies for a sample slice.
 * Uses two cascaded EMA low-pass filters on |sample| to separate bass/mid/treble.
 *   bass   ≈ 0–105 Hz  (EMA α=0.03)
 *   mid    ≈ 105–980 Hz (difference of the two EMAs)
 *   treble ≈ >980 Hz   (residual above upper EMA)
 *
 * For per-column overview segments (thousands of samples) the EMA settles fully
 * within the slice, so initialising from the first sample is accurate enough.
 */
function analyzeSlice(samples, start, end) {
  const len = end - start;
  if (len === 0) return { rms: 0, peak: 0, bassRms: 0, midRms: 0, trebleRms: 0 };

  let sumSq = 0;
  let peak = 0;
  let bassSum = 0;
  let midSum = 0;
  let trebleSum = 0;
  let emaBass = Math.abs(samples[start] || 0);
  let emaMid = emaBass;

  for (let i = start; i < end; i++) {
    const s = samples[i] || 0;
    const abs = Math.abs(s);
    sumSq += s * s;
    if (abs > peak) peak = abs;
    emaBass = ALPHA_BASS * abs + (1 - ALPHA_BASS) * emaBass;
    emaMid = ALPHA_MID * abs + (1 - ALPHA_MID) * emaMid;
    bassSum += emaBass;
    midSum += Math.max(0, emaMid - emaBass);
    trebleSum += Math.max(0, abs - emaMid);
  }

  return {
    rms: Math.sqrt(sumSq / len),
    peak,
    bassRms: bassSum / len,
    midRms: midSum / len,
    trebleRms: trebleSum / len,
  };
}

/** PWV3/PWAV/PWV2 mono encoding helpers */
function monoHeightWhiteness(rms, peak) {
  const transientRatio = rms > 0.001 ? Math.min(peak / (rms + 0.001), 4) : 0;
  const height = Math.min(31, Math.round(rms * 62));
  const whiteness = Math.min(7, Math.round(transientRatio * 2));
  return { height, whiteness };
}

/**
 * Compute fixed-size overview columns by evenly dividing the full sample array.
 * colFn(samples, start, end) → value (number or Buffer)
 */
function computeFixedColumns(samples, numCols, colFn) {
  const step = samples.length / numCols;
  const out = [];
  for (let col = 0; col < numCols; col++) {
    const start = Math.floor(col * step);
    const end = Math.max(Math.floor((col + 1) * step), start + 1);
    out.push(colFn(samples, start, end));
  }
  return out;
}

/**
 * One pass over the samples that fills every scroll waveform (pwv3, pwv5, pwv7)
 * and the fixed-size overviews (pwav, pwv2, pwv4, pwv6).
 * @param {Float32Array} samples - mono samples at SAMPLE_RATE
 * @returns {{pwv3: Buffer, pwv5: Buffer, pwv7: Buffer, pwav: Buffer, pwv2: Buffer,
 *            pwv4: Buffer, pwv6: Buffer, numCols: number, totalSamples: number}}
 *          columns at COLS_PER_SEC; `totalSamples` is the decoded sample count,
 *          which the ANLZ PVBR trailer carries.
 */
function computeColumns(samples) {
  const numCols = Math.floor(samples.length / SAMPLES_PER_COL);

  const pwv3 = Buffer.alloc(numCols);
  const pwv5 = Buffer.alloc(numCols * 2);
  const pwv7 = Buffer.alloc(numCols * 3);

  let emaBass = 0;
  let emaMid = 0;

  for (let col = 0; col < numCols; col++) {
    const start = col * SAMPLES_PER_COL;
    let sumSq = 0;
    let peak = 0;
    let bassSum = 0;
    let midSum = 0;
    let trebleSum = 0;

    for (let i = start; i < start + SAMPLES_PER_COL; i++) {
      const s = samples[i] || 0;
      const abs = Math.abs(s);
      sumSq += s * s;
      if (abs > peak) peak = abs;
      emaBass = ALPHA_BASS * abs + (1 - ALPHA_BASS) * emaBass;
      emaMid = ALPHA_MID * abs + (1 - ALPHA_MID) * emaMid;
      bassSum += emaBass;
      midSum += Math.max(0, emaMid - emaBass);
      trebleSum += Math.max(0, abs - emaMid);
    }

    const rms = Math.sqrt(sumSq / SAMPLES_PER_COL);
    const bassRms = bassSum / SAMPLES_PER_COL;
    const midRms = midSum / SAMPLES_PER_COL;
    const trebleRms = trebleSum / SAMPLES_PER_COL;

    const { height, whiteness } = monoHeightWhiteness(rms, peak);
    pwv3[col] = ((whiteness & 7) << 5) | (height & 31);

    const r = Math.min(7, Math.round(trebleRms * 28));
    const g = Math.min(7, Math.round(midRms * 28));
    const b = Math.min(7, Math.round(bassRms * 28));
    pwv5.writeUInt16BE(
      ((r & 7) << 13) | ((g & 7) << 10) | ((b & 7) << 7) | ((height & 31) << 2),
      col * 2
    );

    pwv7[col * 3 + 0] = Math.min(255, Math.round(trebleRms * 510));
    pwv7[col * 3 + 1] = Math.min(255, Math.round(midRms * 510));
    pwv7[col * 3 + 2] = Math.min(255, Math.round(bassRms * 510));
  }

  const pwav = Buffer.from(
    computeFixedColumns(samples, PWAV_COLS, (s, a, b) => {
      const { rms, peak } = analyzeSlice(s, a, b);
      const { height, whiteness } = monoHeightWhiteness(rms, peak);
      return ((whiteness & 7) << 5) | (height & 31);
    })
  );

  const pwv2 = Buffer.from(
    computeFixedColumns(samples, PWV2_COLS, (s, a, b) => {
      const { rms } = analyzeSlice(s, a, b);
      return Math.min(15, Math.round(rms * 31)) & 0x0f;
    })
  );

  const pwv4 = Buffer.concat(
    computeFixedColumns(samples, PWV4_COLS, (s, a, b) => {
      const { rms, peak, bassRms, midRms, trebleRms } = analyzeSlice(s, a, b);
      const peakByte = Math.min(255, Math.round(peak * 255));
      return Buffer.from([
        peakByte,
        255 - peakByte,
        Math.min(255, Math.round(rms * 510)),
        Math.min(255, Math.round(bassRms * 510)),
        Math.min(255, Math.round(midRms * 510)),
        Math.min(255, Math.round(trebleRms * 510)),
      ]);
    })
  );

  const pwv6 = Buffer.concat(
    computeFixedColumns(samples, PWV6_COLS, (s, a, b) => {
      const { bassRms, midRms, trebleRms } = analyzeSlice(s, a, b);
      return Buffer.from([
        Math.min(255, Math.round(trebleRms * 510)),
        Math.min(255, Math.round(midRms * 510)),
        Math.min(255, Math.round(bassRms * 510)),
      ]);
    })
  );

  // The waveform samples are decoded at SAMPLE_RATE; the PVBR trailer carries the
  // count at the file's own 44.1 kHz, so scale it back up (rekordbox's own value is
  // this count plus the encoder padding, within 0.01%).
  const totalSamples = Math.round((samples.length * 44100) / SAMPLE_RATE);
  return { pwv3, pwv5, pwav, pwv2, pwv4, pwv6, pwv7, numCols, totalSamples };
}

/**
 * Compute a pwv7-style scroll waveform (3 bytes/col: treble, mid, bass, each
 * 0-255) at an arbitrary columns-per-second rate. Shares the EMA band-split
 * logic used inside computeColumns() for the 150 cols/sec pwv7 buffer, but is
 * factored out so it can also drive the 600 cols/sec hires detail buffer
 * (#262) without duplicating the whole computeColumns() pass (pwv3/pwv5/etc.
 * are export-only and always stay at COLS_PER_SEC).
 */
function computePwv7AtRate(samples, samplesPerCol) {
  const numCols = Math.floor(samples.length / samplesPerCol);
  const pwv7 = Buffer.alloc(numCols * 3);

  let emaBass = 0;
  let emaMid = 0;

  for (let col = 0; col < numCols; col++) {
    const start = col * samplesPerCol;
    let bassSum = 0;
    let midSum = 0;
    let trebleSum = 0;

    for (let i = start; i < start + samplesPerCol; i++) {
      const s = samples[i] || 0;
      const abs = Math.abs(s);
      emaBass = ALPHA_BASS * abs + (1 - ALPHA_BASS) * emaBass;
      emaMid = ALPHA_MID * abs + (1 - ALPHA_MID) * emaMid;
      bassSum += emaBass;
      midSum += Math.max(0, emaMid - emaBass);
      trebleSum += Math.max(0, abs - emaMid);
    }

    const bassRms = bassSum / samplesPerCol;
    const midRms = midSum / samplesPerCol;
    const trebleRms = trebleSum / samplesPerCol;

    pwv7[col * 3 + 0] = Math.min(255, Math.round(trebleRms * 510));
    pwv7[col * 3 + 1] = Math.min(255, Math.round(midRms * 510));
    pwv7[col * 3 + 2] = Math.min(255, Math.round(bassRms * 510));
  }

  return { pwv7, numCols };
}

/**
 * Decode a file to mono float32 at SAMPLE_RATE by piping ffmpeg's raw output, so
 * nothing has to be written to disk.
 * @param {string} filePath
 * @param {string} [ffmpegBin='ffmpeg']
 * @returns {Promise<Float32Array>}
 */
function extractPcm(filePath, ffmpegBin = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, [
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
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      const raw = Buffer.concat(chunks);
      const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      resolve(floats);
    });
  });
}

/**
 * Generate waveform data from an audio file.
 *
 * Returns scroll waveforms (variable-length, 150 cols/sec) and fixed-size overviews:
 *   pwv3  — monochrome scroll (1 byte/col)
 *   pwv5  — RGB+height colour scroll (2 bytes/col, u16be)
 *   pwv7  — RGB colour scroll for .2EX (3 bytes/col: treble,mid,bass each 0-255)
 *   pwav  — monochrome overview, always PWAV_COLS (400) bytes
 *   pwv2  — tiny monochrome overview, always PWV2_COLS (100) bytes
 *   pwv4  — colour overview, always PWV4_COLS×6 (7200) bytes
 *   pwv6  — colour overview for .2EX, always PWV6_COLS×3 (3600) bytes
 *   numCols — number of scroll columns
 *
 * @param {string} filePath - Absolute path to the audio file
 * @returns {Promise<{pwv3: Buffer, pwv5: Buffer, pwav: Buffer, pwv2: Buffer, pwv4: Buffer, numCols: number}>}
 */
export async function generateWaveform(filePath, ffmpegBin = 'ffmpeg') {
  const samples = await extractPcm(filePath, ffmpegBin);
  return computeColumns(samples);
}

/**
 * Generate waveform data optimised for the Beat Grid Editor UI.
 *
 * Returns:
 *   detail       — pwv7 scroll waveform (3 bytes/col: treble, mid, bass each 0-255)
 *                  at COLS_PER_SEC (150) columns per second (variable length) —
 *                  kept for backwards compat / fast overview reads
 *   detailHires  — pwv7-style scroll waveform at COLS_PER_SEC_HIRES (600)
 *                  columns per second, for sharp rendering at high zoom (#262)
 *   overview     — 4 bytes/col × PWV4_COLS cols [rms, bass, mid, treble] each 0-255
 *                  for the full-track navigation strip
 *   numCols      — number of `detail` columns
 *   numColsHires — number of `detailHires` columns
 *   colsPerSec      — COLS_PER_SEC (150)
 *   colsPerSecHires — COLS_PER_SEC_HIRES (600)
 */
export async function generateEditorWaveform(filePath, ffmpegBin = 'ffmpeg') {
  const samples = await extractPcm(filePath, ffmpegBin);
  const { pwv7, pwv4, numCols } = computeColumns(samples);
  const { pwv7: detailHires, numCols: numColsHires } = computePwv7AtRate(
    samples,
    SAMPLES_PER_COL_HIRES
  );

  const overview = Buffer.alloc(PWV4_COLS * 4);
  for (let i = 0; i < PWV4_COLS; i++) {
    overview[i * 4 + 0] = pwv4[i * 6 + 2];
    overview[i * 4 + 1] = pwv4[i * 6 + 3];
    overview[i * 4 + 2] = pwv4[i * 6 + 4];
    overview[i * 4 + 3] = pwv4[i * 6 + 5];
  }
  return {
    detail: pwv7,
    detailHires,
    overview,
    numCols,
    numColsHires,
    colsPerSec: COLS_PER_SEC,
    colsPerSecHires: COLS_PER_SEC_HIRES,
  };
}

/**
 * Generate a compact waveform overview suitable for in-app seek bar rendering.
 *
 * Returns a flat Buffer of PWV4_COLS (1200) columns × 4 bytes each:
 *   [rms, bass, mid, treble] per column, each 0-255.
 *
 * Supports all color modes (Classic / RGB / 3-Band) in the renderer.
 * Total size: 4 800 bytes per track.
 */
export async function generateWaveformOverview(filePath, ffmpegBin = 'ffmpeg') {
  const samples = await extractPcm(filePath, ffmpegBin);
  const { pwv4 } = computeColumns(samples);
  const numCols = pwv4.length / 6;

  const bassArr = new Array(numCols);
  const midArr = new Array(numCols);
  const trebleArr = new Array(numCols);
  for (let i = 0; i < numCols; i++) {
    bassArr[i] = pwv4[i * 6 + 3];
    midArr[i] = pwv4[i * 6 + 4];
    trebleArr[i] = pwv4[i * 6 + 5];
  }

  const p95 = (arr) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] || 1;
  };
  const maxBass = p95(bassArr);
  const maxMid = p95(midArr);
  const maxTreble = p95(trebleArr);

  const out = Buffer.alloc(numCols * 4);
  for (let i = 0; i < numCols; i++) {
    out[i * 4 + 0] = pwv4[i * 6 + 2];
    out[i * 4 + 1] = Math.min(255, Math.round((bassArr[i] / maxBass) * 220));
    out[i * 4 + 2] = Math.min(255, Math.round((midArr[i] / maxMid) * 220));
    out[i * 4 + 3] = Math.min(255, Math.round((trebleArr[i] / maxTreble) * 220));
  }
  return out;
}
