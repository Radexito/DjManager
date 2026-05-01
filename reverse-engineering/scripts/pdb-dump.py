#!/usr/bin/env python3
"""
pdb-dump.py  — Dump the contents of a Rekordbox export.pdb file.

Decodes track rows with all named fields and string heap values.
Also lists Artists, Albums, Keys, Genres, Labels with their IDs.

Usage:
    python3 pdb-dump.py export.pdb
    python3 pdb-dump.py export.pdb --table tracks
    python3 pdb-dump.py export.pdb --table keys
    python3 pdb-dump.py export.pdb --table tracks --id 1     # single track by pdb id
    python3 pdb-dump.py export.pdb --raw-header              # show raw 94-byte header bytes
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(__file__))
from _lib import (
    parse_pdb_header, iter_table_rows, decode_track_row, decode_key_row,
    decode_artist_row, decode_album_row, decode_genre_row,
    TRACK_HEADER_FIELDS, STRING_SLOTS, TABLE_NAMES, hexlines,
)


def dump_tracks(data, tables, target_id=None, raw_header=False):
    track_table = next((t for t in tables if t["type"] == 0), None)
    if not track_table or track_table["first_page"] == track_table["empty_candidate"]:
        print("Tracks table: empty")
        return

    row_count = 0
    for row_data, abs_off in iter_table_rows(data, track_table["first_page"], 0):
        tr = decode_track_row(row_data, abs_off, data)
        if tr is None:
            continue
        track_id = tr.get("Id", 0)
        if target_id and track_id != target_id:
            continue
        row_count += 1

        print(f"\n── Track id={track_id} ─────────────────────────────────")
        if raw_header:
            print("   Raw 94-byte header:")
            print(hexlines(tr["_raw_header"], indent="     "))
            print()

        for off, size, fmt, name in TRACK_HEADER_FIELDS:
            val = tr.get(name)
            # Extra decoding for known fields
            extra = ""
            if "Tempo" in name and val:
                extra = f"  →  {val / 100:.2f} BPM"
            elif "Rating" in name:
                stars = val // 51 if val else 0
                extra = f"  →  {stars}★"
            elif "FileType" in name:
                ft = {1: "mp3", 4: "aac/m4a", 5: "flac", 11: "wav"}
                extra = f"  →  {ft.get(val, 'unknown')}"
            elif "Duration" in name:
                extra = f"  →  {val}s = {val//60}:{val%60:02d}"
            print(f"   {off:>3}  {name:<40} {val!r}{extra}")

        print()
        print("   String heap:")
        for slot, val in tr["_strings"].items():
            if val:
                print(f"        {slot:<25} {val!r}")

    if row_count == 0:
        print("(no matching track rows found)")
    else:
        print(f"\nTotal: {row_count} track row(s)")


def dump_simple_table(data, tables, table_type, decoder, label):
    tbl = next((t for t in tables if t["type"] == table_type), None)
    if not tbl or tbl["first_page"] == tbl["empty_candidate"]:
        print(f"{label} table: empty")
        return
    rows = []
    for row_data, _ in iter_table_rows(data, tbl["first_page"], table_type):
        r = decoder(row_data)
        if r:
            rows.append(r)
    if not rows:
        print(f"{label} table: no decodable rows")
        return
    print(f"{label} ({len(rows)} rows):")
    for r in rows:
        print(f"  {r}")


def dump_table_overview(tables):
    print(f"{'Type':>5}  {'Name':<22}  {'first_pg':>9}  {'last_pg':>8}  {'empty_cand':>11}")
    print("-" * 65)
    for t in tables:
        name = TABLE_NAMES.get(t["type"], f"Unknown{t['type']}")
        has_data = "data" if t["first_page"] != t["empty_candidate"] else "empty"
        print(f"  {t['type']:>3}  {name:<22}  {t['first_page']:>9}  {t['last_page']:>8}"
              f"  {t['empty_candidate']:>11}  {has_data}")


def main():
    ap = argparse.ArgumentParser(description="Dump Rekordbox export.pdb contents")
    ap.add_argument("file", help="export.pdb path")
    ap.add_argument("--table", "-t",
                    choices=["all", "tracks", "artists", "albums", "keys", "genres", "labels"],
                    default="all", help="Which table to dump")
    ap.add_argument("--id", type=int, help="Only show track with this PDB id")
    ap.add_argument("--raw-header", action="store_true",
                    help="Print raw 94 header bytes for each track row")
    args = ap.parse_args()

    data = open(args.file, "rb").read()
    num_tables, next_unused, sequence, tables = parse_pdb_header(data)

    print(f"File       : {args.file}")
    print(f"Size       : {len(data)} bytes  ({len(data)//4096} pages)")
    print(f"Tables     : {num_tables}")
    print(f"NextUnused : page {next_unused}")
    print(f"Sequence   : {sequence}")
    print()
    dump_table_overview(tables)
    print()

    t = args.table
    if t in ("all", "tracks"):
        dump_tracks(data, tables, target_id=args.id, raw_header=args.raw_header)
    if t in ("all", "artists"):
        dump_simple_table(data, tables, 2, decode_artist_row, "Artists")
    if t in ("all", "albums"):
        dump_simple_table(data, tables, 3, decode_album_row, "Albums")
    if t in ("all", "keys"):
        dump_simple_table(data, tables, 5, decode_key_row, "Keys")
    if t in ("all", "genres"):
        dump_simple_table(data, tables, 1, decode_genre_row, "Genres")
    if t in ("all", "labels"):
        dump_simple_table(data, tables, 4, decode_artist_row, "Labels")


if __name__ == "__main__":
    main()
