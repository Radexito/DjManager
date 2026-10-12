#!/usr/bin/env python3
"""Decode a Motorola S-record firmware image by address (overwrite, count overlaps)."""
import sys, re, collections

path, out_path = sys.argv[1], sys.argv[2]
text = open(path, "rb").read()
recs = re.findall(rb"S([0-9])([0-9A-Fa-f]{2})([0-9A-Fa-f]+)", text)
addr_bits = {1: 2, 2: 3, 3: 4}

data_recs = []
entries = []
for kind, cnt, payload in recs:
    k = kind.decode()
    raw = bytes.fromhex(payload.decode())
    if k in ("1", "2", "3"):
        n = addr_bits[int(k)]
        data_recs.append((int.from_bytes(raw[:n], "big"), raw[n:-1]))
    elif k in ("7", "8", "9"):
        entries.append((k, int.from_bytes(raw[:-1], "big")))

print("data records:", len(data_recs), " entry records:", entries)

hi = max(a + len(d) for a, d in data_recs)
img = bytearray(b"\xff" * hi)
written = bytearray(hi)          # 1 = byte was written at least once
overlaps = 0
overlap_bytes = 0
for a, d in data_recs:
    seg = written[a:a + len(d)]
    if any(seg):
        overlaps += 1
        overlap_bytes += sum(seg)
    img[a:a + len(d)] = d
    for i in range(len(d)):
        written[a + i] = 1
print("image size: 0x%x (%d bytes)" % (hi, hi))
print("records overlapping earlier data:", overlaps, "overwritten bytes:", overlap_bytes)
print("coverage: %.2f%% (unwritten bytes remain 0xff)" % (100 * sum(written) / hi))
print("entry records:", entries)

open(out_path, "wb").write(img)
print("wrote", out_path)

strs = re.findall(rb"[\x20-\x7e]{10,}", bytes(img))
print("\nprintable runs >= 10 in the whole image:", len(strs))
for s in strs[:25]:
    print("   ", s.decode(errors="replace")[:78])
