#!/usr/bin/env python3
"""Raw-stream decompression trials: raw deflate, raw LZMA (property search), LZSS."""
import zlib, lzma, sys, math, collections, re

MAXOUT = 1 << 24


def entropy(b):
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def raw_deflate(src, limit=MAXOUT):
    d = zlib.decompressobj(-15)
    out = d.decompress(src, limit)
    if len(out) < 16384:
        raise ValueError("too small")
    return out


LZMA_FILTERS = []
for lc in (0, 1, 2, 3):
    for pb in (0, 1, 2):
        for dict_size in (1 << 16, 1 << 20, 1 << 23):
            LZMA_FILTERS.append([{"id": lzma.FILTER_LZMA1, "lc": lc, "lp": 0, "pb": pb,
                                  "dict_size": dict_size}])


def raw_lzma(src, limit=MAXOUT):
    for filt in LZMA_FILTERS:
        try:
            d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=filt)
            out = d.decompress(src, limit)
            if len(out) >= 16384:
                return out, filt
        except Exception:
            continue
    raise ValueError("no lzma params worked")


def lzss(src, limit=MAXOUT, ei=12, ej=4, r=2, n=1 << 12, f=1 << 4):
    """Classic Okumura LZSS: flag byte, 8 tokens; token 0 = literal, else 12-bit pos + 4-bit len."""
    out = bytearray()
    i = 0
    flags = 0
    nbits = 0
    while i < len(src):
        if nbits == 0:
            flags = src[i]; i += 1; nbits = 8
        bit = flags & 1; flags >>= 1; nbits -= 1
        if bit == 0:
            out.append(src[i]); i += 1
        else:
            if i + 1 >= len(src):
                break
            b0, b1 = src[i], src[i + 1]; i += 2
            pos = b0 | ((b1 >> 4) << 8)
            ln = (b1 & 0x0F) + 3
            start = len(out) - pos - 1
            if start < 0:
                raise ValueError("bad backref")
            for k in range(ln):
                out.append(out[start + k])
        if len(out) > limit:
            raise ValueError("too big")
    if len(out) < 16384:
        raise ValueError("too small")
    return bytes(out)


def trial(name, fn, data, offsets):
    hits = 0
    for off in offsets:
        try:
            res = fn(data[off:off + (1 << 22)])
        except Exception:
            continue
        out = res[0] if isinstance(res, tuple) else res
        runs = [m.group() for m in re.finditer(rb"[\x20-\x7e]{24,}", out[:2 << 20])]
        print("  HIT %s at 0x%x -> %d bytes, entropy %.2f, long text runs %d" %
              (name, off, len(out), entropy(out[:65536]), len(runs)))
        if runs:
            print("      e.g.", runs[0][:70])
        hits += 1
        if hits > 3:
            break
    return hits


img = open(sys.argv[1], "rb").read()
print("image", len(img), "bytes")
# header area, then the region after the fill, then a coarse sweep
offsets = list(range(0, 0x1200, 1)) + \
          list(range(0x10000, 0x14000, 16)) + \
          list(range(0x14000, len(img) - (1 << 22), 0x4000))
print("offsets to try:", len(offsets))

for name, fn in (("raw-deflate", raw_deflate), ("raw-lzma", raw_lzma), ("lzss", lzss)):
    print("\n=== %s ===" % name)
    n = trial(name, fn, img, offsets)
    if not n:
        print("  no hits")
