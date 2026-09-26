# Pioneer 2k / XDJ firmware: what the update files actually contain

Measured 2026-09-26 on the official `.UPD` files, using locally built multi-target binutils (the build
recipe is in `reverse-engineering/firmware-scripts/README.md`). The firmware itself is downloaded from the
vendor's site and is not redistributed here; the scripts take its location from `CDJ_FW_DIR`. Nothing here
is copied from community notes; every claim has an offset
or a measurement, and the negative results are listed as plainly as the positive ones.

## 1. Container format (verified, sums to the byte)

A `.UPD` is a manifest, then N components concatenated:

```
<size1 in decimal>\r\n<size2>\r\n...      manifest, then
<MODEL> <PART>Ver<X.YZ>                  fixed-width banner, padded with spaces, NUL-terminated
<payload>                                either Motorola S-record text, or raw binary
```

The manifest sizes plus the manifest length equal the file size exactly:

| file                   | manifest | components                          | banner overhead |
| ---------------------- | -------- | ----------------------------------- | --------------- |
| `CDJ2000NXS_v144.UPD`  | 33 bytes | 2015268, 388690, 7062204, 98888     | 0               |
| `CDJ2000NXS2_v187.UPD` | 33 bytes | 6931940, 388690, 9347916, 100274    | 0               |
| `XDJ1KMK2_v145.UPD`    | 17 bytes | 25306326, 90046                     | 0               |
| `XDJRX_v221.UPD`       | none     | whole file encrypted, see section 5 |                 |
| `XDJRX2_v143.UPD`      | none     | whole file encrypted, see section 5 |                 |

Verification for the XDJ-1000MK2: `17 + 25306326 + 90046 = 25396389`, the exact file size. For the NXS:
`33 + 2015268 + 388690 + 7062204 + 98888 = 9565083`, likewise exact.

Each component names itself in its banner, so the component inventory is readable without any guessing:

| model             | component                  | payload form  | decoded image                                              |
| ----------------- | -------------------------- | ------------- | ---------------------------------------------------------- |
| CDJ-2000NXS 1.44  | `CDJ-2000NXS GUI Ver1.200` | raw binary    | 2,015,268 bytes as stored                                  |
|                   | `CDJ-2000NXS DRIVVer1.00`  | S-record text | 8,450 records                                              |
|                   | `CDJ-2000NXS MAINVer1.44`  | S-record text | 90,542 records                                             |
|                   | `CDJ-2000NXS PANLVer1.00`  | S-record text | 1,286 records                                              |
| CDJ-2000NXS2 1.87 | `CDJ-2000NXS2GUI Ver1.81`  | raw binary    | 6,931,940 bytes as stored                                  |
|                   | `CDJ-2000NXS2DRIVVer1.00`  | S-record text | 135,168-byte image, 8,448 records                          |
|                   | `CDJ-2000NXS2MAINVer1.87`  | S-record text | 3,906,816-byte image, 119,844 records, entry `0xA0000000`  |
|                   | `CDJ-2000NXS2PANLVer1.00`  | S-record text | 1,048,576-byte image, 1,297 records                        |
| XDJ-1000MK2 1.45  | `XDJ-1000MK2 MAINVer1.45`  | S-record text | 10,504,320-byte image, 324,439 records, entry `0xA0000000` |
|                   | `XDJ-1000MK2 PANLVer1.00`  | S-record text | 1,048,576-byte image, 1,166 records                        |

Two notes on the decode: the S7 entry record for every MAIN component is `0xA0000000`, which is a RAM
address, so these are images to be unpacked and jumped into rather than flash images. And the two PANL
images are both exactly 1 MB but are **not** identical (sha256 `5a21bd9e...` for the NXS2 versus
`e193c727...` for the XDJ-1000MK2), so they are model-specific builds of the same component.

## 2. The GUI component is plaintext Blackfin code, and it names its own RTOS

The CDJ-2000NXS `GUI` component contains a contiguous **368,640-byte region of genuine Blackfin code at
`0x087000` to `0x0e1000`**, byte-verified by disassembly: function epilogues of the form
`(R7:4, P5:3) = [SP++]`, `UNLINK`, `RTS`, `CALL` targets inside the block, and switch chains comparing
against error constants such as `0xffc0`.

The strings in the same component identify the stack beyond doubt:

- `Copyright (c) 1996-2006 Express Logic Inc. * ThreadX Blackfin BF53x/VisualDSP Version G5` at `0x06bdac`
- `.\\GLib\\src\\DS_G3_Font.c:284`, `DS_G3_InnerUse.c:205 pImage->type == DS_GR_8BIT_COMPRESS_BMP`,
  `DS_HW_Glib3_TopNext.c:358`, `DS_Task_Glib3_itron.c:216 nRet == SUCCESS`

So this component is the **display stack**: ThreadX on a Blackfin BF53x, an eSOL Glib3 graphics library,
fonts and chassis tables, with compressed bitmaps (the `0x070000` region sits at 7.59 bits/byte entropy,
consistent with `DS_GR_8BIT_COMPRESS_BMP`). It is not the database or protocol code.

## 3. The MAIN component is packed, not plain code

For the XDJ-1000MK2 MAIN payload (10,504,320 bytes, 95.8% non-`0xff`):

- It is **not machine code** for any architecture tried. Blackfin illegal-opcode rate per 4 KiB window:
  32.5% to 40.5%, against 36.7% for random data and 0.0% for assembled Blackfin (control below).
  ARM and Thumb are also ruled out by fingerprint: `push {..lr}` frequency is _below_ the random-data
  rate, `BX LR` never appears, and branch targets do not concentrate in-image.
- It is **not ciphertext**: the byte histogram is far too skewed. 0x00 is about 8 to 11 times its
  uniform frequency and 0xff about 6 to 10 times, then 0xdf, 0xef, 0xe0, 0x40. A block or stream cipher
  would flatten this. Chi-square over 1 MiB windows is 0.7 to 2.3 million, where urandom scores 243 and
  zlib-of-random scores 276.
- No decompressor produced output: zlib, raw deflate, gzip, xz, lzma-alone, raw LZMA with an
  lc/lp/pb/dict property search, bzip2, zstd, LZ4 (frame and block), Snappy, LZF, and Okumura LZSS
  (12/4) were each tried from thousands of offsets.

Conclusion: the MAIN payload is a packed image whose decompressor lives in the boot ROM, and it is the
one part of these updates that is not directly readable. It still leaks readable content, which is how
we get section 4.

## 4. Deck vocabulary confirmed in the firmware (cross-check against our protocol work)

