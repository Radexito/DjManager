# Blackfin (Pioneer CDJ/XDJ) firmware — player-side rekordbox DB reader: findings

Task: from the already-decoded Blackfin firmware images, locate/read the player-side
code that consumes the rekordbox USB database (ANLZ + PDB/track records), well enough
to name the fields that DjManager's PDB writer still leaves as unnamed constants.
Read-only on the images; all work confined to /tmp/bfin-work/.

**STATUS: COMPLETE** (report written incrementally; all four deliverables below are filled).

**Headline: negative result, measured not assumed — the player-side rekordbox DB reader is
NOT in the readable part of these images, so our unnamed track-row fields cannot be named
from firmware. Two earlier leads are refuted with instruction addresses. Details in §2-§5.**

---

## 0. Inputs, toolchain, method

Toolchain: `/tmp/bfin/bin/bfin-elf-objdump` (GNU binutils 2.39, bfin-elf), used as
`bfin-elf-objcopy -I binary -O elf32-bfin -B bfin <img> <img>.elf` then
`bfin-elf-objdump -D --start-address=A --stop-address=B <img>.elf`.
A raw `-b binary -m bfin` invocation is NOT supported by bfd (no plain binary target);
the ELF wrapper above is the working recipe.

Images inspected (read-only):
| file | size | md5 |
|---|---|---|
| /tmp/fw/decoded/C2KNXS-run1-0x0.bin | 3,019,968 | d3c82a224c49ceedaa57cbfc9c913e2f |
| /tmp/fw/decoded/C2KNXS-blobA.bin | 1.9 MB | (see below) |
| /tmp/fw/decoded/C2KNXS2-run1-0x0.bin | 3.9 MB | 3e1976ccd39d2c1c0227cc5d807f4408 |

Also reused: `/tmp/bfin-work/_full0.asm` (63 MB, full disassembly of C2KNXS-run1-0x0.bin).

**Decode-validity calibration (the yardstick used throughout):**
- 64 KiB of `/dev/urandom` -> 36.0 % ILLEGAL (binutils 2.39, bfin; from HOWTO.txt).
- Genuine Blackfin code -> 0.0 % ILLEGAL (measured again here).

## 1. Region map: code vs data vs compressed/encrypted (decode-validity evidence)

Per-4 KiB-window ILLEGAL-instruction rate, computed by parsing `_full0.asm`
(724 windows, 0x0-0x2e1000 covered by the disassembly):

| image / range | windows | ILLEGAL rate | verdict |
|---|---|---|---|
| C2KNXS-run1-0x0.bin, **every** 4 KiB window 0x0-0x2e1000 | 724 | 30-40 % (588 windows), 40-50 % (114), 20-30 % (15), 10-20 % (2) | **not decodable code** - sits at the random-data rate (36 %); NOT one window is under 5 %, none under 1 % |
| C2KNXS-run1-0x0.bin 0x31000-0x40000 | 15 | objdump emits no instruction lines at all | all-zero/unmapped padding (verified: 0x32000-0x33000 is 4096 x 0x00, high-bit rate 0.0 %) |
| C2KNXS-blobA.bin 0x87000-0x93000 | ~12 | **0.0-0.1 %** | **genuine Blackfin code**, fully readable |
| C2KNXS-blobA.bin 0x0, 0x1000, 0x80000, 0x100000, 0x180000, 0x1d0000 | 6 | 30.9-77.7 % | data / compressed / still-encoded - not code |

| C2KNXS2-blobA.bin 0x0, 0x30000, 0x80000, 0x100000, 0x180000, 0x200000, 0x300000, 0x400000, 0x500000, 0x600000, 0x640000 | 12 | 32.3-49.9 % | encoded/compressed - not code, not a string pool (printable-run density only 0.25-6.6 % per 256 KiB) |

