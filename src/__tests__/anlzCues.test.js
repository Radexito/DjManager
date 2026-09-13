import { describe, it, expect } from 'vitest';
import { buildExtPcobSections, buildPco2Sections, buildPcobSections } from '../audio/anlzWriter.js';
import { parseAnlzCues, readAnlzSections, readExportTrackCues } from '../explorer/anlzCues.js';

/** The 28-byte PMAI header the writers produce. */
function fileHeader(totalSize) {
  const buf = Buffer.alloc(28);
  buf.write('PMAI', 0, 4, 'ascii');
  buf.writeUInt32BE(0x1c, 4);
  buf.writeUInt32BE(totalSize, 8);
  buf.writeUInt32BE(0x00000001, 12);
  buf.writeUInt32BE(0x00010000, 16);
  buf.writeUInt32BE(0x00010000, 20);
  return buf;
}

function anlz(...sections) {
  const body = Buffer.concat(sections);
  return Buffer.concat([fileHeader(28 + body.length), body]);
}

/** A PCOB built by hand, so memory cues can be exercised (the writer stubs them). */
function pcob(entries) {
  const size = 24 + entries.length * 56;
  const buf = Buffer.alloc(size, 0);
  buf.write('PCOB', 0, 'ascii');
  buf.writeUInt32BE(24, 4);
  buf.writeUInt32BE(size, 8);
  buf.writeUInt32BE(entries[0]?.hotCue === 0 ? 0 : 1, 12);
  buf.writeUInt16BE(entries.length, 18);
  entries.forEach((entry, i) => {
    const off = 24 + i * 56;
    buf.write('PCPT', off, 'ascii');
    buf.writeUInt32BE(28, off + 4);
    buf.writeUInt32BE(56, off + 8);
    buf.writeUInt32BE(entry.hotCue, off + 12);
    buf[off + 28] = entry.type ?? 1;
    buf.writeUInt32BE(entry.timeMs, off + 32);
    buf.writeUInt32BE(entry.loopMs ?? 0xffffffff, off + 36);
    buf[off + 40] = entry.palette ?? 0;
  });
  return buf;
}

const CUE_POINTS = [
  { position_ms: 1000, color: '#ff0000', hot_cue_index: 0, label: 'Intro' },
  { position_ms: 60000, color: '#00b4d8', hot_cue_index: 1, label: 'Drop' },
  { position_ms: 90000, color: '#00ff00', hot_cue_index: 2, label: '' },
  { position_ms: 120000, color: '#cc00ff', hot_cue_index: 3, label: 'Break' },
];

describe('readAnlzSections', () => {
  it('walks the sections of a PMAI file', () => {
    const buffer = anlz(...buildPcobSections(CUE_POINTS));
    const sections = readAnlzSections(buffer);
    expect(sections.map((s) => s.tag)).toEqual(['PCOB', 'PCOB']);
  });

  it('returns nothing for a file that is not ANLZ', () => {
    expect(readAnlzSections(Buffer.from('not an anlz file at all'))).toEqual([]);
    expect(readAnlzSections(Buffer.alloc(0))).toEqual([]);
    expect(readAnlzSections(null)).toEqual([]);
  });

  it('stops at a truncated section instead of reading past the end', () => {
    const buffer = anlz(...buildPcobSections(CUE_POINTS));
    const truncated = buffer.subarray(0, buffer.length - 10);

    // the intact section is still read, the cut one is dropped
    expect(readAnlzSections(truncated).map((s) => s.tag)).toEqual(['PCOB']);
  });
});

describe('parseAnlzCues', () => {
  it('reads the hot cues out of the DAT file, with their palette colours', () => {
    const cues = parseAnlzCues(anlz(...buildPcobSections(CUE_POINTS)));

    expect(cues.map((c) => c.letter)).toEqual(['A', 'B', 'C']);
    expect(cues.map((c) => c.positionMs)).toEqual([1000, 60000, 90000]);
    expect(cues.every((c) => c.type === 'cue')).toBe(true);
    expect(cues.every((c) => c.memory === false)).toBe(true);
    expect(cues[0].color).toBe('#ff0000');
    expect(cues[1].color).toBe('#00b4d8');
  });

  it('reads the cues Rekordbox keeps in the EXT file, labels and colours included', () => {
    const ext = anlz(...buildExtPcobSections(CUE_POINTS), ...buildPco2Sections(CUE_POINTS));
    const cues = parseAnlzCues(ext);

    // the labels come from the PCO2 half, which carries every cue
    expect(cues.map((c) => c.letter)).toEqual(['A', 'B', 'C', 'D']);
    const breakCue = cues.find((c) => c.letter === 'D');
    expect(breakCue).toMatchObject({ positionMs: 120000, type: 'cue' });
    expect(breakCue.label).toBe('Break');
    expect(breakCue.color).toBe('#b300ff');
  });

  it('reads memory cues, which carry no hot cue letter', () => {
    const cues = parseAnlzCues(
      anlz(
        pcob([
          { hotCue: 0, timeMs: 5000, palette: 3 },
          { hotCue: 1, timeMs: 20000, palette: 5 },
        ])
      )
    );

    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      memory: true,
      letter: null,
      positionMs: 5000,
      color: '#ff9900',
    });
    expect(cues[1]).toMatchObject({ memory: false, letter: 'A', positionMs: 20000 });
  });

  it('reads a loop cue with its length', () => {
    const cues = parseAnlzCues(anlz(pcob([{ hotCue: 2, timeMs: 30000, type: 2, loopMs: 4000 }])));
    expect(cues[0]).toMatchObject({ letter: 'B', type: 'loop', positionMs: 30000, loopMs: 4000 });
  });

  it('orders the cues by position', () => {
    const cues = parseAnlzCues(
      anlz(
        pcob([
          { hotCue: 1, timeMs: 90000 },
          { hotCue: 2, timeMs: 1000 },
        ])
      )
    );
    expect(cues.map((c) => c.positionMs)).toEqual([1000, 90000]);
  });

  it('returns nothing for an empty or foreign file', () => {
    expect(parseAnlzCues(Buffer.from('nope'))).toEqual([]);
    expect(parseAnlzCues(null)).toEqual([]);
  });
});

describe('readExportTrackCues', () => {
  const ROOT = '/run/media/usb/STICK';
  const ANALYZE_PATH = '/PIONEER/USBANLZ/P077/00016B47/ANLZ0000.DAT';
  const BASE = `${ROOT}/PIONEER/USBANLZ/P077/00016B47/ANLZ0000`;

  const fsWith = (files) => ({
    readFileSync: (p) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
  });

  it('merges the cues spread across the three ANLZ files', () => {
    const cues = readExportTrackCues(
      ROOT,
      ANALYZE_PATH,
      fsWith({
        [`${BASE}.DAT`]: anlz(...buildPcobSections(CUE_POINTS)),
        [`${BASE}.EXT`]: anlz(
          ...buildExtPcobSections(CUE_POINTS),
          ...buildPco2Sections(CUE_POINTS)
        ),
      })
    );

    expect(cues.map((c) => c.letter)).toEqual(['A', 'B', 'C', 'D']);
    expect(cues[3]).toMatchObject({ label: 'Break', positionMs: 120000 });
  });

  it('skips the files that are not there and survives a missing export', () => {
    const cues = readExportTrackCues(ROOT, ANALYZE_PATH, fsWith({}));
    expect(cues).toEqual([]);
    expect(readExportTrackCues(null, ANALYZE_PATH, fsWith({}))).toEqual([]);
    expect(readExportTrackCues(ROOT, '', fsWith({}))).toEqual([]);
  });
});
