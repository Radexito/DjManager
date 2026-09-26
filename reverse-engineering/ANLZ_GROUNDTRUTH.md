# ANLZ Ground-Truth Byte Report

**Job:** find real rekordbox-/CDJ-written ANLZ files reachable from this machine, byte-document their
section layout and cue records (labels + colours), and compare against the DjManager writer
(`~/github/DjManager/src/audio/anlzWriter.js`).

**Verdict up front: ground truth WAS found.** Two independent rekordbox-written families plus one
device-written family, and — critically — **real cue records with labels and colours** exist in the
repo's own `reverse-engineering/captures/`, which are **rekordbox exports, not ours** (provenance
proof in §2). No CDJ-written ANLZ with cues exists on this machine.

All copies live under `/tmp/anlz-gt/` (read-only on every source; nothing written to the laptop, the
stick, or the repo).

---

## 1. Inventory of every ANLZ file found

| #   | Source path                                                                                                           | Files                                                                         | Writer                                               | How I know                                                                                                                                                                                                       | Copied to                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| A   | `C:\Users\Radexito\AppData\Roaming\Pioneer\rekordbox\share\PIONEER\USBANLZ\<xx>\<uuid>\ANLZ0000.{DAT,EXT,2EX,3EX}`    | **374** (98 DAT, 97 EXT, 97 2EX, 82 3EX), 26 MB, all mtime `2026-07-25 16:17` | **rekordbox (PC)** — GROUND TRUTH                    | It _is_ rekordbox's own AppData export cache; contains `.3EX` and `PSSI` which this repo cannot produce                                                                                                          | `/tmp/anlz-gt/share/`           |
| B   | `C:\shimi usb\PIONEER\USBANLZ\P0xx\xxxxxxx\ANLZ0000.DAT`                                                              | **54** DAT-only, all mtime `01/01/2012 01:00` (Pioneer device epoch)          | **device (CDJ/XDJ) or old rekordbox** — GROUND TRUTH | DAT-only (no EXT/2EX), device epoch timestamp, header constants `1,0,0,0`, sits beside `RBFLTR.DAT`, `PIONEER/CDJ`, `PIONEER/MPJ`, and **no** `MYSETTING.DAT`                                                    | `/tmp/anlz-gt/shimi/`           |
| C   | `~/github/DjManager/reverse-engineering/captures/<NN-slug>/PIONEER/USBANLZ/P0xx/xxxxxx/ANLZ0000.{DAT,EXT,2EX}`        | 52 ANLZ sets across 25 capture dirs                                           | **rekordbox (PC)** — GROUND TRUTH, **contains cues** | See §2 — decisive                                                                                                                                                                                                | read in place (repo, read-only) |
| D   | `U:\PIONEER\USBANLZ\P037\00006F45` and `P066\0001A04C` (drive `U:`, label `DJ_OUTPUT`, mounted on the Windows laptop) | 6 (2× DAT/EXT/2EX)                                                            | **OURS (DjManager)**                                 | `U:\PIONEER\rekordbox\export-manifest.json` (written only by our exporter) lists exactly `analyzePath: /PIONEER/USBANLZ/P037/00006F45/ANLZ0000.DAT` and `.../P066/0001A04C/...`. All mtime `2026-09-26 02:05 AM` | `/tmp/anlz-gt/stick/`           |
| E   | `C:\Users\Radexito\Desktop\playlists.zip` → `PIONEER/USBANLZ/P05C/0001DFE2/`                                          | 3 (DAT/EXT/2EX)                                                               | **OURS (DjManager)**                                 | zip contains `PIONEER/rekordbox/export-manifest.json`; PPTH = `/music/...`                                                                                                                                       | `/tmp/anlz-gt/zipanlz/`         |

Also recovered for context: `C:\shimi usb\PIONEER\rekordbox\{export.pdb, exportExt.pdb, RBFLTR.DAT}`
→ `/tmp/anlz-gt/shimi_rekordbox/`.

**Local Linux machine (`/`, `-xdev`): no `ANLZ0000.*` and no `export.pdb` anywhere.** `/run/media`,
`/media`, `/mnt` are empty (`/mnt/{bitlocker,seed,windows}` exist but contain no ANLZ).

---

## 2. Provenance proof for family C (this is the whole point of the job)

Family C lives in _our_ repo, so it had to be checked hard. It is **not** ours:

1. **`PPTH` payload path.** Every family-C file carries a rekordbox _device-library_ path:
   - C: `/Contents/UnknownArtist/UnknownAlbum/track-normal.mp3`
   - C (41): `/Contents/UnknownArtist/UnknownAlbum/track-normal.mp3`
   - C (51): `/Contents/artist_name/album_name/track-normal.mp3`
     Our writer emits a flat `/music/<file>` path (proven by family D/E:
     `/music/Drake - Drake - God's Plan.mp3`). `grep` for `Contents` in `src/` returns nothing.