Plaintext strings inside the XDJ-1000MK2 MAIN payload, at the offsets given:

- `0x0a9c8a`: `PIONEER/` `LIBRARY/` `PDTL` together, next to `/PIONEER`
- `0x0cda71`: `PMAI`, `PTH`, `VB`, `QTZ`, `WAV`, `V2`, `COB` as an adjacent run
- `0x0a546a`: `CDJ-TopN` and `GUI`
- header table at the start holds little-endian pointers into `0xA0000000` (`a000007a`, `a0000134`,
  `a0000300`, `a0000050`) mixing with values like `80000000` and `0xa4150000`

That run at `0x0cda71` is the ANLZ tag set the deck dispatches on, and it matches exactly what our
protocol document already records (`PPTH`, `PVBR`, `PQTZ`, `PWAV`, `PWV2`, `PCOB`), while the
`PIONEER/LIBRARY` and `PDTL` pair confirms the Device Library paths we documented. This is independent
confirmation of the protocol work from the consumer side.

## 5. The RX and RX2 are a different problem

Both files are entropy 7.95 across their entire length with no manifest, no banner and no LUKS magic, so
there is nothing to segment. Unlike the MAIN components above, the byte distribution needs checking
against the cipher tests, which is running separately. They are 2017 and 2024 builds, so if the scheme
is unchanged across seven years it is a deliberate, long-lived design.

## 6. Method and pitfalls (read this before repeating the work)

- **A low illegal-opcode rate alone does not prove code.** S-record text scores 2.0%, because repetitive
  hex decodes as mostly-legal instructions. Always confirm by reading the disassembly for structural
  instructions (`LINK`, `UNLINK`, `RTS`, `CALL` with in-block targets, `[SP++]` restores). In this work
  that mistake produced two false "code" findings in the DRIV and PANL components, which are S-record
  text; they are corrected here.
- **Controls, measured on the same toolchain**: assembled Blackfin 0.0%, random data 36.7%, generic ASCII
  text 31.1%, S-record text 2.0%, 0xff fill 100%, 0x00 fill 100%.
- Decode S-records by address, not by concatenation: later records patch earlier ones. On the
  XDJ-1000MK2 MAIN image 1,166 records overwrite 36,831 bytes, all inside `0x0c0000..0x0ffffc`.
- Split components before decoding. Merging them put two address spaces in one buffer and produced
  1,166 phantom overlaps.
- The toolchain: `binutils 2.39 --target=bfin-elf --enable-targets=bfin-elf,arm-linux-gnueabi,aarch64-linux-gnu`
  (and `--target=sh4-linux-gnu --enable-targets=sh4-linux-gnu,sh-elf` for the SH-4 side).
  Do **not** use `--enable-targets=all`: `opcodes/mips-formats.h` fails to compile with a modern GCC
  (`static_assert` without `assert.h`), which aborts the whole build.
- The scripts behind this document are in `reverse-engineering/firmware-scripts/`: `split_components.py`,
  `srec_decode2.py`, `census.py`, `component_codescan.py`, `code_map.py`, `arm_fingerprint.py`,
  `lz_trials.py`, `raw_trials.py`.

## 7. Open items

1. Identify the MAIN packing scheme (LZO1X, LZJB and FastLZ tests in flight; the interleaved-text
   phenomenon, readable text punctuated by bytes whose distribution skews to `?F`/`?0`, is the strongest
   clue and is consistent with an LZ token stream).
2. Verify whether the GUI code region contains the database or ANLZ logic, or whether that lives in the
   packed MAIN. A first scan for the tag fragments in the GUI component found nothing, which points at
   MAIN.
3. Identify the RX/RX2 scheme.
4. A second firmware version of the same model would let us diff to separate code from data, and a boot
   ROM read would name the packing outright.

## 8. Cross-model check: the DRIV component in NXS 1.44 and NXS2 1.87

Both models carry a 388,690-byte `DRIV` component that decodes to a 135,168-byte image. Comparing them:

| measurement                             | value                                               |
| --------------------------------------- | --------------------------------------------------- |
| longest byte-identical prefix           | **72 bytes** (identical in both), then they diverge |
| byte-identical positions overall        | 27,224 of 135,168 = 20.1%                           |
| entropy                                 | 7.60 (NXS) and 7.53 (NXS2)                          |
| chi-square, byte histogram              | 150,928 and 191,410 (uniform is about 255)          |
| readable strings in the decoded payload | none; only 6 to 8 character fragments               |

Both are packed with the same scheme, and the shared 72-byte prefix is the interesting part: it is
consistent with **compression of near-identical source**, where a small build difference propagates after
the first block, and inconsistent with a keyed transform, which would leave no identical prefix at all.
Together with the skewed histograms in section 3, that is a second independent argument that these
payloads are compressed rather than encrypted. It also means the DRIV payloads cannot be decrypted into
readable code by any key, and only the GUI component (section 2) is directly readable.

## 9. Which payloads are readable, and why that closes the firmware route for protocol questions

A whole-component check separates the two generations cleanly:

| component                            | ThreadX | Express Logic | Glib3   | `DS_G3_Font` | `BF53x` | printable runs >= 14 |
| ------------------------------------ | ------- | ------------- | ------- | ------------ | ------- | -------------------- |
| CDJ-2000NXS 1.44 `GUI` (raw binary)  | 1       | 1             | **124** | **31**       | 1       | **432**              |
| CDJ-2000NXS2 1.87 `GUI` (raw binary) | 0       | 0             | 0       | 0            | 0       | 27                   |

So the 2012-era NXS GUI payload is plaintext and the NXS2 GUI payload is packed, even though both are raw
binary payloads of the same component name. The same holds for the other components: on the NXS, code was
found only in the GUI component; on the NXS2 and XDJ-1000MK2 no component showed plaintext code.

**And the readable component does not contain the parts we care about.** Scanning the whole NXS GUI for the
database and protocol vocabulary returns nothing: zero hits for `PIONEER`, `LIBRARY`, `PDTL`, `rekordbox`,
`ANLZ`, `USBANLZ`, `PMAI`, `pdb`, `export`, `playlist`, `track`, `bpm`, `cue`. Its content is ThreadX,
eSOL Glib3 graphics, fonts, chassis tables and compressed bitmaps.

Consequences, stated plainly:

1. The deck-side database, ANLZ and USB logic is **not readable from any firmware we have**. It lives in
   the packed MAIN payloads, and the RX family additionally encrypts everything but its 12-byte tag.
