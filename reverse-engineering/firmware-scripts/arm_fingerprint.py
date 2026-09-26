#!/usr/bin/env python3
"""ARM/Thumb code fingerprint: function prologues and in-image branch targets.
Real code is full of push {...lr} and branches that stay inside the image; random data is not."""
import struct, re, sys, collections

def thumb_fp(b):
    # PUSH {..., LR} = 0xB5xx ; BL = 0xF0xx followed by 0xF8xx/0xExxx
    push = sum(1 for i in range(0, len(b) - 2, 2)
               if b[i + 1] == 0xB5)
    bl = sum(1 for i in range(0, len(b) - 4, 2)
             if b[i + 1] == 0xF0 and (b[i + 3] & 0xF8) in (0xF8, 0xF0, 0xE8))
    pop = sum(1 for i in range(0, len(b) - 2, 2) if b[i + 1] == 0xBD)
    return push, bl, pop


def arm_fp(b):
    # ARM: push {...,lr} = E92D4xxx ; BL = cond 1011 with offset ; BX LR = E12FFF1E
    push = bx = bl = 0
    inside_bl = 0
    for i in range(0, len(b) - 4, 4):
        w = struct.unpack_from("<I", b, i)[0]
        if (w & 0xFFFF0000) == 0xE92D0000 and (w & 0x4000):
            push += 1
        if w == 0xE12FFF1E:
            bx += 1
        if (w >> 24) in (0xEB,):
            bl += 1
            off = w & 0x00FFFFFF
            if off & 0x00800000:
                off -= 0x01000000
            t = i + 8 + off * 4
            if 0 <= t < len(b):
                inside_bl += 1
    return push, bx, bl, inside_bl


img_path = sys.argv[1]
img = open(img_path, "rb").read()
sample = img[:min(len(img), 4 << 20)]
rand = open("/dev/urandom", "rb").read(len(sample))

print("sample size: %d bytes (%s)" % (len(sample), img_path))
for name, data in (("image", sample), ("random", rand)):
    tp, tbp, tpop = thumb_fp(data)
    ap, abx, abl, ainside = arm_fp(data)
    n = len(data)
    print("\n%s:" % name)
    print("   thumb: PUSH{..lr}=%d (%.2f per KiB)  BL=%d  POP{..pc}=%d" %
          (tp, 1000 * tp / (n / 1024), tbp, tpop))
    print("   arm  : push{..lr}=%d  BX LR=%d  BL=%d (targets in image: %d, %.1f%%)" %
          (ap, abx, abl, ainside, 100.0 * ainside / abl if abl else 0.0))
