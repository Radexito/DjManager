# Pioneer 2k / XDJ firmware: what the update files actually contain

Measured 2026-09-26 on the official `.UPD` files, using a multi-target binutils built in `~/re/binutils`.
Working copies live in `~/re/fw2k/`. Nothing here is copied from community notes; every claim has an offset
or a measurement, and the negative results are listed as plainly as the positive ones.

## 1. Container format (verified, sums to the byte)

A `.UPD` is a manifest, then N components concatenated:

```
<size1 in decimal>\r\n<size2>\r\n...      manifest, then
<MODEL> <PART>Ver<X.YZ>                  fixed-width banner, padded with spaces, NUL-terminated
<payload>                                either Motorola S-record text, or raw binary
```

The manifest sizes plus the manifest length equal the file size exactly:

| file | manifest | components | banner overhead |
| --- | --- | --- | --- |
| `CDJ2000NXS_v144.UPD` | 33 bytes | 2015268, 388690, 7062204, 98888 | 0 |
| `CDJ2000NXS2_v187.UPD` | 33 bytes | 6931940, 388690, 9347916, 100274 | 0 |
| `XDJ1KMK2_v145.UPD` | 17 bytes | 25306326, 90046 | 0 |
| `XDJRX_v221.UPD` | none | whole file encrypted, see section 5 | |
| `XDJRX2_v143.UPD` | none | whole file encrypted, see section 5 | |

Verification for the XDJ-1000MK2: `17 + 25306326 + 90046 = 25396389`, the exact file size. For the NXS:
`33 + 2015268 + 388690 + 7062204 + 98888 = 9565083`, likewise exact.

Each component names itself in its banner, so the component inventory is readable without any guessing:

| model | component | payload form | decoded image |
| --- | --- | --- | --- |
| CDJ-2000NXS 1.44 | `CDJ-2000NXS GUI Ver1.200` | raw binary | 2,015,268 bytes as stored |
| | `CDJ-2000NXS DRIVVer1.00` | S-record text | 8,450 records |
| | `CDJ-2000NXS MAINVer1.44` | S-record text | 90,542 records |
| | `CDJ-2000NXS PANLVer1.00` | S-record text | 1,286 records |
| CDJ-2000NXS2 1.87 | `CDJ-2000NXS2GUI Ver1.81` | raw binary | 6,931,940 bytes as stored |
| | `CDJ-2000NXS2DRIVVer1.00` | S-record text | 135,168-byte image, 8,448 records |
| | `CDJ-2000NXS2MAINVer1.87` | S-record text | 3,906,816-byte image, 119,844 records, entry `0xA0000000` |
| | `CDJ-2000NXS2PANLVer1.00` | S-record text | 1,048,576-byte image, 1,297 records |
| XDJ-1000MK2 1.45 | `XDJ-1000MK2 MAINVer1.45` | S-record text | 10,504,320-byte image, 324,439 records, entry `0xA0000000` |
| | `XDJ-1000MK2 PANLVer1.00` | S-record text | 1,048,576-byte image, 1,166 records |

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
  ARM and Thumb are also ruled out by fingerprint: `push {..lr}` frequency is *below* the random-data
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
- The toolchain: `binutils 2.39 --target=bfin-elf --enable-targets=bfin-elf,arm-linux-gnueabi,aarch64-linux-gnu`.
  Do **not** use `--enable-targets=all`: `opcodes/mips-formats.h` fails to compile with a modern GCC
  (`static_assert` without `assert.h`), which aborts the whole build.
- Scripts used are in `~/re/fw2k/`: `split_components.py`, `srec_decode2.py`, `census.py`,
  `component_codescan.py`, `code_map.py`, `arm_fingerprint.py`, `lz_trials.py`, `raw_trials.py`.

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

| measurement | value |
| --- | --- |
| longest byte-identical prefix | **72 bytes** (identical in both), then they diverge |
| byte-identical positions overall | 27,224 of 135,168 = 20.1% |
| entropy | 7.60 (NXS) and 7.53 (NXS2) |
| chi-square, byte histogram | 150,928 and 191,410 (uniform is about 255) |
| readable strings in the decoded payload | none; only 6 to 8 character fragments |

Both are packed with the same scheme, and the shared 72-byte prefix is the interesting part: it is
consistent with **compression of near-identical source**, where a small build difference propagates after
the first block, and inconsistent with a keyed transform, which would leave no identical prefix at all.
Together with the skewed histograms in section 3, that is a second independent argument that these
payloads are compressed rather than encrypted. It also means the DRIV payloads cannot be decrypted into
readable code by any key, and only the GUI component (section 2) is directly readable.