2. **`PSSI` sections.** Family C's `.EXT` files end with a `PSSI` section (e.g. capture 41:
   `PSSI @0x29c0f lenHdr=32 lenTag=728`, 695 non-zero bytes). `PSSI` appears **nowhere** in this
   repo's source — our writer physically cannot emit it.
3. **`DJMMYSETTING.DAT`** is present in 24 of 25 capture dirs and contains the ASCII strings
   `PioneerDJ` and `rekordbox` (`60000000 "PioneerDJ" ... "rekordbox" ... "1.000"`). Our
   `settingWriter.js` writes only `MYSETTING.DAT`, `MYSETTING2.DAT`, `DEVSETTING.DAT`.
4. **`PIONEER/extracted/gcred.dat`** (obfuscated blob) and **`PIONEER/rekordbox/exportLibrary.db`**
   (obfuscated, starts `82 62 31 42 3c 63 2d c4` — not SQLite) exist in every family-C capture.
   Neither name appears in this repo.
5. **No `export-manifest.json`** in any family-C capture — our exporter always writes one.
6. Test-track file names (`track-normal.mp3`, `track-160bpm.mp3`, `track-140bpm.mp3`,
   `track-variable-bpm.mp3`) match `reverse-engineering/CAPTURE_GUIDE.md` verbatim, and
   `capture 41`'s `export.pdb` contains the literal strings `Orange`, `Yellow`, `Purple`.

**Conclusion:** family C = rekordbox 6/7 exports captured into the repo per CAPTURE_GUIDE.md.
**This is the ground truth the task was looking for, and it contains cues with both labels and colours.**

---

## 3. Full section listing (representative member of each family)

### A — rekordbox PC export cache, `share/fe7/5413b-e285-4730-8ede-bcd954508b0d/`

`ANLZ0000.DAT` — 7704 bytes, `len_file=0x1e18`, header constants `1, 0x00010000, 0x00010000, 0`

| tag  | offset   | lenHdr | lenTag | body | nonZero | entropy | note                                                                           |
| ---- | -------- | ------ | ------ | ---- | ------- | ------- | ------------------------------------------------------------------------------ |
| PPTH | 0x00001c | 16     | 60     | 44   | 21      | 2.850   | path `?/without_artwork.mp3` (decoded len_path=44)                             |
| PVBR | 0x000058 | 16     | 1620   | 1604 | **3**   | 0.023   | seek table essentially empty                                                   |
| PQTZ | 0x0006ac | 24     | 5408   | 5384 | 3870    | 4.337   | 673 beats; first `bn=2 tempo=15000 t=53ms`, last `bn=2 tempo=15000 t=268853ms` |
| PWAV | 0x001bcc | 20     | 420    | 400  | 400     | 5.322   |                                                                                |
| PWV2 | 0x001d70 | 20     | 120    | 100  | 100     | 3.597   |                                                                                |
| PCOB | 0x001de8 | 24     | **24** | 0    | 0       | 0.0     | stub, type=1, num=0, sentinel 0xffffffff                                       |
| PCOB | 0x001e00 | 24     | **24** | 0    | 0       | 0.0     | stub, type=0                                                                   |

`ANLZ0000.EXT` — 130334 bytes

| tag      | offset       | lenHdr | lenTag  | body    | nonZero | note                                          |
| -------- | ------------ | ------ | ------- | ------- | ------- | --------------------------------------------- |
| PPTH     | 0x00001c     | 16     | 60      | 44      | 21      |                                               |
| PWV3     | 0x000058     | 24     | 40380   | 40356   | 40251   | 1 byte/col, cols=40356                        |
| PCOB     | 0x009e14     | 24     | 24      | 0       | 0       | stub                                          |
| PCOB     | 0x009e2c     | 24     | 24      | 0       | 0       | stub                                          |
| PCO2     | 0x009e44     | 20     | 20      | 0       | 0       | stub                                          |
| PCO2     | 0x009e58     | 20     | 20      | 0       | 0       | stub                                          |
| PQT2     | 0x009e6c     | 56     | 1402    | 1346    | 1346    | entry_count=673, 673×2=1346 ✓, f44=0x05fec87f |
| PWV5     | 0x00a3e6     | 24     | 80736   | 80712   | 77786   | 2 bytes/col, cols=40356                       |
| PWV4     | 0x01df46     | 24     | 7224    | 7200    | 7167    | 6 bytes/col, cols=1200                        |
| **PSSI** | **0x01fb7e** | **32** | **416** | **384** | **78**  | **our writer has no PSSI**                    |

