import {
  PAGE_SIZE,
  EMPTY_TABLE_SENTINEL,
  DATA_HEADER_TOTAL,
  decodeTrackRow,
  readHeader,
  readPage,
} from './pdbRead.js';

/**
 * Editing a track that lives on a mounted medium.
 *
 * The writers in this repository build a whole `export.pdb` from a library
 * model: they number every row from 1, flatten folders and only carry the
 * fields the export needs. Running that over an existing stick would rewrite
 * more than the field the user touched, so a medium is edited in place instead:
 * the string is replaced inside the row that already holds it.
 *
 * That is only possible while the new text fits the slot the old text occupied.
 * A longer text would overlap the next string in the row, and moving it means
 * rebuilding the page, which is a different job with a different risk. The
 * caller gets `too-long` with the current limit instead of a silent truncation.
 */

/** String slots of a track row, in the order the writer emits them. */
const SLOTS = { isrc: 0, composer: 1, message: 5, mixName: 12, comment: 16, title: 17 };

const TRACK_HEADER_BYTES = 94;

/** Table type that carries track rows (see TABLE_TYPES). */
const TRACK_TABLE = 0;

/**
 * Bytes an encoded DeviceSQL string occupies, read from its own header.
 * @param {Buffer} row row buffer
 * @param {number} at offset of the string inside the row
 * @returns {number} bytes the string occupies, header included
 */
function encodedLength(row, at) {
  const head = row[at];
  if (head === 0x40 || head === 0x90) return row.readUInt16LE(at + 1);
  return 1 + ((head >> 1) - 1);
}

/**
 * Encode a string the way this format stores it.
 *
 * Kept local instead of importing the writer: the writer's encoder is free to
 * change its long-form layout, and this function has to match what is already
 * on the medium, which is the reader's definition, not the writer's.
 * @param {string} value text
 * @returns {Buffer} encoded string
 */
function encode(value) {
  const ascii = /^[\x20-\x7e]*$/.test(value);
  if (ascii && value.length < 127) {
    const buf = Buffer.allocUnsafe(1 + value.length);
    buf[0] = ((value.length + 1) << 1) | 1;
    buf.write(value, 1, 'ascii');
    return buf;
  }
  if (ascii) {
    const buf = Buffer.allocUnsafe(4 + value.length);
    buf[0] = 0x40;
    buf.writeUInt16LE(value.length + 4, 1);
    buf[3] = 0x00;
    buf.write(value, 4, 'ascii');
    return buf;
  }
  const encoded = Buffer.from(value, 'utf16le');
  const buf = Buffer.allocUnsafe(4 + encoded.length);
  buf[0] = 0x90;
  buf.writeUInt16LE(encoded.length + 4, 1);
  buf[3] = 0x00;
  encoded.copy(buf, 4);
  return buf;
}

/**
 * Walk the data pages of one table.
 * @param {Buffer} buffer whole file
 * @param {number} firstPage first data page, or the empty sentinel
 * @returns {Array<{pageIndex: number, rows: Array<{row: Buffer, at: number}>}>}
 *   pages with each row buffer and its absolute offset in the file
 */
function tablePages(buffer, firstPage) {
  const pages = [];
  if (firstPage === EMPTY_TABLE_SENTINEL || firstPage <= 0) return pages;
  let pageIndex = firstPage;
  const seen = new Set();
  const lastPage = Math.floor(buffer.length / PAGE_SIZE) - 1;
  // The chain ends at the empty sentinel, at a page past the end of the file
  // (the writer links to the next unused page) or on a loop.
  while (
    pageIndex !== EMPTY_TABLE_SENTINEL &&
    pageIndex > 0 &&
    pageIndex <= lastPage &&
    !seen.has(pageIndex)
  ) {
    seen.add(pageIndex);
    const page = readPage(buffer, pageIndex);
    const start = pageIndex * PAGE_SIZE + DATA_HEADER_TOTAL;
    let at = start;
    const rows = page.rows.map((row) => {
      const entry = { row, at };
      at += row.length;
      return entry;
    });
    pages.push({ pageIndex, rows });
    pageIndex = page.nextPage;
  }
  return pages;
}

/**
 * Replace one text field of one track in a `export.pdb` buffer.
 * @param {Buffer} buffer whole file
 * @param {{trackId: number, field?: string, value: string}} options
 * @returns {{ok: true, bytes: Buffer} | {ok: false, reason: string, limit?: number}}
 */
export function patchTrackField(buffer, { trackId, field = 'title', value }) {
  const slot = SLOTS[field];
  if (slot === undefined) return { ok: false, reason: `unknown field ${field}` };
  const text = String(value ?? '');
  if (text.length === 0) return { ok: false, reason: 'empty' };

  const header = readHeader(buffer);
  const trackTable = header.tables.find((table) => table.type === TRACK_TABLE);
  if (!trackTable) return { ok: false, reason: 'no track table' };

  const pages = tablePages(buffer, trackTable.firstPage);
  for (const page of pages) {
    for (const entry of page.rows) {
      let decoded;
      try {
        decoded = decodeTrackRow(entry.row);
      } catch {
        continue;
      }
      if (decoded.id !== trackId) continue;

      const row = entry.row;
      const at = row.readUInt16LE(TRACK_HEADER_BYTES + slot * 2);
      if (at <= 0 || at >= row.length) return { ok: false, reason: 'no string slot' };

      const room = encodedLength(row, at);
      const encoded = encode(text);
      if (encoded.length > room) {
        return { ok: false, reason: 'too-long', limit: room };
      }
      // A long string has to sit on a 4-byte boundary of the file, which the
      // writer guarantees when it lays a row out. Moving a short string into a
      // long form can break that, so refuse rather than produce a file the deck
      // may refuse to read.
      if (encoded[0] === 0x40 || encoded[0] === 0x90) {
        if ((entry.at + at) % 4 !== 0) return { ok: false, reason: 'needs alignment' };
      }

      const out = Buffer.from(buffer);
      const absolute = entry.at + at;
      encoded.copy(out, absolute);
      out.fill(0, absolute + encoded.length, absolute + room);
      return { ok: true, bytes: out };
    }
  }
  return { ok: false, reason: 'track not found' };
}

/**
 * The longest text the slot can take, so a caller can say it before saving.
 * @param {Buffer} buffer whole file
 * @param {{trackId: number, field?: string}} options
 * @returns {number|null} bytes available, or null when the slot is not found
 */
export function slotRoom(buffer, { trackId, field = 'title' }) {
  const slot = SLOTS[field];
  if (slot === undefined) return null;
  const header = readHeader(buffer);
  const trackTable = header.tables.find((table) => table.type === TRACK_TABLE);
  if (!trackTable) return null;
  for (const page of tablePages(buffer, trackTable.firstPage)) {
    for (const entry of page.rows) {
      let decoded;
      try {
        decoded = decodeTrackRow(entry.row);
      } catch {
        continue;
      }
      if (decoded.id !== trackId) continue;
      const at = entry.row.readUInt16LE(TRACK_HEADER_BYTES + slot * 2);
      if (at <= 0 || at >= entry.row.length) return null;
      return encodedLength(entry.row, at);
    }
  }
  return null;
}
