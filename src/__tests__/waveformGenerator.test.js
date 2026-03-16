import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Import after mocks
import { generateWaveform } from '../audio/waveformGenerator.js';
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
    expect(result).toHaveProperty('numCols');
    expect(result).toHaveProperty('numPreviewCols');
    expect(Buffer.isBuffer(result.pwv3)).toBe(true);
    expect(Buffer.isBuffer(result.pwv5)).toBe(true);
    expect(Buffer.isBuffer(result.pwav)).toBe(true);
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

  it('pwv3 has 1 byte per column', async () => {
    const numCols = 30;
    spawn.mockReturnValue(
      makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * numCols).fill(0.5)))
    );

    const result = await generateWaveform('/audio/test.mp3');

    expect(result.pwv3.length).toBe(numCols);
    expect(result.numCols).toBe(numCols);
  });

  it('pwv5 has 2 bytes per column', async () => {
    const numCols = 30;
    spawn.mockReturnValue(
      makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * numCols).fill(0.5)))
    );

    const result = await generateWaveform('/audio/test.mp3');

    expect(result.pwv5.length).toBe(numCols * 2);
  });

  it('pwav has 1/10th the columns of pwv3', async () => {
    const numCols = 100; // must be divisible by 10
    spawn.mockReturnValue(
      makeFakeProc(makeF32leBuffer(new Array(SAMPLES_PER_COL * numCols).fill(0.3)))
    );

    const result = await generateWaveform('/audio/test.mp3');

    expect(result.pwav.length).toBe(numCols / 10);
    expect(result.numPreviewCols).toBe(numCols / 10);
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
