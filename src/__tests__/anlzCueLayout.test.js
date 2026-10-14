import { describe, it, expect } from 'vitest';
import {
  buildPcobSections,
  buildExtPcobSections,
  buildPco2Sections,
  resolveCueSpan,
} from '../audio/anlzWriter.js';

/**
 * Pinned-byte tests for the ANLZ cue-record layout (#571 loops, #572 memory cues,
 * #574 labels/colours).
 *
 * Every expectation below is the bytes of a real rekordbox 6 export that is
 * checked into reverse-engineering/captures/ — the capture is named in each test.
 * These are deliberately byte assertions rather than behavioural ones: the old
 * writer produced a well-formed record for every case below, it just produced
 * the WRONG bytes (type 1 + 0xFFFFFFFF end for loops, an empty stub for memory
 * cues), so only the bytes can catch a regression.
 */

// PCPT record is 56 bytes; offsets are relative to the start of the record.
const PCPT = {
  slot: 0x0c,
  status: 0x10,
  const10000: 0x14,
  type: 0x1c,
  start: 0x20,
  end: 0x24,
  trailer: 0x28, // 16 zero bytes
};

// PCP2 record offsets, relative to the start of the record.
const PCP2 = {
  slot: 0x0c,
  type: 0x10,
  start: 0x14,
  end: 0x18,
  lenComment: 0x28,
  label: 0x2c,
};

/** Reads the PCPT record `index` out of a PCOB section (24-byte header). */
function pcpt(pcob, index) {
  return pcob.subarray(24 + index * 56, 24 + (index + 1) * 56);
}

/** Walks the PCP2 records of a PCO2 section (20-byte header). */
function pcp2Entries(pco2) {
  const count = pco2.readUInt16BE(16);
  const out = [];
  let off = 20;
  for (let i = 0; i < count; i++) {
    const len = pco2.readUInt32BE(off + 8);
    out.push(pco2.subarray(off, off + len));
    off += len;
  }
  return out;
}

describe('loop records — type 2 + absolute end (#571)', () => {
  // capture 46-loop-cue: one loop, slot 1, start 0x0000ef81 (61313 ms),
  // end 0x0000f595 (62869 ms), +0x1c = 02 in both DAT PCOB and EXT PCO2.
  const loop = {
    position_ms: 61313,
    hot_cue_index: 0,
    color: '#00b4d8',
    label: '',
    loop_end_ms: 62869,
  };

  it('PCPT of a loop has type 2 at +0x1c and the absolute end at +0x24 (capture 46)', () => {
    const [pcob1] = buildPcobSections([loop]);
    const rec = pcpt(pcob1, 0);

    expect(rec.readUInt32BE(8)).toBe(56);
    expect(rec.readUInt32BE(PCPT.slot)).toBe(1);
    expect(rec[PCPT.type]).toBe(2); // OLD CODE wrote 1 here
    expect(rec.readUInt32BE(PCPT.start)).toBe(61313);
    expect(rec.readUInt32BE(PCPT.end)).toBe(62869); // OLD CODE wrote 0xffffffff here
    // 0xFFFFFFFF at +0x24 is what a plain cue point carries (captures 40, 41) —
    // byte-for-byte identical to what we used to write for a loop.
    expect(rec.readUInt32BE(PCPT.end)).not.toBe(0xffffffff);
  });

  it('PCPT of a plain cue point still carries the 0xFFFFFFFF end (capture 40)', () => {
    const { loop_end_ms: _drop, ...plain } = loop;
    const [pcob1] = buildPcobSections([plain]);
    const rec = pcpt(pcob1, 0);

    expect(rec[PCPT.type]).toBe(1);
    expect(rec.readUInt32BE(PCPT.end)).toBe(0xffffffff);
  });

  it('PCP2 of a loop has type 2 at +0x10 and the absolute end at +0x18 (capture 46)', () => {
    const [pco2hot] = buildPco2Sections([loop]);
    const rec = pcp2Entries(pco2hot)[0];

    expect(rec.subarray(0, 4).toString('ascii')).toBe('PCP2');
    expect(rec.readUInt32BE(PCP2.slot)).toBe(1);
    expect(rec[PCP2.type]).toBe(2); // OLD CODE wrote 1 here
    expect(rec.readUInt32BE(PCP2.start)).toBe(61313);
    expect(rec.readUInt32BE(PCP2.end)).toBe(62869); // OLD CODE wrote 0xffffffff
  });

  it('four loops keep their own slot, type and end (capture 47)', () => {
    // 47-multiple-loops: A = 1-beat loop at 5310..5699, B = 2-beat at 10366..11143,
    // C = 4-beat at 15421..16977 (DAT list 1) and D = 8-beat at 20477..23589 (EXT list 1).
    const loops = [
      { position_ms: 5310, loop_end_ms: 5699, hot_cue_index: 0 },
      { position_ms: 10366, loop_end_ms: 11143, hot_cue_index: 1 },
      { position_ms: 15421, loop_end_ms: 16977, hot_cue_index: 2 },
      { position_ms: 20477, loop_end_ms: 23589, hot_cue_index: 3 },
    ];
    const [datHot, datMem] = buildPcobSections(loops);
    const [extHot, extMem] = buildExtPcobSections(loops);

    expect(datHot.readUInt32BE(8)).toBe(24 + 3 * 56);
    expect(extHot.readUInt32BE(8)).toBe(24 + 1 * 56);
    expect(datMem.readUInt32BE(8)).toBe(24);
    expect(extMem.readUInt32BE(8)).toBe(24);

    const datRecs = [0, 1, 2].map((i) => pcpt(datHot, i));
    expect(datRecs.map((r) => r.readUInt32BE(PCPT.slot))).toEqual([1, 2, 3]);
    expect(datRecs.map((r) => r[PCPT.type])).toEqual([2, 2, 2]);
    expect(datRecs.map((r) => r.readUInt32BE(PCPT.end))).toEqual([5699, 11143, 16977]);

    const extRec = pcpt(extHot, 0);
    expect(extRec.readUInt32BE(PCPT.slot)).toBe(4); // D
    expect(extRec[PCPT.type]).toBe(2);
    expect(extRec.readUInt32BE(PCPT.start)).toBe(20477);
    expect(extRec.readUInt32BE(PCPT.end)).toBe(23589);
  });

  it('resolveCueSpan treats a missing / 0xFFFFFFFF end as "not a loop"', () => {
    expect(resolveCueSpan({ position_ms: 1 })).toEqual({ type: 1, endMs: null });
    expect(resolveCueSpan({ position_ms: 1, loop_end_ms: 0xffffffff })).toEqual({
      type: 1,
      endMs: null,
    });
    expect(resolveCueSpan({ position_ms: 1, loop_end_ms: null })).toEqual({
      type: 1,
      endMs: null,
    });
    // loopTimeMs is what anlzCueReader emits, so a re-imported loop round-trips
    expect(resolveCueSpan({ position_ms: 1, loopTimeMs: 2000 })).toEqual({
      type: 2,
      endMs: 2000,
    });
  });
});

