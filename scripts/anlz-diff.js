#!/usr/bin/env node
/**
 * anlz-diff.js — ANLZ file parser and hex-diff tool
 *
 * Usage:
 *   # Parse and pretty-print a single ANLZ file:
 *   node scripts/anlz-diff.js path/to/ANLZ0000.DAT
 *
 *   # Compare native Rekordbox file against ours:
 *   node scripts/anlz-diff.js path/to/native/ANLZ0000.DAT path/to/ours/ANLZ0000.DAT
 *
 * Purpose: reverse-engineer the PCOB2 (memory cue) format for issue #208.
 * Export a track with memory cues from Rekordbox to USB, then run:
 *   node scripts/anlz-diff.js <rekordbox-usb>/PIONEER/USBANLZ/Pxxx/xxxxxxxx/ANLZ0000.DAT <our-export>/PIONEER/USBANLZ/Pxxx/xxxxxxxx/ANLZ0000.DAT
 */

import fs from 'fs';
import path from 'path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function hex(n, width = 8) {
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0');
}

function hexBytes(buf, start, len) {
  return Array.from(buf.slice(start, start + len))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function fourcc(buf, offset) {
  return buf.slice(offset, offset + 4).toString('ascii');
}

// ── Section parser ────────────────────────────────────────────────────────────

function parseSections(buf) {
  const sections = [];
  let pos = 28; // skip 28-byte PMAI header
  while (pos + 12 <= buf.length) {
    const tag = fourcc(buf, pos);
    const lenHdr = buf.readUInt32BE(pos + 4);
    const lenTag = buf.readUInt32BE(pos + 8);
    if (lenTag === 0 || pos + lenTag > buf.length) break;
    sections.push({ tag, lenHdr, lenTag, pos, buf: buf.slice(pos, pos + lenTag) });
    pos += lenTag;
  }
  return sections;
}

// ── Section-specific decoders ─────────────────────────────────────────────────

function decodePcob(sec) {
  const b = sec.buf;
  const type = b.readUInt32BE(12);
  const numCues = b.readUInt16BE(18);
  const memoryCount = b.readUInt32BE(20);

  const lines = [
    `  type          = ${type} (${type === 1 ? 'hot_cues' : 'memory_cues'})`,
    `  num_cues      = ${numCues}`,
    `  memory_count  = ${hex(memoryCount)} (${memoryCount === 0xffffffff ? 'sentinel' : memoryCount})`,
  ];

  // Parse PCPT sub-tags
  let off = 24;
  for (let i = 0; i < numCues && off + 56 <= b.length; i++) {
    const ptag = fourcc(b, off);
    if (ptag !== 'PCPT') {
      lines.push(`  [entry ${i}] unexpected tag: ${ptag}`);
      break;
    }
    const lenHdr = b.readUInt32BE(off + 4);
    const lenTag = b.readUInt32BE(off + 8);
    const hotCue = b.readUInt32BE(off + 12);
    const status = b.readUInt32BE(off + 16);
    const unk20 = b.readUInt32BE(off + 20);
    const orderFirst = b.readUInt16BE(off + 24);
    const orderLast = b.readUInt16BE(off + 26);
    const cueType = b[off + 28];
    const pad29 = b[off + 29];
    const unk30 = b.readUInt16BE(off + 30);
    const timeMs = b.readUInt32BE(off + 32);
    const loopTime = b.readUInt32BE(off + 36);
    const colorIdx = b[off + 40];
    const rawHex = hexBytes(b, off, lenTag);

    lines.push(`  [PCPT entry ${i}]`);
    lines.push(`    tag         = ${ptag}`);
    lines.push(`    len_header  = ${lenHdr}`);
    lines.push(`    len_tag     = ${lenTag}`);
    lines.push(
      `    hot_cue     = ${hotCue} (${hotCue === 0 ? 'memory' : `hot ${String.fromCharCode(64 + hotCue)}`})`
    );
    lines.push(`    status      = ${status} (${statusName(status)})`);
    lines.push(`    unk[20-23]  = ${hex(unk20)}`);
    lines.push(`    order_first = ${hex(orderFirst, 4)}`);
    lines.push(`    order_last  = ${hex(orderLast, 4)}`);
    lines.push(
      `    type        = ${cueType} (${cueType === 1 ? 'cue_point' : cueType === 2 ? 'loop' : 'unknown'})`
    );
    lines.push(`    pad[29]     = ${hex(pad29, 2)}`);
    lines.push(`    unk[30-31]  = ${hex(unk30, 4)}`);
    lines.push(`    time_ms     = ${timeMs} (${(timeMs / 1000).toFixed(3)}s)`);
    lines.push(`    loop_time   = ${hex(loopTime)}`);
    lines.push(`    color_idx   = ${colorIdx}`);
    lines.push(`    raw hex     = ${rawHex}`);
    off += lenTag;
  }

  return lines.join('\n');
}

function statusName(s) {
  return s === 0 ? 'disabled' : s === 1 ? 'enabled' : s === 4 ? 'active_loop' : `unknown(${s})`;
}

function decodePco2(sec) {
  const b = sec.buf;
  const type = b.readUInt32BE(12);
  const numCues = b.readUInt16BE(16);

  const lines = [
    `  type     = ${type} (${type === 1 ? 'hot_cues' : 'memory_cues'})`,
    `  num_cues = ${numCues}`,
  ];

  let off = 20;
  for (let i = 0; i < numCues && off + 16 <= b.length; i++) {
    const ptag = fourcc(b, off);
    if (ptag !== 'PCP2') {
      lines.push(`  [entry ${i}] unexpected tag: ${ptag}`);
      break;
    }
    const lenHdr = b.readUInt32BE(off + 4);
    const lenTag = b.readUInt32BE(off + 8);
    const hotCue = b.readUInt32BE(off + 12);
    const cueType = b[off + 16];
    const timeMs = b.readUInt32BE(off + 20);
    const loopTime = b.readUInt32BE(off + 24);
    const colorId = b[off + 28];
    const rawHex = hexBytes(b, off, Math.min(lenTag, 64));

    lines.push(`  [PCP2 entry ${i}]`);
    lines.push(
      `    hot_cue    = ${hotCue} (${hotCue === 0 ? 'memory' : `hot ${String.fromCharCode(64 + hotCue)}`})`
    );
    lines.push(
      `    type       = ${cueType} (${cueType === 1 ? 'cue_point' : cueType === 2 ? 'loop' : 'unknown'})`
    );
    lines.push(`    time_ms    = ${timeMs} (${(timeMs / 1000).toFixed(3)}s)`);
    lines.push(`    loop_time  = ${hex(loopTime)}`);
    lines.push(`    color_id   = ${colorId}`);
    lines.push(`    len_tag    = ${lenTag}`);
    const fullHex = hexBytes(b, off, lenTag);
    lines.push(`    full hex   = ${fullHex}`);
    off += lenTag;
  }

  return lines.join('\n');
}

// ── Print a single file ───────────────────────────────────────────────────────

function printAnlz(filePath, label) {
  const buf = fs.readFileSync(filePath);
  const magic = fourcc(buf, 0);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${label}: ${path.basename(filePath)}`);
  console.log(`  file size : ${buf.length} bytes`);
  console.log(`  magic     : ${magic}`);
  if (magic !== 'PMAI') {
    console.log('  WARNING: not a PMAI file!');
    return;
  }

  const sections = parseSections(buf);
  console.log(`  sections  : ${sections.map((s) => s.tag).join(', ')}\n`);

  for (const sec of sections) {
    console.log(`── ${sec.tag}  pos=${sec.pos}  len_hdr=${sec.lenHdr}  len_tag=${sec.lenTag}`);
    if (sec.tag === 'PCOB') {
      console.log(decodePcob(sec));
    } else if (sec.tag === 'PCO2') {
      console.log(decodePco2(sec));
    }
  }
}

// ── Diff two files section by section ────────────────────────────────────────

function diffAnlz(nativePath, oursPath) {
  const nBuf = fs.readFileSync(nativePath);
  const oBuf = fs.readFileSync(oursPath);

  const nSecs = parseSections(nBuf);
  const oSecs = parseSections(oBuf);

  console.log('\n' + '='.repeat(70));
  console.log('DIFF: native vs ours');
  console.log(`  native sections : ${nSecs.map((s) => s.tag).join(', ')}`);
  console.log(`  ours   sections : ${oSecs.map((s) => s.tag).join(', ')}`);

  const allTags = [...new Set([...nSecs.map((s) => s.tag), ...oSecs.map((s) => s.tag)])];

  for (const tag of allTags) {
    const nInstances = nSecs.filter((s) => s.tag === tag);
    const oInstances = oSecs.filter((s) => s.tag === tag);

    const count = Math.max(nInstances.length, oInstances.length);
    for (let i = 0; i < count; i++) {
      const n = nInstances[i];
      const o = oInstances[i];

      if (!n) {
        console.log(`\n[${tag}#${i}] MISSING in native (only in ours)`);
        continue;
      }
      if (!o) {
        console.log(`\n[${tag}#${i}] MISSING in ours (only in native)`);
        continue;
      }

      const same = n.buf.equals(o.buf);
      console.log(
        `\n[${tag}#${i}]  native_len=${n.lenTag}  ours_len=${o.lenTag}  ${same ? '✓ IDENTICAL' : '✗ DIFFERS'}`
      );

      if (!same) {
        // Show byte-level diff for PCOB and PCO2
        if (tag === 'PCOB' || tag === 'PCO2') {
          console.log('  NATIVE:');
          console.log(tag === 'PCOB' ? decodePcob(n) : decodePco2(n));
          console.log('  OURS:');
          console.log(tag === 'PCOB' ? decodePcob(o) : decodePco2(o));
        }

        // First 128 differing bytes
        const maxLen = Math.max(n.buf.length, o.buf.length);
        const diffs = [];
        for (let b = 0; b < maxLen && diffs.length < 32; b++) {
          const nb = n.buf[b] ?? -1;
          const ob = o.buf[b] ?? -1;
          if (nb !== ob) {
            diffs.push(`    [+${b}] native=${hex(nb, 2)} ours=${hex(ob, 2)}`);
          }
        }
        if (diffs.length > 0) {
          console.log(`  First ${diffs.length} byte differences:`);
          console.log(diffs.join('\n'));
        }
      }
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage:');
  console.error('  node scripts/anlz-diff.js <file.DAT>                  # parse single file');
  console.error('  node scripts/anlz-diff.js <native.DAT> <ours.DAT>     # diff two files');
  process.exit(1);
}

if (args.length === 1) {
  printAnlz(args[0], 'FILE');
} else {
  printAnlz(args[0], 'NATIVE');
  printAnlz(args[1], 'OURS  ');
  diffAnlz(args[0], args[1]);
}
