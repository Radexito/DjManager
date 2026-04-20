#!/usr/bin/env python3
"""
pdb-diff.py  — Diff two export.pdb files at track-row field level.

Identifies exactly which named fields changed between two captures.
Most useful for gain/normalization reverse-engineering (series 20-25).

Usage:
    python3 pdb-diff.py captures/20-gain-default/export.pdb captures/21-gain-plus6db/export.pdb
    python3 pdb-diff.py A/export.pdb B/export.pdb --match-by title
    python3 pdb-diff.py captures/20-gain-default captures/21-gain-plus6db
        (auto-finds export.pdb in each folder)
    python3 pdb-diff.py A B --raw     # also show raw byte diff of changed rows
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(__file__))
from _lib import (
    parse_pdb_header, iter_table_rows, decode_track_row,
    TRACK_HEADER_FIELDS, STRING_SLOTS, TABLE_NAMES, hexlines, hexdiff_row,
)


def find_pdb(path):
    if os.path.isfile(path):
        return path
    for root, _, files in os.walk(path):
        for f in files:
            if f.lower() == "export.pdb":
                return os.path.join(root, f)
    return None


def load_tracks(data, tables):
    """Return dict of title → decoded row for all tracks."""
    track_table = next((t for t in tables if t["type"] == 0), None)
    if not track_table:
        return {}
    result = {}
    for row_data, abs_off in iter_table_rows(data, track_table["first_page"], 0):
        tr = decode_track_row(row_data, abs_off, data)
        if tr is None:
            continue
        key = tr["_strings"].get("Title") or f"id={tr.get('Id', '?')}"
        result[key] = tr
    return result


def diff_track_row(title, a, b, show_raw):
    print(f"\n── Track: {title!r} ─────────────────────────────────")

    diffs = []
    same = []

    for off, size, fmt, name in TRACK_HEADER_FIELDS:
        va = a.get(name)
        vb = b.get(name)
        if va != vb:
            diffs.append((off, size, name, va, vb))
        else:
            same.append(name)

    # String fields
    str_diffs = []
    for slot in STRING_SLOTS:
        sa = a["_strings"].get(slot, "")
        sb = b["_strings"].get(slot, "")
        if sa != sb:
            str_diffs.append((slot, sa, sb))

    if not diffs and not str_diffs:
        print("   (identical)")
        return

    print(f"   {len(diffs)} header field(s) changed,  "
          f"{len(str_diffs)} string field(s) changed")
    print(f"   {len(same)} header field(s) unchanged")

    if diffs:
        print("\n   Changed header fields:")
        print(f"   {'Off':>4}  {'Field':<42}  {'A':>12}  {'B':>12}")
        print("   " + "-" * 75)
        for off, size, name, va, vb in diffs:
            # Extra decode hints
            hint = ""
            if "Tempo" in name:
                hint = f"  ({va/100:.2f} → {vb/100:.2f} BPM)"
            elif "Rating" in name:
                hint = f"  ({va//51}★ → {vb//51}★)"
            print(f"   {off:>4}  {name:<42}  {va!r:>12}  {vb!r:>12}{hint}")

    if str_diffs:
        print("\n   Changed string fields:")
        for slot, sa, sb in str_diffs:
            print(f"        {slot:<25}  A={sa!r}")
            print(f"        {'':25}  B={sb!r}")

    if show_raw:
        print("\n   Raw header diff (94 bytes):")
        raw_a = a["_raw_header"]
        raw_b = b["_raw_header"]
        for row in range(0, 94, 16):
            ca = raw_a[row : row + 16]
            cb = raw_b[row : row + 16]
            if ca != cb:
                print(hexdiff_row(row, ca, cb))


def main():
    ap = argparse.ArgumentParser(description="Diff PDB track rows between two captures")
    ap.add_argument("a", help="First export.pdb or capture folder")
    ap.add_argument("b", help="Second export.pdb or capture folder")
    ap.add_argument("--raw", action="store_true",
                    help="Show raw header byte diff for changed tracks")
    ap.add_argument("--match-by", choices=["title", "id", "filename"],
                    default="title",
                    help="Field to use to match tracks between files")
    args = ap.parse_args()

    path_a = find_pdb(args.a)
    path_b = find_pdb(args.b)
    if not path_a:
        sys.exit(f"export.pdb not found under: {args.a}")
    if not path_b:
        sys.exit(f"export.pdb not found under: {args.b}")

    data_a = open(path_a, "rb").read()
    data_b = open(path_b, "rb").read()
    _, _, _, tables_a = parse_pdb_header(data_a)
    _, _, _, tables_b = parse_pdb_header(data_b)

    tracks_a = load_tracks(data_a, tables_a)
    tracks_b = load_tracks(data_b, tables_b)

    print(f"A: {path_a}  ({len(data_a)} bytes,  {len(tracks_a)} tracks)")
    print(f"B: {path_b}  ({len(data_b)} bytes,  {len(tracks_b)} tracks)")

    all_keys = sorted(set(tracks_a) | set(tracks_b))
    changed_count = 0

    for key in all_keys:
        a = tracks_a.get(key)
        b = tracks_b.get(key)
        if a is None:
            print(f"\n── Track {key!r}: ONLY IN B")
            continue
        if b is None:
            print(f"\n── Track {key!r}: ONLY IN A")
            continue
        if a["_raw_header"] != b["_raw_header"] or a["_strings"] != b["_strings"]:
            changed_count += 1
            diff_track_row(key, a, b, args.raw)

    if changed_count == 0:
        print("\nAll track rows are identical.")
    else:
        print(f"\n{changed_count} track row(s) changed.")


if __name__ == "__main__":
    main()