describe('memory cues — slot 0 in the memory cue list (#572)', () => {
  // capture 42-momory_cue: DAT PCOB list kind 0, one PCPT record, slot 00 at +0x0c,
  // type 01 at +0x1c, start 0x00010954 (67924 ms), end FFFFFFFF. The EXT PCO2
  // list kind 0 holds the matching PCP2 record with slot 00.
  const memoryCue = { position_ms: 67924, label: '', color: '', hot_cue_index: -1 };

  it('DAT PCOB memory list has kind 0, count 1 and a real slot-0 record (capture 42)', () => {
    const [pcob1, pcob2] = buildPcobSections([memoryCue]);

    // list 0 = memory cue list; the hot cue list is the empty stub
    expect(pcob1.readUInt32BE(8)).toBe(24);
    expect(pcob1.readUInt32BE(12)).toBe(1);
    expect(pcob2.readUInt32BE(12)).toBe(0); // OLD CODE: kind 0 but len_tag 24 (a stub)
    expect(pcob2.readUInt32BE(16)).toBe(1); // entry count
    expect(pcob2.readUInt32BE(8)).toBe(24 + 56); // OLD CODE wrote 24 here

    const rec = pcpt(pcob2, 0);
    expect(rec.subarray(0, 4).toString('ascii')).toBe('PCPT');
    expect(rec.readUInt32BE(8)).toBe(56);
    expect(rec.readUInt32BE(PCPT.slot)).toBe(0); // OLD CODE had no record at all
    expect(rec[PCPT.type]).toBe(1);
    expect(rec.readUInt32BE(PCPT.start)).toBe(67924);
    expect(rec.readUInt32BE(PCPT.end)).toBe(0xffffffff);
  });

  it('EXT PCO2 memory list has kind 0 and a real slot-0 record (capture 42)', () => {
    const [pco2hot, pco2mem] = buildPco2Sections([memoryCue]);

    expect(pco2hot.readUInt32BE(12)).toBe(1);
    expect(pco2hot.readUInt32BE(8)).toBe(20); // empty hot cue list
    expect(pco2mem.readUInt32BE(12)).toBe(0);
    expect(pco2mem.readUInt16BE(16)).toBe(1); // OLD CODE wrote 0 here
    expect(pco2mem.readUInt32BE(8)).toBe(20 + 88); // 20 header + the 88-byte PCP2

    const rec = pcp2Entries(pco2mem)[0];
    expect(rec.readUInt32BE(PCP2.slot)).toBe(0);
    expect(rec[PCP2.type]).toBe(1);
    expect(rec.readUInt32BE(PCP2.start)).toBe(67924);
    expect(rec.readUInt32BE(PCP2.end)).toBe(0xffffffff);
  });

  it('the EXT PCOB memory list stays empty (capture 42 has a memory cue there too)', () => {
    const [, extMem] = buildExtPcobSections([memoryCue]);
    expect(extMem.readUInt32BE(12)).toBe(0);
    expect(extMem.readUInt32BE(8)).toBe(24);
  });

  it('memory cues and hot cues coexist in their own lists', () => {
    const hotA = { position_ms: 1000, hot_cue_index: 0, color: '#ff0000' };
    const [pcob1, pcob2] = buildPcobSections([hotA, memoryCue]);

    expect(pcob1.readUInt32BE(12)).toBe(1); // hot cue list
    expect(pcob1.readUInt32BE(16)).toBe(1);
    expect(pcpt(pcob1, 0).readUInt32BE(PCPT.slot)).toBe(1);
    expect(pcob2.readUInt32BE(12)).toBe(0); // memory cue list
    expect(pcob2.readUInt32BE(16)).toBe(1);
    expect(pcpt(pcob2, 0).readUInt32BE(PCPT.slot)).toBe(0);
  });
});

