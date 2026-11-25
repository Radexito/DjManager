/**
 * The `exportExt.pdb` file: the My Tags database a Pioneer export carries next
 * to `export.pdb`.
 *
 * Layout of the file, measured on two native files (a rekordbox export of the
 * rekordcrate demo library and the export rekordbox wrote on the Windows test
 * stick), both 18 pages:
 *
 *   page  0      the file header, nine table entries, `nextUnusedPage` 21
 *   pages 1,3,5  table index pages, one per table type 0..8, `next` points at
 *    … ,17       that table's first data page
 *   pages 2,4,6  data pages. An empty table leaves its page zeroed, which is
 *    … ,18       why the file is always 18 pages even with no tags at all.
 *
 * Data pages are written in the order **type 7, then type 3**: the bookkeeping
 * row gets page 16 and points at 19, the tag page gets 8 and points at 20, and
 * the header then says the next unused page is 21. Writing them the other way
 * round produces a file that differs from rekordbox's in every `next` pointer.
 *
 * The tag rows carry a per-page row index at offset 2, `row * 32`, restarting on
 * every page. {@link DataPage.insertRow} writes that field when it is told the
 * row has an index, so a row is encoded with a placeholder and the page patches
 * it, which is what makes a tree that spills onto a second page come out right.
 */

import { Buffer } from 'node:buffer';

import { encodeExtMetaRow, encodeExtTagRow, encodeExtTrackTagRow } from './ext.js';
import { DataPage, PAGE_SIZE, buildFileHeader, buildIndexPage } from './pdb.js';

/** Same sentinel `export.pdb` uses for "this table has no data page yet". */
const EMPTY_TABLE_SENTINEL = 0x03ffffff;

/** Table types a `exportExt.pdb` file carries, in header order. */
const EXT_TABLE_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** Header word at offset 16, which is 1 in both native files. */
const EXT_HEADER_WORD16 = 1;

/**
 * Put tags in the order the file stores them: each category in `Seq` order
 * followed by its own tags, then tags whose category is missing.
 *
 * The same id can appear more than once in a native file, so rows are tracked by
 * their position in the input, never by id: a tree whose ids repeat still comes
 * out with every row in place.
 *
 * This is a helper for callers that only have positions. The builder itself
 * writes the array it is given, because a caller reading rekordbox's own
 * `myTag` table already has the order in `sequenceNo`.
 *
 * @param {Array<{id:number,name:string,parentId?:number,position?:number,isCategory?:boolean}>} tags
 * @returns {Array<object>} a new array, never the input
 */
export function orderExtTags(tags = []) {
  const rows = tags.map((tag, arrival) => ({
    id: Number(tag.id),
    name: String(tag.name ?? ''),
    parentId: Number(tag.parentId ?? tag.categoryId ?? 0),
    position: Number(tag.position ?? 0),
    isCategory: Boolean(tag.isCategory),
    arrival,
  }));
  const byPosition = (a, b) => a.position - b.position || a.arrival - b.arrival;

  const categories = rows.filter((row) => row.isCategory).sort(byPosition);
  const placed = new Set();

  const ordered = [];
  for (const category of categories) {
    ordered.push(category);
    placed.add(category.arrival);
    const children = rows.filter(
      (row) => !row.isCategory && row.parentId === category.id && !placed.has(row.arrival)
    );
    children.sort(byPosition);
    for (const child of children) {
      ordered.push(child);
      placed.add(child.arrival);
    }
  }
  // A tag whose category is not in the tree still has to be stored: a deck that
  // silently loses tags is worse than one showing them at the end of the list.
  const categoryIds = new Set(categories.map((row) => row.id));
  for (const row of rows.sort(byPosition)) {
    if (placed.has(row.arrival)) continue;
    if (row.isCategory) continue;
    if (categoryIds.has(row.parentId)) continue;
    ordered.push(row);
    placed.add(row.arrival);
  }
  const leftovers = rows.filter((row) => !placed.has(row.arrival)).sort(byPosition);
  for (const row of leftovers) {
    ordered.push(row);
    placed.add(row.arrival);
  }
  return ordered.map(({ id, name, parentId, position, isCategory }) => ({
    id,
    name,
    parentId,
    position,
    isCategory,
  }));
}

