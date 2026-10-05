#!/usr/bin/env python3
"""Try byte-oriented LZ formats (LZ4 block, Snappy, LZF) against the MAIN image."""
import sys, math, collections, re

MAXOUT = 1 << 26


def entropy(b):
    if not b:
        return 0.0
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def lz4_block(src, limit=MAXOUT):
    out = bytearray()
    i = 0
    n = len(src)
    while i < n:
        token = src[i]; i += 1
        ll = token >> 4
        if ll == 15:
            while True:
                if i >= n: raise ValueError
                b = src[i]; i += 1; ll += b
                if b != 255: break
        if i + ll > n: raise ValueError
        out += src[i:i + ll]; i += ll
        if i >= n: break
        if i + 2 > n: raise ValueError
        off = src[i] | (src[i + 1] << 8); i += 2
        ml = token & 0x0F
        if ml == 15:
            while True:
                if i >= n: raise ValueError
                b = src[i]; i += 1; ml += b
                if b != 255: break
        ml += 4
        if off == 0 or off > len(out): raise ValueError
        start = len(out) - off
        if ml > off:                      # overlapping copy
            chunk = bytes(out[start:])
            while len(chunk) < ml:
                chunk += chunk
            out += chunk[:ml]
        else:
            out += out[start:start + ml]
        if len(out) > limit: raise ValueError
    return bytes(out)


def snappy_block(src, limit=MAXOUT):
    i = 0; n = len(src)
    shift = 0; ulen = 0
    while True:
        if i >= n: raise ValueError
        b = src[i]; i += 1
        ulen |= (b & 0x7F) << shift
        if not (b & 0x80): break
        shift += 7
        if shift > 32: raise ValueError
    out = bytearray()
    while i < n:
        tag = src[i]; i += 1
        t = tag & 3
        if t == 0:
            ln = tag >> 2
            if ln < 60:
                ln += 1
            else:
                k = ln - 59
                if i + k > n: raise ValueError
                ln = int.from_bytes(src[i:i + k], "little") + 1; i += k
            if i + ln > n: raise ValueError
            out += src[i:i + ln]; i += ln
        else:
            if t == 1:
                if i >= n: raise ValueError
                ln = ((tag >> 2) & 7) + 4
                off = ((tag >> 5) << 8) | src[i]; i += 1
            elif t == 2:
                if i + 2 > n: raise ValueError
                ln = (tag >> 2) + 1
                off = int.from_bytes(src[i:i + 2], "little"); i += 2
            else:
                if i + 4 > n: raise ValueError
                ln = (tag >> 2) + 1
                off = int.from_bytes(src[i:i + 4], "little"); i += 4
            if off == 0 or off > len(out): raise ValueError
            start = len(out) - off
            chunk = bytes(out[start:])
            while len(chunk) < ln:
                chunk += chunk
            out += chunk[:ln]
        if len(out) > limit: raise ValueError
    if ulen and len(out) != ulen:
        pass
    return bytes(out)


def lzf_block(src, limit=MAXOUT):
    out = bytearray()
    i = 0; n = len(src)
    while i < n:
        ctrl = src[i]; i += 1
        if ctrl < 32:
            ln = ctrl + 1
            if i + ln > n: raise ValueError
            out += src[i:i + ln]; i += ln
        else:
            ln = ctrl >> 5
            if i >= n: raise ValueError
            ref = len(out) - ((ctrl & 0x1F) << 8) - src[i] - 1; i += 1
            if ln == 7:
                if i >= n: raise ValueError
                ln += src[i]; i += 1
            ln += 2
            if ref < 0: raise ValueError
            chunk = bytes(out[ref:])
            while len(chunk) < ln:
                chunk += chunk
            out += chunk[:ln]
        if len(out) > limit: raise ValueError
    return bytes(out)


def try_codec(name, fn, data, offsets):
    hits = []
    for off in offsets:
        try:
            out = fn(data[off:off + (1 << 24)])
        except Exception:
            continue
        if len(out) < 32768:
            continue
        e = entropy(out[:65536])
        runs = [m.group() for m in re.finditer(rb"[\x20-\x7e]{24,}", out[:1 << 20])]
        hits.append((off, len(out), e, len(runs)))
        print("  HIT %s at 0x%x -> %d bytes, entropy %.2f, long runs %d" % (name, off, len(out), e, len(runs)))
        if runs:
            print("      sample:", runs[0][:70])
    return hits


img = open(sys.argv[1], "rb").read()
print("image", len(img), "bytes")

coarse = list(range(0, 0x4000, 1)) + list(range(0x4000, len(img), 0x1000))
for name, fn in (("lz4", lz4_block), ("snappy", snappy_block), ("lzf", lzf_block)):
    print("\n=== %s, %d offsets tried ===" % (name, len(coarse)))
    try_codec(name, fn, img, coarse)
print("\ndone")
