#!/usr/bin/env python3
"""
capture-diff.py  — Umbrella diff of two complete capture folders.

Runs all relevant diffs (ANLZ .DAT, .EXT, .2EX, PDB, all SETTING.DAT files)
and prints a structured summary. Designed to produce output short enough to
paste into a conversation without burning tokens on raw hex.

Usage:
    python3 capture-diff.py captures/20-gain-default captures/21-gain-plus6db
    python3 capture-diff.py captures/20-gain-default captures/21-gain-plus6db --verbose
    python3 capture-diff.py captures/20-gain-default captures/21-gain-plus6db --pdb-raw
"""

import sys
import os
import argparse
import importlib.util

sys.path.insert(0, os.path.dirname(__file__))
from _lib import (
    parse_anlz, decode_section_body, hexdiff_row, KNOWN_SECTIONS,
    parse_pdb_header, iter_table_rows, decode_track_row,
    TRACK_HEADER_FIELDS, STRING_SLOTS, find_anlz,
)


# ── helpers ───────────────────────────────────────────────────────────────────

SETTING_FILES = ["MYSETTING.DAT", "MYSETTING2.DAT", "DEVSETTING.DAT"]


def find_file(root, name):
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.upper() == name.upper():
                return os.path.join(dirpath, f)
    return None


def section_summary(tag, a, b):
    """Return one-line summary of what changed in a section."""
    dec_a = decode_section_body(tag, a["body"])
    dec_b = decode_section_body(tag, b["body"])
    raw_a, raw_b = a["raw"], b["raw"]
    changed = sum(1 for i in range(max(len(raw_a), len(raw_b)))
                  if (raw_a[i] if i < len(raw_a) else None) != (raw_b[i] if i < len(raw_b) else None))
    lines = [f"  [{tag}]  {changed} byte(s) changed  ({KNOWN_SECTIONS.get(tag,'unknown')})"]
    if dec_a and dec_a != dec_b:
        lines.append(f"    A: {dec_a.splitlines()[0]}")
        lines.append(f"    B: {dec_b.splitlines()[0]}")
    return "\n".join(lines)


def diff_anlz_file(path_a, path_b, ext, verbose):
    data_a = open(path_a, "rb").read()
    data_b = open(path_b, "rb").read()
    secs_a, _ = parse_anlz(data_a)
    secs_b, _ = parse_anlz(data_b)

    map_a = {}
    map_b = {}
    seen = {}
    for s in secs_a:
        i = seen.get(s["tag"], 0)
        map_a[(s["tag"], i)] = s
        seen[s["tag"]] = i + 1
    seen = {}
    for s in secs_b:
        i = seen.get(s["tag"], 0)
        map_b[(s["tag"], i)] = s
        seen[s["tag"]] = i + 1

    all_keys = list(dict.fromkeys(list(map_a) + list(map_b)))
    diffs = []
    for key in all_keys:
        tag, idx = key
        a = map_a.get(key)
        b = map_b.get(key)
        if a is None:
            diffs.append(f"  [{tag}]  ADDED in B")
        elif b is None:
            diffs.append(f"  [{tag}]  REMOVED in B")
        elif a["raw"] != b["raw"]:
            diffs.append(section_summary(tag, a, b))

    print(f"\n  ANLZ0000{ext}  {'CHANGED' if diffs else 'identical'}")
    if diffs:
        for d in diffs:
            print(d)
        if verbose:
            print(f"    A: {path_a}")
            print(f"    B: {path_b}")
            print(f"    tip: python3 reverse-engineering/scripts/anlz-diff.py {path_a} {path_b} --ext {ext}")