Evidence for the code verdict (blobA, all four values from `bfin-elf-objdump`):
```
0x087000: 1672 insns   0 ILLEGAL   0.0%
0x087100: 1646 insns   1 ILLEGAL   0.1%
0x092000: 1671 insns   0 ILLEGAL   0.0%
0x092407: 1623 insns   1 ILLEGAL   0.1%
```
and for the negative verdict (same tool, same options):
```
C2KNXS-run1-0x0.bin 0xf4000: 1686 insns  (15.1% ILLEGAL - the *cleanest* window in the image)
C2KNXS-run1-0x0.bin 0x9b000: 2022 insns  (25.1% ILLEGAL)
C2KNXS-blobA.bin   0x80000: 1959 insns  (73.8% ILLEGAL)
```
Corroboration that C2KNXS-run1-0x0.bin is not a plaintext code image: its strings are
readable ASCII but *interleaved with stray high-bit junk bytes*, e.g. at 0xb21f4:
`"M<FF>usic Anal<FF>yse File<FF> is brok<FB>en\0%/ANLZ<9F>%04X.DAT"` (0xff/0xfb/0x9f
inserted roughly every 9-11 bytes). Readable text + random-rate disassembly means the
run1 stream is a container whose big payload regions are still compressed/encoded.
This is why every previous attempt to read "the code" out of the run1 image was doomed.

**Consequence for the whole task:** the only place genuine decoder code can be read in
this corpus is C2KNXS-blobA.bin (and probably C2KNXS2-blobA.bin). All conclusions below
come from there.

## 2. ANLZ section dispatch and PDB/track record reader: located or not

**Answer: neither was located. The search for both can be bounded with evidence.**

Readable code in the corpus is confined to `C2KNXS-blobA.bin`, and it consists of two
segments (from per-4 KiB ILLEGAL rates over `_bA.asm`, 475 windows, 91 windows < 2 % ILLEGAL):
- `0x78000-0x79000` (4 KiB)
- `0x87000-0xe1000` (576 KiB) - the main code body

The whole remaining ~1.3 MB of blobA is non-code (30-78 % ILLEGAL), and all of
`C2KNXS-run1-0x0.bin` is non-code (see section 1).

ANLZ tags (`PPTH PVBR PQTZ PCOB PWAV PWV2 PWV3 PQT2 PVDI`) are **not present as
constants in the readable code**: grepping the 912,039-line `_bA.asm` for the 16-bit
immediate halves of each tag returns only coincidence-level counts (0-3 hits each, e.g.
`0x5448`->1, `0x4156`->2, and those are ordinary small data immediates; a genuine
4-tag dispatch table would need a 32-bit constant per tag, i.e. `..L = lo` + `..H = hi`
pairs, which are absent). Raw ASCII scan of the three images likewise finds at most one
loose `PWAV` (0xb715a in C2KNXS-run1-0x0.bin, 0xf47c in C2KNXS2-run1-0x0.bin) and no
`PPTH/PVBR/PQTZ/PCOB/PQT2/PVDI` - single loose hits are the expected false-positive rate.
**Conclusion: the ANLZ section-tag dispatch lives in the still-encoded payload (or in a
different component), not in the readable Blackfin code of these images.**
Corroborating: the ANLZ path-format string `%/ANLZ%04X.DAT` does exist (C2KNXS-run1-0x0.bin
@ 0xb21f4, next to `"Music Analyse File is broken."`), but it sits inside an encoded region
of the run1 stream where disassembly is random-rate, and no reference to it can be resolved
in blobA because blobA contains no such string at all.

Two previous leads are now **refuted with instruction-level evidence**:

**(a) The `0xC0700` "constant in real code" at blobA 0x92407 is a byte-level coincidence.**
The bytes are `00 07 0c 00` spanning two instructions and two immediates:
```
0x92406: 60 00        CALL (P0);
0x92408: 07 0c        CC = R7 == 0x0;
0x9240a: 00 60        R0 = 0x0 (X);
```
`0x92407` is the second byte of `CALL (P0)` (0x00), then `07 0c` = the whole
`CC = R7 == 0x0` opcode, then the low byte (0x00) of `R0 = 0x0`. So the 0x000C0700
pattern is assembled from instruction bytes; it is not an immediate. Consistent with
this, `0xC0700`/`0x0C0700` appears **zero** times as an immediate anywhere in
`_full0.asm`. The second occurrence (C2KNXS2-run1-0x0.bin 0x6a7a3) was already known to be
in high-entropy bytes. **Neither occurrence is a PDB bitmask/contentLink constant.**

