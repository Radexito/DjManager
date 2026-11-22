/**
 * Reading side of the DeviceSQL playlist database.
 *
 * Mirrors `pdb.js`: the same page size, the same 40-byte data-page header, the
 * same rowset table at the bottom of every page. Row payloads are returned as
 * raw buffers, because what a row means depends on its table; `decodeDeviceSQLString`
 * turns the strings inside one into text.
 */

/** Every DeviceSQL page is this long. */
export const PAGE_SIZE = 4096;

/** Bytes a data page spends on its header before the row heap starts. */
export const DATA_HEADER_TOTAL = 40;

/** Bytes per rowset, the slot table at the bottom of a data page. */
export const ROWSET_SIZE = 36;

/** Rows one rowset points at. */
export const MAX_ROWS_PER_ROWSET = 16;

/** Page number that means "no page". */
export const EMPTY_TABLE_SENTINEL = 0x03ffffff;

/**
 * Parse the file header, including the table index.
 * @param {Buffer} buffer whole file
 * @returns {{pageSize: number, numTables: number, nextUnusedPage: number, sequence: number, tables: Array<{type: number, emptyCandidate: number, firstPage: number, lastPage: number}>}}
 */
export function readHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PAGE_SIZE) {
    throw new Error('not a device database: smaller than one page');
  }
  const pageSize = buffer.readUInt32LE(4);
  if (pageSize !== PAGE_SIZE) {
    throw new Error(`unsupported page size ${pageSize}`);
  }
  const numTables = buffer.readUInt32LE(8);
  if (numTables < 1 || 28 + numTables * 16 > PAGE_SIZE) {
    throw new Error(`implausible table count ${numTables}`);
  }
  const tables = [];
  for (let i = 0; i < numTables; i += 1) {
    const at = 28 + i * 16;
    tables.push({
      type: buffer.readUInt32LE(at),
      emptyCandidate: buffer.readUInt32LE(at + 4),
      firstPage: buffer.readUInt32LE(at + 8),
      lastPage: buffer.readUInt32LE(at + 12),
    });
  }
  return {
    pageSize,
    numTables,
    nextUnusedPage: buffer.readUInt32LE(12),
    sequence: buffer.readUInt32LE(20),
    tables,
  };
}

/**
 * Row payloads of one data page, in insertion order.
 * @param {Buffer} page a single 4096-byte page
 * @returns {Buffer[]} row buffers, padding included
 */
export function readPageRows(page) {
  const raw = page.readUIntLE(24, 3);
  const numRows = raw & 0x1fff;
  if (numRows === 0) return [];
  const topSize = page.readUInt16LE(30);
  const sets = Math.ceil(numRows / MAX_ROWS_PER_ROWSET);

  const positions = [];
  for (let set = 0; set < sets; set += 1) {
    const base = PAGE_SIZE - ROWSET_SIZE * (set + 1);
    for (let slot = 0; slot < MAX_ROWS_PER_ROWSET; slot += 1) {
      positions.push(page.readUInt16LE(base + (MAX_ROWS_PER_ROWSET - 1 - slot) * 2));
    }
  }

  const rows = [];
  for (let i = 0; i < numRows; i += 1) {
    const start = DATA_HEADER_TOTAL + positions[i];
    const end =
      i + 1 < numRows ? DATA_HEADER_TOTAL + positions[i + 1] : DATA_HEADER_TOTAL + topSize;
    if (end <= start || end > PAGE_SIZE) break;
    rows.push(page.subarray(start, end));
  }
  return rows;
}

/**
 * One page with its header fields and rows.
 * @param {Buffer} buffer whole file
 * @param {number} pageIndex page to read
 * @returns {{index: number, type: number, nextPage: number, numRows: number, rows: Buffer[]}}
 */
export function readPage(buffer, pageIndex) {
  const at = pageIndex * PAGE_SIZE;
  if (at + PAGE_SIZE > buffer.length) throw new Error(`page ${pageIndex} is past the end`);
  const page = buffer.subarray(at, at + PAGE_SIZE);
  const rows = readPageRows(page);
  return {
    index: page.readUInt32LE(4),
    type: page.readUInt32LE(8),
    nextPage: page.readUInt32LE(12),
    numRows: rows.length,
    rows,
  };
}

/**
 * Follow a table's page chain and collect its rows.
 * @param {Buffer} buffer whole file
 * @param {number} firstPage first page of the table, or the empty sentinel
 * @returns {Buffer[]} every row the table carries
 */
