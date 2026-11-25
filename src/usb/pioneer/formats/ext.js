/**
 * Rows of `exportExt.pdb`, the second database a Pioneer export carries: the My
 * Tags tree and the junction rows that assign a tag to a track.
 *
 * The layouts below were measured against two native files, a rekordbox export
 * of the rekordcrate demo library and the export written by rekordbox on the
 * Windows test stick, and they match the published format description at
 * https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html#tag-rows
 * Re-encoding every row of both files with these functions reproduces 56 of 56
 * rows in the first file and 73 of 75 in the second. The two differences sit in
 * the padding that follows the string heap: a medium that has been used carries
 * leftover allocator bytes there, a fresh export carries zeros. Nothing in the
 * format requires those bytes, so a writer emits zeros and the comparison has to
 * ignore the padding of a used stick.
 *
 * Three table types carry data:
 *
 * - type 3, tag rows: one row per tag or category, laid out at
 *   {@link EXT_TAG_HEADER_BYTES} + name + unknown string;
 * - type 4, track/tag rows: 16 bytes, `0, trackId, tagId, 3`;
 * - type 7, one bookkeeping row: the tag master id that `exportLibrary.db`
 *   repeats in its `property` row.
 *
 * The remaining types (0, 1, 2, 5, 6, 8) are empty on every file seen so far.
 */

/** Big-endian-free marker every tag row starts with (short name, 1-byte offsets). */
export const EXT_TAG_SUBTYPE_NEAR = 0x0680;

/** Tag rows with a long or far name use this subtype and 2-byte offsets. */
export const EXT_TAG_SUBTYPE_FAR = 0x0684;

/** Bytes before the string heap: 3 fixed bytes, the offsets, 28 bytes of header. */
export const EXT_TAG_HEADER_BYTES = 0x1f;

/** The index shifts by this much for every tag row in the table. */
export const EXT_TAG_INDEX_STEP = 0x20;

/** Marks a row as a category rather than a tag. */
export const EXT_TAG_IS_CATEGORY = 0x01000000;

/** Fixed bytes the bookkeeping row carries after the tag master id. */
const EXT_META_TAIL = Buffer.from([
  0x03, 0x22, 0x23, 0x24, 0x25, 0x26, 0x03, 0x03, 0x03, 0x03, 0x03,
]);

/** A DeviceSQL string in its short ASCII form, which is what names use. */
function encodeName(value) {
  const str = String(value ?? '');
  const buf = Buffer.allocUnsafe(1 + str.length);
  buf[0] = ((str.length + 1) << 1) | 1;
  buf.write(str, 1, 'ascii');
  return buf;
}

/**
 * A tag or category row.
 *
 * Bytes: subtype, index shift, eight zero bytes, category id, position, id,
 * category flag, `0x03`, name offset, unknown string offset, then the two
 * strings. Offsets are absolute within the row.
 *
 * Row length is the used bytes rounded up to four and then enlarged by eight,
 * which is what every row of both native files does.
 *
 * @param {{index: number, id: number, name: string, categoryId?: number,
 *   position?: number, isCategory?: boolean, unknown?: string}} row
 * @returns {Buffer}
 */
export function encodeExtTagRow({
  index,
  id,
  name,
  categoryId = 0,
  position = 0,
  isCategory = false,
  unknown = '',
}) {
  const nameBuf = encodeName(name);
  const unknownBuf = encodeName(unknown);
  const used = EXT_TAG_HEADER_BYTES + nameBuf.length + unknownBuf.length;
  const total = Math.ceil(used / 4) * 4 + 8;
  const buf = Buffer.alloc(total);

  buf.writeUInt16LE(EXT_TAG_SUBTYPE_NEAR, 0);
  buf.writeUInt16LE((index * EXT_TAG_INDEX_STEP) & 0xffff, 2);
  buf.writeUInt32LE(categoryId, 12);
  buf.writeUInt32LE(position, 16);
  buf.writeUInt32LE(id, 20);
  buf.writeUInt32LE(isCategory ? EXT_TAG_IS_CATEGORY : 0, 24);
  buf[28] = 0x03;
  buf[29] = EXT_TAG_HEADER_BYTES;
  buf[30] = EXT_TAG_HEADER_BYTES + nameBuf.length;
  nameBuf.copy(buf, EXT_TAG_HEADER_BYTES);
  unknownBuf.copy(buf, EXT_TAG_HEADER_BYTES + nameBuf.length);
  return buf;
}

/**
 * A track/tag junction row: `0, tagId, contentId, 3`.
 *
 * The order was settled on a stick where rekordbox itself had tagged tracks: the
 * tag id comes second, and the third word is the content id the device library
 * uses for that track, not the row number in `export.pdb`. A deck asked to show
 * a tag with those two swapped shows an empty list, which is how the order was
 * found. The leading zero and the trailing three are constant.
 *
 * @param {{tagId: number, contentId: number}} row
 * @returns {Buffer}
 */
export function encodeExtTrackTagRow({ tagId, contentId }) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(Number(tagId) >>> 0, 4);
  buf.writeUInt32LE(Number(contentId) >>> 0, 8);
  buf.writeUInt32LE(3, 12);
  return buf;
}

/**
 * The single type 7 row: 22 zero bytes after the type word, the tag master id at
 * offset 24, then the constant tail and zeros up to 60 bytes.
 *
 * @param {{masterTagId: number}} row
 * @returns {Buffer}
 */
export function encodeExtMetaRow({ masterTagId }) {
  const buf = Buffer.alloc(60);
  buf.writeUInt16LE(0x0700, 0);
  buf.writeUInt32LE(Number(masterTagId) >>> 0, 24);
  EXT_META_TAIL.copy(buf, 28);
  return buf;
}