describe('PCP2 labels and colours (#574)', () => {
  it('label is a length + UTF-16BE text at +0x2c, colour at +0x2c+len (capture 44)', () => {
    // capture 44-labled-cue/P062: hot cue 3 labelled "Break".
    //   [0x28..0x2b] = 00 00 00 0c   (u16 length 12 = 5 chars + NUL, as a u32)
    //   [0x2c..0x37] = 00 42 00 72 00 65 00 61 00 6b 00 00 = UTF-16BE "Break" + NUL
    //   [0x38..0x3b] = 00 33 ff 00   (hue code + R,G,B — the "three colour bytes")
    //   record length 100 = 16 + 72 + 12
    const cue = {
      position_ms: 15421,
      hot_cue_index: 2,
      label: 'Break',
      color: '#123456', // not in the palette → colour block stays zeroed
    };
    const [pco2hot] = buildPco2Sections([cue]);
    const rec = pcp2Entries(pco2hot)[0];

    expect(rec.readUInt32BE(8)).toBe(100); // OLD CODE wrote 104 (min-88 padding)
    expect(rec.readUInt32BE(PCP2.lenComment)).toBe(12);
    expect(rec.subarray(PCP2.label, PCP2.label + 10).toString('hex')).toBe('0042007200650061006b');
    expect(rec.readUInt16BE(PCP2.label + 10)).toBe(0); // NUL terminator
    expect(rec[PCP2.label + 12]).toBe(0); // colour block right after the label
    expect(rec[PCP2.label + 15]).toBe(0);
  });

  it('a 25-character label keeps the same layout (capture 45)', () => {
    // capture 45-labled-cue-long: len_comment 52 = 25 chars + NUL, record length
    // 140 = 16 + 72 + 52, colour block at 0x2c+52 = 0x60.
    const label = 'This is a very long label';
    const cue = { position_ms: 5310, hot_cue_index: 0, label, color: '#ff0000' };
    const [pco2hot] = buildPco2Sections([cue]);
    const rec = pcp2Entries(pco2hot)[0];

    const labelByteLen = (label.length + 1) * 2;
    expect(labelByteLen).toBe(52);
    expect(rec.readUInt32BE(8)).toBe(16 + 72 + 52);
    expect(rec.readUInt32BE(PCP2.lenComment)).toBe(52);
    // UTF-16BE, no byte-swapping left behind
    expect(rec.subarray(PCP2.label, PCP2.label + 8).toString('hex')).toBe('0054006800690073');
    expect(rec.readUInt16BE(PCP2.label + 50)).toBe(0);
    // red = hue 00 + ff 00 17 (capture 43 slot 1 / capture 45)
    const colourAt = PCP2.label + 52;
    expect([...rec.subarray(colourAt, colourAt + 4)]).toEqual([0x00, 0xff, 0x00, 0x17]);
  });

  it('an unlabelled record has len_comment 0 and the colour at +0x2c (capture 43)', () => {
    const cue = { position_ms: 10366, hot_cue_index: 1, label: '', color: '#ff9900' };
    const [pco2hot] = buildPco2Sections([cue]);
    const rec = pcp2Entries(pco2hot)[0];

    expect(rec.readUInt32BE(8)).toBe(88);
    expect(rec.readUInt32BE(PCP2.lenComment)).toBe(0);
    // orange = hue 26 + ff 5e 00 (capture 43 slot 2)
    expect([...rec.subarray(PCP2.label, PCP2.label + 4)]).toEqual([0x26, 0xff, 0x5e, 0x00]);
  });

  it('the eight palette colours write the captured hue code and RGB (capture 43)', () => {
    // 43-hot-cue-colors: all eight slots in rekordbox's own palette, in order.
    const expected = [
      ['#ff0000', [0x00, 0xff, 0x00, 0x17]], // slot 1 red
      ['#ff9900', [0x26, 0xff, 0x5e, 0x00]], // slot 2 orange
      ['#ffff00', [0x20, 0xff, 0xe8, 0x00]], // slot 3 yellow
      ['#00ff00', [0x16, 0x1a, 0xff, 0x00]], // slot 4 green
      ['#00b4d8', [0x09, 0x00, 0xe0, 0xff]], // slot 5 cyan
      ['#0080ff', [0x01, 0x00, 0x00, 0xff]], // slot 6 blue
      ['#cc00ff', [0x38, 0xb3, 0x00, 0xff]], // slot 7 violet
      ['#ff00a1', [0x31, 0xff, 0x00, 0xa1]], // slot 8 pink
    ];
    const cues = expected.map(([color], i) => ({
      position_ms: 1000 * (i + 1),
      hot_cue_index: i,
      label: '',
      color,
    }));
    const [pco2hot] = buildPco2Sections(cues);
    const recs = pcp2Entries(pco2hot);

    expect(recs).toHaveLength(8);
    recs.forEach((rec, i) => {
      expect(rec.readUInt32BE(PCP2.slot)).toBe(i + 1);
      expect([...rec.subarray(PCP2.label, PCP2.label + 4)]).toEqual(expected[i][1]);
    });
  });

  it('PCPT trailer is 16 zero bytes, colour byte included (captures 43, 44)', () => {
    // No captured PCPT record has anything but zeros at +0x28, even for the
    // eight fully coloured hot cues of capture 43 — the colour lives only in PCP2.
    const [pcob1] = buildPcobSections([
      { position_ms: 5310, hot_cue_index: 0, color: '#00b4d8' },
      { position_ms: 10366, hot_cue_index: 1, color: '#ff00a1' },
    ]);
    for (const i of [0, 1]) {
      const rec = pcpt(pcob1, i);
      expect([...rec.subarray(PCPT.trailer, PCPT.trailer + 16)]).toEqual(new Array(16).fill(0));
      expect(rec.readUInt32BE(PCPT.const10000)).toBe(0x00010000);
      expect(rec.readUInt32BE(PCPT.status)).toBe(0);
      expect(rec.subarray(29, 32).toString('hex')).toBe('0003e8');
    }
  });
});

