import { describe, expect, it } from 'vitest';

import {
  EXT_TAG_HEADER_BYTES,
  EXT_TAG_IS_CATEGORY,
  EXT_TAG_SUBTYPE_NEAR,
  encodeExtMetaRow,
  encodeExtTagRow,
  encodeExtTrackTagRow,
} from '../usb/pioneer/formats/ext.js';
import { decodeDeviceSQLString } from '../usb/pioneer/formats/pdbRead.js';

/** The name a tag row carries, read back the way a player would. */
function nameOf(row) {
  return decodeDeviceSQLString(row, row[29]).value;
}

describe('exportExt tag rows', () => {
  it('lays out the header fields the format describes', () => {
    const row = encodeExtTagRow({
      index: 3,
      id: 1816740240,
      name: 'Acid House',
      categoryId: 1,
      position: 2,
    });

    expect(row.readUInt16LE(0)).toBe(EXT_TAG_SUBTYPE_NEAR);
    expect(row.readUInt16LE(2)).toBe(3 * 0x20);
    // eight bytes of unknown purpose, then category, position, id, flag
    expect([...row.subarray(4, 12)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(row.readUInt32LE(12)).toBe(1);
    expect(row.readUInt32LE(16)).toBe(2);
    expect(row.readUInt32LE(20)).toBe(1816740240);
    expect(row.readUInt32LE(24)).toBe(0);
    // the constant 3, then the two string offsets
    expect(row[28]).toBe(0x03);
    expect(row[29]).toBe(EXT_TAG_HEADER_BYTES);
    expect(row[30]).toBe(EXT_TAG_HEADER_BYTES + 1 + 'Acid House'.length);
    expect(nameOf(row)).toBe('Acid House');
  });

  it('marks categories and leaves the category field empty for them', () => {
    const row = encodeExtTagRow({ index: 0, id: 1, name: 'Genre', isCategory: true });

    expect(row.readUInt32LE(24)).toBe(EXT_TAG_IS_CATEGORY);
    expect(row.readUInt32LE(12)).toBe(0);
    expect(nameOf(row)).toBe('Genre');
  });

  it('rounds the row up to four bytes and adds eight, as every native row does', () => {
    // Name lengths taken from the two native files: Genre 48, Acid House 52,
    // Electro House 56 bytes.
    const sizes = ['Genre', 'Acid House', 'Electro House'].map(
      (name) => encodeExtTagRow({ index: 0, id: 1, name }).length
    );
    expect(sizes).toEqual([48, 52, 56]);

    const used = EXT_TAG_HEADER_BYTES + 1 + 'Genre'.length + 1;
    expect(used).toBe(38);
    expect(encodeExtTagRow({ index: 0, id: 1, name: 'Genre' }).length).toBe(48);
  });

  it('keeps the empty second string in place, one byte, right after the name', () => {
    const row = encodeExtTagRow({ index: 0, id: 1, name: 'Genre' });
    const pos = EXT_TAG_HEADER_BYTES + 1 + 'Genre'.length;

    expect(row.readUInt8(pos)).toBe(0x03);
    expect(decodeDeviceSQLString(row, row[30]).value).toBe('');
  });
});

describe('exportExt track/tag rows', () => {
  it('writes the magic zero, the two ids and the constant three', () => {
    const row = encodeExtTrackTagRow({ trackId: 7, tagId: 1816740240 });

    expect(row.length).toBe(16);
    expect(row.readUInt32LE(0)).toBe(0);
    expect(row.readUInt32LE(4)).toBe(7);
    expect(row.readUInt32LE(8)).toBe(1816740240);
    expect(row.readUInt32LE(12)).toBe(3);
  });
});

describe('exportExt bookkeeping row', () => {
  it('carries the tag master id that the device library repeats', () => {
    const row = encodeExtMetaRow({ masterTagId: 3142762754 });

    expect(row.length).toBe(60);
    expect(row.readUInt16LE(0)).toBe(0x0700);
    expect(row.readUInt32LE(24)).toBe(3142762754);
    // the constant tail measured on both native files
    expect([...row.subarray(28, 39)]).toEqual([
      0x03, 0x22, 0x23, 0x24, 0x25, 0x26, 0x03, 0x03, 0x03, 0x03, 0x03,
    ]);
    expect([...row.subarray(39)]).toEqual(new Array(21).fill(0));
  });
});
