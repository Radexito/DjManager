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

// Two-stage EMA cutoffs for frequency band separation (applied to |sample|).
// α ≈ 2π·f_c / f_s  →  0.03 ≈ 105 Hz (bass),  0.28 ≈ 980 Hz (bass+mid)
const ALPHA_BASS = 0.03;
const ALPHA_MID = 0.28;

// ─── Per-slice analysis ───────────────────────────────────────────────────────

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
  // PWV5: 2 bytes per col — RGB+height u16be per Pioneer/crate-digger spec:
  //   bits 15-13: red (treble, 3 bits)
  //   bits 12-10: green (mid,    3 bits)
  //   bits  9- 7: blue  (bass,   3 bits)
  //   bits  6- 2: height        (5 bits)
  //   bits  1- 0: unused
  const pwv5 = Buffer.alloc(numCols * 2);
  // PWV7: 3 bytes per col — [treble, mid, bass] each 0-255 (CDJ-3000 / .2EX)
  const pwv7 = Buffer.alloc(numCols * 3);

  // Carry EMA state across columns — critical for the bass channel where the
  // time constant (1/α_bass = 33 samples) is comparable to SAMPLES_PER_COL (147).
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
  //   byte 0: peak intensity  (peak * 255)          — confirmed from native files
  //   byte 1: complement      (255 - byte0)          — native avg b0+b1 ≈ 255
  //   byte 2: overall RMS     (rms * 510, capped)
  //   byte 3: bass energy     (0–105 Hz)
  //   byte 4: mid energy      (105–980 Hz)
  //   byte 5: treble energy   (>980 Hz)
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
  // pwv4 layout per column: [peak, 255-peak, rms, bass, mid, treble]
  const numCols = pwv4.length / 6;
  const out = Buffer.alloc(numCols * 4);
  for (let i = 0; i < numCols; i++) {
    out[i * 4 + 0] = pwv4[i * 6 + 2]; // rms
    out[i * 4 + 1] = pwv4[i * 6 + 3]; // bass
    out[i * 4 + 2] = pwv4[i * 6 + 4]; // mid
    out[i * 4 + 3] = pwv4[i * 6 + 5]; // treble
  }
  return out;
}
