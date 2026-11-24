import { describe, expect, it } from 'vitest';

import { buildExtPdbBuffer, orderExtTags } from '../usb/pioneer/formats/extPdb.js';

const PAGE = 4096;

/** Rows a page says it holds, and how much heap it says is used. */
function pageHead(buffer, pageIndex) {
  const page = buffer.subarray(pageIndex * PAGE, (pageIndex + 1) * PAGE);
  const raw = page[24] | (page[25] << 8) | (page[26] << 16);
  return {
    type: page.readUInt32LE(8),
    next: page.readUInt32LE(12),
    rows: raw % 8192,
    flag: page[27],
    free: page.readUInt16LE(28),
    top: page.readUInt16LE(30),
  };
}

/** Every row of a tag page, read by walking the heap: rows carry their length. */
function tagRows(buffer, pageIndex) {
  const page = buffer.subarray(pageIndex * PAGE, (pageIndex + 1) * PAGE);
  const { rows } = pageHead(buffer, pageIndex);
  const out = [];
  let pos = 0;
  for (let i = 0; i < rows; i++) {
    const row = page.subarray(40 + pos, 40 + pos + 0x40);
    out.push({
      index: row.readUInt16LE(2),
      parentId: row.readUInt32LE(12),
      position: row.readUInt32LE(16),
      id: row.readUInt32LE(20),
      isCategory: row.readUInt32LE(24) >>> 24,
      nameLength: row[29] >> 1,
      at: pos,
    });
    // A row is its used bytes rounded up to four, plus eight.
    const nameBytes = row[29] >> 1;
    const unknownBytes = 1;
    const used = 0x1f + nameBytes + unknownBytes;
    pos += Math.ceil(used / 4) * 4 + 8;
  }
  return out;
}

const tag = (id, name, parentId = 0, position = 0, isCategory = false) => ({
  id,
  name,
  parentId,
  position,
  isCategory,
});

describe('buildExtPdbBuffer', () => {
  it('writes the same 18-page frame as a native file, even with no tags', () => {
    const buffer = buildExtPdbBuffer({ masterTagId: 1744129535 });

    expect(buffer.length).toBe(18 * PAGE);
    const header = buffer.subarray(0, 32);
    expect(header.readUInt32LE(4)).toBe(PAGE);
    expect(header.readUInt32LE(8)).toBe(9); // nine tables
    expect(header.readUInt32LE(12)).toBe(21); // next unused page
    expect(header.readUInt32LE(16)).toBe(1); // the value a native file carries

    // Index pages on the odd pages, one per table type.
    for (let type = 0; type < 9; type++) {
      const head = pageHead(buffer, 1 + type * 2);
      expect(head.type).toBe(type);
      expect(head.flag).toBe(0x64);
      expect(head.next).toBe(2 + type * 2);
    }

    // The bookkeeping row is always there, on page 16, pointing at 19.
    const meta = pageHead(buffer, 16);
    expect(meta.type).toBe(7);
    expect(meta.rows).toBe(1);
    expect(meta.next).toBe(19);
    expect(meta.top).toBe(60);
    expect(buffer.readUInt32LE(16 * PAGE + 40 + 24)).toBe(1744129535);

    // With no tree there is no tag page at all.
    expect(pageHead(buffer, 8).rows).toBe(0);
  });

  it('writes tags in the order it is given, with the per-page index', () => {
    const tags = [
      tag(1, 'Genre', 0, 0, true),
      tag(2, 'Acid House', 1, 0),
      tag(3, 'Deep House', 1, 1),
      tag(4, 'Mood', 0, 1, true),
      tag(5, 'Dark', 4, 0),
    ];
    const buffer = buildExtPdbBuffer({ tags, masterTagId: 7 });
    const head = pageHead(buffer, 8);

    expect(head.type).toBe(3);
    expect(head.rows).toBe(5);
    expect(head.next).toBe(20);

    const rows = tagRows(buffer, 8);
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((row) => row.isCategory)).toEqual([1, 0, 0, 1, 0]);
    expect(rows.map((row) => row.index)).toEqual([0, 0x20, 0x40, 0x60, 0x80]);
    expect(rows.map((row) => row.parentId)).toEqual([0, 1, 1, 0, 4]);
  });

  it('restarts the row index when the tree spills onto a second page', () => {
    const tags = [];
    for (let i = 1; i <= 200; i++) tags.push(tag(i, `Tag ${i}`, 0, i));
    const buffer = buildExtPdbBuffer({ tags, masterTagId: 7 });

    const first = pageHead(buffer, 8);
    const second = first.next;
    expect(second).toBeGreaterThan(17); // beyond the index pages
    const secondHead = pageHead(buffer, second);
    expect(secondHead.type).toBe(3);
    expect(first.rows + secondHead.rows).toBe(200);
    expect(first.rows).toBeLessThan(200);

    // The index restarts per page: the second page starts at zero again.
    expect(tagRows(buffer, second)[0].index).toBe(0);
    expect(tagRows(buffer, 8).at(-1).index).toBe((first.rows - 1) * 0x20);
  });

  it('ignores tags without a name instead of writing an empty row', () => {
    const buffer = buildExtPdbBuffer({ tags: [tag(1, '')], masterTagId: 0 });
    expect(pageHead(buffer, 8).rows).toBe(1);
  });
});

describe('orderExtTags', () => {
  it('puts each category before its own tags and orphans last', () => {
    const ordered = orderExtTags([
      tag(2, 'Acid House', 1, 0),
      tag(1, 'Genre', 0, 0, true),
      tag(9, 'Orphan', 99, 0),
      tag(4, 'Mood', 0, 1, true),
      tag(3, 'Deep House', 1, 1),
    ]);
    expect(ordered.map((row) => row.name)).toEqual([
      'Genre',
      'Acid House',
      'Deep House',
      'Mood',
      'Orphan',
    ]);
  });

  it('keeps every row when the same id appears twice', () => {
    const ordered = orderExtTags([
      tag(1, 'Genre', 0, 0, true),
      tag(1, 'Genre again', 0, 1, true),
      tag(2, 'Tag', 1, 0),
    ]);
    expect(ordered).toHaveLength(3);
    expect(ordered.map((row) => row.name)).toEqual(['Genre', 'Tag', 'Genre again']);
  });
});