`ANLZ0000.2EX` — 124820 bytes: `PPTH(16,60) → PWV7 @0x58 (24,121092) → PWV6 @0xd95c (20,3620) → PWVC @0x1e780 (14,20)`

`ANLZ0000.3EX` — 7834 bytes — **NOT an ANLZ/PMAI container.** First bytes
`81 a9 65 6d 62 65 64 64 69 6e 67 8b a2 64 34 cb ...` = msgpack-ish map with the literal ASCII
string `embedding`, plus a UUID `7f08a5ebc606992bdcf37a2db610e599` and float payload. Treat `.3EX`
as a separate, non-ANLZ format.

**Section-sequence census over all 374 family-A files:**

```
 96 x .DAT  PPTH -> PVBR -> PQTZ -> PWAV -> PWV2 -> PCOB -> PCOB
 16 x .EXT  PPTH -> PWV3 -> PCOB -> PCOB -> PCO2 -> PCO2 -> PQT2 -> PWV5 -> PWV4
 72 x .EXT  PPTH -> PWV3 -> PCOB -> PCOB -> PCO2 -> PCO2 -> PQT2 -> PWV5 -> PWV4 -> PSSI
  7 x .EXT  PPTH -> PWV3 -> PCOB -> PCOB -> PCO2 -> PCO2 -> PWV5 -> PWV4          (no PQT2)
 95 x .2EX  PPTH -> PWV7 -> PWV6 -> PWVC
 80 x .3EX  (not PMAI)
```

**Non-empty cue sections in family A: 0 of 374.** rekordbox's AppData share cache holds analysis only;
cues live in `export.pdb` until a USB export.

### B — device-written, `shimi/P000/0000C128/ANLZ0000.DAT` — 2352 bytes

Raw header: `50 4d 41 49 | 00 00 00 1c | 00 00 09 30 | 00 00 00 01 | 00 00 00 00 | 00 00 00 00 | 00 00 00 00 | 50 50 54 48`

| tag  | offset   | lenHdr | lenTag | body | nonZero          |
| ---- | -------- | ------ | ------ | ---- | ---------------- |
| PPTH | 0x00001c | 16     | 92     | 76   | 37               |
| PVBR | 0x000078 | 16     | 1620   | 1604 | **0**            |
| PQTZ | 0x0006cc | 24     | 24     | 0    | 0 (beat_count=0) |
| PWAV | 0x0006e4 | 20     | 420    | 400  | 396              |
| PWV2 | 0x000888 | 20     | 120    | 100  | 99               |
| PCOB | 0x000900 | 24     | 24     | 0    | 0 (type=1)       |
| PCOB | 0x000918 | 24     | 24     | 0    | 0 (type=0)       |

All 54 family-B files have this identical sequence and **0 non-empty cue sections**.

### C — rekordbox export with cues, `43-hot-cue-colors/…/P056/00018344/`

`ANLZ0000.DAT` — 9896 bytes

| tag      | offset       | lenHdr | lenTag  | body | nonZero  |
| -------- | ------------ | ------ | ------- | ---- | -------- |
| PPTH     | 0x00001c     | 16     | 124     | 108  | 53       |
| PVBR     | 0x000098     | 16     | 1620    | 1604 | **3**    |
| PQTZ     | 0x0006ec     | 24     | 7368    | 7344 | 5331     |
| PWAV     | 0x0023b4     | 20     | 420     | 400  | 400      |
| PWV2     | 0x002558     | 20     | 120     | 100  | 100      |
| **PCOB** | **0x0025d0** | 24     | **192** | 168  | 63       |
| PCOB     | 0x002690     | 24     | 24      | 0    | 0 (stub) |

`ANLZ0000.EXT` — 171751 bytes

| tag      | offset       | lenHdr | lenTag  | body   | nonZero  |
| -------- | ------------ | ------ | ------- | ------ | -------- |
| PPTH     | 0x00001c     | 16     | 124     | 108    | 53       |
| PWV3     | 0x000098     | 24     | 53569   | 53545  | 53268    |
| **PCOB** | **0x00d1d9** | 24     | **304** | 280    | 105      |
| PCOB     | 0x00d309     | 24     | 24      | 0      | 0 (stub) |
| **PCO2** | **0x00d321** | 20     | **724** | 704    | 158      |
| PCO2     | 0x00d5f5     | 20     | 20      | 0      | 0 (stub) |
| PQT2     | 0x00d609     | 56     | 1892    | 1836   | 1591     |
| PWV5     | 0x00dd6d     | 24     | 107114  | 107090 | 101101   |
| PWV4     | 0x027fd7     | 24     | 7224    | 7200   | 6787     |
| **PSSI** | **0x029c0f** | 32     | 728     | 696    | 695      |