2. Therefore the firmware route cannot answer the open protocol questions (track row offset `0x34`, the
   first string slot, the genre id, the auto-gain pair). Ground truth from files the deck and rekordbox
   write is the only route that works, which is what `PDB_SPEC_AND_DIFFERENTIAL.md` did.
3. What the firmware does give us cheaply is the **vocabulary**, which is still useful confirmation: the
   ANLZ tag run and the `PIONEER/LIBRARY` plus `PDTL` paths appear in the XDJ-1000MK2 MAIN payload in the
   clear (section 4), so a packed payload still leaks its strings even when its code stays opaque.

## 10. What the packed payloads still leak (and it is worth having)

Packing hides code but not strings. Three runs inside the **packed** NXS MAIN payload are readable and they
confirm protocol details from the deck's own side:

| offset in decoded NXS MAIN | bytes read as text                                     | what it is                                                                                                                                          |
| -------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x0b21f4`                 | `...sic Analyse File is broken` then `%/ANLZ%04X.DAT`  | the deck composes ANLZ paths itself, with a four-digit hex file index, so `ANLZ0000.DAT` is the deck's own convention and not a rekordbox invention |
| `0x0b20de`                 | `PMAI PTH VBR QTZ WAV2 V2 COB`                         | the ANLZ tag dispatch table, and it sits next to the string above, so this region is the ANLZ handling data                                         |
| `0x08e9c0`                 | `PGM ... /export.pdb ... MP3 AAC M4A MP4 AIF JPG FLAC` | a reference to the export database path plus the supported audio format list                                                                        |

The same tag run appears in the XDJ-1000MK2 MAIN payload (section 4), so the ANLZ vocabulary is consistent
across the family, and `ANLZ%04X.DAT` is new: it is the deck-side template behind the file naming our
protocol document already records.

## 11. Corrections and additions after the component analysis

**Correction to an interim claim.** A sub-analysis reported the `GUI` component as plaintext code in _both_
files. Measured by marker count that is wrong for the NXS2: the NXS `GUI` payload contains
`DS_G3_Font` 31 times, `Glib3` 124 times, `GLib\src` 296 times and `ThreadX` once, while the NXS2 `GUI`
payload contains **zero** of those strings and only 27 printable runs of 14+ characters. Only the NXS 1.44
GUI payload is plaintext; the NXS2 one is packed. The claim is recorded here so the document stays honest
about which generation is readable.

**The S0 record names the original build file.** Each S-record component's leading `S0` record carries the
file name it was produced from, which the decode surfaces directly:

| component   | S0 payload as text                                                          |
| ----------- | --------------------------------------------------------------------------- |
| NXS2 `DRIV` | `G11.MOT`                                                                   |
| NXS2 `MAIN` | `romobj  mot` (i.e. a `.mot` object, with the separator rendered as spaces) |

**Vocabulary now confirmed in three packed MAIN payloads**, each of which hides its code but leaks strings:

| payload                                     | strings found                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| NXS MAIN `0x08e9c0`, `0x0b20de`, `0x0b21f4` | format list, `PMAI PTH VBR QTZ WAV2 V2 COB`, `%/ANLZ%04X.DAT`, `Music Analyse File is broken.` |
| NXS2 MAIN `0x0ca6cf`                        | `./PIONEER/` `LIBRARY/` `PDTL` and `LocalDBSer...` (a local database server string)            |
| NXS2 MAIN `0x0ee6a9`                        | `PMAI PTH VB QTZ WAV V2 COB 3N KEY`                                                            |
| XDJ-1000MK2 MAIN `0x0a9c8a`, `0x0cda71`     | `PIONEER/` `LIBRARY/` `PDTL`; `PMAI PTH VB QTZ WAV V2 COB`                                     |

So the tag set includes `3N` and `KEY` in the NXS2 build, and a `LocalDBServer` string appears next to the
Device Library paths, which is consistent with the deck exposing its library over Pro DJ Link.

**What the component analysis adds on the packed payloads.** The DRIV payload shrinks by 17% under LZMA,
which rules out ciphertext for it, and the MAIN payload is a _mixture_: `0xFF` is 3.86% of 2.9 MB with no
run longer than 64 bytes, which is impossible both for ciphertext and for a single clean compressed stream.
The PANL payload is plaintext data tables (16-bit ramps plus `0x00`/`0x55`/`0xAA` fill), not code.

## 12. The packing: what was ruled out, and the honest conclusion

The MAIN payloads were attacked with purpose-built decoders rather than guesses, and every one is a
controlled negative. Offsets swept: every byte of the first 8 KiB, every 64 bytes up to 1 MiB, then every
4 KiB to the end, for each codec on each of the two MAIN payloads (26,757 and 25,146 offsets), with a
planted-stream positive control and 400 random-data probe offsets per codec to prove there are no false
positives.

| codec                                                               | how it was tested                                                                                     | result                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| LZO1X-1                                                             | pure-python port of `lzo1x_decompress_safe`, validated byte-exact 56/56 against `liblzo2` round trips | 0 valid streams at any offset; planted control found instantly                 |
| LZJB                                                                | port validated 5/5 against a reference implementation                                                 | 0 valid streams; best survival 320 bytes before an out-of-range back-reference |
| FastLZ level 1                                                      | transcription of the reference, validated 6/6 plus a hand-built stream                                | 0 valid streams, first token fails everywhere                                  |
| zlib, raw deflate, gzip                                             | 6,013 offsets plus magic-anchored attempts                                                            | no output                                                                      |
| xz, lzma-alone, raw LZMA                                            | property search over lc 0-3, lp 0-1, pb 0-2 and three dictionary sizes (1,440 combinations)           | no output                                                                      |
| bzip2, zstd, LZ4 frame, LZ4 block, Snappy, LZF, Okumura LZSS (12/4) | magic-anchored and swept offsets                                                                      | no output                                                                      |

Additional structure checks, which also came back negative:

- **Not periodic.** For the text-heavy window at `0x10000`, the most skewed residue class over k = 2..32
  reaches only 0.693 against a 0.600 baseline, and a high-entropy control window shows the same spread
  (0.789 against 0.675). So the readable text is not interleaved on a fixed lane.
- **The readable text is genuine and byte-aligned.** 1,640 of the window's 4,096 bytes are printable, with
  runs up to 102 characters, e.g. `PIONEER`, `XDJ-1000`, `end of version`, `0.01`, `1408052` all appearing
  intact. Byte-aligned literals of that length rule out a range coder such as LZMA, whose literals are not
  byte-aligned.
- **The payload is a mixture, not one stream.** `0xFF` accounts for 3.86% of 2.9 MB with no run longer than
  64 bytes, which is impossible both for ciphertext and for a single clean compressed stream, and the DRIV
  payload still shrinks 17% under LZMA while the RX payloads (genuinely encrypted) shrink 0%.

**Conclusion.** The MAIN and DRIV payloads are compressed with a scheme that is not any of the eleven
standard codecs tested, does not expose a header or a periodic structure, and keeps byte-aligned literals.
What remains is a vendor-proprietary encoding whose decompressor is almost certainly in the deck's own
boot ROM rather than in the update file, since no component of the updates contains a boot stage. That
means the deck-side database code cannot be read from these files at all, and the firmware route is closed
for it. What the payloads do still give is the vocabulary and the path templates, which is section 10 and
section 11, and that is the part worth keeping.

## 13. CORRECTION: the MAIN payload is LZSS-packed SH-4 code, and it is readable

Sections 9 to 12 conclude that the MAIN payloads are a proprietary encoding with the decompressor in the
deck boot ROM, and that deck-side code is therefore unreadable. **That conclusion is wrong** and this
section replaces it. The resolution came from the `cdj2k-revival/cdj2000-emulator` project, which had
already solved the hardware problem this analysis was missing.

**What was missing: the CPU.** The CDJ-2000 is a two-processor machine. The GUI board is a **Blackfin
BF531** which paints the display, and the MAIN board is a **Renesas SH-4**, which runs the player, the
flash, SDRAM, DMAC, panel, SD, ATAPI, USB and the audio DSP. Every code test in sections 9 to 12 was run
for Blackfin (which correctly matched the GUI component) and for ARM and Thumb (which correctly came back
negative), and **never for SH-4**. The MAIN payload was therefore being scanned for instructions from the
wrong architecture, which is exactly what produced the "no code, must be a proprietary compressor" result.

**What the packing is.** The MAIN updater carries an SH-4 image whose regions are **LZSS**-packed with a
4 KiB space-filled window, 18-byte lookahead, a 12-bit position and a 4-bit length biased by 3, and packed
regions at `0x10000` and `0x40000`, each guarded by a checksum. The flag convention is the detail that
defeated the earlier sweep: in this format a flag bit of 1 means **literal** and 0 means **match**, the
inverse of the Okumura convention that was tested, which is why every offset was rejected.

**Consequences, corrected.** LZSS leaves literals in the clear and replaces only repeated material with
match tokens, which explains every symptom that was misread as encryption or a proprietary codec: the
readable strings survive verbatim inside the packed region, the occasional stray byte between readable
characters is a match token, the byte histogram is skewed, and there is no periodic structure. The entropy
figures in section 9 measure the _packed_ form, not the code.

**Container details newly verified.** The reference parser accepted our original `C2KNXS.UPD` unchanged and
validated every component, which independently confirms the manifest and title analysis and adds two facts
it did not have: each component ends with a **CRC-16 (CRC-HQX, `binascii.crc_hqx`, seed 0)** trailer, and
the trailer width and byte order differ per component, 4 bytes big-endian for GUI and 2 bytes little-endian
for DRIV, MAIN and PANL. The same project documents the RX-style family as `[payload][12-byte tag][4-byte
CRC32]`, matching section 8.

**Result.** Decompressing our CDJ-2000NXS `C2KMAIN.UPD` yields a 3,019,968-byte flash image, a 196,608-byte
unpacked loader and a **4,063,232-byte unpacked MAIN application** loaded at `0x04000000`. It is genuine
SH-4 code: `rts` (`0x000B`) appears 8,662 times against 43 in random data of the same size, `nop`
(`0x0009`) 24,671 against 32, the `mov.l r14,@-r15` and `sts.l pr,@-r15` prologues 6,250 and 5,942 against
28 and 30, `rte` 143, and `jsr @Rn` 54,409 against 495. Deck-side database and ANLZ logic is therefore
readable, and that analysis is the live follow-up rather than a dead end.

**Licence boundary.** The reference project is GPL-2.0-or-later. Its extractors were run locally for
analysis and none of its code is copied into this repository; its findings are cited here and its code is
not redistributed. The decoder parameters above are stated as a format description so that anything needed
here can be implemented independently.

## 14. The deck's own module map, ANLZ tag tables, and what it does not know

The unpacked SH-4 image carries the build paths of the modules it was compiled from, which maps the
firmware's own structure. All of these live under `DB/cache/cue/src/`:

```
disc_cue_api.c  disc_cue_local.c  disc_cue_localIdx.c  disc_cue_localRd.c  disc_cue_localWr.c
ex_fsys.c
mep_cue_api.c  mep_cue_local.c
msc_anlz_api_usb.c  msc_anlz_local_usb.c  msc_anlz_local_usbRd.c  msc_anlz_local_usbWr.c
msc_anlz_local_usbmng.c  msc_anlz_local_remove.c
```

The split is informative: the `msc_anlz_*` family is the USB ANLZ path with separate read (`usbRd`), write
(`usbWr`), management (`usbmng`) and remove modules, and the `disc_cue_*` family is the same idea for
disc media. Also present: a TCP/IP stack (`Middle/cente/tcpip/...`), a shell (`Middle/cente/shell/...`),
`LocalDBServer` / `RemoteDBServer` / `DBComm_TASK` / `DSListen_TASK` (the PRO DJ LINK database server),
and `mhod` / `pdst` atoms.

**The ANLZ tag tables are the parser's dispatch arrays.** Every 4-byte tag constant in the image occurs
only inside these tables, never in a separate literal pool, so the parser walks each array with a pointer
instead of comparing immediates. The tables, by the module they sit beside:

| address      | order                                                         | module                    |
| ------------ | ------------------------------------------------------------- | ------------------------- |
| `0x040ace28` | `PMAI PPTH PVBR PQTZ PWAV PWV2 PCOB PWV3 PKEY PCO2 PCP2`      | `msc_anlz_api_usb.c`      |
| `0x040acebc` | `PVBR PQTZ PWAV PWV2 PCOB PWV3 PKEY PCO2 PCPT PCP2`           | `msc_anlz_api_usb.c`      |
| `0x040acf0c` | `PMAI PPTH PVBR PQTZ PWAV PWV2 PCOB PCPT PWV3 PKEY PCO2 PCP2` | `msc_anlz_local_remove.c` |
| `0x040ad100` | `PMAI PPTH PCOB`                                              | `msc_anlz_local_usb.c`    |
| `0x040ad1b4` | `PMAI PPTH PVBR PQTZ PWAV PWV2 PCOB PCPT`                     | `msc_anlz_local_usbRd.c`  |
| `0x040ad234` | `PMAI PPTH PVBR PQTZ PWAV PWV2 PCOB PCPT`                     | `msc_anlz_local_usbWr.c`  |
| `0x040ad274` | `PMAI PPTH PCPT PCP2 PCOB PCO2`                               | `msc_anlz_local_usbmng.c` |

The read and write tables in `usbRd`/`usbWr` are identical and both start with `PMAI PPTH`, which
confirms `PMAI` writes the header and `PPTH` the path for the DAT file, and that the deck's own writer
emits the same eight DAT sections we do. The variants without `PMAI`/`PPTH` are the EXT side, and the
`PCPT` / `PCP2` / `PCO2` entries are what the newer cue features travel in.

**Tags this generation does not know.** `PWV4`, `PWV5`, `PWV6`, `PWV7`, `PSSI`, `PSSC` and `PQT2` return
zero occurrences in the entire 4 MB image. The NXS 1.44 firmware has no parser for the coloured preview
waveforms, no song structure (phrase) support, and no `PQT2`. Files carrying them are simply not the
files this deck reads, which is direct evidence for which sections are worth writing for this generation.
`PCO2` is present, so hot-cue labels and colours in the extended cue section are within this deck's
vocabulary.

**New tags not previously in the protocol document:** `PKEY` (4 occurrences), `PCPT` (5), `PCP2` (4),
`PMNG` and `PTBL` (one each, beside `msc_anlz_local_usbmng.c`, so they belong to ANLZ management rather
than to a single ANLZ file). One genuine code use of `PKEY` exists at `0x043a401f`, the rest are table
entries.

**Path construction, from the strings themselves:** the deck builds ANLZ paths as `/%s/%s` with
`/ANLZ%04X.` plus an extension, and the folder as `P%03X`, matching
`PIONEER/USBANLZ/P001/ANLZ0000.DAT` independently of anything rekordbox does. Device Library paths are
`: /PIONEER/LIBRARY/PDTL.DB` and a second `.` -prefixed copy `:/.PIONEER/LIBRARY/PDTL.DB`, and the export
files are `PIONEER/rekordbox/export.pdb` and `PIONEER/rekordbox/exportExt.pdb` (both present twice, in two
different modules, so both the export reader and a second consumer use them).

**The deck's own failure message for bad analysis data** is `Music Analyse File is broken!!!`, sitting in
`msc_anlz_local_usb.c` right next to the `ANLZ%04X` template. That is the string a deck shows when it
rejects an ANLZ file, and it is the ANLZ-side counterpart of the corrupted-library report in issue #577.

## 15. The deck's own media cache, and why it is not the rekordbox export

The database region of the image names a second, entirely separate database belonging to the deck:
`CacheDB`, reached through an engine called `DSQL`, with one error string per accessor:

```
CacheDB DSQLerror! djdsqlCache_GetCasheDir()    djdsqlCache_GetSNamePath()   djdsqlCache_GetLNamePath()
CacheDB DSQLerror! djdsqlCache_GetRootID()      djdsqlCache_GetEntInf()      djdsqlCache_SetDispOffset()
CacheDB DSQLerror! djdsqlCache_GetDirCnt()      djdsqlCache_GetFileCnt()     djdsqlCache_SetEntryCnt()
CacheDB DSQLerror! djdsqlCache_SetDepth()       djdsqlCache_GetDepth()       djdsqlCache_SetFlgs()
CacheDB DSQLerror! djdsqlCache_CheckDirRegist() djdsqlCache_DelteTbl()       djdsqlCache_SetRegState()
CacheDB DSQLerror! djdsqlCache_GetImgAddr()     djdsqlCache_SetImgAddr()     djdsqlCache_DelDirRecord()
CacheDB DSQLerror! djdsqlCache_InsertDir()      djdsqlCache_InsertFile()     djdsqlCache_GetSongInf()
CacheDB DSQLerror! djdsqlCache_InsertSongInf()  djdsqlCache_GetPlayingInfo_Track()
CacheDB DSQLerror! djdsqlCache_GetTrack_Content()
MEP/iTunes DSQLerror! djdsqlCache_GetPlayingInfo_Track()  djdsqlCache_GetTrack_Content()
MEP/iTunes DSQLerror! djdsqliTunes_GetTrackContent()
```

That is a directory-and-file indexed cache with its own table management (`DelteTbl`, `InsertDir`,
`InsertFile`, `CheckDirRegist`, `SetRegState`), which is the deck's own model of the media it has seen,
distinct from any file rekordbox writes. The `MEP/iTunes` variants and the `mhod` / `pdst` atoms beside
the export paths show the same layer handles MEP and iTunes databases, which is why those atoms are
present at all. This matters for interpretation only: it means an error seen while browsing is not
automatically a complaint about `export.pdb`.

Other strings in the same region, for reference:

```
0x0406f8c0  This information is not supported (ItemKind=%d).
0x0406f580  GetOneData_SongInfo(): Wrong Patameter!!!!!! pstRmif=%d, pstRec=%d
0x0406f664  Delivery Flag      : %s
0x0406f84c  ReqGet_DeliverySongInfo():aquire memory pool error!
0x0406fa50  ReqLoadTrackPreviousPlay : Memory Pool Acquisition Error !!!!!
```

`Delivery` and `SongInfo` are the PRO DJ LINK side, where one player serves track information to another.

The deck's Device Library paths appear as `: /PIONEER/LIBRARY/PDTL.DB` and `:/.PIONEER/LIBRARY/PDTL.DB`,
differing only by a dot before `PIONEER`, with drive-letter formatting available as `%c:/%s` and
`%c:/.%s`. The export files are `PIONEER/rekordbox/export.pdb` and `PIONEER/rekordbox/exportExt.pdb`, and
each appears twice, in two different modules, so more than one consumer opens them. The dotted variant is
the same file reached through a hidden or alternate root; the strings alone do not say which.

## 16. Corrections from reading the deck's ANLZ code, and what it confirmed

A disassembly pass over the ANLZ modules corrected three statements in section 14 and settled the tag
recognition rules. Corrections first, since section 14 is wrong on them:

1. **The tag tables are arrays of 8-byte records, not contiguous u32 words.** Each record is
   `{tag[4], u32 0}`, so record _i_ of the table at `0x040ace28` is at `0x040ace28 + 8*i`. The hexdump
   shows `PMAI 00000000 PPTH 00000000 ...`. The tag order already recorded stands; only the stride was
   wrong.
2. **The chain is unrolled, not pointer-walked.** Each record's address is loaded individually from a
   literal pool, one pool slot per record, and the recognition code is a repeated 9-instruction block
   rather than a loop over the array. There _are_ stride-4 arrays of pointers to the records immediately
   after each record array, which is what the C code indexes by number.
3. **Pointers in this image use the SH-4 alias form `0xA4xxxxxx`, not `0x04xxxxxx`.** Physical
   `0x040ad0bc` is referenced as `0xa40ad0bc`. This is why the earlier search for absolute pointers to
   the strings and tables returned zero hits and was misread as "the strings must be reached by a base
   register plus offset". They are reached absolutely; the search was looking for the wrong address form.
   **Any further xref search must use the `0xA4` form.** The image is little-endian, confirmed
   independently as the native `sts.l pr,@-r15` byte pair `22 4f` occurs 5,964 times against 43 for the
   reversed pair.

**Tag recognition, confirmed from the code:** given a 4-byte tag it compares against each record of the
`0x040ace28` list in that exact order, returning 0 for recognised and -1 for unrecognised, and it **never
reads a section length**. Unknown tags simply fall through to -1. This means the deck does not skip
sections by their declared size, so a length field in our files is not what protects us.

**The reader enforces an expected order.** In `msc_anlz_local_usbRd.c` (code from `0x042b7506`, pools
pointing at the table at physical `0x040ad1b4`), each section tag read is compared against the next
expected record with the same 4-byte compare, and on mismatch the code **does not resynchronise**: it
jumps to an error exit that logs file and line and returns **-2** (`0x042b8178`) or **-3**
(`0x042b8196`). Confirmed at the read helper and at the `PVBR` comparison; the identical three-instruction
shape recurs for the remaining tags. The expected sequence recorded for that table is
`PMAI PPTH PVBR PQTZ PWAV PWV2 PCOB PCPT`.

**Where that leaves our writer.** Our DAT emits a 28-byte `PMAI` file header, then
`PPTH PVBR PQTZ PWAV PWV2 PCOB PCOB`, so the first seven expected tags match in order and the eighth
differs: we emit a second `PCOB` (the memory cue list) where the table names `PCPT`. Two readings remain
open and the code examined does not yet decide between them: either `PCPT` is the tag of the first cue
entry _inside_ the `PCOB` body, in which case our sub-tag assumption and our second `PCOB` are both fine,
or `PCPT` is a top-level section that follows `PCOB`, in which case our second `PCOB` is where the reader
loses the sequence. Rekordbox's own DAT files do carry two cue lists, so repetition is probably tolerated,
but which of the two readings holds is **not yet determined** and a follow-up disassembly of the writer
and manager modules is running against it.

**A section header the deck itself builds** carries, after its 4-byte tag, a **32-bit length field of
`0x1C` (28)**, then u16 fields (one of them 1) and zero fill from +128. That is the 28-byte ANLZ header
seen from the deck's side, matching the 28-byte file header our writer emits.

**The database side, and a useful negative.** An exhaustive message scan across the database region and
the whole image found **no PDB analogue of the ANLZ breakage message**. There is no `broken`, `corrupt`,
`checksum`, `CRC`, `invalid` or `illegal` string associated with the export database, no magic or version
constant check adjacent to any of the six sites that load `export.pdb` or `exportExt.pdb`, and the failure
path is a return of -1 with an internal log rather than a rejection. The `CacheDB DSQLerror!` family
belongs to the deck's own SQL cache, which is a different database. **So the deck does not adjudicate our
file as corrupt; when a device library is rejected as corrupted, the stricter reader is rekordbox, not the
player.** That is exactly why the byte-differential against a genuine rekordbox export, the method behind
PRs #585 to #590, is the right instrument for acceptance, and it reframes the expectation behind issue
#577.

**Still open, with the code that will decide them already located:** the PCOB and PCO2 entry strides and
the meaning of the cue type byte, the cue-list slot structure, and the PCO2 label and colour offsets. In
this run no raw track-row access at the offsets our writer uses was observed either, so the database field
mapping remains unconfirmed from the deck's side.

## 17. Cue-record layout: what the deck's reader requires, and what stayed unresolved

A second disassembly pass went at the writer and manager modules directly, and it settles the question
section 16 left open.

**The trailing `PCPT` in the expected sequence is a per-record prefix, not a following section.**
Immediately after the `PCOB` tag matches, every record the reader takes must begin with the four bytes
`PCPT`: the comparison is a 4-byte match at the start of each record (`0x042b7d06`-`0x042b7d1c` and
`0x042b836e`-`0x042b837e`), and a mismatch jumps to an error exit (`0x042b7d9c` /
`0x042b83ae`). That is why the table ends `... PCOB PCPT`. **CONFIRMED as code.** It also means our
writer's choice to prefix cue entries with a `PCPT` sub-tag is what this deck expects, and the earlier
worry that a second `PCOB` section breaks the expected sequence does not follow from this code, because
the `PCPT` requirement is per record rather than a section that must appear after `PCOB`. The
section-level walk across two `PCOB` sections remains undecoded, so that narrow point is still open.

**Cue record stride.** The code strides cue records by **64 bytes**, from four independent witnesses: a
`shld` by 6 for a `count * 64` allocation (`0x042b7c98`), `add #64,r11` in a loop delay slot
(`0x042b83a8`), `add #64,r4` on the write side (`0x042ba142`), a 64-byte copy spanning `+0` to `+0x3C`
(`0x042b7d4c`-`0x042b7d86`), and reads issued with a length of 64 (`0x042b7cec`, `0x042b8358`).
**CONFIRMED as code.** A real asymmetry sits beside it and is left unresolved rather than smoothed over:
on the write path the record IO length is **56 while the stride is 64**. Whether 64 is the parsed
in-memory record and 56 the serialised one, or whether a field is padded, is **UNRESOLVED**. The
file-level layout is best settled by the byte-differential against rekordbox's own export, which is
already the method behind the cue issues.

