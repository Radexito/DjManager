#!/usr/bin/env python3
"""Split a Pioneer .UPD into its named components and decode each S-record set separately."""
import sys, re, collections, os

path = sys.argv[1]
data = open(path, "rb").read()
print("file:", path, len(data), "bytes")

# manifest: leading CRLF-terminated decimal sizes
pos = 0
sizes = []
while True:
    m = re.match(rb"(\d+)\r\n", data[pos:pos + 16])
    if not m:
        break
    sizes.append(int(m.group(1)))
    pos += m.end()
print("manifest sizes:", sizes, "  manifest ends at", pos)

comps = []
start = pos
for s in sizes:
    comps.append((start, s))
    start += s
print("component ranges (start, size, end):")
for a, s in comps:
    print("   %10d  %10d  %10d" % (a, s, a + s))

for i, (a, s) in enumerate(comps):
    blob = data[a:a + s]
    banner = re.match(rb"[\x20-\x7e]{6,60}", blob)
    name = banner.group(0).decode() if banner else "<no banner>"
    print("\n=== component %d at %d size %d banner: %r" % (i, a, s, name))
    print("    first 48 hex:", blob[:48].hex())

    # find the S-record start (banner area is text/padding, records start at an S0/S1/S2/S3)
    m = re.search(rb"S([0-9])([0-9A-Fa-f]{2})", blob)
    if not m:
        print("    no S-records found")
        continue
    off = m.start()
    print("    S-records start at component offset", off)
    text = blob[off:]
    recs = re.findall(rb"S([0-9])([0-9A-Fa-f]{2})([0-9A-Fa-f]+)", text)
    kinds = collections.Counter(r[0].decode() for r in recs)
    print("    records:", len(recs), dict(kinds))
    addr_bits = {1: 2, 2: 3, 3: 4}
    hi = 0
    entries = []
    for kind, cnt, payload in recs:
        k = kind.decode()
        if not k.isdigit():
            continue
        raw = bytes.fromhex(payload.decode())
        if int(k) in addr_bits:
            ad = int.from_bytes(raw[:addr_bits[int(k)]], "big")
            hi = max(hi, ad + len(raw) - addr_bits[int(k)] - 1)
        elif k in ("7", "8", "9"):
            entries.append((k, hex(int.from_bytes(raw[:-1], "big"))))
    print("    address space 0x0..0x%x (%d bytes), entry records: %s" % (hi, hi, entries))
    img = bytearray(b"\xff" * hi)
    for kind, cnt, payload in recs:
        k = kind.decode()
        if not k.isdigit() or int(k) not in addr_bits:
            continue
        raw = bytes.fromhex(payload.decode())
        ad = int.from_bytes(raw[:addr_bits[int(k)]], "big")
        d = raw[addr_bits[int(k)]:-1]
        img[ad:ad + len(d)] = d
    out = "%s.comp%d.bin" % (os.path.splitext(path)[0], i)
    open(out, "wb").write(img)
    nz = sum(1 for b in img if b != 0xff)
    print("    wrote %s (%d bytes), non-0xff bytes: %d (%.1f%%)" % (out, len(img), nz, 100 * nz / max(1, len(img))))