---

## 4. Decoded ground-truth cue records (exact offsets)

### 4.1 PCOB header — byte-identical to our spec, entries start at `offset + lenHdr` (NO `len_entry` field)

`43-hot-cue-colors` DAT, 0x25d0:

```
0x25d0  50 43 4f 42            'PCOB'
0x25d4  00 00 00 18            len_header = 24
0x25d8  00 00 00 c0            len_tag = 192   (24 + 3*56)
0x25dc  00 00 00 01            type = 1 (hot cues)
0x25e0  00 00                  pad = 0
0x25e2  00 03                  num_cues = 3
0x25e4  ff ff ff ff            sentinel
0x25e8  50 43 50 54 00 00 00 1c 00 00 00 38   first PCPT, len_header=28, len_tag=56
```

### 4.2 PCPT (56 bytes, fixed) — `43-hot-cue-colors` DAT, first entry @0x25e8

| off     | size | our-spec name | measured value (hot_cue=2 entry) | measured value (hot_cue=1 entry @0x2620) |
| ------- | ---- | ------------- | -------------------------------- | ---------------------------------------- |
| +0      | 4    | fourcc        | `PCPT`                           | `PCPT`                                   |
| +4      | 4    | len_header    | 28 (0x1c)                        | 28                                       |
| +8      | 4    | len_tag       | 56 (0x38)                        | 56                                       |
| +12     | 4    | hot_cue       | **`00 00 00 02`** (B)            | **`00 00 00 01`** (A)                    |
| +16     | 4    | status        | `00 00 00 00`                    | `00 00 00 00`                            |
| +20     | 4    | const         | `00 01 00 00`                    | `00 01 00 00`                            |
| +24     | 2    | order_first   | `ff ff`                          | `ff ff`                                  |
| +26     | 2    | order_last    | `ff ff`                          | `ff ff`                                  |
| +28     | 1    | type          | `01` (cue point)                 | `01`                                     |
| +29     | 1    | —             | `00`                             | `00`                                     |
| +30     | 2    | const         | `03 e8`                          | `03 e8`                                  |
| +32     | 4    | time_ms       | `00 00 28 7e` = 10366            | `00 00 14 be` = 5310                     |
| +36     | 4    | loop_time     | `ff ff ff ff` (none)             | `ff ff ff ff`                            |
| **+40** | 1    | colour        | **`00`**                         | **`00`**                                 |
| +41     | 15   | —             | zeros                            | zeros                                    |

### 4.3 PCOB record tables

`43-hot-cue-colors/P056/00018344/ANLZ0000.DAT`, PCOB @0x25d0 (type=1, num_cues=3) — **A–C live in the DAT**:

| #   | PCPT @ | hot_cue | type | time_ms | loop_time  | +40 colour |
| --- | ------ | ------- | ---- | ------- | ---------- | ---------- |
| 0   | 0x25e8 | 2 (B)   | 1    | 10366   | 0xffffffff | **0x00**   |
| 1   | 0x2620 | 1 (A)   | 1    | 5310    | 0xffffffff | **0x00**   |
| 2   | 0x2658 | 3 (C)   | 1    | 15033   | 0xffffffff | **0x00**   |

`43-hot-cue-colors/…/ANLZ0000.EXT`, PCOB @0xd1d9 (type=1, num_cues=5) — **D–H live only in the EXT**:

| #   | PCPT @ | hot_cue | type | time_ms | loop_time  | +40 colour |
| --- | ------ | ------- | ---- | ------- | ---------- | ---------- |
| 0   | 0xd1f1 | 8 (H)   | 1    | 40701   | 0xffffffff | 0x00       |
| 1   | 0xd229 | 7 (G)   | 1    | 35256   | 0xffffffff | 0x00       |
| 2   | 0xd261 | 6 (F)   | 1    | 30200   | 0xffffffff | 0x00       |
| 3   | 0xd299 | 5 (E)   | 1    | 25533   | 0xffffffff | 0x00       |
| 4   | 0xd2d1 | 4 (D)   | 1    | 20477   | 0xffffffff | 0x00       |

### 4.4 PCO2 / PCP2 — the label + colour source of truth

`43-hot-cue-colors/…/ANLZ0000.EXT`, PCO2 @0xd321, `lenTag=724`, type=1, **num_cues=8** (u16 at +16 = `00 08`), pad `00 00`:

```
0x0d321  50 43 4f 32   'PCO2'
0x0d325  00 00 00 14   len_header = 20
0x0d329  00 00 02 d4   len_tag = 724
0x0d32d  00 00 00 01   type = 1
0x0d331  00 08         num_cues = 8
0x0d333  00 00         pad
0x0d335  50 43 50 32 ... first PCP2
```

**PCP2 entry layout, verified byte-for-byte** (`43`, entry 0 @0xd335, hot_cue=8):

| off     | size | field       | measured              |
| ------- | ---- | ----------- | --------------------- |
| +0      | 4    | fourcc      | `50 43 50 32`         |
| +4      | 4    | len_header  | `00 00 00 10` = 16    |
| +8      | 4    | len_tag     | `00 00 00 58` = 88    |
| +12     | 4    | hot_cue     | `00 00 00 08`         |
| +16     | 1    | type        | `01`                  |
| +17     | 1    | —           | `00`                  |
| +18     | 2    | const       | `03 e8`               |
| +20     | 4    | time_ms     | `00 00 9e fd` = 40701 |
| +24     | 4    | loop_time   | `ff ff ff ff`         |
| +28     | 1    | color_id    | `00`                  |
| +29     | 1    | const       | `01`                  |
| +30     | 10   | —           | zeros                 |
| +40     | 4    | len_comment | `00 00 00 00`         |
| +44     | —    | label       | (none)                |
| **+44** | 1    | colour code | `31`                  |
| +45     | 1    | R           | `ff`                  |
| +46     | 1    | G           | `00`                  |
| +47     | 1    | B           | `a1`                  |
| +48     | 40   | —           | zeros                 |

**All 8 hot cues in the colour capture (order in file: 8,7,6,5,4,2,1,3):**

| PCP2 @  | hot_cue | time_ms | lenTag | code          | R   | G   | B   | notes.txt intent |
| ------- | ------- | ------- | ------ | ------------- | --- | --- | --- | ---------------- |
| 0x0d335 | 8 (H)   | 40701   | 88     | **0x31** (49) | 255 | 0   | 161 | pink             |
| 0x0d38d | 7 (G)   | 35256   | 88     | **0x38** (56) | 179 | 0   | 255 | violet           |
| 0x0d3e5 | 6 (F)   | 30200   | 88     | **0x01** (1)  | 0   | 0   | 255 | blue             |
| 0x0d43d | 5 (E)   | 25533   | 88     | **0x09** (9)  | 0   | 224 | 255 | cyan             |
| 0x0d495 | 4 (D)   | 20477   | 88     | **0x16** (22) | 26  | 255 | 0   | green            |
| 0x0d4ed | 2 (B)   | 10366   | 88     | **0x26** (38) | 255 | 94  | 0   | orange           |
| 0x0d545 | 1 (A)   | 5310    | 88     | **0x00** (0)  | 255 | 0   | 23  | red              |
| 0x0d59d | 3 (C)   | 15033   | 88     | **0x20** (32) | 255 | 232 | 0   | yellow           |

### 4.5 Labelled cue — `45-labled-cue-long/P056/00018344/ANLZ0000.EXT`

```
0x0d209  PCO2 | 00 00 00 14 (lenHdr=20) | 00 00 00 a0 (lenTag=160) | 00 00 00 01 (type=1)
0x0d215  00 01   num_cues = 1
0x0d217  00 00   pad
0x0d21d  PCP2 | 00 00 00 10 (lenHdr=16) | 00 00 00 8c (lenTag=140) | 00 00 00 01 (hot_cue=1)
0x0d22d  01 00 03 e8 | 00 00 14 be (time_ms=5310) | ff ff ff ff (loop n/a)
0x0d239  00 01 00*10
0x0d245  00 00 00 34   len_comment = 52  = (25 chars + NUL) * 2
0x0d249  00 54 00 68 00 69 00 73 00 20 00 69 00 73 00 20 00 61 00 20 00 76 00 65 00 72 00 79
         00 20 00 6c 00 6f 00 6e 00 67 00 20 00 6c 00 61 00 62 00 65 00 6c 00 00
         = UTF-16BE "This is a very long label" + 00 00
0x0d27d  00 ff 00 17   colour block at +44+52 = +96 : code=0x00, R=0xff, G=0x00, B=0x17
```

Body = 28 + 52 + 44 = 124 ⇒ `len_tag = 16 + 124 = 140`; section = 20 + 140 = 160 ✓.

### 4.6 Memory cue — `42-momory_cue/P056/00018344/`