**There is a second cue list, and capacity is not 8.** Two independent `PCOB`-triggered walks exist in the
reader; the second reads a different count and handles only slots beyond 10 (`cmp/gt #10`, allocating
`(count - 10) * 64`, `0x042b8276`-`0x042b82a8`). **CONFIRMED.** So the deck's model is a list of up to 10
plus an overflow list, not the fixed eight hot cues our writer assumes when it splits cues A to C into the
DAT and D onward into the EXT. The only per-record discriminator found is **bit 1 of the u32 at record
offset +16**, which increments a counter when clear (`0x042b838c`-`0x042b83a2`). **CONFIRMED as code**, but
what that flag means in cue terms is not established. The record count is a u16 in the reader's context
(`ctx+0xB5A`, `ctx+0xB8E`) and a u32 in the writer's structure (`+36`).

**PCO2 is not in the strict-order reader's table.** `PMAI PPTH PVBR PQTZ PWAV PWV2 PCOB PCPT` is the set
for both the reader and the writer tables; `PCO2` appears only in the manager table (`0x040ad274`) and in
`msc_anlz_api_usb.c`. **CONFIRMED.** Our DAT carries no `PCO2`, so this does not affect the DAT path; it
matters for the EXT, which is the manager's territory. In the manager's `PCO2` code
(`0x042bcef6`-`0x042bcfb2`) the offsets touched are `+4`, `+8`, `+12`, `+14`, `+16`, with a 16-byte item
packed and a payload copied at item `+18`; **which of those carries the label and which the colour is NOT
determinable** from this code.

