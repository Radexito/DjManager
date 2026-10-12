#!/usr/bin/env python3
"""Control: does ASCII text (like S-record text) fake a low illegal rate?"""
import subprocess, re

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from paths import locate, objdump, scratch  # noqa: E402

BIN = objdump("bfin-elf-objdump")


def illegal(b):
    window = scratch()
    window.write_bytes(b)
    out = subprocess.run([BIN, "-D", "-b", "binary", "-m", "bfin", str(window)],
                         capture_output=True, text=True).stdout
    tot = bad = 0
    for line in out.splitlines():
        if re.match(r"\s+[0-9a-f]+:", line):
            tot += 1
            if re.search(r"ILLEGAL|\(invalid\)|<bad>", line):
                bad += 1
    return 100.0 * bad / tot if tot else 100.0


# 1. what is actually at DRIV raw 0x52000?
d = locate("raw_C2KNXS.comp1.bin").read_bytes()
seg = d[0x52000:0x52080]
print("DRIV raw 0x52000..0x52080:")
print("   hex:", seg[:48].hex())
print("   asc:", "".join(chr(b) if 32 <= b < 127 else "." for b in seg[:48]))

# 2. controls
print("\ncontrols (illegal-opcode rate):")
print("   4 KiB of ASCII text        : %.1f%%" % illegal(b"the quick brown fox jumps over the lazy dog. " * 96))
print("   S-record text from the file : %.1f%%" % illegal(d[0x52000:0x53000]))
print("   random data                : %.1f%%" % illegal(open("/dev/urandom", "rb").read(4096)))
print("   the known GUI code block   : %.1f%%" %
      illegal(locate("raw_C2KNXS.comp0.bin").read_bytes()[0x87000:0x88000]))
print("   0xff fill                  : %.1f%%" % illegal(b"\xff" * 4096))
print("   0x00 fill                  : %.1f%%" % illegal(b"\x00" * 4096))