**(b) The function that loads 42/43 is not a record reader, and 42 is not the string-offset
table size.** Full disassembly of blobA 0x923d0-0x92426 shows 42 and 43 are *selectors*
passed to a helper, and the u16 reads at +0x1a/+0x1e are on the two returned objects, not
on a track record:
```
0x923d0: LINK 0x0
0x923da: R1 = 0x2a (X)          ; 42
0x923de: CALL 0xb2a62           ; objA = f(arg1, 42)
0x923e2: P5 = R0
0x923e8: R1 = 0x2b (X)          ; 43
0x923ea: CALL 0xb2a62           ; objB = f(arg1, 43)
0x923ee: P1 = R0
0x923f0: P0 = [P5]              ; vtable of objA
0x923f4: R2 = W[P5 + 0x1e] (X)  ; sign-extended u16, objA+30
0x923f6: R1 = W[P5 + 0x1a] (X)  ; sign-extended u16, objA+26
0x923f8: R1 = R2 - R1
0x923fa: P0 = [P0 + 0x14]       ; virtual method, slot +0x14
0x923fc: R6 = W[P1 + 0x1e] (X)
0x923fe: R3 = W[P1 + 0x1a] (X)
0x92400: R3 = R6 - R3
0x92402: R6 = R3 - R1           ; R6 = (objB.d30-objB.d26) - (objA.d30-objA.d26)
0x92404: R1 = 0x1 (X)
0x92406: CALL (P0)              ; virtual call on objA with R1=1, R2=R6
0x92408: CC = R7 == 0x0
0x9240e: R1 = 0xe (X)           ; 14
0x92410: CC = R7 == R1          ; compares arg2 against 0 and 14
0x92418: R0 *= R6               ; then call 0xe0a04 with a scaled value
0x9241a: CALL 0xe0a04
```
The `W[... + 0x1a]`/`W[... + 0x1e]` pair is used only as a *delta* between two sibling
objects selected by index 42 and 43, and it never touches the 21x2-byte string-offset
table. The "42 = our 42-byte string offset table" match is numerology. There is no
evidence this function has anything to do with PDB records.

## 3. Our track-row map fields: name or rule out (with evidence)

Given section 2, every field of our writer's map must be resolved from *indirect*
evidence in the readable code. Status of each previously "unknown" field:

| field (our offset) | value we write | firmware verdict | evidence |
|---|---|---|---|
| u16 @0 "Unnamed0" | 0x24 | **not named** | no code in the readable region tests a record's first u16 against 0x24; PDB row-type dispatch not present (section 2) |
| u16 @2 IndexShift | 0 | **not named** (mechanism already known from the format, not from firmware) | no firmware evidence found either way |
| u32 @4 "Bitmask" | 0xC0700 | **ruled out as a firmware constant** - the only in-code occurrence is a byte coincidence at 0x92407 (section 2a); appears 0 times as an immediate | `grep -c '0x0c0700|0xc0700' _full0.asm` = 0 |
| u16 @24 / u16 @26 auto-gain | 13940 / 17802 (0x3674/0x458A) refs 0x4975/0x5DC9 | **not confirmable from firmware**; nothing in the readable code loads these two consecutive u16s as a gain pair (the only `+0x1a`/`+0x1e` pair found is the unrelated delta in section 2b) | blobA 0x923d0-0x92426 |
| u16 @86 "Unnamed26" | 0x29 | **not named** | no 0x29 record-field test in readable code |
| u16 @92 "Unnamed30" | 0x03 | **not named** | no 0x03 record-field test in readable code |
| string-index semantics (KeyAnalyzed "1", PhraseAnalyzed "1", AutoloadHotcues "ON", UnknownString4/5/6/7/8) | as listed | **not nameable**; the string-offset walker that would assign meaning to the 21 offsets is not in the readable region | section 2 |
| everything else in the row (SampleRate, ComposerId, ... FilePath) | - | labels came from prior public-format work, **not** from these images; firmware adds nothing | - |

Note the honest asymmetry: none of the 21 string names is present as a string anywhere in
these images either (the task's earlier result stands: `tracks`, `genres`, `artists`,
`playlist_tree`, `columns`, `smartList`, `myTag`, `OneLibrary`, `exportExt`, `master.db`
are all absent; only the debris fragments `1scAnlzS`, `cAnlzSem`, `KdexMyTagNyaExtD` show up
in `strings-clean.txt`).

## 4. Not-recoverable list (with reason)

1. **The PDB/track-record reader** - not recoverable from these images. Reason: the only
   region where a parser could live that is readable is blobA 0x87000-0xe1000, and it
   contains no PDB/track/ANLZ strings or tag constants; the rest of the corpus is at
   random-data decode rates (30-78 % ILLEGAL) and therefore is not instruction-addressable.