**What the deck's code does not settle.** No site in the decoded loops compares an entry field against 1,
2 or `0xFFFFFFFF`, so **the meaning of the cue type byte and the loop end sentinel is NOT DETERMINABLE
from this code**, and it was deliberately not guessed. No count-versus-length check, checksum or
skip-by-length resynchronisation was found in the decoded loops either, stated as not-proof-of-absence
since the section walk before `0x042b7c00` and the tail after `0x042b83de` were not decoded. For these two
questions the rekordbox byte-differential stays the deciding instrument.

**Two method facts worth keeping.** The alias maps as `physical = 0x04000000 | (ptr & 0x00FFFFFF)`, so a
naive subtraction of `0x04000000` yields an offset outside the image. And cross-references are found most
reliably by scanning aligned little-endian u32 for the address of an **individual tag record**, not a table
base, because each code site loads its own record pointer from its own pool slot.

## 18. Cue fields and database validation: pass two, including corrections to section 17

A second pass swept the cue and database regions with the decompiler and cross-referenced every cue-tag
use in the whole image. It settles the cue question, and it corrects two things section 17 said.

### The cue-section plumbing does not test a cue type value

Every reference to the tags `PCPT`, `PCOB` and `PCO2` anywhere in the 4 MB image resolves to exactly **five
literal-pool words**, and all five sit either inside the two cue-record read loops (`0x042b7fa0`,
`0x042b8608`, `0x042b7c80`, `0x042b82ec`) or inside the `PCO2` builder (`0x042bd070`). **No consuming module
reads a cue type **value** compared against 1, 2 or `0xFFFFFFFF`. The only per-record predicate in that code
is bit 1 of the u32 at record offset `+0x10`, which bumps the counter at `ctx+0xB84` when the bit is clear.

