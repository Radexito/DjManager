#!/usr/bin/env python3
"""
anlz-dump.py  — Parse and display every section of a PMAI ANLZ file.

Companion to scripts/anlz-diff.js (which focuses on PCOB/PCO2 cue decoding).
This script focuses on waveform headers, beatgrid math, and raw hex inspection.

Usage:
    python3 anlz-dump.py ANLZ0000.DAT
    python3 anlz-dump.py ANLZ0000.EXT --section PQT2
    python3 anlz-dump.py ANLZ0000.DAT --hex-limit 0          # full hex
    python3 anlz-dump.py ANLZ0000.2EX --section PWV7 --raw   # raw section bytes
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(__file__))
from _lib import parse_anlz, decode_section_body, hexlines, KNOWN_SECTIONS


def main():
    ap = argparse.ArgumentParser(description="Dump PMAI ANLZ file sections")
    ap.add_argument("file", help="ANLZ0000.DAT / .EXT / .2EX")
    ap.add_argument("--section", "-s", help="Only show this tag (e.g. PQT2)")
    ap.add_argument("--hex-limit", "-l", type=int, default=128,
                    help="Max body bytes to hex-dump per section (0 = unlimited)")
    ap.add_argument("--raw", action="store_true",
                    help="Hex-dump full raw section bytes (incl. 12-byte common header)")
    ap.add_argument("--list", action="store_true",
                    help="Only list section names and sizes, no hex")
    args = ap.parse_args()

    data = open(args.file, "rb").read()
    sections, file_len = parse_anlz(data)

    print(f"File     : {args.file}")
    print(f"Size     : {len(data)} bytes  (header says {file_len})")
    print(f"Sections : {' → '.join(s['tag'] for s in sections)}")
    print()

    if args.list:
        print(f"{'Tag':<6} {'Offset':>10} {'len_hdr':>9} {'len_tag':>9} {'body':>7}  Description")
        print("-" * 75)
        for s in sections:
            tag = s["tag"]
            print(f"{tag:<6} {s['offset']:#10x} {s['len_header']:>9} {s['len_tag']:>9} "
                  f"{len(s['body']):>7}  {KNOWN_SECTIONS.get(tag, 'unknown')}")
        return

    for s in sections:
        tag = s["tag"]
        if args.section and tag != args.section:
            continue
        desc = KNOWN_SECTIONS.get(tag, "unknown")
        print(f"[{tag}]  offset={s['offset']:#08x}  len_header={s['len_header']}  "
              f"len_tag={s['len_tag']}  body={len(s['body'])} bytes")
        print(f"         {desc}")
        decoded = decode_section_body(tag, s["body"])
        if decoded:
            for line in decoded.splitlines():
                print(f"         {line}")
        limit = None if args.hex_limit == 0 else args.hex_limit
        payload = s["raw"] if args.raw else s["body"]
        if payload:
            print(hexlines(payload, limit=limit))
        print()


if __name__ == "__main__":
    main()
