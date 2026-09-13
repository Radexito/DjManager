import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  supportsMp4Tags,
  readMp4Tags,
  patchMp4Tags,
  writeMp4Tags,
  buildFreeformItem,
  INITIALKEY_MEAN,
  INITIALKEY_NAME,
} from '../audio/mp4Tags.js';

// ── Synthetic but structurally valid MP4 ─────────────────────────────────────
// ftyp + moov(trak.mdia.minf.stbl[stco], udta.meta[hqlr, ilst]) + mdat, so the
// same code paths as a real file run: box walking, ancestor size bumps and the
// stco shift that a moov-before-mdat file needs.

function box(tag, ...parts) {
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(8 + body.length, 0);
  out.write(tag, 4, 'latin1');
  body.copy(out, 8);
  return out;
}

function textItem(tag, value) {
  const data = Buffer.concat([Buffer.alloc(8), Buffer.from(value, 'utf8')]);
  const dataBox = Buffer.alloc(8 + data.length);
  dataBox.writeUInt32BE(8 + data.length, 0);
  dataBox.write('data', 4, 'latin1');
  data.copy(dataBox, 8);
  return box(tag, dataBox);
}

function intItem(tag, value) {
  const data = Buffer.concat([Buffer.alloc(8), Buffer.from([(value >> 8) & 0xff, value & 0xff])]);
  const dataBox = Buffer.alloc(8 + data.length);
  dataBox.writeUInt32BE(8 + data.length, 0);
  dataBox.write('data', 4, 'latin1');
  data.copy(dataBox, 8);
  return box(tag, dataBox);
}

function makeMp4({ moovFirst = true, tmpo = null, initialKey = null, withArtwork = true } = {}) {
  const items = [textItem('\u00a9nam', 'Old Title'), textItem('\u00a9ART', 'Old Artist')];
  if (withArtwork) items.push(textItem('covr', 'x'.repeat(120)));
  if (tmpo != null) items.push(intItem('tmpo', tmpo));
  if (initialKey) items.push(buildFreeformItem(INITIALKEY_MEAN, INITIALKEY_NAME, initialKey));

  const hdlr = box('hdlr', Buffer.alloc(25));
  const ilst = box('ilst', ...items);
  const meta = box('meta', Buffer.alloc(4), hdlr, ilst);
  const udta = box('udta', meta);

  const stco = box(
    'stco',
    Buffer.alloc(4),
    (() => {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(2, 0);
      return c;
    })(),
    (() => {
      const o = Buffer.alloc(8);
      o.writeUInt32BE(1000, 0);
      o.writeUInt32BE(2000, 4);
      return o;
    })()
  );
  const stbl = box('stbl', stco);
  const minf = box('minf', stbl);
  const mdia = box('mdia', minf);
  const trak = box('trak', mdia);
  const moov = box('moov', trak, udta);
  const mdat = box('mdat', Buffer.alloc(64, 0xab));
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'));

  return moovFirst ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov]);
}

/** Every stco offset, plus the total number of bytes the ilst holds. */
function stcoOffsets(buf) {
  const i = buf.indexOf(Buffer.from('stco', 'latin1'));
  const count = buf.readUInt32BE(i + 8);
  const out = [];
  for (let k = 0; k < count; k += 1) out.push(buf.readUInt32BE(i + 12 + 4 * k));
  return out;
}

/** Walk the tree and fail loudly on any inconsistent box. */
function assertBoxesValid(buf, start = 0, end = buf.length) {
  let i = start;
  while (i + 8 <= end) {
    const size = buf.readUInt32BE(i);
    const tag = buf.toString('latin1', i + 4, i + 8);
    if (size < 8 || i + size > end) throw new Error(`broken box ${tag} size=${size} at ${i}`);
    if (['moov', 'udta', 'meta', 'ilst', 'trak', 'mdia', 'minf', 'stbl'].includes(tag)) {
      assertBoxesValid(buf, i + 8 + (tag === 'meta' ? 4 : 0), i + size);
    }
    i += size;
  }
}

describe('mp4Tags — reading', () => {
  it('reads bpm and the freeform INITIALKEY item', () => {
    const buf = makeMp4({ tmpo: 146, initialKey: '9B' });
    expect(readMp4Tags(buf)).toEqual({ bpm: 146, key: '9B' });
  });

  it('returns nulls when the file has neither', () => {
    expect(readMp4Tags(makeMp4())).toEqual({ bpm: null, key: null });
  });

  it('ignores other freeform items (UPC, lyrics)', () => {
    const buf = Buffer.concat([
      makeMp4({ tmpo: 120 }),
      buildFreeformItem('com.apple.iTunes', 'UPC', '5054284715865'),
    ]);
    // the extra item sits outside ilst, so it must not be picked up as the key
    expect(readMp4Tags(buf).key).toBeNull();
  });
});