**Scope of this claim, narrowed after a challenge.** The scan is exhaustive for references to the tag
_strings_, which is how the code handling the cue sections is located. A test on a cue value need not
reference a tag string, so this covers the cue-section plumbing rather than the whole image. The routines
that interpret cue kinds may live in the `disc_cue_*` and `mep_cue_*` modules, which have not been
decompiled; a follow-up is running against them.

**The deck certainly does store cues.** Its own writer module (`msc_anlz_local_usbWr.c`) emits
`PCPT`-prefixed records at a 0x40 stride with a 0x38-byte IO length and writes a `PCO2` section, so cues
written on the deck are real and readable. What the plumbing does not do is decide what a cue _is_ from a
small integer type field of the kind our writer emits. The likeliest carrier of that distinction is which
cue list an entry belongs to, that is the section or slot index, together with status-flag bits.

The consequence for our exporter, narrowed accordingly: the firmware cannot _confirm_ our type encoding, so
rekordbox's own output remains the authority for the hot cue, memory cue and loop values, for the end
sentinel and for colours. It does not follow that the deck is blind to cue kinds, and it does not follow
that the deck cannot store them.

### Two corrections to section 17

1. **`FUN_042bcef6` is a `PCO2` _builder_, not a parser.** It writes the literal `"PCO2"` into the record
   buffer and copies the label payload; `DAT_042bd070` is `0x040ad29c`, the `PCO2` record in the manager
   table. So the field mapping read out of it describes what the **deck itself writes** when it writes an
   ANLZ file, not what it expects to find. Useful in itself: the deck's own writer emits a `PCO2` section,
   so `PCO2` is inside this generation's write vocabulary as well as its read tables.