def diff_pdb(path_a, path_b, show_raw, verbose):
    data_a = open(path_a, "rb").read()
    data_b = open(path_b, "rb").read()
    _, _, _, tables_a = parse_pdb_header(data_a)
    _, _, _, tables_b = parse_pdb_header(data_b)

    def load_tracks(data, tables):
        tt = next((t for t in tables if t["type"] == 0), None)
        if not tt:
            return {}
        out = {}
        for row_data, abs_off in iter_table_rows(data, tt["first_page"], 0):
            tr = decode_track_row(row_data, abs_off, data)
            if tr:
                out[tr["_strings"].get("Title") or f"id={tr.get('Id')}"] = tr
        return out

    tracks_a = load_tracks(data_a, tables_a)
    tracks_b = load_tracks(data_b, tables_b)

    changed_tracks = 0
    for key in sorted(set(tracks_a) | set(tracks_b)):
        a = tracks_a.get(key)
        b = tracks_b.get(key)
        if a is None or b is None:
            print(f"  PDB: track {key!r} {'only in B' if a is None else 'only in A'}")
            continue
        field_diffs = [(off, size, name, a.get(name), b.get(name))
                       for off, size, fmt, name in TRACK_HEADER_FIELDS
                       if a.get(name) != b.get(name)]
        str_diffs = [(slot, a["_strings"].get(slot,""), b["_strings"].get(slot,""))
                     for slot in STRING_SLOTS
                     if a["_strings"].get(slot) != b["_strings"].get(slot)]
        if not field_diffs and not str_diffs:
            continue
        changed_tracks += 1
        print(f"\n  PDB track {key!r}: {len(field_diffs)} header field(s) + {len(str_diffs)} string(s) changed")
        for off, size, name, va, vb in field_diffs:
            print(f"    offset {off:>3}  {name:<40}  {va!r} → {vb!r}")
        for slot, sa, sb in str_diffs:
            print(f"    string  {slot:<38}  {sa!r} → {sb!r}")
        if show_raw:
            raw_a = a["_raw_header"]
            raw_b = b["_raw_header"]
            for row in range(0, 94, 16):
                ca, cb = raw_a[row:row+16], raw_b[row:row+16]
                if ca != cb:
                    print(hexdiff_row(row, ca, cb))

    if changed_tracks == 0:
        print("  PDB track rows: identical")


def diff_setting(path_a, path_b, filename):
    data_a = open(path_a, "rb").read()
    data_b = open(path_b, "rb").read()

    def mask(d):
        b = bytearray(d)
        if len(b) > 7:
            b[6] = 0
            b[7] = 0
        return bytes(b)

    if mask(data_a) == mask(data_b):
        print(f"  {filename}: identical (CRC masked)")
        return

    changed = [i for i in range(max(len(data_a), len(data_b)))
               if i not in (6, 7) and
               (data_a[i] if i < len(data_a) else None) != (data_b[i] if i < len(data_b) else None)]
    print(f"  {filename}: {len(changed)} byte(s) changed at offsets {changed[:20]}"
          f"{'...' if len(changed) > 20 else ''}")


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="Full diff of two capture folders (ANLZ + PDB + SETTING.DAT)")
    ap.add_argument("a", help="First capture folder")
    ap.add_argument("b", help="Second capture folder")
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="Print file paths and drill-down tips")
    ap.add_argument("--pdb-raw", action="store_true",
                    help="Print raw header byte diffs for changed track rows")
    args = ap.parse_args()

    print(f"Comparing:")
    print(f"  A = {args.a}")
    print(f"  B = {args.b}")

    # ── ANLZ files ────────────────────────────────────────────────────────────
    print("\n=== ANLZ ===")
    for ext in [".DAT", ".EXT", ".2EX"]:
        pa = find_anlz(args.a, ext)
        pb = find_anlz(args.b, ext)
        if not pa and not pb:
            continue
        if not pa:
            print(f"  ANLZ0000{ext}: only in B ({pb})")
            continue
        if not pb:
            print(f"  ANLZ0000{ext}: only in A ({pa})")
            continue
        diff_anlz_file(pa, pb, ext, args.verbose)

    # ── PDB ───────────────────────────────────────────────────────────────────
    print("\n=== PDB ===")
    pa = find_file(args.a, "export.pdb")
    pb = find_file(args.b, "export.pdb")
    if not pa or not pb:
        print(f"  export.pdb missing in {'A' if not pa else 'B'}")
    else:
        diff_pdb(pa, pb, args.pdb_raw, args.verbose)
        if args.verbose:
            print(f"\n  tip: python3 reverse-engineering/scripts/pdb-diff.py {args.a} {args.b}")

    # ── SETTING.DAT ───────────────────────────────────────────────────────────
    print("\n=== SETTING.DAT ===")
    for fname in SETTING_FILES:
        pa = find_file(args.a, fname)
        pb = find_file(args.b, fname)
        if not pa or not pb:
            continue
        diff_setting(pa, pb, fname)
    if args.verbose:
        print(f"\n  tip: python3 reverse-engineering/scripts/setting-diff.py {args.a} {args.b}")


if __name__ == "__main__":
    main()
