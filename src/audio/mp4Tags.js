import fs from 'fs';
import path from 'path';

// #474 — MP4/M4A tag writing with no external dependency.
//
// ffmpeg cannot write the "initial key" field of an MP4: every spelling of
// `-metadata INITIALKEY=...` / `----:com.apple.iTunes:INITIALKEY=...` is silently
// dropped by its mov muxer (verified on copies of real files). So we edit the
// `moov.udta.meta.ilst` atom list ourselves:
//
//   tmpo                 16-bit integer BPM (read by iTunes, Traktor, rekordbox)
//   ---- (freeform)      mean="com.apple.iTunes", name="INITIALKEY",
//                        UTF-8 value  — what Mixed In Key and Serato write
//
// Growing the metadata moves every byte after it, so:
//   * the sizes of ilst / meta / udta / moov are bumped by the inserted bytes;
//   * when moov sits before mdat, all stco/co64 chunk offsets are shifted by the
//     same amount, otherwise players read garbage where the audio used to be
//     (this is the mistake the first prototype made: mutagen could read the
//     tags but the audio no longer decoded).
//
// Everything else in the file (artwork, UPC, unsynced lyrics, isrc, ...) is left
// exactly as it was.

const CONTAINERS = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl', 'meta', 'ilst']);
const FULL_BOX_EXTRA_HEADER = { meta: 4 };

export const INITIALKEY_MEAN = 'com.apple.iTunes';
export const INITIALKEY_NAME = 'INITIALKEY';

/** Walk size+type boxes in [start, end), calling visit(tag, begin, end, depth). */
function walkBoxes(buf, start, end, visit, depth = 0) {
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const tag = buf.toString('latin1', i + 4, i + 8);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) return;
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header || i + size > end) return;
    visit(tag, i, i + size, depth, header);
    if (CONTAINERS.has(tag)) {
      walkBoxes(buf, i + header + (FULL_BOX_EXTRA_HEADER[tag] ?? 0), i + size, visit, depth + 1);
    }
    i += size;
  }
}

/** First box with this tag anywhere in the tree, as { begin, end }. */
export function findBox(buf, tag, start = 0, end = buf.length) {
  let hit = null;
  walkBoxes(buf, start, end, (t, begin, boxEnd) => {
    if (!hit && t === tag) hit = { begin, end: boxEnd };
  });
  return hit;
}

function dataAtom(payload, typeCode) {
  const body = Buffer.alloc(8 + payload.length);
  body.writeUInt32BE(typeCode, 0);
  body.writeUInt32BE(0, 4); // locale
  payload.copy(body, 8);
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(8 + body.length, 0);
  box.write('data', 4, 'latin1');
  body.copy(box, 8);
  return box;
}

function subBox(tag, text) {
  const payload = Buffer.concat([Buffer.alloc(4), Buffer.from(text, 'utf8')]);
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(8 + payload.length, 0);
  box.write(tag, 4, 'latin1');
  payload.copy(box, 8);
  return box;
}

function itemBox(tag, subs) {
  const body = Buffer.concat([Buffer.from(tag, 'latin1'), ...subs]);
  const box = Buffer.alloc(4 + body.length);
  box.writeUInt32BE(4 + body.length, 0);
  body.copy(box, 4);
  return box;
}

/** ilst item holding a 16-bit integer (tmpo). */
export function buildIntItem(tag, value) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(Number(value) & 0xffff, 0);
  return itemBox(tag, [dataAtom(payload, 0x15)]);
}

/** ilst "----" item: mean + name + an UTF-8 data atom. */
export function buildFreeformItem(mean, name, value) {
  return itemBox('----', [
    subBox('mean', mean),
    subBox('name', name),
    dataAtom(Buffer.from(value, 'utf8'), 0x01),
  ]);
}

/** Existing ilst entries as { tag, begin, end } (absolute offsets in `buf`). */
function listIlstItems(buf, ilst) {
  const items = [];
  walkBoxes(buf, ilst.begin + 8, ilst.end, (tag, begin, end, depth) => {
    if (depth === 0) items.push({ tag, begin, end });
  });
  return items;
}

/** Read the BPM/key our writer (or another tag editor) left in an MP4 file. */
export function readMp4Tags(buf) {
  const ilst = findBox(buf, 'ilst');
  if (!ilst) return { bpm: null, key: null };
  let bpm = null;
  let key = null;
  for (const item of listIlstItems(buf, ilst)) {
    if (item.tag === 'tmpo') {
      const data = findBox(buf, 'data', item.begin + 8, item.end);
      if (data && data.end - data.begin >= 18) {
        bpm = buf.readUInt16BE(data.end - 2);
      }
    } else if (item.tag === '----') {
      let mean = null;
      let name = null;
      let value = null;
      walkBoxes(buf, item.begin + 8, item.end, (tag, begin, end, depth) => {
        if (depth !== 0) return;
        const text = buf.toString('utf8', begin + 12, end);
        if (tag === 'mean') mean = text;
        else if (tag === 'name') name = text;
        else if (tag === 'data' && end - begin > 16) value = buf.toString('utf8', begin + 16, end);
      });
      if (mean === INITIALKEY_MEAN && name?.toUpperCase() === INITIALKEY_NAME) key = value;
    }
  }
  return { bpm, key };
}