/**
 * Build the complete `exportExt.pdb` buffer.
 *
 * @param {{
 *   tags?: Array<object>,
 *   trackTags?: Array<{trackId:number,tagId:number}>,
 *   masterTagId?: number,
 * }} input
 * @returns {Buffer}
 */
export function buildExtPdbBuffer({
  tags = [],
  trackTags = [],
  masterTagId = 0,
  linkType = 4,
} = {}) {
  // The order is the caller's: rekordbox stores the tree in `Seq` order, which is
  // what `myTag.sequenceNo` gives us. Rows are written exactly as they arrive.
  const rows = tags.map((tag) => ({
    id: Number(tag.id),
    name: String(tag.name ?? ''),
    parentId: Number(tag.parentId ?? tag.categoryId ?? 0),
    position: Math.max(0, Number(tag.position ?? 0)),
    isCategory: Boolean(tag.isCategory),
  }));
  const tagsInOrder = rows;
  const rowsByType = new Map(EXT_TABLE_ORDER.map((type) => [type, []]));
  // Which table carries the track/tag junctions is still open (see #57): the two
  // published descriptions disagree between type 4 and type 5, so the caller
  // decides and the deck settles it.
  const linkTable = linkType === 5 ? 5 : 4;

  rowsByType.get(7).push(encodeExtMetaRow({ masterTagId: Number(masterTagId) >>> 0 }));
  for (const tag of tagsInOrder) {
    rowsByType.get(3).push(
      encodeExtTagRow({
        index: 0, // the page patches this with the per-page row index
        id: tag.id,
        name: tag.name,
        categoryId: tag.parentId,
        position: Math.max(0, tag.position),
        isCategory: tag.isCategory,
      })
    );
  }
  for (const link of trackTags) {
    rowsByType
      .get(linkTable)
      .push(encodeExtTrackTagRow({ tagId: link.tagId, contentId: link.contentId ?? link.trackId }));
  }

  const writtenPages = new Map();
  const tableStates = new Map();

  let nextUnusedPage = 1;
  for (const type of EXT_TABLE_ORDER) {
    const indexPageIndex = nextUnusedPage;
    tableStates.set(type, {
      indexPageIndex,
      emptyCandidate: indexPageIndex + 1,
      firstPage: indexPageIndex,
      lastPage: indexPageIndex,
    });
    writtenPages.set(indexPageIndex, buildIndexPage(type, indexPageIndex, EMPTY_TABLE_SENTINEL, 1));
    nextUnusedPage += 2;
  }

  let sequence = 2;
  const writeOrder = [7, 3].concat(linkTable === 4 ? [4] : [5]);
  for (const type of writeOrder) {
    const rows = rowsByType.get(type);
    if (!rows || rows.length === 0) continue;

    const state = tableStates.get(type);
    const firstDataPage = state.emptyCandidate;
    let currentPageIndex = firstDataPage;
    let page = new DataPage(type);

    for (const row of rows) {
      // Tag rows store their own index at offset 2; the page owns that field.
      if (page.insertRow(row, type === 3)) continue;

      writtenPages.set(currentPageIndex, page.toBuffer(currentPageIndex, nextUnusedPage, sequence));
      state.lastPage = currentPageIndex;
      state.emptyCandidate = nextUnusedPage;
      nextUnusedPage += 1;
      sequence += 1;

      currentPageIndex = state.emptyCandidate;
      page = new DataPage(type);
      page.insertRow(row, type === 3);
    }

    writtenPages.set(currentPageIndex, page.toBuffer(currentPageIndex, nextUnusedPage, sequence));
    state.lastPage = currentPageIndex;
    state.emptyCandidate = nextUnusedPage;
    nextUnusedPage += 1;
    sequence += 1;

    const indexPage = buildIndexPage(type, state.indexPageIndex, firstDataPage, 1);
    indexPage.writeUInt32LE(firstDataPage, 44);
    writtenPages.set(state.indexPageIndex, indexPage);
  }

  const maxPage = Math.max(...writtenPages.keys());
  const file = Buffer.alloc((maxPage + 1) * PAGE_SIZE);
  buildFileHeader(tableStates, nextUnusedPage, sequence + 1, {
    tableOrder: EXT_TABLE_ORDER,
    word16: EXT_HEADER_WORD16,
  }).copy(file, 0);
  for (const [pageIndex, pageBuf] of writtenPages) {
    pageBuf.copy(file, pageIndex * PAGE_SIZE);
  }
  return file;
}
