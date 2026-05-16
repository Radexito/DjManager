#!/usr/bin/env python3
"""
setting-diff.py  — Diff PIONEER SETTING.DAT files, masking the CRC bytes.

The CRC lives at bytes 6-7 of every SETTING.DAT and changes whenever any
other byte changes, so it's always masked out before comparison.

Usage:
    python3 setting-diff.py captures/110-settings-default captures/111-settings-quantize-off
        (auto-finds MYSETTING.DAT, MYSETTING2.DAT, DEVSETTING.DAT in each folder)
    python3 setting-diff.py A/PIONEER/MYSETTING.DAT B/PIONEER/MYSETTING.DAT
    python3 setting-diff.py A B --file DEVSETTING.DAT
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(__file__))
from _lib import hexlines, hexdiff_row


SETTING_FILES = ["MYSETTING.DAT", "MYSETTING2.DAT", "DEVSETTING.DAT"]
CRC_OFFSET = 6   # bytes 6-7 are CRC-16/XMODEM — always ignore when comparing


def find_setting_file(root, filename):
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.upper() == filename.upper():
                return os.path.join(dirpath, f)
    return None


def diff_dat(path_a, path_b, filename):
    data_a = open(path_a, "rb").read()
    data_b = open(path_b, "rb").read()

    # Mask CRC at bytes 6-7
    def mask(d):
        b = bytearray(d)
        if len(b) > 7:
            b[6] = 0
            b[7] = 0
        return bytes(b)

    ma = mask(data_a)
    mb = mask(data_b)

    print(f"\n── {filename} ─────────────────────────────────")
    print(f"   A: {path_a}  ({len(data_a)} bytes)")
    print(f"   B: {path_b}  ({len(data_b)} bytes)")

    crc_a = int.from_bytes(data_a[6:8], "big")
    crc_b = int.from_bytes(data_b[6:8], "big")
    print(f"   CRC A={crc_a:#06x}  CRC B={crc_b:#06x}  (masked in comparison)")

    if ma == mb:
        print("   (no differences beyond CRC)")
        return

    changed = [i for i in range(max(len(ma), len(mb)))
               if (ma[i] if i < len(ma) else None) != (mb[i] if i < len(mb) else None)]
    print(f"   {len(changed)} byte(s) differ at offsets: {changed[:40]}"
          f"{'...' if len(changed) > 40 else ''}")

    rows = sorted({(off // 16) * 16 for off in changed})
    for row in rows:
        ca = data_a[row : row + 16] if row < len(data_a) else b""
        cb = data_b[row : row + 16] if row < len(data_b) else b""
        # Mark CRC bytes as not-changed even if they differ
        note = " (includes CRC offset 6-7)" if row <= 6 < row + 16 else ""
        print(hexdiff_row(row, ca, cb) + note)


def main():
    ap = argparse.ArgumentParser(
        description="Diff SETTING.DAT files between two captures (CRC-masked)")
    ap.add_argument("a", help="First capture folder or specific .DAT file")
    ap.add_argument("b", help="Second capture folder or specific .DAT file")
    ap.add_argument("--file", "-f", default=None,
                    help="Specific file to compare (MYSETTING.DAT / MYSETTING2.DAT / DEVSETTING.DAT)")
    args = ap.parse_args()

    # Direct file comparison
    if os.path.isfile(args.a) and os.path.isfile(args.b):
        filename = os.path.basename(args.a)
        diff_dat(args.a, args.b, filename)
        return

    # Folder comparison — find all three files
    target_files = [args.file] if args.file else SETTING_FILES
    found_any = False
    for filename in target_files:
        pa = find_setting_file(args.a, filename)
        pb = find_setting_file(args.b, filename)
        if not pa and not pb:
            continue
        if not pa:
            print(f"\n{filename}: only in B ({pb})")
            continue
        if not pb:
            print(f"\n{filename}: only in A ({pa})")
            continue
        found_any = True
        diff_dat(pa, pb, filename)

    if not found_any:
        print(f"No SETTING.DAT files found in {args.a} or {args.b}")


if __name__ == "__main__":
    main()
