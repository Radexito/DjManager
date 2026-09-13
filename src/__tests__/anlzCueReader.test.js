import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import {
  buildPcobSections,
  buildExtPcobSections,
  buildPco2Sections,
  getAnlzFolder,
} from '../audio/anlzWriter.js';
import {
  parseAnlzCues,
  mergeCues,
  readTrackCues,
  buildCueImportPlan,
} from '../usb/anlzCueReader.js';

// Fixture: a PCOB memory-cue slot (the writer deliberately never emits these,
// hardware does — build the 56-byte PCPT layout by hand).
function buildMemoryCuePcob(positionsMs) {
  const header = 24;
  const tagLen = header + positionsMs.length * 56;
  const buf = Buffer.alloc(tagLen, 0);
  buf.write('PCOB', 0, 'ascii');
  buf.writeUInt32BE(header, 4);
  buf.writeUInt32BE(tagLen, 8);
  buf.writeUInt32BE(0, 12); // type 0 = memory cues
  buf.writeUInt16BE(positionsMs.length, 18);
  positionsMs.forEach((ms, i) => {
    const e = header + i * 56;
    buf.write('PCPT', e, 'ascii');
    buf.writeUInt32BE(28, e + 4);
    buf.writeUInt32BE(56, e + 8);
    buf.writeUInt32BE(0, e + 12); // hot_cue 0 = memory
    buf[e + 28] = 1; // cue point
    buf.writeUInt32BE(ms, e + 32);
    buf.writeUInt32BE(0xffffffff, e + 36); // no loop
  });
  return buf;
}

const JUNK = Buffer.concat([
  Buffer.from('PMAI', 'ascii'),
  Buffer.alloc(24, 0x11),
  Buffer.from('PQTZ', 'ascii'),
  Buffer.alloc(32, 0x22),
]);

const HOT_CUES = [
  { hot_cue_index: 0, position_ms: 1234, color: '#ff0000', label: 'Intro' },
  { hot_cue_index: 1, position_ms: 5678, color: '#ff9900', label: '' },
  { hot_cue_index: 2, position_ms: 91011, color: '#00b4d8', label: 'Drop' },
  { hot_cue_index: 3, position_ms: 12000, color: '#ff0000', label: '' },
];

