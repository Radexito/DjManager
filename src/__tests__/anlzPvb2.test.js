import { describe, it, expect } from 'vitest';
import { parseFlacFrames, buildPvb2Section } from '../usb/pioneer/formats/anlz.js';

const CRC8 = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    table[i] = crc;
  }
  return table;
})();

/** Table-driven CRC-8 over a frame header, matching what the frame parser validates. */
function crc8(buf) {
  let crc = 0;
  for (const byte of buf) crc = CRC8[crc ^ byte];
  return crc;
}

/** One frame: 4 fixed header bytes, the frame number, its CRC-8, then fake body. */
function frame(number, blockCode = 10, bodyLength = 12) {
  const head = Buffer.from([0xff, 0xf8, (blockCode << 4) | 9, 0x18, number & 0x7f]);
  const crc = Buffer.from([crc8(head)]);
  return Buffer.concat([head, crc, Buffer.alloc(bodyLength, 0xaa)]);
}

/** Concatenates `count` fake frames so multi-frame scanning has something to walk. */
function frames(count, blockCode = 10, bodyLength = 12) {
  return Buffer.concat(Array.from({ length: count }, (_, i) => frame(i, blockCode, bodyLength)));
}

describe('parseFlacFrames', () => {
  it('finds every frame and its block size', () => {
    const buf = frames(5);
    const found = parseFlacFrames(buf, 0);
    expect(found).toHaveLength(5);
    expect(found.map((f) => f.blockSize)).toEqual([1024, 1024, 1024, 1024, 1024]);
    expect(found.map((f) => f.offset)).toEqual([0, 18, 36, 54, 72]);
  });

  it('rejects a sync pattern that is not a real frame', () => {
    const good = frame(0);
    const fake = Buffer.from([0xff, 0xf8, 0x90, 0x18, 0x01, 0x00, 0x00, 0x00]);
    const buf = Buffer.concat([good, fake, frame(1)]);
    const found = parseFlacFrames(buf, 0);
    expect(found).toHaveLength(2);
    expect(found[1].number).toBe(1);
  });

  it('reads a 4096 block code', () => {
    const found = parseFlacFrames(frames(2, 12), 0);
    expect(found.map((f) => f.blockSize)).toEqual([4096, 4096]);
  });

  it('returns nothing when there are no frames', () => {
    expect(parseFlacFrames(Buffer.alloc(64, 0x00), 0)).toEqual([]);
  });
});

describe('buildPvb2Section', () => {
  const info = (frameCount, blockSize = 1024) => ({
    blockSize,
    totalSamples: frameCount * blockSize,
    frames: parseFlacFrames(frames(frameCount, blockSize === 4096 ? 12 : 10), 0),
  });

  it('caps the entry count at 400 and keeps the header consistent', () => {
    const section = buildPvb2Section(info(1000));
    expect(section.toString('ascii', 0, 4)).toBe('PVB2');
    expect(section.readUInt32BE(4)).toBe(0x20);
    const count = section.readUInt32BE(0x18);
    expect(count).toBe(400);
    expect(section.length).toBe(0x20 + count * 0x14);
    expect(section.readUInt32BE(8)).toBe(section.length);
    expect(section.readUInt32BE(0x1c)).toBe(0x14);
    expect(Number(section.readBigUInt64BE(0x10))).toBe(1000 * 1024);
  });

  it('uses fewer entries than frames when the file is short', () => {
    const section = buildPvb2Section(info(100));
    expect(section.readUInt32BE(0x18)).toBe(100);
    expect(section.length).toBe(0x20 + 100 * 0x14);
  });

  it('starts at sample 0 and offset 0 and walks forward', () => {
    const section = buildPvb2Section(info(1000));
    const count = section.readUInt32BE(0x18);
    let lastSample = -1;
    let lastOffset = -1;
    for (let k = 0; k < count; k++) {
      const sample = Number(section.readBigUInt64BE(0x20 + k * 20));
      const offset = Number(section.readBigUInt64BE(0x20 + k * 20 + 8));
      const blockSize = section.readUInt32BE(0x20 + k * 20 + 16);
      expect(blockSize).toBe(1024);
      expect(sample % 1024).toBe(0);
      expect(sample).toBeGreaterThanOrEqual(lastSample);
      expect(offset).toBeGreaterThan(lastOffset);
      lastSample = sample;
      lastOffset = offset;
    }
    expect(Number(section.readBigUInt64BE(0x20))).toBe(0);
    expect(Number(section.readBigUInt64BE(0x20 + 8))).toBe(0);
  });

  it('applies step = total // count', () => {
    const section = buildPvb2Section(info(1000));
    const samples = [0, 1, 2, 3].map((k) => Number(section.readBigUInt64BE(0x20 + k * 20)));
    expect(samples).toEqual([0, 2048, 5120, 7168]);
  });
});