export function readTableRows(buffer, firstPage) {
  const rows = [];
  let pageIndex = firstPage;
  const seen = new Set();
  while (pageIndex !== EMPTY_TABLE_SENTINEL && pageIndex < buffer.length / PAGE_SIZE) {
    if (seen.has(pageIndex)) break;
    seen.add(pageIndex);
    const page = readPage(buffer, pageIndex);
    rows.push(...page.rows);
    pageIndex = page.nextPage;
  }
  return rows;
}

/**
 * Read the whole database.
 * @param {Buffer} buffer whole file
 * @returns {{header: object, tables: Map<number, Buffer[]>, pageCount: number}}
 */
export function readPdb(buffer) {
  const header = readHeader(buffer);
  const tables = new Map();
  for (const table of header.tables) {
    tables.set(table.type, readTableRows(buffer, table.firstPage));
  }
  return { header, tables, pageCount: Math.floor(buffer.length / PAGE_SIZE) };
}

/**
 * Decode one DeviceSQL string.
 *
 * Only the three forms the writer emits are handled: short ASCII, long ASCII and
 * long UTF-16. Anything else is reported instead of guessed at.
 * @param {Buffer} row buffer holding the string
 * @param {number} offset where the string header starts
 * @returns {{value: string, length: number, next: number}} decoded text and the offset after it
 */
export function decodeDeviceSQLString(row, offset = 0) {
  const head = row[offset];
  if (head === undefined) throw new Error('string offset is past the row');

  if (head === 0x40) {
    const total = row.readUInt16LE(offset + 1);
    const length = total - 4;
    return {
      value: row.toString('ascii', offset + 4, offset + 4 + length),
      length: total,
      next: offset + total,
    };
  }

  if (head === 0x90) {
    const total = row.readUInt16LE(offset + 1);
    const bytes = total - 4;
    return {
      value: row.toString('utf16le', offset + 4, offset + 4 + bytes),
      length: total,
      next: offset + total,
    };
  }

  if (head & 0x01) {
    const length = (head >> 1) - 1;
    return {
      value: row.toString('ascii', offset + 1, offset + 1 + length),
      length: length + 1,
      next: offset + length + 1,
    };
  }

  throw new Error(`unsupported string header 0x${head.toString(16)} at ${offset}`);
}

/** Bytes of fixed fields at the start of a track row. */
const TRACK_HEADER_BYTES = 94;

/** String slots a track row carries, in the order the writer emits them. */
const TRACK_STRINGS = 21;

/**
 * Offset of one string slot inside a track row.
 * @param {Buffer} row
 * @param {number} index slot number
 * @returns {number} offset from the start of the row
 */
function trackStringOffset(row, index) {
  return row.readUInt16LE(TRACK_HEADER_BYTES + index * 2);
}

/**
 * ISRC uses its own fixed form: 0x90, total length, 0x00, 0x03, ASCII, 0x00.
 * @param {Buffer} row
 * @param {number} at offset of the string header
 * @returns {string}
 */
function decodeIsrc(row, at) {
  if (at <= 0 || at + 5 > row.length || row[at] !== 0x90 || row[at + 4] !== 0x03) return '';
  const total = row.readUInt16LE(at + 1);
  const length = total - 6;
  if (length <= 0) return '';
  return row.toString('ascii', at + 5, at + 5 + length);
}

/**
 * Decode a track row into the fields the writer stored.
 *
 * Offsets mirror `buildTrackRow`; when Pioneer changes a column, both sides have
 * to move together, which is why they sit next to each other in the same tree.
 * @param {Buffer} row
 * @returns {object} the track as the database describes it
 */
export function decodeTrackRow(row) {
  if (row.length < TRACK_HEADER_BYTES + TRACK_STRINGS * 2) {
    throw new Error(`track row is too short (${row.length} bytes)`);
  }
  const str = (index) => {
    const at = trackStringOffset(row, index);
    if (at <= 0 || at >= row.length) return '';
    try {
      return decodeDeviceSQLString(row, at).value;
    } catch {
      return '';
    }
  };

  return {
    id: row.readUInt32LE(72),
    artistId: row.readUInt32LE(68),
    albumId: row.readUInt32LE(64),
    genreId: row.readUInt32LE(60),
    keyId: row.readUInt32LE(32),
    labelId: row.readUInt32LE(40),
    artworkId: row.readUInt32LE(28),
    composerId: row.readUInt32LE(12),
    remixerId: row.readUInt32LE(44),
    originalArtistId: row.readUInt32LE(36),
    title: str(17),
    filename: str(19),
    filePath: str(20),
    comment: str(16),
    composer: str(1),
    mixName: str(12),
    analyzePath: str(14),
    message: str(5),
    isrc: decodeIsrc(row, trackStringOffset(row, 0)),
    sampleRate: row.readUInt32LE(8),
    fileSize: row.readUInt32LE(16),
    bitrate: row.readUInt32LE(48),
    trackNumber: row.readUInt32LE(52),
    bpm: row.readUInt32LE(56) / 100,
    year: row.readUInt16LE(80),
    duration: row.readUInt16LE(84),
    discNumber: row.readUInt16LE(76),
    playCount: row.readUInt16LE(78),
    sampleDepth: row.readUInt16LE(82),
    colorId: row.readUInt8(88),
    rating: row.readUInt8(89),
    fileType: row.readUInt16LE(90),
  };
}