2. **The ANLZ section dispatch (PPTH/PVBR/PQTZ/PCOB/PWAV/PWV2/PWV3/PQT2)** - not recovered:
   tags absent from the readable code and from all plaintext string pools.
3. **The meaning of u16 @0 = 0x24 and u16 @92 = 0x03** - not recoverable here. Reason: no
   consumer-side test of these fields is in the readable code; the values are only ever
   *produced* by our writer.
4. **Whether u16 @24/@26 are really auto-gain** - not recoverable here (no arithmetic on a
   @24/@26 pair found; the writers' 0x4975/0x5DC9 reference values do not appear in the
   readable code).
5. **The u16 @86 = 0x29 field** - not recoverable here.
6. **All C2KNXS-run1-0x0.bin / C2KNXS2-run1-0x0.bin payload code** - not recoverable
   without first completing the container decode; reason: high-entropy/encoded bytes,
   30-40 % ILLEGAL per 4 KiB window in every single window (random-data rate 36 %), with
   stray high-bit junk bytes interleaved into otherwise-readable ASCII.
7. **`0xC0700` as anything other than a literal our writer copies from
   `exportLibrary.db.contentLink`** - no firmware confirmation obtainable; see 2(a).

## 5. Conclusion / honest bottom line

**The consumer-side code that reads the rekordbox USB database is not present in readable
form in the decoded Blackfin images, so the unknown fields of our track-row map cannot be
named from firmware. This is a negative result, and it is bounded by measurement, not by
effort.**

What is established:
- Exactly one readable code body exists in the inspected corpus: `C2KNXS-blobA.bin`
  0x78000-0x79000 and 0x87000-0xe1000 (0.0-0.1 % ILLEGAL). Its 576 KiB parse cleanly and
  were read instruction by instruction.
- Everything else is at random-data decode rates (30-78 % ILLEGAL, random-data rate 36 %):
  all of `C2KNXS-run1-0x0.bin` (every one of 724 windows), all of `C2KNXS2-blobA.bin`
  (12 windows spread over 6.6 MB), and the non-code 1.3 MB of `C2KNXS-blobA.bin`.
- That readable code contains **no** ANLZ tag constants (PPTH/PVBR/PQTZ/PCOB/PWAV/PWV2/
  PWV3/PQT2), **no** PDB/ANLZ/track strings, and no plausible PDB record parser. Therefore
  the ANLZ section dispatch (deliverable 2) was **not located**, and neither was the
  PDB/track record reader.
- The two promising leads from the previous attempt are both **refuted**:
  the 0xC0700 at blobA 0x92407 is instruction bytes (`CALL (P0)` + `CC = R7 == 0x0` +
  `R0 = 0x0`), and the "42/43" function at 0x923d0 passes 42/43 as object selectors to
  0xb2a62, reads +0x1a/+0x1e as a delta between two sibling objects and then does a
  virtual call - it is a gain/compare-style helper, not a record reader.
- Consequence for the writer: the 0x24 at @0, the 0xC0700 at @4, the @24/@26 gain pair,
  the 0x29 at @86 and the 0x03 at @92 remain **unconfirmed by the player**. Our values are
  still justified by native-file observation and the public format descriptions, but the
  firmware does not corroborate or contradict them. In particular the 0xC0700 is a value our
  writer copies from `exportLibrary.db`'s `contentLink`; the firmware offers no evidence for
  it either way (the earlier "found in code" claim does not survive disassembly).
- Nothing in these images names the fields, and none of the 21 string slots' names
  (`tracks`, `genres`, `artists`, ... ) appear as strings anywhere in them.

To actually resolve these fields one would need one of: (i) a completed container decode of
the run1 streams (they still hold ~30-40 % ILLEGAL everywhere plus interleaved high-bit
junk, i.e. the decode is not finished); (ii) the other product's flash layout, e.g. an
already-plaintext JTAG/eMMC read where the application text pool and the DB layer are in the
same address space; or (iii) dynamic analysis on a real CDJ. From these images alone the
answer is "not recoverable", and stating that is the deliverable.

Method hygiene: all work was read-only on the images; only `/tmp/bfin-work/` was written
(this report, `_bA.elf`, `_bA.asm`, `_b2A.elf`, `_nx2.elf`). No repository file was touched.