/**
 * Insert/replace tmpo and the INITIALKEY freeform item in an MP4 buffer.
 * Returns { buffer, inserted, replaced, chunkOffsetsPatched }.
 * The input buffer is never modified.
 */
export function patchMp4Tags(
  buf,
  { bpm = null, key = null, mean = INITIALKEY_MEAN, name = INITIALKEY_NAME } = {}
) {
  const moov = findBox(buf, 'moov');
  if (!moov) throw new Error('not an MP4 file (no moov box)');
  const udta = findBox(buf, 'udta', moov.begin + 8, moov.end);
  if (!udta) throw new Error('MP4 has no udta box');
  const meta = findBox(buf, 'meta', udta.begin + 8, udta.end);
  if (!meta) throw new Error('MP4 has no meta box');
  const ilst = findBox(buf, 'ilst', meta.begin + 12, meta.end);
  if (!ilst) throw new Error('MP4 has no ilst box');

  const wanted = [];
  if (bpm != null)
    wanted.push({ tag: 'tmpo', build: () => buildIntItem('tmpo', Math.round(Number(bpm))) });
  if (key) wanted.push({ tag: '----', build: () => buildFreeformItem(mean, name, key) });

  const existing = listIlstItems(buf, ilst);
  const drop = [];
  const add = [];
  for (const want of wanted) {
    if (want.tag === 'tmpo') {
      for (const item of existing.filter((i) => i.tag === 'tmpo')) drop.push(item);
      add.push(want.build());
    } else if (want.tag === '----') {
      for (const item of existing) {
        if (item.tag !== '----') continue;
        const read = readKeyItem(buf, item);
        if (read.mean === mean && read.name?.toUpperCase() === name.toUpperCase()) drop.push(item);
      }
      add.push(want.build());
    }
  }
  if (add.length === 0) {
    return { buffer: buf, inserted: 0, replaced: 0, chunkOffsetsPatched: 0 };
  }

  const kept = Buffer.concat(
    existing
      .filter((item) => !drop.includes(item))
      .map((item) => buf.subarray(item.begin, item.end))
  );
  const added = Buffer.concat(add);
  const newIlstBody = Buffer.concat([kept, added]);
  const newIlst = Buffer.alloc(8 + newIlstBody.length);
  newIlst.writeUInt32BE(8 + newIlstBody.length, 0);
  newIlst.write('ilst', 4, 'latin1');
  newIlstBody.copy(newIlst, 8);

  const delta = newIlst.length - (ilst.end - ilst.begin);
  const out = Buffer.concat([buf.subarray(0, ilst.begin), newIlst, buf.subarray(ilst.end)]);

  for (const ancestor of [meta, udta, moov]) {
    out.writeUInt32BE(out.readUInt32BE(ancestor.begin) + delta, ancestor.begin);
  }

  const mdat = findBox(buf, 'mdat');
  let chunkOffsetsPatched = 0;
  if (delta !== 0 && mdat && moov.begin < mdat.begin) {
    // Everything after the insert point moved, so every chunk offset must too.
    walkBoxes(out, 0, out.length, (tag, begin, end) => {
      if (tag !== 'stco' && tag !== 'co64') return;
      const count = out.readUInt32BE(begin + 12);
      const wide = tag === 'co64';
      let pos = begin + 16;
      for (let n = 0; n < count && pos + (wide ? 8 : 4) <= end; n += 1) {
        if (wide) {
          out.writeBigUInt64BE(out.readBigUInt64BE(pos) + BigInt(delta), pos);
          pos += 8;
        } else {
          out.writeUInt32BE(out.readUInt32BE(pos) + delta, pos);
          pos += 4;
        }
        chunkOffsetsPatched += 1;
      }
    });
  }

  return { buffer: out, inserted: add.length, replaced: drop.length, chunkOffsetsPatched };
}

function readKeyItem(buf, item) {
  let mean = null;
  let name = null;
  walkBoxes(buf, item.begin + 8, item.end, (tag, begin, end, depth) => {
    if (depth !== 0) return;
    if (tag === 'mean') mean = buf.toString('utf8', begin + 12, end);
    else if (tag === 'name') name = buf.toString('utf8', begin + 12, end);
  });
  return { mean, name };
}

/** Containers this module can write. */
export function supportsMp4Tags(filePath) {
  const ext = path.extname(filePath ?? '').toLowerCase();
  return ext === '.m4a' || ext === '.mp4';
}

/** Write BPM/key into an .m4a/.mp4 file, atomically (temp file + rename). */
export function writeMp4Tags(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing-file' };
  let patched;
  let original;
  try {
    original = fs.readFileSync(filePath);
    patched = patchMp4Tags(original, opts);
  } catch (err) {
    return { ok: false, reason: 'unreadable-container', error: err.message };
  }
  if (patched.inserted === 0) return { ok: true, wrote: [], reason: 'no-values' };
  if (patched.buffer === original) return { ok: true, wrote: [], reason: 'already-current' };

  const tmp = `${filePath}.mp4tmp`;
  try {
    fs.writeFileSync(tmp, patched.buffer);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'write-failed', error: err.message };
  }
  return {
    ok: true,
    wrote: [opts.bpm != null ? 'bpm' : null, opts.key ? 'key' : null].filter(Boolean),
    replaced: patched.replaced,
    chunkOffsetsPatched: patched.chunkOffsetsPatched,
  };
}