/**
 * Decode an artist row.
 * @param {Buffer} row
 * @returns {{id: number, name: string}}
 */
export function decodeArtistRow(row) {
  // The name offset is stored in the row: 0x0a normally, 0x0c when the name is
  // a long UTF-16 string, which the writer aligns to four bytes (issue #3).
  // Reading the stored byte keeps this in step with buildArtistRow.
  const nameAt = row[9] || 10;
  return { id: row.readUInt32LE(4), name: decodeDeviceSQLString(row, nameAt).value };
}

/**
 * Decode an album row.
 * @param {Buffer} row
 * @returns {{id: number, artistId: number, name: string}}
 */
export function decodeAlbumRow(row) {
  // Stored offset, same rule as the artist row: 0x16, or 0x18 for a long string.
  const nameAt = row[21] || 22;
  return {
    id: row.readUInt32LE(12),
    artistId: row.readUInt32LE(8),
    name: decodeDeviceSQLString(row, nameAt).value,
  };
}

/**
 * Decode a key row.
 * @param {Buffer} row
 * @returns {{id: number, name: string}}
 */
export function decodeKeyRow(row) {
  return { id: row.readUInt32LE(4), name: decodeDeviceSQLString(row, 8).value };
}

/**
 * Decode a colour row.
 * @param {Buffer} row
 * @returns {{id: number, name: string}}
 */
export function decodeColorRow(row) {
  return { id: row.readUInt16LE(5), name: decodeDeviceSQLString(row, 8).value };
}

/**
 * Decode a playlist tree row.
 * @param {Buffer} row
 * @returns {{id: number, parentId: number, sortOrder: number, isFolder: boolean, name: string}}
 */
export function decodePlaylistTreeRow(row) {
  return {
    id: row.readUInt32LE(12),
    parentId: row.readUInt32LE(0),
    sortOrder: row.readUInt32LE(8),
    isFolder: row.readUInt32LE(16) === 1,
    name: decodeDeviceSQLString(row, 20).value,
  };
}

/**
 * Decode a playlist entry row.
 * @param {Buffer} row
 * @returns {{entryIndex: number, trackId: number, playlistId: number}}
 */
export function decodePlaylistEntryRow(row) {
  return {
    entryIndex: row.readUInt32LE(0),
    trackId: row.readUInt32LE(4),
    playlistId: row.readUInt32LE(8),
  };
}

/**
 * Group playlist entries by the playlist they belong to, in entry order.
 * @param {Array<{entryIndex: number, trackId: number, playlistId: number}>} entries
 * @returns {Map<number, number[]>} playlist id to track ids
 */
export function groupPlaylistEntries(entries) {
  const grouped = new Map();
  for (const entry of [...entries].sort((a, b) => a.entryIndex - b.entryIndex)) {
    if (!grouped.has(entry.playlistId)) grouped.set(entry.playlistId, []);
    grouped.get(entry.playlistId).push(entry.trackId);
  }
  return grouped;
}

/**
 * Read and decode everything a stick's database carries.
 * @param {Buffer} buffer whole file
 * @returns {{header: object, tracks: object[], artists: object[], albums: object[], keys: object[], colors: object[], playlists: object[], tracksByPlaylist: Map<number, number[]>}}
 */
export function readLibrary(buffer) {
  const { header, tables } = readPdb(buffer);
  const rowsOf = (type) => tables.get(type) ?? [];
  const entries = rowsOf(8).map(decodePlaylistEntryRow);

  return {
    header,
    tracks: rowsOf(0).map(decodeTrackRow),
    artists: rowsOf(2).map(decodeArtistRow),
    albums: rowsOf(3).map(decodeAlbumRow),
    keys: rowsOf(5).map(decodeKeyRow),
    colors: rowsOf(6).map(decodeColorRow),
    playlists: rowsOf(7).map(decodePlaylistTreeRow),
    entries,
    tracksByPlaylist: groupPlaylistEntries(entries),
  };
}