```
ANLZ0000.DAT  PCOB @0x25e8  lenHdr=24 lenTag=80  type=0 (memory) num_cues=1
    PCPT @0x2600  hot_cue=0  type=1  time_ms=67924  loop_time=0xffffffff  +40 colour=0x00
    (slot-1 PCOB @0x25d0 is the empty 24-byte stub)
ANLZ0000.EXT  PCO2 @0xd21d  lenHdr=20 lenTag=108 type=0 num_cues=1
    PCP2 @0xd231  hot_cue=0  type=1  time_ms=67924  loop=0xffffffff  code=0x00 rgb=(0,0,0)  lenTag=88
```

### 4.7 Loop cues — `loop_time` is an **absolute end position in ms**, not a length

`46-loop-cue`: notes say "start ≈ 01:01.3, end ≈ 1:02.8, set for 4 beats".

```
ANLZ0000.DAT PCOB @0x25d0 lenTag=80  type=1 num_cues=1
  PCPT hot_cue=1 type=2 time_ms=61313 loop_time=62869 (0xf595)   → 62869-61313 = 1556 ms ✓
ANLZ0000.EXT PCO2 @0xd209 lenTag=108 type=1 num_cues=1
  PCP2 hot_cue=1 type=2 time_ms=61313 loop=0xf595 code=0 rgb=(255,140,0)
```

`47-multiple-loops` (A=1 beat @5s, B=2 @10s, C=4 @15s, D=8 @20s — all confirmed):

| section              | @      | hot_cue | time_ms | loop_time | length_ms | beats |
| -------------------- | ------ | ------- | ------- | --------- | --------- | ----- |
| DAT PCOB (3 entries) | 0x25e8 | 3       | 15421   | 16977     | 1556      | 4     |
|                      | 0x2620 | 2       | 10366   | 11143     | 777       | 2     |
|                      | 0x2658 | 1       | 5310    | 5699      | 389       | 1     |
| EXT PCOB (1 entry)   | 0xd1f1 | 4       | 20477   | 23589     | 3112      | 8     |
| EXT PCO2 (4 entries) | 0xd255 | 4       | 20477   | 0x5c25    | 3112      | 8     |
|                      | 0xd2ad | 3       | 15421   | 0x4251    | 1556      | 4     |
|                      | 0xd305 | 2       | 10366   | 0x2b87    | 777       | 2     |
|                      | 0xd35d | 1       | 5310    | 0x1643    | 389       | 1     |

**Split confirmed:** A–C in DAT PCOB, D+ in EXT PCOB, and EXT PCO2 carries the full set.

### 4.8 Our own files (family D/E) — blind mode, as expected

`stick/P037/00006F45/ANLZ0000.DAT` — 2348 bytes:

| tag  | offset   | lenHdr | lenTag | body | nonZero  |
| ---- | -------- | ------ | ------ | ---- | -------- |
| PPTH | 0x00001c | 16     | 92     | 76   | 37       |
| PVBR | 0x000078 | 16     | 1616   | 1600 | **1194** |
| PQTZ | 0x0006c8 | 24     | 24     | 0    | 0        |
| PWAV | 0x0006e0 | 20     | 420    | 400  | 0        |
| PWV2 | 0x000884 | 20     | 120    | 100  | 0        |
| PCOB | 0x0008fc | 24     | 24     | 0    | 0        |
| PCOB | 0x000914 | 24     | 24     | 0    | 0        |

`stick/P037/00006F45/ANLZ0000.EXT` (168147 B): `PPTH → PWV3(24,53561) → PCOB stub → PCOB stub →
PCO2 stub → PCO2 stub → PQT2(56,56) → PWV5(24,107098) → PWV4(24,7224)` — **no PSSI**.
`2EX` (164395 B): `PPTH → PWV7(24,160635) → PWV6(20,3620) → PWVC(14,20)`.

Our writer's cue bytes were generated by importing the real module
(`/tmp/anlz-gt/gen_ours.mjs` → `node gen_ours.mjs`) with the same 8 hot cues / times / colours as
ground truth 43:

```
DAT PCOB slot1  192 bytes  PCPT hot_cue 1,2,3   colour byte +40 = 02,03,04
EXT PCOB slot1  304 bytes  PCPT hot_cue 4,5,6,7,8  colour byte +40 = 05,06,07,08,00
EXT PCO2 slot1  724 bytes  PCP2 hot_cue 1..8   lenTag 88 each
PCO2 + 25-char label: section 160 bytes, PCP2 lenTag=140  ← identical to ground truth
```

---

## 5. Comparison: our writer vs ground truth (byte level)

Size/shape agreement is excellent — every section length our writer produces for the same cue set
matches ground truth exactly (192/304/724/160). The differences are all in _content_.

