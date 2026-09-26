#!/usr/bin/env python3
"""Container census for Pioneer firmware files: layout, entropy, magics, encodings."""
import sys, os, re, math, zlib, lzma, bz2, struct, collections

MAGICS = [
    (b"\x1f\x8b\x08", "gzip"),
    (b"\x78\x01", "zlib/1"), (b"\x78\x5e", "zlib/5e"), (b"\x78\x9c", "zlib/9c"), (b"\x78\xda", "zlib/da"),
    (b"\xfd7zXZ\x00", "xz"),
    (b"BZh", "bzip2"),
    (b"\x28\xb5\x2f\xfd", "zstd"),
    (b"\x04\x22\x4d\x18", "lz4-frame"),
    (b"\x02\x21\x4c\x18", "lz4-legacy"),
    (b"\x5d\x00\x00", "lzma-alone"),
    (b"\x89LZO\x00", "lzo"),
    (b"\x7fELF", "ELF"),
    (b"UBI#", "UBI"),
    (b"UBI!", "UBIFS"),
    (b"hsqs", "squashfs-LE"),
    (b"sqsh", "squashfs-BE"),
    (b"\x85\x19", "cramfs"),
    (b"\x19\x85", "jffs2-LE"),
    (b"070701", "cpio-newc"),
    (b"\x1f\x9d", "compress(.Z)"),
    (b"PMAI", "PMAI"),
    (b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00", "-"),
]


def entropy(b):
    if not b:
        return 0.0
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def printable_density(b):
    if not b:
        return 0.0
    return sum(1 for x in b if 32 <= x < 127 or x in (9, 10, 13)) / len(b)


def try_decompress(buf, codec, limit=1 << 22):
    try:
        if codec in ("zlib/1", "zlib/5e", "zlib/9c", "zlib/da"):
            d = zlib.decompressobj()
            out = d.decompress(buf, limit)
            return out if len(out) > 64 else None
        if codec == "gzip":
            d = zlib.decompressobj(16 + zlib.MAX_WBITS)
            out = d.decompress(buf, limit)
            return out if len(out) > 64 else None
        if codec in ("xz", "lzma-alone"):
            fmt = lzma.FORMAT_XZ if codec == "xz" else lzma.FORMAT_ALONE
            d = lzma.LZMADecompressor(format=fmt)
            out = d.decompress(buf, limit)
            return out if len(out) > 64 else None
        if codec == "bzip2":
            d = bz2.BZ2Decompressor()
            out = d.decompress(buf, limit)
            return out if len(out) > 64 else None
    except Exception:
        return None
    return None


def main(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(8192)
        f.seek(0)
        data = f.read()
    print("=== %s  (%d bytes)" % (path, size))

    # manifest / banner
    txt = re.findall(rb"[\x20-\x7e]{4,}", head[:2048])
    print("head printable runs:", [t.decode()[:48] for t in txt[:6]])
    nums = re.findall(rb"\b\d{3,12}\b", head[:1024])
    print("head decimal runs  :", [n.decode() for n in nums[:12]])

    # entropy profile in 4 KiB windows
    W = 4096
    prof = [(i, entropy(data[i:i + W])) for i in range(0, len(data), W)]
    runs = []
    for off, e in prof:
        hi = e > 7.5
        if runs and runs[-1][2] == hi:
            runs[-1][1] = off + W
        else:
            runs.append([off, off + W, hi])
    print("\nentropy runs (offset_start, offset_end, high>7.5):")
    for a, b, hi in runs[:14]:
        print("   %10d - %10d  %s  (%.2f bits avg)" % (a, b, "HIGH" if hi else "low ", 
              sum(e for o, e in prof if a <= o < b) / max(1, len([1 for o, e in prof if a <= o < b]))))
    if len(runs) > 14:
        print("   ... %d more runs" % (len(runs) - 14))

    # magic scan
    print("\nmagic hits:")
    seen = {}
    for mg, name in MAGICS:
        if name == "-":
            continue
        idx = data.find(mg)
        while idx != -1 and seen.get(name, 0) < 4:
            seen[name] = seen.get(name, 0) + 1
            print("   %-12s at %10d  (0x%x)" % (name, idx, idx))
            idx = data.find(mg, idx + 1)
    if not seen:
        print("   none")

    # decompression attempts at magic hits and at low->high entropy transitions
    print("\ndecompression attempts:")
    tried = 0
    for mg, name in MAGICS:
        if name in ("-", "PMAI", "ELF"):
            continue
        idx = data.find(mg)
        while idx != -1 and tried < 40:
            out = try_decompress(data[idx:], name)
            tried += 1
            if out:
                print("   %s at %d -> %d bytes, entropy %.2f, head=%s" %
                      (name, idx, len(out), entropy(out[:4096]), out[:64].hex()))
            idx = data.find(mg, idx + 1)
    for a, b, hi in runs[1:20]:
        if hi:
            for codec in ("zlib/9c", "gzip", "xz", "lzma-alone", "bzip2"):
                out = try_decompress(data[a:a + (8 << 20)], codec)
                if out:
                    print("   %s at run start %d -> %d bytes, entropy %.2f, head=%s" %
                          (codec, a, len(out), entropy(out[:4096]), out[:64].hex()))
    if tried == 0:
        print("   no magic-anchored attempts")

    # cipher structure tests
    print("\nblock structure:")
    body = data[W * 2:W * 2 + (4 << 20)]
    blocks = [body[i:i + 16] for i in range(0, len(body) - 16, 16)]
    print("   duplicate 16-byte blocks in a 4 MiB window: %d / %d" %
          (len(blocks) - len(set(blocks)), len(blocks)))
    print("   printable density of that window: %.4f" % printable_density(body))

    # S-record detection
    if printable_density(data[:65536]) > 0.8:
        recs = re.findall(rb"\nS([0-9A-F])", data[:1 << 20])
        print("\nS-record letters in first 1 MiB:", collections.Counter(r.decode() for r in recs))


if __name__ == "__main__":
    for p in sys.argv[1:]:
        main(p)
        print()