describe('hot cue split stays as confirmed', () => {
  // capture 41-hot-cue-a-h: A-C (slots 2, 1, 3 in file order) in the DAT list 1,
  // D-H (slots 8, 7, 6, 5, 4 in file order) in the EXT list 1, all eight again in
  // EXT PCO2 list 1. File order is not sorted — we must not reorder anything.
  const cues = [
    { position_ms: 10366, hot_cue_index: 1 }, // B
    { position_ms: 5310, hot_cue_index: 0 }, // A
    { position_ms: 15033, hot_cue_index: 2 }, // C
    { position_ms: 40701, hot_cue_index: 7 }, // H
    { position_ms: 35256, hot_cue_index: 6 }, // G
    { position_ms: 30200, hot_cue_index: 5 }, // F
    { position_ms: 25533, hot_cue_index: 4 }, // E
    { position_ms: 20477, hot_cue_index: 3 }, // D
  ];

  it('DAT carries A-C and EXT carries D-H, in the order given', () => {
    const [datHot] = buildPcobSections(cues);
    const [extHot] = buildExtPcobSections(cues);

    expect(datHot.readUInt32BE(16)).toBe(3);
    expect([0, 1, 2].map((i) => pcpt(datHot, i).readUInt32BE(PCPT.slot))).toEqual([2, 1, 3]);
    expect(extHot.readUInt32BE(16)).toBe(5);
    expect([0, 1, 2, 3, 4].map((i) => pcpt(extHot, i).readUInt32BE(PCPT.slot))).toEqual([
      8, 7, 6, 5, 4,
    ]);
  });

  it('EXT PCO2 list 1 carries all eight hot cues flat, in the order given', () => {
    const [pco2hot] = buildPco2Sections(cues);
    expect(pco2hot.readUInt16BE(16)).toBe(8);
    expect(pcp2Entries(pco2hot).map((r) => r.readUInt32BE(PCP2.slot))).toEqual([
      2, 1, 3, 8, 7, 6, 5, 4,
    ]);
  });
});