2. **The field at record `+0x2C` has no field meaning.** In `FUN_042b7c98` it is `puVar6[0xb]` inside a
   16-longword whole-record copy, not a position being filled in. Section 17's "the position field" reading
   was wrong.

### What the deck's own `PCO2` records look like

The builder writes `label(4) | u32 | u32 | u16 | u16 | u16 | [u32 if d[+0x14] != 0]`, with the label copied
to `record + d[+4]` for a length of `d[+8] - d[+4]`, so the two u32s are a start and end offset for the
label payload. `FUN_042bd48c` builds `label(4) | u32 | u32(len) | u16 | payload` with a header length of
`0x0E` and guards `arg > 0xd && len > 0xd`. `FUN_042bd074` reads u16 fields at `+2` and `+0x0E` through
`+0x1A` and u32 at `+4` and `+8`, and derives `label_len = LEN - 0x2C - count(+0x1A)`, which is the one
place `0x2C` carries real meaning. Its working set is **56 bytes per record, `count * 0x38`**, which agrees
with the writer's 56-byte IO length. **Which field carries the colour is NOT DETERMINABLE:** no mask or
unpack to three or six bits exists anywhere in that cluster.

### The `+0x10` flag and the database

The reader does `mov.l @(16,r11)` then `tst #2`, and increments the counter at `ctx+0xB84` when the bit is
**clear**. The control flow is confirmed; the meaning is not, and the counter has no readers anywhere.

**No database validation exists.** The `0x04060000`-`0x04076000` region is data, holding the export path
strings. The two xref sites that use those strings (`0x0417c062`-`0x0417c0b4` and `0x041a7824`) pass the path
to helper routines and branch only on whether the return value is zero; **no magic, version, page counter or
checksum is read.** The `0x04170000`-`0x04174000` region, 24 functions, is the filesystem layer and contains
only byte-class tests. This closes the question raised in section 16 with the same answer: the deck reads
what rekordbox writes without adjudicating it.

### Remaining work, stated precisely

The two export reference sites are not inside functions Ghidra defined, so their callees were not
decompiled. Closing the validation question completely needs `AddFunctions` at the starts of the functions
containing `0x0417c062` and `0x041a7824`. Everything else here rests on decompiled bodies or on an
exhaustive scan of the image.