describe('mp4Tags — patching', () => {
  it('inserts tmpo and the key item, preserving everything else', () => {
    const src = makeMp4();
    const { buffer, inserted, replaced } = patchMp4Tags(src, { bpm: 128, key: '9B' });

    expect(inserted).toBe(2);
    expect(replaced).toBe(0);
    expect(readMp4Tags(buffer)).toEqual({ bpm: 128, key: '9B' });
    expect(buffer.toString('latin1')).toContain('Old Title');
    expect(buffer.toString('latin1')).toContain('Old Artist');
    expect(buffer.length).toBeGreaterThan(src.length);
    expect(() => assertBoxesValid(buffer)).not.toThrow();
  });

  it('replaces an existing tmpo instead of adding a second one', () => {
    const src = makeMp4({ tmpo: 146 });
    const { buffer, replaced } = patchMp4Tags(src, { bpm: 128 });
    expect(replaced).toBe(1);
    const matches = buffer.toString('latin1').split('tmpo').length - 1;
    expect(matches).toBe(1);
    expect(readMp4Tags(buffer).bpm).toBe(128);
  });

  it('replaces an existing INITIALKEY item instead of duplicating it', () => {
    const src = makeMp4({ initialKey: '9B' });
    const { buffer } = patchMp4Tags(src, { key: '12A' });
    expect(buffer.toString('latin1').split(INITIALKEY_NAME).length - 1).toBe(1);
    expect(readMp4Tags(buffer).key).toBe('12A');
  });

  it('shifts every stco chunk offset when moov sits before mdat', () => {
    const src = makeMp4({ moovFirst: true });
    const before = stcoOffsets(src);
    const { buffer, chunkOffsetsPatched } = patchMp4Tags(src, { bpm: 128, key: '9B' });
    const after = stcoOffsets(buffer);

    const delta = buffer.length - src.length;
    expect(chunkOffsetsPatched).toBe(2);
    expect(delta).toBeGreaterThan(0);
    expect(after).toEqual(before.map((offset) => offset + delta));
  });

  it('leaves chunk offsets alone when mdat comes first', () => {
    const src = makeMp4({ moovFirst: false });
    const before = stcoOffsets(src);
    const { buffer, chunkOffsetsPatched } = patchMp4Tags(src, { bpm: 128, key: '9B' });
    expect(chunkOffsetsPatched).toBe(0);
    expect(stcoOffsets(buffer)).toEqual(before);
    expect(readMp4Tags(buffer).bpm).toBe(128);
  });

  it('is size-neutral when the same values are written again', () => {
    const first = patchMp4Tags(makeMp4(), { bpm: 128, key: '9B' }).buffer;
    const second = patchMp4Tags(first, { bpm: 128, key: '9B' }).buffer;
    expect(second.length).toBe(first.length);
    expect(readMp4Tags(second)).toEqual({ bpm: 128, key: '9B' });
  });

  it('does nothing without values', () => {
    const src = makeMp4();
    const res = patchMp4Tags(src, {});
    expect(res.inserted).toBe(0);
    expect(res.buffer).toBe(src);
  });

  it('refuses anything that is not an MP4', () => {
    expect(() =>
      patchMp4Tags(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), { bpm: 1 })
    ).toThrow();
  });
});

describe('mp4Tags — file level', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-mp4-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes to disk atomically and reads the values back', () => {
    const file = path.join(dir, 'track.m4a');
    fs.writeFileSync(file, makeMp4({ tmpo: 146 }));

    const res = writeMp4Tags(file, { bpm: 128, key: '9B' });
    expect(res.ok).toBe(true);
    expect(res.wrote).toEqual(['bpm', 'key']);
    expect(res.replaced).toBe(1);

    const onDisk = fs.readFileSync(file);
    expect(readMp4Tags(onDisk)).toEqual({ bpm: 128, key: '9B' });
    expect(() => assertBoxesValid(onDisk)).not.toThrow();
    expect(fs.existsSync(`${file}.mp4tmp`)).toBe(false);
  });

  it('reports a missing file instead of throwing', () => {
    expect(writeMp4Tags(path.join(dir, 'nope.m4a'), { bpm: 1 })).toEqual({
      ok: false,
      reason: 'missing-file',
    });
  });

  it('knows which containers it handles', () => {
    expect(supportsMp4Tags('/music/a.m4a')).toBe(true);
    expect(supportsMp4Tags('/music/a.MP4')).toBe(true);
    expect(supportsMp4Tags('/music/a.mp3')).toBe(false);
    expect(supportsMp4Tags('/music/a.flac')).toBe(false);
  });
});
