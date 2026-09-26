#!/usr/bin/env python3
"""Scan decoded component images for real Blackfin code (illegal-rate map, best of 4 phases)."""
import subprocess, sys, re, glob, os

BIN = "/home/radexito/re/binutils/bin/bfin-elf-objdump"


def rate(chunk):
    open("/tmp/w.bin", "wb").write(chunk)
    out = subprocess.run([BIN, "-D", "-b", "binary", "-m", "bfin", "/tmp/w.bin"],
                         capture_output=True, text=True).stdout
    tot = bad = 0
    for line in out.splitlines():
        if re.match(r"\s+[0-9a-f]+:", line):
            tot += 1
            if re.search(r"ILLEGAL|\(invalid\)|<bad>", line):
                bad += 1
    return tot, bad


print("file, sampling every 4 KiB (small files) or 64 KiB (large), best of 4 phases")
print("random-data baseline = 36.7%")
for path in sys.argv[1:]:
    img = open(path, "rb").read()
    step = 4096 if len(img) <= (1 << 20) else 65536
    results = []
    for off in range(0, len(img) - 4096, step):
        best = 100.0
        for ph in range(4):
            tot, bad = rate(img[off + ph:off + ph + 4096])
            if tot:
                best = min(best, 100.0 * bad / tot)
        results.append((off, best))
    code = [r for r in results if r[1] < 5.0]
    print("\n%s  (%d bytes, %d windows sampled)" % (os.path.basename(path), len(img), len(results)))
    print("   windows with <5%% illegal (i.e. looks like real code): %d" % len(code))
    if code:
        print("   ranges:", ", ".join("0x%x(%.1f%%)" % (o, r) for o, r in code[:20]))
    lo, hi = min(results, key=lambda x: x[1]), max(results, key=lambda x: x[1])
    print("   best window 0x%06x %.1f%% | worst window 0x%06x %.1f%%" % (lo[0], lo[1], hi[0], hi[1]))
