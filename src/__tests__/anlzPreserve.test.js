import { describe, it, expect } from 'vitest';
import { parseAnlzSections, preservedSections } from '../usb/pioneer/formats/anlz.js';

/** Builds one ANLZ section: a 12-byte header followed by the payload. */
function section(tag, payload, lenHeader = 12) {
  const header = Buffer.alloc(12);
  header.write(tag, 0, 4, 'ascii');
  header.writeUInt32BE(lenHeader, 4);
  header.writeUInt32BE(payload.length + 12, 8);
  return Buffer.concat([header, payload]);
}

/** Wraps the given sections in a PMAI container whose header accounts for their total length. */
function container(...sections) {
  const head = Buffer.alloc(28);
  head.write('PMAI', 0, 4, 'ascii');
  head.writeUInt32BE(28, 4);
  head.writeUInt32BE(28 + sections.reduce((s, b) => s + b.length, 0), 8);
  return Buffer.concat([head, ...sections]);
}

describe('parseAnlzSections', () => {
  it('returns the sections in file order, with their lengths', () => {
    const buf = container(
      section('PPTH', Buffer.from([1, 2, 3]), 16),
      section('PQTZ', Buffer.alloc(20, 0xaa)),
      section('PSSI', Buffer.alloc(24, 0xbb), 32)
    );
    const sections = parseAnlzSections(buf);
    expect(sections.map((s) => s.tag)).toEqual(['PPTH', 'PQTZ', 'PSSI']);
    expect(sections[0].lenHeader).toBe(16);
    expect(sections[2].lenTag).toBe(24 + 12);
    expect(sections[2].raw.equals(section('PSSI', Buffer.alloc(24, 0xbb), 32))).toBe(true);
  });

  it('stops at the first header that is not a section', () => {
    const buf = Buffer.concat([
      container(section('PPTH', Buffer.from([0]))),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    expect(parseAnlzSections(buf).map((s) => s.tag)).toEqual(['PPTH']);
  });

  it('stops instead of reading past the end of a truncated file', () => {
    const full = container(section('PPTH', Buffer.alloc(40, 0x7f)));
    const truncated = full.subarray(0, full.length - 10);
    expect(parseAnlzSections(truncated)).toEqual([]);
  });

  it('returns an empty list for a buffer shorter than the container header', () => {
    expect(parseAnlzSections(Buffer.alloc(10))).toEqual([]);
    expect(parseAnlzSections(null)).toEqual([]);
  });
});

describe('preservedSections', () => {
  it('keeps sections the writer does not produce, byte for byte', () => {
    const pssi = section('PSSI', Buffer.alloc(72, 0x5a), 32);
    const existing = container(section('PPTH', Buffer.alloc(6, 0x01)), pssi);
    const kept = preservedSections(existing, ['PPTH', 'PQTZ']);
    expect(kept).toHaveLength(1);
    expect(kept[0].equals(pssi)).toBe(true);
  });

  it('drops nothing when every section is produced by the writer', () => {
    const existing = container(section('PPTH', Buffer.alloc(4)), section('PQT2', Buffer.alloc(8)));
    expect(preservedSections(existing, ['PPTH', 'PQT2'])).toEqual([]);
  });

  it('keeps several unknown sections in their original order', () => {
    const existing = container(
      section('PPTH', Buffer.alloc(4)),
      section('PSSI', Buffer.alloc(48, 0x11), 32),
      section('PWV5', Buffer.alloc(4)),
      section('PVDI', Buffer.alloc(24, 0x22))
    );
    const tags = preservedSections(existing, ['PPTH', 'PWV5']).map((b) =>
      b.toString('ascii', 0, 4)
    );
    expect(tags).toEqual(['PSSI', 'PVDI']);
  });

  it('skips a section whose len_tag is smaller than its len_header', () => {
    const broken = section('PSSI', Buffer.alloc(0), 32);
    const existing = container(section('PPTH', Buffer.alloc(4)), broken);
    expect(preservedSections(existing, ['PPTH'])).toEqual([]);
  });

  it('returns nothing when there is no existing file', () => {
    expect(preservedSections(null, ['PPTH'])).toEqual([]);
  });
});