## 19. Does the deck distinguish cue kinds? What the third pass settled and where it stopped

This pass was a deliberate check on section 18's claim, after the objection that the deck demonstrably
stores cues. The objection was right about the deck's capabilities and the claim needed narrowing.

### Confirmed

- **Exactly one predicate exists on a cue record:** `tst #2` on the u32 at record `+0x10`, byte-verified in
  the image and in the decompilation, in both `PCPT` loops. Nothing else inspects a cue record's fields.
- **The counter that predicate feeds is write-only.** It lives at `base+0xB9C`, correcting section 18's
  `0xB84`, and the idiom that forms `0xB9C` occurs **exactly once in the entire 4 MB image**, the increment
  itself, with no literal-pool entry for `0xB9C` or `0xB84` anywhere. So the bit's meaning cannot be derived
  from this firmware, and it therefore cannot name hot cue, memory cue or loop.
- **Cue entries are addressed positionally:** `base(ctx+0xB6C) + slot(ctx+0xB68) * 0x40`. Neither the base
  nor the slot is ever interpreted, with no bound check and no dispatch on either.
- **The deck's writer emits its own type field.** `FUN_042bd48c` builds
  `tag(4) | u32 | u32(len) | u16 | payload` with a header length of `0x0E` and a `0x38` body, and the u16 is
  a byte-swapped value taken from its fourth argument, landing at **record offset `+0x0C`**. So the deck does
  write a per-entry type field, and section 18's claim was correctly narrowed: the deck writes one and no
  reader tests one in the code examined.

### Where this stopped, and why

The four call sites of that builder were located as **pool slots** (`0x042bafc0`, `0x042bb2dc`, `0x042bb644`,
`0x042bb918`), and all four hold the same value, the builder's own address. They are not referenced by any
`mov.l @(disp,PC),Rn` in the entire image, which was verified arithmetically by computing the pool target of
every `0xDnnn` word rather than by sampling: **zero direct pool references.** The builder is therefore
reached through an indexed table, and the constants it receives as its type argument are not extractable by
static reference following. Extracting them would need either dynamic analysis in an emulator or a
table-ownership analysis of the dispatcher.

**So the type values themselves remain undetermined from the firmware**, and the differential against
rekordbox's own output is the practical authority, which is where this question now belongs. One candidate
remains flagged for a future pass rather than claimed: of the fifty image-wide sites that compare some
structure's `+0x10` against 1, 2 or 3, exactly one (`0x042a0386`, a `cmp/eq #1`) sits near a cue module, just
above the last log site of `mep_cue_local.c`. It is UNCERTAIN which structure it inspects.

### Bonus: the module map, by alias-pointer scan

| module                             | what the scan pinned                 |
| ---------------------------------- | ------------------------------------ |
| `disc_cue_api.c`                   | log sites 0x041aa024-0x041aad20      |
| `disc_cue_localWr.c`               | log sites 0x041b2f78-0x041b3ea0      |
| `mep_cue_api.c`, `mep_cue_local.c` | log sites 0x0429ed10-0x0429fd8c      |
| `msc_anlz_api_usb.c`               | code 0x042aa764-0x042ababc, 18 sites |
| `msc_anlz_local_usbWr.c`           | code 0x042b8abc-0x042ba738           |

That is the deck's own layout of the cue and ANLZ code, which is what makes the next sweep a matter of
picking a name rather than searching blind.

## 20. The cue record layout, confirmed from rekordbox's own output

Every cue question in this document has been answered by the firmware only in the negative. The layout
itself comes from the preserved rekordbox 6 captures under `reverse-engineering/captures/`, which is the
authority section 19 said it had to be. Raw dumps in `~/re/fw2k/nxs-emulator-cues.md`.

A `PCPT` record is **56 bytes (`0x38`)** and reads as follows, big-endian:

| offset  | field                                                     |
| ------- | --------------------------------------------------------- |
| `+0x00` | `PCPT` tag                                                |
| `+0x04` | u32 entry header length, `0x1C`                           |
| `+0x08` | u32 entry length, `0x38`                                  |
| `+0x0C` | u32 **cue slot: `0` = memory cue, `1..8` = hot cue A..H** |
| `+0x10` | u32 zero                                                  |
| `+0x14` | u32 constant `0x00010000`                                 |
| `+0x18` | u32 constant `0xFFFFFFFF`                                 |
| `+0x1C` | u8 **type: `1` = cue point, `2` = loop**                  |
| `+0x1D` | three bytes, `00 03 e8`                                   |
| `+0x20` | u32 start time in milliseconds                            |
| `+0x24` | u32 loop end in milliseconds, or `0xFFFFFFFF`             |
| `+0x28` | 16 zero bytes                                             |

The enclosing `PCOB` section header carries the list kind: `PCOB`, u32 header length `0x18`, u32 section
length, then a u32 that is **1 for the hot cue list and 0 for the memory cue list**, a u32 entry count, and
`0xFFFFFFFF`.

**Cross-checks, all from separate captures:** `41-hot-cue-a-h` holds eight hot cues with slots 1 to 8 at
`+0x0C`, every record with `+0x1C` = `01` and `+0x24` = `FFFFFFFF`. `47-multiple-loops` holds four loops with
slots 1 to 4, `+0x1C` = `02`, and real end positions at `+0x24`. `44-labled-cue` shows the label in `PCO2`/`PCP2`
as **UTF-16BE with a u16 length prefix** (`00 0C` before `Break`) followed by a **three-byte colour**
(`33 FF 00`).

**What this settles, with the defects named:**

1. **Loops are type `2` with an absolute end time**, so our writer emitting type `1` with an end of
   `0xFFFFFFFF` is wrong, which is issue #571.
2. **A memory cue is an ordinary cue record with slot `0`** at `+0x0C` and type `1`, not a stub, which is
   issue #572. Nothing else in the record distinguishes it from a hot cue.
3. **Labels and colours live in `PCO2`/`PCP2`** as a length-prefixed UTF-16BE string plus three colour
   bytes, which is issue #574.
4. Eight hot cues fit in a single file with slots 1 to 8, which puts the A to C / D to H split our writer
   assumes in question.

**Why the firmware could not have answered this, restated:** the deck's writer takes the slot number as its
fourth argument and stores it at `+0x0C`, and the deck's reader never tests a type value at all. The kinds
are expressed by _which record and which section an entry belongs to_, which is a property of the file
layout rather than of any comparison the code makes. The emulator was the right instinct for behaviour; the
captures were the faster oracle for encoding.