| #   | Aspect                       | **Ours** (measured)                                                                | **Ground truth** (measured)                                                     | Verdict                                                                                    |
| --- | ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `PMAI` file header len_hdr   | 28                                                                                 | 28                                                                              | **same**                                                                                   |
| 2   | hdr[12]                      | `00 00 00 01`                                                                      | `00 00 00 01`                                                                   | same                                                                                       |
| 3   | hdr[16]                      | `00 01 00 00`                                                                      | `00 01 00 00` (rekordbox PC) / `00 00 00 00` (device family B)                  | same vs PC; **differs vs device**                                                          |
| 4   | hdr[20]                      | `00 01 00 00`                                                                      | `00 01 00 00` (PC) / `00 00 00 00` (device)                                     | same vs PC; **differs vs device**                                                          |
| 5   | hdr[24]                      | `00 00 00 00`                                                                      | `00 00 00 00`                                                                   | same                                                                                       |
| 6   | `.DAT` section order         | PPTH,PVBR,PQTZ,PWAV,PWV2,PCOB,PCOB                                                 | identical                                                                       | **same**                                                                                   |
| 7   | `.EXT` section order         | PPTH,PWV3,PCOB,PCOB,PCO2,PCO2,PQT2,PWV5,PWV4                                       | same **+ PSSI** after PWV4                                                      | **DIFF — missing PSSI**                                                                    |
| 8   | `.2EX` section order         | PPTH,PWV7,PWV6,PWVC                                                                | identical                                                                       | **same**                                                                                   |
| 9   | `PPTH` path                  | `/music/<file>`                                                                    | `/Contents/<Artist>/<Album>/<file>`                                             | **DIFF**                                                                                   |
| 10  | `PVBR` payload               | 1194/1600 bytes non-zero (linear seek table)                                       | **3**/1604 (PC), **0**/1604 (device)                                            | **DIFF — we fill it, rekordbox does not**                                                  |
| 11  | `PCOB` header                | 24 B, lenHdr=24, entries at +24, no `len_entry`                                    | identical                                                                       | **same**                                                                                   |
| 12  | `PCPT` fixed 56 B, lenHdr=28 | identical                                                                          | identical                                                                       | **same**                                                                                   |
| 13  | `PCPT` +40 colour byte       | palette code 1–8 (`02,03,04,05,06,07,08`)                                          | **always `0x00`**                                                               | **DIFF**                                                                                   |
| 14  | `PCPT` +28 type              | hard-coded `01`                                                                    | `01` point / **`02` loop**                                                      | **DIFF — we cannot write loops**                                                           |
| 15  | `PCPT` +36 loop_time         | hard-coded `ff ff ff ff`                                                           | end-ms for loops (e.g. `00 00 f5 95`)                                           | **DIFF — we cannot write loops**                                                           |
| 16  | DAT `PCOB` slot 2 (memory)   | always 24-B stub                                                                   | populated: `lenTag=80, type=0, num_cues=1` (capture 42)                         | **DIFF** (our code comment claims non-empty PCOB2 is rejected — ground truth disproves it) |
| 17  | EXT `PCO2` slot 2 (memory)   | always 20-B stub                                                                   | populated: `lenTag=108, type=0, num_cues=1` (capture 42)                        | **DIFF**                                                                                   |
| 18  | `PCO2` header                | 20 B, num_cues@+16, pad@+18                                                        | identical                                                                       | **same**                                                                                   |
| 19  | `PCP2` field layout          | type@16, `0x03e8`@18, time@20, loop@24, `00`@28, `01`@29, len_comment@40, label@44 | identical                                                                       | **same**                                                                                   |
| 20  | `PCP2` no-label lenTag       | 88                                                                                 | 88                                                                              | **same**                                                                                   |
| 21  | `PCP2` labelled lenTag       | 140 for a 25-char label (16+124)                                                   | 140                                                                             | **same**                                                                                   |
| 22  | `PCP2` colour block offset   | `44 + labelByteLen`                                                                | `44 + labelByteLen`                                                             | **same**                                                                                   |
| 23  | `PCP2` colour **green**      | `16 1a ff 00`                                                                      | `16 1a ff 00`                                                                   | **same**                                                                                   |
| 24  | `PCP2` colour **cyan**       | `09 00 e0 ff`                                                                      | `09 00 e0 ff`                                                                   | **same**                                                                                   |
| 25  | `PCP2` colour **violet**     | `38 b3 00 ff`                                                                      | `38 b3 00 ff`                                                                   | **same**                                                                                   |
| 26  | `PCP2` colour **red**        | `2a ff 00 00`                                                                      | `00 ff 00 17`                                                                   | **DIFF**                                                                                   |
| 27  | `PCP2` colour **orange**     | `23 ff a2 00`                                                                      | `26 ff 5e 00`                                                                   | **DIFF**                                                                                   |
| 28  | `PCP2` colour **yellow**     | `1f f3 f4 00`                                                                      | `20 ff e8 00`                                                                   | **DIFF**                                                                                   |
| 29  | `PCP2` colour **blue**       | `05 00 70 ff`                                                                      | `01 00 00 ff`                                                                   | **DIFF**                                                                                   |
| 30  | `PCP2` colour **pink**       | not in `PIONEER_PCP2_MAP` → writes `00 00 00 00`                                   | `31 ff 00 a1`                                                                   | **DIFF**                                                                                   |
| 31  | cue order inside PCOB/PCO2   | ascending hot_cue (1,2,3 / 4..8)                                                   | rekordbox order (DAT 2,1,3; EXT 8,7,6,5,4; PCO2 8,7,6,5,4,2,1,3)                | **DIFF**                                                                                   |
| 32  | no-colour cue in PCP2        | writes `00 00 00 00`                                                               | writes `00 00 00 00` **but often carries RGB with code 0** (e.g. `00 ff 00 17`) | **DIFF (partial)**                                                                         |
| 33  | `.3EX`                       | not written                                                                        | present, **not a PMAI/ANLZ container** (msgpack "embedding" blob)               | **DIFF**                                                                                   |

