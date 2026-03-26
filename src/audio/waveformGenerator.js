import { spawn } from 'child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 22050; // Hz — sufficient for waveform resolution
const COLS_PER_SEC = 150; // native Rekordbox scroll waveform resolution (confirmed)
const SAMPLES_PER_COL = Math.round(SAMPLE_RATE / COLS_PER_SEC); // 147 samples/col

// Fixed-size preview waveform column counts (per Pioneer/rekordcrate spec)
export const PWAV_COLS = 400; // PWAV: overview waveform (touch strip)
export const PWV2_COLS = 100; // PWV2: tiny overview (CDJ-900)
export const PWV4_COLS = 1200; // PWV4: colour overview (NXS2), 6 bytes/col
export const PWV6_COLS = 1200; // PWV6: colour overview for 2EX (CDJ-3000), 3 bytes/col

// ─── Per-slice analysis ───────────────────────────────────────────────────────

/**
 * Compute RMS, peak, and approximate frequency-band energies for a sample slice.
 * Uses a two-stage IIR to separate bass (<~500 Hz) from treble (>~2 kHz).
 */
function analyzeSlice(samples, start, end) {
  const len = end - start;
  if (len === 0) return { rms: 0, peak: 0, bassRms: 0, midRms: 0, trebleRms: 0 };

  let sumSq = 0;
  let peak = 0;
  let bassSum = 0;
  let trebleSum = 0;
  // EMA low-pass: alpha=0.1 approximates a ~450 Hz cutoff at 22050 Hz
  let ema = Math.abs(samples[start] || 0);

  for (let i = start; i < end; i++) {
    const s = samples[i] || 0;
    const abs = Math.abs(s);
    sumSq += s * s;
    if (abs > peak) peak = abs;
    ema = 0.1 * abs + 0.9 * ema;
    bassSum += ema;
    trebleSum += Math.max(0, abs - ema);
  }

  const rms = Math.sqrt(sumSq / len);
  const bassRms = bassSum / len;
  const trebleRms = trebleSum / len;
  // Mid is energy that sits between bass and treble approximations
  const midRms = Math.max(0, rms - bassRms - trebleRms * 0.5);

  return { rms, peak, bassRms, midRms, trebleRms };
}

// ─── Column encoders ──────────────────────────────────────────────────────────

/** PWV3/PWAV/PWV2 mono encoding helpers */
function monoHeightWhiteness(rms, peak) {
  const transientRatio = rms > 0.001 ? Math.min(peak / (rms + 0.001), 4) : 0;
  const height = Math.min(31, Math.round(rms * 62));
  const whiteness = Math.min(7, Math.round(transientRatio * 2));
  return { height, whiteness };
}

// ─── Core waveform computation ────────────────────────────────────────────────

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

function computeColumns(samples) {
  // ── Scroll waveforms (variable length, 150 cols/sec = ~6.67 ms/col) ─────
  const numCols = Math.floor(samples.length / SAMPLES_PER_COL);

  // PWV3: 1 byte per col — (whiteness[0-7] << 5) | height[0-31]
  const pwv3 = Buffer.alloc(numCols);
  // PWV5: 2 bytes per col — correct RGB+height u16be per Pioneer/crate-digger spec:
  //   bits 15-13: red (treble, 3 bits)
  //   bits 12-10: green (mid,    3 bits)
  //   bits  9- 7: blue  (bass,   3 bits)
  //   bits  6- 2: height        (5 bits)
  //   bits  1- 0: unused
  const pwv5 = Buffer.alloc(numCols * 2);
  // PWV7: 3 bytes per col — [treble, mid, bass] each 0-255 (CDJ-3000 / .2EX)
  const pwv7 = Buffer.alloc(numCols * 3);

  for (let col = 0; col < numCols; col++) {
    const start = col * SAMPLES_PER_COL;
    const { rms, peak, bassRms, midRms, trebleRms } = analyzeSlice(
      samples,
      start,
      start + SAMPLES_PER_COL
    );
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

  // ── Fixed-size overview waveforms ─────────────────────────────────────────

  // PWAV: 400 bytes — (whiteness << 5) | height  (same encoding as PWV3)
  const pwav = Buffer.from(
    computeFixedColumns(samples, PWAV_COLS, (s, a, b) => {
      const { rms, peak } = analyzeSlice(s, a, b);
      const { height, whiteness } = monoHeightWhiteness(rms, peak);
      return ((whiteness & 7) << 5) | (height & 31);
    })
  );

  // PWV2: 100 bytes — 4-bit height only (byte = height & 0x0F, range 0-15)
  const pwv2 = Buffer.from(
    computeFixedColumns(samples, PWV2_COLS, (s, a, b) => {
      const { rms } = analyzeSlice(s, a, b);
      return Math.min(15, Math.round(rms * 31)) & 0x0f;
    })
  );

  // PWV4: 1200 × 6 bytes — colour overview (NXS2)
  //   byte 0: whiteness/brightness indicator
  //   byte 1: whiteness/brightness indicator
  //   byte 2: energy_bottom_half_freq  (overall RMS, < ~10 kHz)
  //   byte 3: energy_bottom_third_freq (bass, < ~3.5 kHz)
  //   byte 4: energy_mid_third_freq    (mid,  3.5–7 kHz)
  //   byte 5: energy_top_third_freq    (treble, > 7 kHz)
  const pwv4 = Buffer.concat(
    computeFixedColumns(samples, PWV4_COLS, (s, a, b) => {
      const { rms, peak, bassRms, midRms, trebleRms } = analyzeSlice(s, a, b);
      const transientRatio = rms > 0.001 ? Math.min(peak / (rms + 0.001), 4) : 0;
      const whiteness = Math.min(255, Math.round(transientRatio * 64));
      return Buffer.from([
        whiteness,
        whiteness,
        Math.min(255, Math.round(rms * 510)),
        Math.min(255, Math.round(bassRms * 510)),
        Math.min(255, Math.round(midRms * 510)),
        Math.min(255, Math.round(trebleRms * 510)),
      ]);
    })
  );

  // PWV6: 1200 × 3 bytes — colour overview for .2EX (CDJ-3000)
  //   byte 0: treble energy (0-255)
  //   byte 1: mid energy    (0-255)
  //   byte 2: bass energy   (0-255)
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

  return { pwv3, pwv5, pwav, pwv2, pwv4, pwv6, pwv7, numCols };
}

// ─── ffmpeg PCM extraction ────────────────────────────────────────────────────

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
