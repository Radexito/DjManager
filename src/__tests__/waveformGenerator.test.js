import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Import after mocks
import { generateWaveform, PWAV_COLS, PWV2_COLS, PWV4_COLS } from '../audio/waveformGenerator.js';
import { spawn } from 'child_process';

// ── Helpers ───────────────────────────────────────────────────────────────────

// 22050 Hz * 10 ms / 1000 = 220.5 → Math.round → 221 samples per column (matches waveformGenerator.js)
const SAMPLES_PER_COL = Math.round((22050 * 10) / 1000); // 221

/** Convert a JS number array (float32 values) to a raw Buffer as f32le */
function makeF32leBuffer(floatValues) {
  const buf = Buffer.allocUnsafe(floatValues.length * 4);
  for (let i = 0; i < floatValues.length; i++) {
    buf.writeFloatLE(floatValues[i], i * 4);
  }
  return buf;
}

/** Create a fake child process that emits pcmBuffer on stdout then closes */
function makeFakeProc(pcmBuffer, exitCode = 0) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  setImmediate(() => {
    if (pcmBuffer && pcmBuffer.length > 0) proc.stdout.emit('data', pcmBuffer);
    proc.emit('close', exitCode);
  });

  return proc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateWaveform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the expected result shape', async () => {
    const sampleCount = SAMPLES_PER_COL * 50;
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(sampleCount).fill(0))));

    const result = await generateWaveform('/audio/test.mp3');

    expect(result).toHaveProperty('pwv3');
    expect(result).toHaveProperty('pwv5');
    expect(result).toHaveProperty('pwav');
    expect(result).toHaveProperty('pwv2');
    expect(result).toHaveProperty('pwv4');
    expect(result).toHaveProperty('numCols');
    expect(Buffer.isBuffer(result.pwv3)).toBe(true);
    expect(Buffer.isBuffer(result.pwv5)).toBe(true);
    expect(Buffer.isBuffer(result.pwav)).toBe(true);
    expect(Buffer.isBuffer(result.pwv2)).toBe(true);
    expect(Buffer.isBuffer(result.pwv4)).toBe(true);
  });

  it('silent audio (all zeros) produces zero heights in pwv3', async () => {
    const sampleCount = SAMPLES_PER_COL * 20;
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(sampleCount).fill(0))));

    const result = await generateWaveform('/audio/silent.mp3');

    for (let i = 0; i < result.pwv3.length; i++) {
      expect(result.pwv3[i] & 31).toBe(0);
    }
  });

  it('loud audio (1.0 samples) produces non-zero heights in pwv3', async () => {
    const sampleCount = SAMPLES_PER_COL * 20;
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(sampleCount).fill(1.0))));

    const result = await generateWaveform('/audio/loud.mp3');

    const maxHeight = Math.max(...Array.from(result.pwv3).map((b) => b & 31));
    expect(maxHeight).toBeGreaterThan(0);
  });

  it('pwv3 has 1 byte per scroll column', async () => {
    const numCols = 30;
    spawn.mockReturnValue(
      makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * numCols).fill(0.5)))
    );

    const result = await generateWaveform('/audio/test.mp3');

    expect(result.pwv3.length).toBe(numCols);
    expect(result.numCols).toBe(numCols);
  });

  it('pwv5 has 2 bytes per scroll column', async () => {
    const numCols = 30;
    spawn.mockReturnValue(
      makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * numCols).fill(0.5)))
    );

    const result = await generateWaveform('/audio/test.mp3');

    expect(result.pwv5.length).toBe(numCols * 2);
  });

  it('pwav is always exactly PWAV_COLS (400) bytes regardless of track length', async () => {
    // Short track
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * 10).fill(0.3))));
    const short = await generateWaveform('/audio/short.mp3');
    expect(short.pwav.length).toBe(PWAV_COLS);

    // Long track
    spawn.mockReturnValue(
      makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * 500).fill(0.3)))
    );
    const long = await generateWaveform('/audio/long.mp3');
    expect(long.pwav.length).toBe(PWAV_COLS);
  });

  it('pwv2 is always exactly PWV2_COLS (100) bytes', async () => {
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * 50).fill(0.5))));

    const result = await generateWaveform('/audio/test.mp3');

    expect(result.pwv2.length).toBe(PWV2_COLS);
  });

  it('pwv2 bytes are in 4-bit height range (0-15)', async () => {
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * 50).fill(0.5))));

    const result = await generateWaveform('/audio/test.mp3');

    for (let i = 0; i < result.pwv2.length; i++) {
      expect(result.pwv2[i]).toBeGreaterThanOrEqual(0);
      expect(result.pwv2[i]).toBeLessThanOrEqual(15);
    }
  });

  it('pwv4 is always exactly PWV4_COLS × 6 (7200) bytes', async () => {
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * 50).fill(0.5))));

    const result = await generateWaveform('/audio/test.mp3');

    expect(result.pwv4.length).toBe(PWV4_COLS * 6);
  });

  it('pwv5 RGB+height encoding: u16be bits (r:3|g:3|b:3|h:5|unused:2)', async () => {
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * 10).fill(0.5))));

    const result = await generateWaveform('/audio/test.mp3');

    for (let i = 0; i < result.numCols; i++) {
      const u16 = result.pwv5.readUInt16BE(i * 2);
      const r = (u16 >> 13) & 7;
      const g = (u16 >> 10) & 7;
      const b = (u16 >> 7) & 7;
      const h = (u16 >> 2) & 31;
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(7);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(7);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(31);
      // unused bits must be zero
      expect(u16 & 0x3).toBe(0);
    }
  });

  it('pwv3 byte encoding: (whiteness << 5) | height', async () => {
    const sampleCount = SAMPLES_PER_COL * 10;
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(sampleCount).fill(0.5))));

    const result = await generateWaveform('/audio/test.mp3');

    for (let i = 0; i < result.pwv3.length; i++) {
      const height = result.pwv3[i] & 31;
      const whiteness = (result.pwv3[i] >> 5) & 7;
      expect(height).toBeGreaterThanOrEqual(0);
      expect(height).toBeLessThanOrEqual(31);
      expect(whiteness).toBeGreaterThanOrEqual(0);
      expect(whiteness).toBeLessThanOrEqual(7);
    }
  });

  it('silent audio produces zero heights in pwv2', async () => {
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * 20).fill(0))));

    const result = await generateWaveform('/audio/silent.mp3');

    for (let i = 0; i < result.pwv2.length; i++) {
      expect(result.pwv2[i]).toBe(0);
    }
  });

  it('calls ffmpeg spawn with the provided file path', async () => {
    const sampleCount = SAMPLES_PER_COL * 5;
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(sampleCount).fill(0))));

    await generateWaveform('/audio/mytrack.flac');

    expect(spawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['/audio/mytrack.flac']));
  });

  it('calls ffmpeg with f32le output format', async () => {
    const sampleCount = SAMPLES_PER_COL * 5;
    spawn.mockReturnValue(makeFakeProc(makeF32leBuffer(new Array(sampleCount).fill(0))));

    await generateWaveform('/audio/test.mp3');

    expect(spawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-f', 'f32le']));
  });

  it('rejects when ffmpeg exits non-zero with no output', async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => proc.emit('close', 1));
    spawn.mockReturnValue(proc);

    await expect(generateWaveform('/audio/bad.mp3')).rejects.toThrow();
  });

  it('handles multiple data chunks from stdout', async () => {
    const halfCount = SAMPLES_PER_COL * 10;
    const chunk1 = makeF32leBuffer(new Array(halfCount).fill(0.2));
    const chunk2 = makeF32leBuffer(new Array(halfCount).fill(0.3));

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => {
      proc.stdout.emit('data', chunk1);
      proc.stdout.emit('data', chunk2);
      proc.emit('close', 0);
    });
    spawn.mockReturnValue(proc);

    const result = await generateWaveform('/audio/chunked.mp3');

    expect(result.numCols).toBe(20);
  });
});