### Highest-impact items

1. **#13 PCPT colour byte** — we write 1–8, rekordbox writes `0x00` in all 20+ observed records.
2. **#14/#15 loops** — our `buildPcptEntry` hard-codes `type=1` and `loop_time=0xFFFFFFFF`, so we can
   never emit a loop cue; ground truth encodes loops with `type=2` and `loop_time = end position in ms`.
3. **#16/#17 memory cues** — our code writes empty stubs and a comment claims a populated PCOB2 makes
   rekordbox reject the file; ground truth capture 42 has a populated PCOB2 **and** PCO2 slot 2.
4. **#7 `PSSI`** — present in 72 of 97 rekordbox EXT files and in every cue capture; we never write it.
5. **#26–#30 colour values** — 4 of 8 palette entries have wrong code _and_ wrong RGB; green/cyan/violet
   are exact.

---

## 6. Coverage / where I looked (including negative results)

Searched, read-only:

- **This Linux box** — `find / -xdev -iname 'ANLZ0000.*' -o -iname 'export.pdb'`: **none**.
  `/run/media` empty; `/media` absent; `/mnt/{bitlocker,seed,windows}` contain no ANLZ.
- **Laptop drives** — `fsutil fsinfo drives` = `C:\ U:\` only; `wmic logicaldisk` = `C:` (fixed),
  `U:` (removable, `DJ_OUTPUT`). No other volumes exist, so no other sticks to inspect.
- `C:\shimi usb` (a real rekordbox USB image: `_Serato_`, `VirtualDJ`, `PIONEER/CDJ`, `PIONEER/MPJ`,
  `RBFLTR.DAT`) — 54 ANLZ, **all cue-free**.
- `C:\Users\Radexito\AppData\Roaming\Pioneer\rekordbox\share\PIONEER\USBANLZ` — 374 files,
  **all cue-free**.
- `C:\Users\Radexito\AppData\Roaming\Pioneer\rekordbox6` — config only, no ANLZ.
- `C:\ProgramData\Pioneer` — Traktor factory settings only.
- `C:\Backup` (Traktor), `C:\Repos` (bitcoin, pax_global_header), `C:\tmp`, `C:\Users\TEMP` — no ANLZ.
- `C:\Users\Radexito\{Music,Documents,Downloads,Videos}` — only `Music\PioneerDJ\Imported from Device`
  (MediaMonkey-style import, no ANLZ).
- `C:\Users\Radexito\Desktop\playlists.zip` — contains our own export.
- Repo `reverse-engineering/captures/` (25 captures) — rekordbox ground truth, analysed in full.

**Not covered:** a full-disk `Get-ChildItem C:\* -Recurse` sweep for `ANLZ0000.*` / `export.pdb` was
launched and was still running when this report was written (500 GB volume). At the time of writing it
had produced **zero** hits. Every _targeted_ root listed above came back clean, so the risk of an
uncatalogued ANLZ elsewhere on C: is low.

---

## 7. Reproduction

```bash
# inventory + section walker
python3 /tmp/anlz-gt/anlzwalk.py <file.DAT> [more files...]
# our writer's own cue bytes for the ground-truth cue set
node /tmp/anlz-gt/gen_ours.mjs
```

Copies: `/tmp/anlz-gt/{share,shimi,stick,zipanlz,shimi_rekordbox}/`.
No source was modified. No network except ssh/scp via `server` to the laptop.
