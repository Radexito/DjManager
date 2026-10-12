#!/usr/bin/env python3
"""Blackfin code-ness map: illegal-opcode rate per sampled 4 KiB window, best of 4 phases."""
import subprocess, sys, re

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from paths import locate, objdump, scratch  # noqa: E402

BIN = objdump("bfin-elf-objdump")
IMG = str(locate("raw_C2KNXS.comp0.bin", *sys.argv[1:2]))
STEP = int(sys.argv[2]) if len(sys.argv) > 2 else 65536
img = open(IMG, "rb").read()
print("image", IMG, len(img), "bytes; sampling every", STEP)

def illegal_rate(chunk):
    window = scratch()
    window.write_bytes(chunk)
    out = subprocess.run([BIN, "-D", "-b", "binary", "-m", "bfin", str(window)],
                         capture_output=True, text=True).stdout
    tot = bad = 0
    for line in out.splitlines():
        if re.match(r"\s+[0-9a-f]+:", line):
            tot += 1
            if re.search(r"ILLEGAL|\(invalid\)|<bad>", line):
                bad += 1
    return tot, bad

rows = []
for off in range(0, len(img) - 4096, STEP):
    best = 100.0
    for ph in range(4):
        tot, bad = illegal_rate(img[off + ph:off + ph + 4096])
        if tot:
            best = min(best, 100.0 * bad / tot)
    rows.append((off, best))

print("\nwindow offset   best-illegal%%   (random-data baseline is ~36.7%%)")
codeish = [r for r in rows if r[1] < 5.0]
print("windows below 5%% illegal: %d of %d" % (len(codeish), len(rows)))
for off, r in sorted(rows, key=lambda x: x[1])[:25]:
    print("   0x%06x   %5.1f%%" % (off, r))
print("\nhistogram of best-illegal%%:")
import collections
buckets = collections.Counter(int(r // 10) * 10 for _, r in rows)
for k in sorted(buckets):
    print("   %3d-%3d%%: %d" % (k, k + 9, buckets[k]))