describe('#259 USB cue import — ANLZ reader', () => {
  describe('parseAnlzCues', () => {
    it('round-trips the hot cues the writer puts in the DAT + EXT files', () => {
      const buffer = Buffer.concat([
        ...buildPcobSections(HOT_CUES),
        ...buildExtPcobSections(HOT_CUES),
        ...buildPco2Sections(HOT_CUES),
      ]);
      const cues = parseAnlzCues(buffer);
      const byIndex = new Map(cues.map((c) => [c.hotCueIndex, c]));

      expect([...byIndex.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
      expect(byIndex.get(0).positionMs).toBe(1234);
      expect(byIndex.get(1).positionMs).toBe(5678);
      expect(byIndex.get(2).positionMs).toBe(91011);
      expect(byIndex.get(3).positionMs).toBe(12000);
      expect(byIndex.get(0).type).toBe('cue');
    });

    it('decodes cue labels (PCO2) and maps colours back to hex', () => {
      const buffer = Buffer.concat(buildPco2Sections(HOT_CUES));
      const cues = parseAnlzCues(buffer);
      const intro = cues.find((c) => c.hotCueIndex === 0);
      expect(intro.label).toBe('Intro');
      expect(intro.color).toBe('#ff0000');
      expect(cues.find((c) => c.hotCueIndex === 2).label).toBe('Drop');
    });

    it('reads memory cues from a PCOB slot with hot_cue 0', () => {
      const buffer = Buffer.concat([JUNK, buildMemoryCuePcob([500, 90000])]);
      const cues = parseAnlzCues(buffer);
      expect(cues).toHaveLength(2);
      expect(cues.every((c) => c.hotCueIndex === -1)).toBe(true);
      expect(cues.map((c) => c.positionMs)).toEqual([500, 90000]);
    });

    it('ignores junk sections and truncated buffers', () => {
      expect(parseAnlzCues(JUNK)).toEqual([]);
      expect(parseAnlzCues(Buffer.alloc(4))).toEqual([]);
      expect(parseAnlzCues(null)).toEqual([]);
      const truncated = Buffer.concat([...buildPco2Sections(HOT_CUES)]).subarray(0, 30);
      expect(() => parseAnlzCues(truncated)).not.toThrow();
    });

    it('prefers the richer PCO2 entry when both describe the same hot cue', () => {
      const buffer = Buffer.concat([
        ...buildPcobSections([
          { hot_cue_index: 0, position_ms: 1000, color: '#ff0000', label: '' },
        ]),
        ...buildPco2Sections([
          { hot_cue_index: 0, position_ms: 1000, color: '#ff0000', label: 'Chorus' },
        ]),
      ]);
      const cues = parseAnlzCues(buffer);
      expect(cues).toHaveLength(1);
      expect(cues[0].label).toBe('Chorus');
    });
  });

  describe('mergeCues', () => {
    it('keeps one entry per hot cue slot, preferring the labelled one', () => {
      const merged = mergeCues([
        [
          { hotCueIndex: 0, positionMs: 1000, label: '' },
          { hotCueIndex: 1, positionMs: 2000, label: 'B' },
        ],
        [{ hotCueIndex: 0, positionMs: 1000, label: 'A', color: '#ff0000' }],
      ]);
      expect(merged).toHaveLength(2);
      expect(merged[0].label).toBe('A');
      expect(merged[1].label).toBe('B');
    });

    it('drops invalid positions', () => {
      const merged = mergeCues([
        [{ hotCueIndex: 0, positionMs: -5 }],
        [{ hotCueIndex: 1, positionMs: NaN }],
      ]);
      expect(merged).toEqual([]);
    });
  });

  describe('readTrackCues', () => {
    const usbRoot = '/media/usb';
    const usbFilePath = '/music/track.mp3';
    const dir = path.join(usbRoot, getAnlzFolder(usbFilePath));

    function makeFs(files) {
      return {
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => files.map((f) => f.name)),
        readFileSync: vi.fn((p) => files.find((f) => p.endsWith(f.name)).data),
      };
    }

    it('reads every ANLZ file in the track folder', () => {
      const fsImpl = makeFs([
        { name: 'ANLZ0000.DAT', data: Buffer.concat(buildPcobSections(HOT_CUES)) },
        { name: 'ANLZ0000.EXT', data: Buffer.concat(buildPco2Sections(HOT_CUES)) },
        { name: 'ANLZ0000.2EX', data: Buffer.alloc(16) },
      ]);
      const cues = readTrackCues(usbRoot, usbFilePath, { fsImpl });
      expect(fsImpl.readdirSync).toHaveBeenCalledWith(dir);
      expect(cues.map((c) => c.hotCueIndex)).toEqual([0, 1, 3, 2]);
    });

    it('returns nothing when the folder is missing or unreadable', () => {
      const missing = {
        readdirSync: vi.fn(() => {
          throw new Error('ENOENT');
        }),
      };
      expect(readTrackCues(usbRoot, usbFilePath, { fsImpl: missing })).toEqual([]);
      expect(readTrackCues(null, null, { fsImpl: missing })).toEqual([]);
    });
  });

  describe('buildCueImportPlan', () => {
    it('adds cues the library does not have yet', () => {
      const plan = buildCueImportPlan({
        usbCues: [{ hotCueIndex: 0, positionMs: 1000, color: '#ff0000', label: '' }],
        existingCues: [],
      });
      expect(plan.add).toHaveLength(1);
      expect(plan.update).toHaveLength(0);
      expect(plan.skip).toHaveLength(0);
      expect(plan.conflicts).toBe(0);
    });

    it('skips a hot cue that is already at the same position', () => {
      const plan = buildCueImportPlan({
        usbCues: [{ hotCueIndex: 0, positionMs: 1002, color: '#ff0000', label: '' }],
        existingCues: [{ id: 7, hot_cue_index: 0, position_ms: 1000 }],
      });
      expect(plan.skip).toHaveLength(1);
      expect(plan.skip[0].existingId).toBe(7);
      expect(plan.add).toHaveLength(0);
    });

    it('treats a moved hot cue slot as an update (hardware wins) and never deletes', () => {
      const plan = buildCueImportPlan({
        usbCues: [{ hotCueIndex: 1, positionMs: 8000, color: null, label: '' }],
        existingCues: [{ id: 9, hot_cue_index: 1, position_ms: 4321 }],
      });
      expect(plan.update).toHaveLength(1);
      expect(plan.update[0].existingId).toBe(9);
      expect(plan.conflicts).toBe(1);
      expect(plan.add).toEqual([]);
    });

    it('matches memory cues by position, not by slot', () => {
      const existingCues = [{ id: 3, hot_cue_index: -1, position_ms: 5000 }];
      const sameSpot = buildCueImportPlan({
        usbCues: [{ hotCueIndex: -1, positionMs: 5050, label: '' }],
        existingCues,
      });
      expect(sameSpot.skip).toHaveLength(1);

      const movedSpot = buildCueImportPlan({
        usbCues: [{ hotCueIndex: -1, positionMs: 60000, label: '' }],
        existingCues,
      });
      expect(movedSpot.add).toHaveLength(1);
    });

    // #518 review — the user picks between extending and replacing.
    describe('modes', () => {
      const existingCues = [
        { id: 1, hot_cue_index: 0, position_ms: 1000 },
        { id: 2, hot_cue_index: 3, position_ms: 30000 },
        { id: 9, hot_cue_index: -1, position_ms: 5000 },
      ];

      it('defaults to extend and reports the mode', () => {
        const plan = buildCueImportPlan({ usbCues: [], existingCues });
        expect(plan.mode).toBe('extend');
        expect(plan.remove).toEqual([]);
      });

      it('extend never plans a removal, even for cues the stick lacks', () => {
        const plan = buildCueImportPlan({
          usbCues: [{ hotCueIndex: 0, positionMs: 1000, label: '' }],
          existingCues,
          mode: 'extend',
        });
        expect(plan.skip).toHaveLength(1);
        expect(plan.remove).toEqual([]);
      });

      it('replace removes library cues the stick does not carry', () => {
        const plan = buildCueImportPlan({
          usbCues: [{ hotCueIndex: 0, positionMs: 1000, label: '' }],
          existingCues,
          mode: 'replace',
        });
        expect(plan.mode).toBe('replace');
        // hot cue 3 and the memory cue are only in the library
        expect(plan.remove.map((c) => c.id).sort()).toEqual([2, 9]);
        expect(plan.skip).toHaveLength(1);
      });

      it('replace updates a moved slot instead of removing it', () => {
        const plan = buildCueImportPlan({
          usbCues: [{ hotCueIndex: 3, positionMs: 31000, label: '' }],
          existingCues,
          mode: 'replace',
        });
        expect(plan.update.map((c) => c.existingId)).toEqual([2]);
        expect(plan.remove.map((c) => c.id).sort()).toEqual([1, 9]);
      });

      it('replace keeps a memory cue that the stick still carries', () => {
        const plan = buildCueImportPlan({
          usbCues: [{ hotCueIndex: -1, positionMs: 5040, label: '' }],
          existingCues,
          mode: 'replace',
        });
        expect(plan.skip).toHaveLength(1);
        expect(plan.remove.map((c) => c.id).sort()).toEqual([1, 2]);
      });

      it('replace with an empty stick clears the track', () => {
        const plan = buildCueImportPlan({ usbCues: [], existingCues, mode: 'replace' });
        expect(plan.remove).toHaveLength(3);
        expect(plan.add).toEqual([]);
      });
    });
  });
});
