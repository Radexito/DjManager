#!/usr/bin/env python3
"""
anlz-diff.py  — Diff two ANLZ files section by section (Python complement to
                scripts/anlz-diff.js which handles PCOB/PCO2 detail).

This script focuses on waveform sections and beatgrid math — areas the JS
tool doesn't decode. For cue point detail use the JS tool.

Usage:
    python3 anlz-diff.py A/ANLZ0000.DAT B/ANLZ0000.DAT
    python3 anlz-diff.py captures/20-gain-default captures/21-gain-plus6db
        (auto-finds first ANLZ0000.DAT inside each folder)
    python3 anlz-diff.py captures/20-gain-default captures/21-gain-plus6db --ext .EXT
    python3 anlz-diff.py A.DAT B.DAT --section PQT2
    python3 anlz-diff.py A.DAT B.DAT --all-sections   # include identical sections
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(__file__))
from _lib import parse_anlz, decode_section_body, hexlines, hexdiff_row, KNOWN_SECTIONS, find_anlz


def diff_sections(secs_a, secs_b, limit, section_filter=None, show_all=False):
    map_a = {}
    map_b = {}
    # Use list of (tag, instance_index) to handle duplicate tags (PCOB appears twice)
    tags_ordered = []
    seen = {}
    for s in secs_a:
        i = seen.get(s["tag"], 0)
        map_a[(s["tag"], i)] = s
        seen[s["tag"]] = i + 1
        tags_ordered.append((s["tag"], i))
    seen = {}
    for s in secs_b:
        i = seen.get(s["tag"], 0)
        map_b[(s["tag"], i)] = s
        seen[s["tag"]] = i + 1
        if (s["tag"], i) not in tags_ordered:
            tags_ordered.append((s["tag"], i))

    found_diff = False
    for key in tags_ordered:
        tag, idx = key
        label = tag if idx == 0 else f"{tag}#{idx}"
        if section_filter and tag != section_filter:
            continue

        a = map_a.get(key)
        b = map_b.get(key)

        if a is None:
            found_diff = True
            print(f"\n[{label}]  ADDED in B  ({KNOWN_SECTIONS.get(tag, 'unknown')})")
            print(hexlines(b["body"], limit=limit))
            continue
        if b is None:
            found_diff = True
            print(f"\n[{label}]  REMOVED in B  ({KNOWN_SECTIONS.get(tag, 'unknown')})")
            print(hexlines(a["body"], limit=limit))
            continue
        if a["raw"] == b["raw"]:
            if show_all:
                print(f"[{label}]  identical  ({a['len_tag']} bytes)")
            continue

        found_diff = True
        raw_a, raw_b = a["raw"], b["raw"]
        changed = [i for i in range(max(len(raw_a), len(raw_b)))
                   if (raw_a[i] if i < len(raw_a) else None) != (raw_b[i] if i < len(raw_b) else None)]

        print(f"\n[{label}]  CHANGED  ({KNOWN_SECTIONS.get(tag, 'unknown')})")
        print(f"         A: {a['len_tag']} bytes   B: {b['len_tag']} bytes")
        print(f"         {len(changed)} byte(s) differ at section-relative offsets: "
              f"{changed[:40]}{'...' if len(changed) > 40 else ''}")

        dec_a = decode_section_body(tag, a["body"])
        dec_b = decode_section_body(tag, b["body"])
        if dec_a or dec_b:
            if dec_a != dec_b:
                print(f"         A: {dec_a.replace(chr(10), chr(10)+'         ')}")
                print(f"         B: {dec_b.replace(chr(10), chr(10)+'         ')}")

        rows_shown = sorted({(off // 16) * 16 for off in changed})
        for row in rows_shown:
            ca = raw_a[row : row + 16] if row < len(raw_a) else b""
            cb = raw_b[row : row + 16] if row < len(raw_b) else b""
            print(hexdiff_row(row, ca, cb))

    if not found_diff:
        print("No differences found between the two ANLZ files.")


def main():
    ap = argparse.ArgumentParser(
        description="Diff two ANLZ files section by section (waveform/beatgrid focus)")
    ap.add_argument("a", help="First ANLZ file or capture folder")
    ap.add_argument("b", help="Second ANLZ file or capture folder")
    ap.add_argument("--ext", default=".DAT",
                    help="Extension to search when paths are folders (.DAT/.EXT/.2EX)")
    ap.add_argument("--section", "-s", help="Only compare this section tag (e.g. PQT2)")
    ap.add_argument("--hex-limit", "-l", type=int, default=256,
                    help="Max bytes to show per diff row (0 = unlimited)")
    ap.add_argument("--all-sections", "-a", action="store_true",
                    help="Also print identical sections")
    args = ap.parse_args()

    path_a, path_b = args.a, args.b
    if os.path.isdir(path_a):
        path_a = find_anlz(path_a, args.ext)
        if not path_a:
            sys.exit(f"No ANLZ0000{args.ext} found under {args.a}")
    if os.path.isdir(path_b):
        path_b = find_anlz(path_b, args.ext)
        if not path_b:
            sys.exit(f"No ANLZ0000{args.ext} found under {args.b}")

    data_a = open(path_a, "rb").read()
    data_b = open(path_b, "rb").read()
    secs_a, _ = parse_anlz(data_a)
    secs_b, _ = parse_anlz(data_b)

    print(f"A: {path_a}  ({len(data_a)} bytes)")
    print(f"B: {path_b}  ({len(data_b)} bytes)")
    print(f"A sections: {' '.join(s['tag'] for s in secs_a)}")
    print(f"B sections: {' '.join(s['tag'] for s in secs_b)}")

    limit = None if args.hex_limit == 0 else args.hex_limit
    diff_sections(secs_a, secs_b, limit=limit,
                  section_filter=args.section, show_all=args.all_sections)


if __name__ == "__main__":
    main()
