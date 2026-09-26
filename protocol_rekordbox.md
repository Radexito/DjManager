# Pioneer Rekordbox USB Export Protocol

Reverse-engineered specification for writing Pioneer CDJ-compatible USB drives.
Confirmed working with Rekordbox 6 / CDJ-3000 / CDJ-NXS2 / CDJ-900.

Based on reverse-engineering of real Rekordbox-generated files, cross-referenced
against the open-source projects `rekordcrate` (Holzhaus), `pyrekordbox`
(dylanljones), `crate-digger` (brunchboy/Deep Symmetry), `rekordbox-explorer`
(CarlosFranzetti), and `dj-library-converter` (sowens81).

---

## Directory Structure

```
USB_ROOT/
├── PIONEER/
│   ├── USBANLZ/
│   │   └── P{3hex}/{8hex}/      ← hash of USB-relative track path
│   │       ├── ANLZ0000.DAT     ← beatgrid + overview waveform (all CDJs)
│   │       ├── ANLZ0000.EXT     ← colour scroll waveform + extended beatgrid
│   │       └── ANLZ0000.2EX     ← CDJ-3000 RGB waveform
│   ├── MYSETTING.DAT            ← Player settings (CRC-16/XMODEM)
│   ├── MYSETTING2.DAT
│   └── DEVSETTING.DAT
└── export.pdb                   ← DeviceSQL binary database (track index)
```

Audio files themselves aren't shown in the tree above since their location is
convention-dependent: native Rekordbox exports place them under
`Contents/<artist>/<album>/track.mp3`, while third-party tools (including this
application) place them under `/music/` or any other user-chosen path. Only the
USB-relative path recorded in `export.pdb`/ANLZ files matters to the CDJ — the
directory layout of the audio itself is not otherwise constrained.

### Path Hash (`getFolderName`)

Pioneer CDJs locate ANLZ files via a hash of the USB-relative track path.

```
filename = normalise(path)       // forward slashes, leading /
hash = 0
for each char c:
    hash = (hash * 0x34f5501d + c * 0x93b6) >>> 0   // uint32
part2 = hash % 0x30d43
part1 = bit-manipulation(part2)
folder = "P" + hex3(part1) + "/" + hex8(part2)
```

See `src/audio/anlzWriter.js: getFolderName()` for the full bit-manipulation.

---

## PMAI File Format

All three ANLZ files share the same container format.

### File Header (28 bytes)

| Offset | Size | Value           | Description              |
| ------ | ---- | --------------- | ------------------------ |
| 0      | 4    | `PMAI`          | Magic                    |
| 4      | 4    | `0x0000001C`    | `len_header` (always 28) |
| 8      | 4    | total file size | `len_file`               |
| 12     | 4    | `0x00000001`    | Constant                 |
| 16     | 4    | `0x00010000`    | Constant                 |
| 20     | 4    | `0x00010000`    | Constant                 |
| 24     | 4    | `0x00000000`    | Constant                 |

### Section Envelope (12 bytes minimum)

Every section starts with a common 12-byte header:

| Offset | Size | Description                                                           |
| ------ | ---- | --------------------------------------------------------------------- |
| 0      | 4    | FourCC tag (`PPTH`, `PVBR`, `PQTZ`, …)                                |
| 4      | 4    | `len_header` — offset to where payload data begins (section-specific) |
| 8      | 4    | `len_tag` — total section length including this header                |

Body data starts at `section_offset + len_header`, not at `section_offset + 12`.
The next section begins at `section_offset + len_tag`.

---

## ANLZ0000.DAT — Section Order and Format

**Required section order** (confirmed from native Rekordbox output):

```
PPTH → PVBR → PQTZ → PWAV → PWV2 → PCOB × 2
```

### PPTH — File Path Tag

`len_header = 16`

| Offset | Size     | Description                                                              |
| ------ | -------- | ------------------------------------------------------------------------ |
| 12     | 4        | `len_path` — byte count of UTF-16BE string **including** null terminator |
| 16     | len_path | Path as UTF-16BE, null-terminated                                        |

Path is the USB-relative track path, e.g. `/music/Artist - Title.mp3`.

### PVBR — VBR Seek Index ⚠️ REQUIRED

`len_header = 16`

**This section must be present in every DAT file.** Its absence causes Rekordbox
to silently skip loading beatgrid and waveform data.

| Offset | Size | Description                                                          |
| ------ | ---- | -------------------------------------------------------------------- |
| 12     | 4    | Unknown (native Rekordbox writes the ID3 header size; 0 is accepted) |
| 16     | 1600 | 400 × `u32BE` seek table                                             |

Seek table: `entry[i]` = byte offset in the audio file corresponding to
`i / 400` of the total duration. A linear approximation is sufficient:

```
entry[i] = floor(i * fileSize / 400)
```

Total section body: `4 + 400 * 4 = 1604 bytes`.

### PQTZ — Beat Grid

`len_header = 24`

Fixed 12-byte subheader:

| Offset | Size | Description  |
| ------ | ---- | ------------ |
| 12     | 4    | `0x00000000` |
| 16     | 4    | `0x00080000` |
| 20     | 4    | `beat_count` |

Followed by `beat_count × 8` bytes, one entry per beat:

| Offset | Size | Description                     |
| ------ | ---- | ------------------------------- |
| 0      | 2    | `beat_number` (1–4, cycling)    |
| 2      | 2    | `tempo` (BPM × 100, u16)        |
| 4      | 4    | `time_ms` (u32BE, milliseconds) |

### PWAV — Monochrome Preview Waveform (overview bar)

`len_header = 20`

| Offset | Size | Description |
| ------ | ---- | --------------------------------- | ------------- |
| 12 | 4 | `len_data` (always 400) |
| 16 | 4 | `0x00010000` (constant) |
| 20 | 400 | 400 bytes: `(whiteness[0–7] << 5) | height[0–31]` |

### PWV2 — Tiny Monochrome Preview (CDJ-900)

`len_header = 20`

Same structure as PWAV but 100 bytes of data. Byte format: `height & 0x0F`.

### PCOB × 2 — Cue Points (DAT file)

Two PCOB sections (slot 1 = hot cues, slot 2 = memory cues).

**Slot 1 (hot cues, type = 1)** — contains PCPT sub-tags for hot cue slots A–C (indices 0–2).
Hot cue slots D–H (indices 3–7) go in EXT PCOB slot 1 (see EXT section below).

**Slot 2 (memory cues, type = 0)** — always the empty 24-byte stub.
Memory cue format in PCOB2 is unconfirmed (non-empty PCOB2 causes Rekordbox to reject the
entire file). Memory cues are stored in EXT PCO2 slot 2 instead.

#### PCOB header (24 bytes)

| Offset | Size | Value                                      |
| ------ | ---- | ------------------------------------------ |
| 0      | 4    | `PCOB`                                     |
| 4      | 4    | `24` (len_header)                          |
| 8      | 4    | `len_tag` = 24 + N × 56 (0 for empty stub) |
| 12     | 4    | `type`: 1 = hot_cues, 0 = memory_cues      |
| 16     | 2    | `0x0000` (padding)                         |
| 18     | 2    | `num_cues` (u16BE)                         |
| 20     | 4    | `0xFFFFFFFF` (memory_count sentinel)       |

#### PCPT sub-tag (56 bytes fixed, one per cue)

| Offset | Size | Value                                             |
| ------ | ---- | ------------------------------------------------- |
| 0      | 4    | `PCPT`                                            |
| 4      | 4    | `28` (len_header)                                 |
| 8      | 4    | `56` (len_tag)                                    |
| 12     | 4    | `hot_cue`: 0 = memory, 1 = A, 2 = B, … 8 = H      |
| 16     | 4    | `0x00000000` (status — native Rekordbox writes 0) |
| 20     | 4    | `0x00010000` (constant)                           |
| 24     | 2    | `0xFFFF` (order_first)                            |
| 26     | 2    | `0xFFFF` (order_last)                             |
| 28     | 1    | `type`: 1 = cue_point, 2 = loop                   |
| 29     | 1    | `0x00`                                            |
| 30     | 2    | `0x03E8` (constant)                               |
| 32     | 4    | `time_ms` (u32BE)                                 |
| 36     | 4    | `0xFFFFFFFF` (loop_time: none for cue points)     |
| 40     | 1    | `color_code` (Pioneer palette 1–8; 0 = no color)  |
| 41     | 15   | zeros                                             |

**Pioneer palette codes** (codes 3 and 6 confirmed by native Rekordbox hex-diff):

| Code | Color      | Hex       |
| ---- | ---------- | --------- |
| 1    | orange-red | `#ff6b35` |
| 2    | red        | `#ff0000` |
| 3 ✓  | orange     | `#ff9900` |
| 4    | yellow     | `#ffff00` |
| 5    | green      | `#00ff00` |
| 6 ✓  | cyan       | `#00b4d8` |
| 7    | blue       | `#0080ff` |
| 8    | violet     | `#cc00ff` |

---

## ANLZ0000.EXT — Section Order and Format

**Required section order** (confirmed from native Rekordbox output):

```
PPTH → PWV3 → PCOB × 2 → PCO2 × 2 → PQT2 → PWV5 → PWV4
```

### PWV3 — Monochrome Scroll Waveform

`len_header = 24`

Subheader (12 bytes at offset 12):

| Offset | Size | Description                                    |
| ------ | ---- | ---------------------------------------------- |
| 12     | 4    | `1` (bytes per entry)                          |
| 16     | 4    | `num_entries` (number of columns, 1 per 10 ms) |
| 20     | 4    | `0x00960000` (constant)                        |

Body: `num_entries` bytes, each `(whiteness[0–7] << 5) | height[0–31]`.

### PCOB × 2 — Cue Objects (EXT file)

Slot 1 carries **hot cues D onwards** and slot 2 carries the memory cues, both in the same `PCPT` form
as the DAT. Rekordbox's own files are the reference here: `43-hot-cue-colors` has `num_cues=5` in the
EXT slot 1 (`hot_cue` 8, 7, 6, 5, 4) while the DAT holds only A, B and C, and `42-momory_cue` has a
populated slot 2 with `len_tag=80` and one `type=0` entry. An earlier revision of this document called
these sections "always empty stubs", which is wrong: the DAT slot 1 holds the first three hot cues and
the EXT holds the rest.

### PCO2 × 2 — Extended Cue Points (EXT file)

**Slot 1 (hot cues, type = 1)** — populated with PCP2 sub-tags for **all** hot cue slots A–H
(hot_cue indices 0–7). This is the source of truth for cue labels and colors in Rekordbox PC.

**Slot 2 (memory cues, type = 0)** — populated with PCP2 sub-tags for memory cues.

#### PCO2 header (20 bytes)

| Offset | Size | Value                                        |
| ------ | ---- | -------------------------------------------- |
| 0      | 4    | `PCO2`                                       |
| 4      | 4    | `20` (len_header)                            |
| 8      | 4    | `len_tag` = 20 + sum of all PCP2 entry sizes |
| 12     | 4    | `type`: 1 = hot_cues, 0 = memory_cues        |
| 16     | 2    | `num_cues` (u16BE)                           |
| 18     | 2    | `0x0000` (padding)                           |

#### PCP2 sub-tag (variable size)

`len_tag = 16 + bodySize`

- No label: `bodySize = 72`, `len_tag = 88`
- With label ≤ 7 chars: `bodySize = 88`, `len_tag = 104` (native Rekordbox always pads to 104)
- With label > 7 chars: `bodySize = 28 + labelByteLen + 44`, `len_tag = 16 + bodySize`

where `labelByteLen = (label.length + 1) × 2` (UTF-16BE + null terminator).

| Offset          | Size         | Value                                              |
| --------------- | ------------ | -------------------------------------------------- |
| 0               | 4            | `PCP2`                                             |
| 4               | 4            | `16` (len_header)                                  |
| 8               | 4            | `len_tag`                                          |
| 12              | 4            | `hot_cue`: 0 = memory, 1 = A, 2 = B, … 8 = H       |
| 16              | 1            | `type`: 1 = cue_point, 2 = loop                    |
| 17              | 1            | `0x00`                                             |
| 18              | 2            | `0x03E8` (constant)                                |
| 20              | 4            | `time_ms` (u32BE)                                  |
| 24              | 4            | `0xFFFFFFFF` (loop_time: none for cue points)      |
| 28              | 1            | `0x00` (color_id — unused)                         |
| 29              | 1            | `0x01` (constant)                                  |
| 30              | 10           | zeros                                              |
| 40              | 4            | `len_comment` (byte count incl. null terminator)   |
| 44              | labelByteLen | UTF-16BE label, null-terminated (0 bytes if empty) |
| 44+labelByteLen | 1            | `color_code` (Pioneer palette 1–8; 0 = no color)   |
| 45+labelByteLen | 1            | `color_red`                                        |
| 46+labelByteLen | 1            | `color_green`                                      |
| 47+labelByteLen | 1            | `color_blue`                                       |
| 48+labelByteLen | 40           | zeros                                              |

### PQT2 — Extended Beat Grid (Rekordbox 6+)

`len_header = 56` (entire header is 56 bytes, no separate body header)

| Offset | Size            | Description                                                         |
| ------ | --------------- | ------------------------------------------------------------------- |
| 0      | 4               | `PQT2`                                                              |
| 4      | 4               | `56` (len_header)                                                   |
| 8      | 4               | `len_tag` = 56 + entry_count × 2                                    |
| 12     | 4               | `0x00000000`                                                        |
| 16     | 4               | `0x01000002` (constant, always present)                             |
| 20     | 4               | `0x00000000`                                                        |
| 24     | 2               | First beat: `beat_number`                                           |
| 26     | 2               | First beat: `tempo` (BPM × 100)                                     |
| 28     | 4               | First beat: `time_ms`                                               |
| 32     | 2               | Last beat: `beat_number`                                            |
| 34     | 2               | Last beat: `tempo`                                                  |
| 36     | 4               | Last beat: `time_ms`                                                |
| 40     | 4               | `entry_count` (**must be > 0** for Rekordbox 6 to display beatgrid) |
| 44     | 4               | `0x00000000`                                                        |
| 48     | 8               | Reserved zeros                                                      |
| 56     | entry_count × 2 | Body: one `u16BE` per beat (`beat_time_ms % 1000`)                  |

### PWV5 — Colour Scroll Waveform (CDJ-NXS2 / CDJ-3000)

`len_header = 24`

Subheader (12 bytes at offset 12):

| Offset | Size | Description             |
| ------ | ---- | ----------------------- |
| 12     | 4    | `2` (bytes per entry)   |
| 16     | 4    | `num_entries`           |
| 20     | 4    | `0x00960305` (constant) |

Body: `num_entries × 2` bytes. Each `u16BE` column:

```
bits 15-13: red   (treble energy, 3 bits)
bits 12-10: green (mid energy,    3 bits)
bits  9- 7: blue  (bass energy,   3 bits)
bits  6- 2: height               (5 bits)
bits  1- 0: unused
```

### PWV4 — Colour Preview Waveform (CDJ-NXS2 touch strip)

`len_header = 24`

Subheader (12 bytes at offset 12):

| Offset | Size | Description                |
| ------ | ---- | -------------------------- |
| 12     | 4    | `6` (bytes per entry)      |
| 16     | 4    | `num_entries` (1200 fixed) |
| 20     | 4    | `0x00000000`               |

Body: 1200 × 6 bytes. Per column: `[peak_byte, 255 - peak_byte, overall_rms, bass, mid, treble]`.

- `peak_byte` = `min(255, round(peak * 255))` — peak amplitude, confirmed from hex-diff of native files (avg b0+b1 ≈ 255).
- `overall_rms`, `bass`, `mid`, `treble` each scaled by 510, capped at 255.

---

## ANLZ0000.2EX — Section Order and Format

**Required section order** (CDJ-3000 only):

```
PPTH → PWV7 → PWV6 → PWVC
```

### PWV7 — RGB Scroll Waveform (CDJ-3000)

`len_header = 24`

Subheader:

| Offset | Size | Description             |
| ------ | ---- | ----------------------- |
| 12     | 4    | `3` (bytes per column)  |
| 16     | 4    | `num_cols`              |
| 20     | 4    | `0x00960000` (constant) |

Body: `num_cols × 3` bytes. Per column: `[treble(0–255), mid(0–255), bass(0–255)]`.

### PWV6 — RGB Overview Waveform (CDJ-3000)

`len_header = 20`

| Offset | Size | Description                           |
| ------ | ---- | ------------------------------------- |
| 0      | 4    | `PWV6`                                |
| 4      | 4    | `20` (len_header)                     |
| 8      | 4    | `len_tag` = 20 + 3600                 |
| 12     | 4    | `3` (bytes per column)                |
| 16     | 4    | `1200` (fixed columns)                |
| 20     | 3600 | 1200 × 3 bytes: `[treble, mid, bass]` |

### PWVC — Colour Waveform Calibration

`len_header = 14`

| Offset | Size | Value    | Description               |
| ------ | ---- | -------- | ------------------------- |
| 0      | 4    | `PWVC`   | FourCC                    |
| 4      | 4    | `14`     | len_header                |
| 8      | 4    | `20`     | len_tag                   |
| 12     | 2    | `0x0000` | Padding                   |
| 14     | 2    | `0x0064` | Calibration value 1 (100) |
| 16     | 2    | `0x0068` | Calibration value 2 (104) |
| 18     | 2    | `0x00C5` | Calibration value 3 (197) |

---

## export.pdb — DeviceSQL Binary Database

Pioneer's binary track index format. Located at `USB_ROOT/export.pdb`.

### File Header

| Offset | Size              | Description        |
| ------ | ----------------- | ------------------ |
| 0      | 4                 | `0x00000000`       |
| 4      | 4                 | `len_page` (4096)  |
| 8      | 4                 | `num_tables`       |
| 12     | 4                 | `next_unused_page` |
| 16     | 4                 | Unknown            |
| 20     | 4                 | `sequence`         |
| 24     | 4                 | `0x00000000`       |
| 28     | `num_tables × 16` | Table pointers     |

### Table Pointer Entry (16 bytes)

| Offset | Size | Description                                                                                                                                                         |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 4    | `type`, numbered 0 to 19: 0 tracks, 1 genres, 2 artists, 3 albums, 4 labels, 5 keys, 6 colours, 7 playlist_tree, 8 playlist_entries, 9 unknown, 10 unknown, 11 history_playlists, 12 history_entries, 13 artwork, 14 unknown, 15 unknown, **16 columns**, 17 unknown, 18 unknown, 19 history |
| 4      | 4    | `empty_candidate`                                                                                                                                                   |
| 8      | 4    | `first_page`                                                                                                                                                        |
| 12     | 4    | `last_page`                                                                                                                                                         |

Verified against the djl-analysis specification and against `buildFileHeader()` in
`src/usb/pdbWriter.js`, which writes **16-byte** entries from offset 28. Earlier revisions
of this document claimed 20 bytes.

### Page Structure (4096 bytes)

| Offset | Size | Description        |
| ------ | ---- | ------------------ |
| Offset | Size | Description                                              |
| ------ | ---- | -------------------------------------------------------- |
| 0      | 4    | `magic` (always 0)                                       |
| 4      | 4    | `page_index` (0 = file header page)                      |
| 8      | 4    | `type` (table type, redundant sanity check)              |
| 12     | 4    | `next_page` (follow only until the header's `last_page`) |
| 16     | 4    | `transaction` / `seqpage` — global edit sequence         |
| 20     | 4    | `unknown2` (usually 0)                                   |
| 24     | 1    | `num_rows` (low byte)                                    |
| 25     | 1    | `unknown3` (written as `num_rows × 0x20`)                |
| 26     | 1    | `unknown4`                                               |
| 27     | 1    | `page_flags` (`0x34` data page, `0x64` index page)       |
| 28     | 2    | `free_size`                                              |
| 30     | 2    | `next_heap_write_offset`                                 |

Data pages then carry an 8-byte header at offset 32 (`unknown5` = 1,
`num_rows_large` u16, two unknown u16s), so their row heap starts at 40. Index
pages carry a 28-byte extra header, so their heap starts at 60. Row offsets are
stored backwards from the end of the heap, 2 bytes each, bit 15 = present flag.

Taken from the verified writer (`PAGE_HEADER_SIZE = 32`, `DATA_HEADER_TOTAL = 40`,
`INDEX_HEADER_TOTAL = 60` in `src/usb/pdbWriter.js`), whose output players read
correctly. Earlier revisions of this document were shifted by four bytes and
mislabelled `next_page`, `seqpage` and the row counts.

Row offsets are stored from the end of the heap, 2 bytes each, bit 15 = present flag.

### Track Row Fields

Key fields in a track row (`type = 0`):

| Field         | Type             | Description                                             |
| ------------- | ---------------- | ------------------------------------------------------- |
| `analyzePath` | DeviceSQL string | ANLZ folder path, e.g. `/PIONEER/USBANLZ/P036/00006A74` |
| `filename`    | DeviceSQL string | Filename only, e.g. `Artist - Title.mp3`                |
| `filePath`    | DeviceSQL string | Full USB path, e.g. `/music/Artist - Title.mp3`         |
| `bpm`         | u32              | BPM × 100                                               |
| `duration`    | u32              | Duration in seconds                                     |
| `sampleRate`  | u32              | e.g. 44100                                              |
| `bitRate`     | u32              | e.g. 320 (kbps)                                         |
| `rating`      | u8               | 0–5 stars                                               |

### DeviceSQL String Encoding

Strings are length-prefixed. The first byte determines encoding:

| Kind | Layout |
| ---- | ------ |
| Short ASCII | `lk = ((dataLen + 1) << 1) | 1`, then `dataLen` ASCII bytes (max 126) |
| Long ASCII | `0x40`, u16**LE** length = `dataLen + 4`, pad `0x00`, then ASCII bytes |
| Unicode | `0x90`, u16**LE** length = `byteLen + 4`, pad `0x00`, then **UTF-16LE** bytes |

`length` counts the whole field including its 4-byte header, and there is no
terminator byte. The flag byte is `lengthAndKind`: bit 0 set means short, the
other bits pick the encoding (`0x40` long ASCII, `0x90` wide).

The wide encoding is **UTF-16LE, not BE**. The djl-analysis specification records
that they too previously believed it was big-endian until `@evilfred` corrected it.
The one exception is ISRC: it reports kind `0x90` but stores `03`, ASCII bytes and
a null. This applies to `export.pdb`/`exportExt.pdb` only — **ANLZ strings really
are UTF-16BE**, which is why both endiannesses appear in this document.

---

## exportLibrary.db — SQLCipher Track Index (Rekordbox PC + CDJ browse menus)

Located at `{usbRoot}/PIONEER/rekordbox/exportLibrary.db`. Used by Rekordbox PC and CDJ/XDJ hardware for browse menus, playlist navigation, cue recall, and track metadata display. CDJs do **not** use it for audio playback — that relies on `export.pdb` and ANLZ files.

### Encryption

SQLCipher-encrypted SQLite. Key and cipher parameters were extracted by hooking `sqlite3_key` in Rekordbox's bundled `sqlite3.dll` via Frida (script: `reverse-engineering/capture_key.py`).

**Key** (64 ASCII bytes, passed verbatim to `sqlite3_key`):

```
r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls
```

Standard SQLCipher parameter combinations (v3 SHA1/64k, v4 SHA512/256k) do **not** work — Rekordbox uses non-default cipher parameters. The only reliable way to create or open this file is to load Rekordbox's own `sqlite3.dll` via `ffi-napi` or ctypes. DLL path: `C:/Program Files/rekordbox/rekordbox 7.x.x/sqlite3.dll`.

### Schema

#### `property` — one row, USB-level metadata

```sql
CREATE TABLE property(
  deviceName varchar,
  dbVersion varchar,           -- '10000'
  numberOfContents integer,    -- 0 (unused)
  createdDate varchar,         -- 'YYYY-MM-DD'
  backGroundColorType integer, -- 0
  myTagMasterDBID integer
)
```

#### `content` — one row per exported track

```sql
CREATE TABLE content(
  content_id integer primary key,
  title varchar,
  titleForSearch varchar,
  subtitle varchar,
  bpmx100 integer,                  -- BPM × 100 (e.g. 12800 = 128.00 BPM)
  length integer,                   -- duration in seconds
  trackNo integer,
  discNo integer,
  artist_id_artist integer,         -- FK → artist
  artist_id_remixer integer,
  artist_id_originalArtist integer,
  artist_id_composer integer,
  artist_id_lyricist integer,
  album_id integer,                 -- FK → album
  genre_id integer,                 -- FK → genre
  label_id integer,                 -- FK → label
  key_id integer,                   -- FK → key
  color_id integer,                 -- FK → color (0 = none)
  image_id integer,                 -- FK → image (0 = none)
  djComment varchar,
  rating integer,                   -- 0–5 stars
  releaseYear integer,
  releaseDate varchar,
  dateCreated varchar,              -- 'YYYY-MM-DD'
  dateAdded varchar,                -- 'YYYY-MM-DD'
  path varchar,                     -- USB-relative path, e.g. '/music/filename.mp3'
  fileName varchar,
  fileSize integer,                 -- bytes
  fileType integer,                 -- 1=MP3, 11=WAV
  bitrate integer,                  -- bits/sec
  bitDepth integer,                 -- 16 or 24
  samplingRate integer,             -- 44100, 48000
  isrc varchar,
  djPlayCount integer,
  isHotCueAutoLoadOn integer,       -- 1 = auto-load hot cues on track load
  isKuvoDeliverStatusOn integer,
  kuvoDeliveryComment varchar,
  masterDbId integer,               -- track id in master.db (PC library link)
  masterContentId integer,          -- 0 for user tracks
  analysisDataFilePath varchar,     -- '/PIONEER/USBANLZ/XX/XXXXXXXX/ANLZ0000.DAT'
  analysedBits integer,             -- bitmask: 41 (0b101001) = fully analysed
  contentLink integer,              -- 0x000C0700 for all observed tracks (meaning TBD)
  hasModified integer,              -- 0
  cueUpdateCount integer,
  analysisDataUpdateCount integer,
  informationUpdateCount integer
)
```

#### Lookup / normalisation tables

```sql
CREATE TABLE artist(artist_id integer primary key, name varchar, nameForSearch varchar)
CREATE TABLE album(album_id integer primary key, name varchar, artist_id integer, image_id integer, isComplation integer, nameForSearch varchar)
CREATE TABLE genre(genre_id integer primary key, name varchar)
CREATE TABLE label(label_id integer primary key, name varchar)
CREATE TABLE key(key_id integer primary key, name varchar)
-- key.name examples: 'D', 'Am', 'F#m', 'Abm'
CREATE TABLE color(color_id integer primary key, name varchar)
-- 1=Pink 2=Red 3=Orange 4=Yellow 5=Green 6=Aqua 7=Blue 8=Purple (same palette as export.pdb)
CREATE TABLE image(image_id integer primary key, path varchar)
-- image.path is USB-relative, e.g. '/PIONEER/rekordbox/artwork/xxx.jpg'
```

#### Playlist tables

```sql
CREATE TABLE playlist(
  playlist_id integer primary key,
  sequenceNo integer,
  name varchar,
  image_id integer,
  attribute integer,           -- 0=playlist, 1=folder
  playlist_id_parent integer   -- 0 = root
)
CREATE TABLE playlist_content(playlist_id integer, content_id integer, sequenceNo integer)
```

#### `cue` — hot cues and memory cues (mirrors ANLZ cue data)

```sql
CREATE TABLE cue(
  cue_id integer primary key,
  content_id integer,
  kind integer,                         -- cue type: hot cue, memory cue, loop (exact values TBD)
  colorTableIndex integer,
  cueComment varchar,
  isActiveLoop integer,
  beatLoopNumerator integer,
  beatLoopDenominator integer,
  inUsec integer,                       -- start position in microseconds
  outUsec integer,                      -- end position; -1 for non-loops
  in150FramePerSec integer,             -- inUsec × 150 / 1000000
  out150FramePerSec integer,
  inMpegFrameNumber integer,
  outMpegFrameNumber integer,
  inMpegAbs integer,
  outMpegAbs integer,
  inDecodingStartFramePosition integer,
  outDecodingStartFramePosition integer,
  inFileOffsetInBlock integer,
  OutFileOffsetInBlock integer,
  inNumberOfSampleInBlock integer,
  outNumberOfSampleInBlock integer
)
```

#### History (written by CDJ hardware, read-only for us)

```sql
CREATE TABLE history(history_id integer primary key, sequenceNo integer, name varchar, attribute integer, history_id_parent integer)
CREATE TABLE history_content(history_id integer, content_id integer, sequenceNo integer)
```

#### Hot cue banks

```sql
CREATE TABLE hotCueBankList(hotCueBankList_id integer primary key, sequenceNo integer, name varchar, image_id integer, attribute integer, hotCueBankList_id_parent integer)
CREATE TABLE hotCueBankList_cue(hotCueBankList_id integer, cue_id integer, sequenceNo integer)
```

#### Static UI tables (populate once from native Rekordbox values)

```sql
CREATE TABLE menuItem(menuItem_id integer primary key, kind integer, name varchar)
-- kind values: GENRE=128, ARTIST=129, ALBUM=130, TRACK=131, BPM=133, RATING=134,
--   YEAR=135, REMIXER=136, LABEL=137, ORIGINAL ARTIST=138, KEY=139, CUE=140,
--   COLOR=141, TIME=146, BITRATE=147, FILE NAME=148, PLAYLIST=145, HISTORY=149,
--   SEARCH=148, DATE ADDED=150, DJ PLAY COUNT=151, FOLDER=152, DEFAULT=161,
--   ALPHABET=162, MATCHING=171, HOT CUE BANK=152
CREATE TABLE category(category_id integer primary key, menuItem_id integer, sequenceNo integer, isVisible integer)
CREATE TABLE sort(sort_id integer primary key, menuItem_id integer, sequenceNo integer, isVisible integer, isSelectedAsSubColumn integer)
CREATE TABLE myTag(myTag_id integer primary key, sequenceNo integer, name varchar, attribute integer, myTag_id_parent integer)
-- Default top-level myTag folders: Genre, Components, Situation, Untitled Column
CREATE TABLE myTag_content(myTag_id integer, content_id integer)
CREATE TABLE recommendedLike(content_id_1 integer, content_id_2 integer, rating integer, createdDate integer)
```

### What is NOT in this database

- **Per-track manual gain slider** — stored only in `master.db` on the PC, never exported to USB. CDJ auto-gain normalisation comes entirely from `Unnamed7`/`Unnamed8` in `export.pdb`.
- **Waveform / beatgrid / key analysis** — stored in ANLZ files. `content.analysisDataFilePath` points to `ANLZ0000.DAT` on USB.
- **Audio files** — stored under `{usbRoot}/music/`.

### Implementation notes

- Load Rekordbox's own `sqlite3.dll` via `ffi-napi` to create/open the file (standard SQLCipher builds will not decrypt it).
- On export: full rebuild, same approach as `export.pdb`.
- `content.masterDbId` = DjManager track `id` from the local SQLite library.
- `content.contentLink = 0x000C0700` — use this constant for all tracks until meaning is confirmed.
- `content.analysedBits = 41` for fully-analysed tracks (BPM + waveform + key complete).
- `content.analysisDataFilePath` must match the ANLZ path written by `writeAnlz()`.
- Populate `cue` rows in parallel with ANLZ cue writing — same source data, different encoding.
- See issue #300 for discovery method and issue #299 for gain field research.

## SETTING.DAT Files

Three files written to `PIONEER/`:

- `MYSETTING.DAT` — primary player settings
- `MYSETTING2.DAT` — secondary player settings
- `DEVSETTING.DAT` — device settings

All use the same format:

| Offset | Size | Description                               |
| ------ | ---- | ----------------------------------------- |
| 0      | 4    | Magic `0x00100000`                        |
| 4      | 2    | `len_header`                              |
| 6      | 2    | CRC-16/XMODEM over bytes 0..len_header-3  |
| 8      | …    | Settings fields (format differs per file) |

CRC-16/XMODEM: poly `0x1021`, init `0x0000`, no reflection.

---

## Waveform Resolution Summary

| Section | Type     | Cols/sec | Columns | Bytes/col | Notes                         |
| ------- | -------- | -------- | ------- | --------- | ----------------------------- |
| PWAV    | Overview | varies   | 400     | 1         | Fixed, spans full track       |
| PWV2    | Overview | varies   | 100     | 1         | Fixed, spans full track       |
| PWV4    | Overview | varies   | 1200    | 6         | Fixed, spans full track       |
| PWV6    | Overview | varies   | 1200    | 3         | Fixed, spans full track (2EX) |
| PWV3    | Scroll   | 100      | dynamic | 1         | 10 ms/col, mono               |
| PWV5    | Scroll   | 100      | dynamic | 2         | 10 ms/col, RGB colour         |
| PWV7    | Scroll   | 100      | dynamic | 3         | 10 ms/col, RGB colour (2EX)   |

Native Rekordbox generates scroll waveforms at 150 cols/sec (≈6.67 ms/col), but
CDJ hardware accepts non-native resolutions. This application generates at
100 cols/sec (10 ms/col).

---

## Key Gotchas

1. **PVBR is mandatory** — Rekordbox will not show waveforms or beatgrid without it, even if those sections are present and correct. No error is shown; data is silently ignored.

2. **PQT2 entry_count must be > 0** — Rekordbox 6 checks this before displaying the beatgrid. An entry_count of 0 results in a flat beatgrid display even if PQTZ in the DAT file is correct.

3. **len_header varies by section** — It is NOT always 12 (the common header size). Values seen in native files: PPTH=16, PVBR=16, PQTZ=24, PWAV=20, PWV2=20, PWV3=24, PWV4=24, PWV5=24, PQT2=56, PWV6=20, PWVC=14. Using the wrong value causes CDJs to misparse the section body.

4. **PPTH null terminator is counted in len_path** — A path of N characters has `len_path = N*2 + 2`.

5. **Section order matters** — CDJs parse sections sequentially and expect specific ordering. Sections out of order may be ignored or cause parse errors.

6. **2EX is only written when waveform data is available** — It is not required for basic CDJ playback, only for CDJ-3000 colour waveforms.

7. **`analyzePath` in PDB points to the folder** (without trailing slash), not to the `.DAT` file. CDJs append `/ANLZ0000.DAT` themselves.

8. **Electron `protocol.handle` cannot be used for audio** — Range request handling is unreliable in Electron 28+. Use a local HTTP server (`127.0.0.1:ephemeral`) instead.

---

## Ground-truth verification: rekordbox-written ANLZ (2026-09-26)

Everything above was originally derived from community documentation plus trial and error. This
section records a byte-level *verification* against ANLZ files that rekordbox itself wrote, which is
the first time the cue sections have been confirmed against the producer's own output.

### Where the reference files came from

| Family | Source | Files | Written by | Notes |
| ------ | ------ | ----- | ---------- | ----- |
| A | `%APPDATA%\\Pioneer\\rekordbox\\share\\PIONEER\\USBANLZ\\<hash>\\<uuid>\\ANLZ0000.*` (Windows laptop) | 374 | rekordbox (PC) | Analysis cache. 98 DAT, 97 EXT, 97 2EX, 82 3EX. **Contains no cues at all** |
| B | `C:\\shimi usb\\PIONEER\\USBANLZ\\P0xx\\xxxxxxx\\ANLZ0000.DAT` | 54 | device or old rekordbox | DAT only, device epoch timestamp, header bytes 16/20 are zero |
| C | `reverse-engineering/captures/<NN-slug>/PIONEER/USBANLZ/...` (this repo) | 52 sets | rekordbox (PC) | **The only cues-with-labels reference.** Captures 42-47 are the decisive ones |
| D | `U:\\PIONEER\\USBANLZ\\P037,P066` (the test stick) | 6 | **DjManager** | Our own blind-mode export |
| E | `playlists.zip` on the laptop desktop | 3 | **DjManager** | Our own export |

Family A proves something useful on its own: rekordbox's cache holds analysis only. Cue points live
in `export.pdb` until an export happens, which is why 40-hot-cue-a-b-c and friends (family C, exported
to a stick) are the files that carry cues.

### Cue sections, confirmed byte for byte

`PCOB` at its own offset: `PCOB | len_header=24 | len_tag | type (u4) | pad (u2) | num_cues (u2) |
memory_count sentinel (u4)`, with the first `PCPT` starting at `offset + 24` and no `len_entry` field.
`PCPT` is a fixed 56 bytes with `len_header = 28`. All of this matches what this document already
claimed. The `PCO2`/`PCP2` layouts match too, including `len_tag = 88` for an unlabelled entry and
`len_tag = 140` for a 25-character label, and the colour block sitting at `44 + len_comment`.

Two `PCPT` facts worth calling out because plain playback hides them:

* `PCPT+40` (the colour byte) is **`0x00` in every observed ground-truth record**, hot cues included.
  Colour is carried by `PCP2` in the EXT file, not by `PCPT`.
* `PCPT+28` is `1` for a cue point and **`2` for a loop**, and `PCPT+36`/`PCP2+24` hold the loop's
  **absolute end position in ms**, not a length. Capture 46: `time_ms=61313`, `loop_time=62869`,
  which is the stated 4-beat loop, 1556 ms long.

### How rekordbox splits cues between DAT and EXT

Observed in both capture 43 (8 hot cues) and capture 47 (4 loops):

| File, slot | Contents |
| ---------- | -------- |
| `.DAT` PCOB slot 1 (`type=1`) | hot cues **A, B, C only** (file order 2, 1, 3) |
| `.EXT` PCOB slot 1 (`type=1`) | hot cues **D onwards** (file order 8, 7, 6, 5, 4) |
| `.EXT` PCO2 slot 1 (`type=1`) | **all** hot cues, with labels and colours |
| `.DAT` PCOB slot 2 (`type=0`) | memory cues (capture 42: `len_tag=80`, one entry) |
| `.EXT` PCO2 slot 2 (`type=0`) | the same memory cues in the PCP2 form |

So the first three hot cues are duplicated into the DAT, the rest live only in the EXT, and the DAT's
slot 2 is a *populated* memory-cue section rather than a stub. This is why a 3-hot-cue player still
sees A/B/C on a stick exported from a 8-cue library.

### The real colour palette

`PCP2+44` carries a hue code followed by R, G, B. Measured from capture 43:

| Colour | Code | R | G | B |
| ------ | ---- | - | - | - |
| red | `0x00` | 255 | 0 | 23 |
| blue | `0x01` | 0 | 0 | 255 |
| cyan | `0x09` | 0 | 224 | 255 |
| green | `0x16` | 26 | 255 | 0 |
| yellow | `0x20` | 255 | 232 | 0 |
| orange | `0x26` | 255 | 94 | 0 |
| pink | `0x31` | 255 | 0 | 161 |
| violet | `0x38` | 179 | 0 | 255 |

"No colour" is code `0x00` with RGB `0, 0, 0` (capture 42). Note that red is also code `0x00`: the
code is a hue index around the wheel, so the RGB triple is what actually distinguishes a colour from
no colour. The values currently in `PIONEER_PCP2_MAP` (`src/audio/anlzWriter.js`) are approximations
for red, orange, yellow and blue, and pink is missing entirely.

### Sections we never write

* **`PSSI`** — **decoded, see the section below.** 32-byte header, then a body of 24-byte records.
  Present in **72 of 97** rekordbox EXT files and in every cue capture, always the last section.

### Divergences between this writer and ground truth

| # | Aspect | Ours | Ground truth | Status |
| - | ------ | ---- | ------------ | ------ |
| 1 | Loop cues | `buildPcptEntry` hard-codes `type=1` and `loop_time=0xFFFFFFFF` (`anlzWriter.js:426,429`) | `type=2` with an absolute end position | **we cannot export a loop** |
| 2 | Memory cues | `PCOB`/`PCO2` slot 2 always written as 24/20-byte stubs; a code comment claims a populated slot 2 is rejected | capture 42 has a populated slot 2 in both files | **we cannot export a memory cue** |
| 3 | `PCPT+40` colour byte | palette code 1-8 | always `0x00` | wrong |
| 4 | `PCP2` colour codes/RGB | approximated for 4 of 8, pink absent | table above | wrong |
| 5 | Cue distribution | all hot cues in DAT slot 1 | A-C in DAT, D+ in EXT | differs; may cost us cues 4-8 on 3-cue players |
| 6 | `PSSI` | never written | in 75% of native EXT files | missing |
| 7 | `PVBR` payload | filled in (1194 of 1600 bytes non-zero) | 3 of 1604 (PC), 0 (device) | differs, but a filled seek table is legal |
| 8 | `PPTH` path | `/music/<file>` (`src/main.js:2372,2376`) | `/Contents/<Artist>/<Album>/<file>` | differs |

Section order, section sizes, header constants, `PCPT`/`PCP2` field layout and the three exact palette
entries that we do get right (green, cyan, violet) all match, so the writer's geometry is sound; the
divergences are content and coverage.

### Reproducing

```bash
python3 reverse-engineering/scripts/anlz-walk.py <file.DAT|.EXT|.2EX> [...]   # section census
node -e "..."   # see reverse-engineering/ANLZ_GROUNDTRUTH.md for the writer-vs-truth harness
```

The full analysis, including every decoded cue record and the raw offsets, is in
`reverse-engineering/ANLZ_GROUNDTRUTH.md`.

---

## What lives on a stick, and who writes it

Two sticks were inventoried for this section. One (`DJ_OUTPUT`, drive `U:`) was written by this
application at 02:05 on 2026-09-26 and then read by rekordbox. The other (`shimi usb`) is a real DJ
stick last written in 2023, used in hardware, and it still carries the player's own leftovers.

| Path | Written by | We write it | Format status |
| ---- | ---------- | ----------- | ------------- |
| `PIONEER/rekordbox/export.pdb` | rekordbox, DjManager | yes | fully specified in this document |
| `PIONEER/rekordbox/exportExt.pdb` | rekordbox 6 and later | no | tags + tag_tracks tables, see below |
| `PIONEER/rekordbox/exportLibrary.db` | rekordbox 6 and later | no | SQLCipher, key and parameters recovered via a `sqlite3_key` hook (above) |
| `PIONEER/rekordbox/export.pdb.bak` | rekordbox | no | backup it leaves when it rewrites the library |
| `PIONEER/rekordbox/playlists3.sync` | rekordbox | no | controls whether rekordbox auto-syncs this stick |
| `PIONEER/rekordbox/RBFLTR.DAT` | **player** | no | see below |
| `PIONEER/USBANLZ/<hash>/<track>/ANLZ0000.DAT` | both | yes | specified above |
| `PIONEER/USBANLZ/.../ANLZ0000.EXT` | both | yes | specified above |
| `PIONEER/USBANLZ/.../ANLZ0000.2EX` | both | yes | specified above |
| `PIONEER/USBANLZ/.../ANLZ0000.3EX` | rekordbox 7 | no | **not an ANLZ container** (msgpack `embedding` blob) |
| `PIONEER/MYSETTING.DAT`, `MYSETTING2.DAT` | rekordbox, DjManager | yes | `src/usb/settingWriter.js` |
| `PIONEER/DEVSETTING.DAT` | rekordbox, DjManager | yes | `src/usb/settingWriter.js` |
| `PIONEER/DJPROFILE.NXS` (also seen as `djprofile.nxs`) | rekordbox | no, correctly | device profile, not ours to write |
| `PIONEER/extracted/gcred.dat` | rekordbox | no | 64 ASCII characters plus CRLF, likely a licence or session token. Not ours |
| `PIONEER/CDJ/`, `PIONEER/MPJ/` | **player** | no | directories players create on first use |
| `PIONEER/LIBRARY/` | rekordbox (Device Library Plus / OneLibrary) | no | **absent from both sticks.** Only the 2024 firmware references this path |
| `/music/<file>` | DjManager | yes | our layout, see the divergence note below |
| `/Contents/<Artist>/<Album>/<file>` | rekordbox | no | rekordbox's own layout |
| `playlists/*.m3u` | DjManager | yes | our export |
| `<folder>/*.m3u8` | rekordbox (optional) | no | rekordbox writes the playlist as an m3u8 beside the music when asked |
| `_Serato_/`, `VirtualDJ/`, `LOST.DIR` | other software / filesystem | no | unrelated, and `LOST.DIR` is a FAT corruption artifact |

`RBFLTR.DAT` deserves a note. It sits under `PIONEER/rekordbox/`, carries the device epoch timestamp
`01/01/2012 01:00`, and inside is an `FMAI` container with the banner `PIONEER` / `CDJ-900NXS` /
`1.31` followed by `FCND` chunks holding small values. It is a **player-written** file, not a Pioneer
delivery format and not something we produce. The shimi stick also proves why it must never be
deleted: the deck that wrote it (a CDJ-900NXS) may look for it again.

## Getting rekordbox to accept a third-party library

A stick written by a third-party tool can be rejected outright with "Device library is corrupted",
with no further detail. Another project working the same problem (murtaza64/manadj, issue 94,
2026-08-18) reports three structural requirements that fixing that rejection. They are recorded here
because they are cheap to satisfy and expensive to debug:

1. The `columns` table (**type 16**; a neighbouring project refers to it as tables 17 and 18
   in its own 1-based numbering) must carry rekordbox's static
   browse-menu schema rows (the GENRE/ARTIST/... column definitions). Empty `columns` tables are
   rejected. DjManager does write a columns table from `COLUMN_DATASET`
   (`src/usb/pdbWriter.js:86`, emitted at line 921), so we should already satisfy this, but the row
   contents have not been diffed against rekordbox's own until now.
2. **Each table's `empty_candidate` must be its own all-zero page and be the final link of that
   table's chain.** One shared zero page for every table is rejected. DjManager gives each table its
   own candidate (`emptyCandidate = indexPageIndex + 1`, line 937) and advances it as pages are
   allocated (lines 964-990), which looks right but has not been confirmed byte for byte.
3. `exportExt.pdb` must exist, even when it contains nothing but empty tables (they wrote nine).

Both ground-truth files examined here enumerate exactly twenty tables, types 0 to 19, in order, with
`type == table index`, which is how the numbering was verified rather than inherited. The earlier
revision of this document listed `9 = history_playlists` and `11 = artwork`, which was wrong from 9
onward.

Two further details from the same source, both worth knowing:

- Audio belongs under `/Contents/`, not `/music/`.
- A track row must be at least 221 bytes, with min-row-size padding when it is shorter.
- The track row byte at offset 92 is the file type code: mp3 = 1, m4a = 4, flac = 5, wav = `0x0b`.

The external claims above are from that issue and are marked as such; the DjManager column is what
this repository does today, verified by reading the code, not by testing.

**Untested here:** whether rekordbox currently accepts a DjManager stick. The failure is quiet and
easy to check: plug the stick in, open the Devices pane, and see whether the library browses or
whether it reports the library as corrupted.

---

## Smart Lists and My Tags on a stick: what is possible

This is the question "can we support rekordbox's new library type and smart playlists later", answered
from evidence gathered here.

**Players do not evaluate rules.** String scans of six firmware images (CDJ-2000NXS 1.44,
CDJ-2000NXS2 1.87, XDJ-1000MK2 1.45, XDJ-RX 2.21, XDJ-RX2 1.43, CDJ-3000 3.22) find no `smartList`,
`myTag`, `MY TAG`, `OneLibrary`, `exportExt` or `master.db` strings at all, and no PDB table names
either, so tables are addressed by number. What a player reads is a static playlist out of
`playlist_tree` / `playlist_entries` in `export.pdb`, which this writer already produces.

**rekordbox does not export smart lists to a stick.** Users report the XML export writing an empty
`smartlist.xml`, and that intelligent playlists cannot be taken to a USB stick. So this is a platform
limitation, not a gap in DjManager.

**My Tags travel; Smart Lists do not.** Two plain-ish carriers exist for My Tags:

| Carrier | Encryption | Contains | Reachable for us |
| ------- | ---------- | -------- | ---------------- |
| `exportExt.pdb` | none, plain PDB | `tags` and `tag_tracks` tables | **yes**, and we already have ground-truth files |
| `exportLibrary.db` | SQLCipher (key recovered, above) | `myTag` tables and `myTagMasterDBID` on the content rows | only with rekordbox's own `sqlite3.dll` or a reimplementation |

`exportLibrary.db` also carries the default My Tag folders rekordbox ships: Genre, Components,
Situation, Untitled Column.

**Practical plan for DjManager:**

1. Implement Smart Lists **in this application** (rule model over our own library) and materialise the
   result as ordinary playlists at export time, written through the existing `playlist_tree` /
   `playlist_entries` tables. That produces something rekordbox itself does not deliver, needs no
   decryption, and plays on every deck.
2. Write `exportExt.pdb` with `tags` and `tag_tracks` so My Tags set in DjManager survive the trip.
   The format is plain and the spec is being recovered from the ground-truth files in
   `/tmp/pdb/` (see `reverse-engineering/` for the full analysis).
3. Treat `exportLibrary.db` as out of scope until someone is willing to depend on rekordbox's own
   DLL to write it.

Reading rekordbox's existing Smart Lists out of `master.db` would require breaking its database
encryption, which is a separate and much larger project, and is not started.

### `PSSI` decoded: rekordbox phrase (song structure) analysis

This section was previously unrecorded here. It is now decoded, from the 21-record example in
rekordbox's own cache (`share/fb0/9b86e-.../ANLZ0000.EXT`):

```
PSSI | len_header = 32 | len_tag | 0x18 (=24, the record size) | (count << 16) | 1 |
       0 | total_beats | 0x01010000
```

then `count` records of 24 bytes, each `{ index u16, position_seconds u16, phrase_type u16, 9 x u16
zero }`, index counting from 1.

Measured values from that file (21 phrases, 560 to 561 beats per `PQT2`):

| # | sec | type | | # | sec | type | | # | sec | type |
| - | --- | ---- | - | - | --- | ---- | - | - | --- | ---- |
| 1 | 5 | 1 | | 8 | 179 | 9 | | 15 | 411 | 9 |
| 2 | 19 | 2 | | 9 | 191 | 6 | | 16 | 419 | 6 |
| 3 | 31 | 8 | | 10 | 251 | 6 | | 17 | 443 | 6 |
| 4 | 39 | 3 | | 11 | 259 | 6 | | 18 | 451 | 6 |
| 5 | 63 | 4 | | 12 | 287 | 6 | | 19 | 475 | 9 |
| 6 | 99 | 5 | | 13 | 323 | 5 | | 20 | 483 | 6 |
| 7 | 127 | 9 | | 14 | 383 | 9 | | 21 | 507 | 10 |

So it is the phrase analysis that drives rekordbox's song structure display. The phrase model is
documented by Pioneer as Intro, Up, Down, Chorus, Bridge, Verse and Outro, with rekordbox 7 adding
Fill in, but the numeric-to-label mapping is **not** published anywhere we could find, and ten distinct
numeric values appear in this one file, so the mapping is left as an open question. Position is in
**seconds**, and it divides evenly into 24-byte records, with the record count in the header.

Cross-checks: the header's `total_beats` field agrees with `PQT2` (673 against 673, 560 against 561),
`count << 16` equalled 16 for a 16-record file and 21 for this 21-record one, the `0x18` field is the
record size, and `0x01010000` was identical in both files examined. Device-written ANLZ (family B)
carry no `PSSI` at all, which fits: phrase analysis is a rekordbox feature, not a device one.

**Conclusion for our writer:** `PSSI` is optional metadata for a display feature, it was absent from
every file our exporter produced and from every device-written file examined, and producing it would
require reimplementing rekordbox's phrase analysis. Do not write it; document it and move on. Cue
display demonstrably works without it.

---

## What the player firmware can and cannot tell us

The hope behind disassembling the firmware was to name the fields our writer still marks as unknown
by watching the *consumer* read them. That is now answered, with a negative result that is bounded by
measurement rather than by effort. Method: binutils 2.39 built with `--target=bfin-elf`, disassembling
the already-decoded payloads, with an instruction-decode-validity yardstick calibrated on both ends
(64 KiB of `/dev/urandom` decodes at 36.0 % ILLEGAL, genuine Blackfin code at 0.0 %). Full report,
including the per-window tables and the instruction listings: `reverse-engineering/BLACKFIN_FINDINGS.md`.

### The S-record layer is plaintext, but the payload is not

This corrects an earlier conclusion of this document. The container for CDJ-2000NXS, CDJ-2000NXS2 and
XDJ-1000MK2 updates is plaintext Motorola S-records, but that only gets you the *transport*. The bytes
inside are compressed or encoded:

| image, region | windows | ILLEGAL rate | verdict |
| ------------- | ------- | ------------ | ------- |
| `C2KNXS-run1-0x0.bin`, every 4 KiB window from 0x0 to 0x2e1000 | 724 | 30-50 % in every window | **not addressable code** (random-data rate) |
| `C2KNXS-run1-0x0.bin`, 0x31000-0x40000 | 15 | no instructions emitted | all-zero padding |
| `C2KNXS-blobA.bin`, 0x87000-0xe1000 | ~144 | **0.0-0.1 %** | **genuine code, 576 KiB, readable** |
| `C2KNXS-blobA.bin`, 0x0 / 0x80000 / 0x100000 / 0x180000 | 6 | 30.9-77.7 % | data, compressed or still encoded |
| `C2KNXS2-blobA.bin`, 12 windows across 6.6 MB | 12 | 32.3-49.9 % | encoded or compressed |

Corroborating detail: the readable ASCII in `C2KNXS-run1-0x0.bin` is interleaved with high-bit junk
every 9 to 11 bytes, for example `"M\xffusic Anal\xffyse File\xff is brok\xfb en\0%/ANLZ\x9f%04X.DAT"`.
Readable text with random-rate disassembly is the signature of a still-compressed container, which is
why earlier attempts to read "the code" out of that stream could not work.

### Neither the ANLZ dispatch nor the PDB reader is in the readable code

- No ANLZ tag constant (`PPTH`, `PVBR`, `PQTZ`, `PCOB`, `PWAV`, `PWV2`, `PWV3`, `PQT2`) appears in the
  readable body: they would need 32-bit constants built as low and high immediate pairs, and those are
  absent. Raw scans find at most single loose fourcc hits, which is the expected false-positive rate.
- No PDB, ANLZ or track strings of any kind, and no plausible record parser. Table names remain entirely
  absent, as established earlier, and the only debris is concatenated fragments such as `1scAnlzS`,
  `cAnlzSem` and `KdexMyTagNyaExtD` (note the `MyTag` sitting inside a fragment, not as a token).
- The one relevant literal that does exist, the path template `%/ANLZ%04X.DAT`, sits at 0xb21f4 in the
  run1 stream next to `"Music Analyse File is broken."`, inside an encoded region.

### Two leads from this session are refuted

Both were mine, and both die on the instruction listing:

1. **The `0xC0700` at blobA 0x92407 is instruction bytes, not a constant.** The bytes `00 07 0c 00`
   are the second byte of `CALL (P0)`, the whole opcode of `CC = R7 == 0x0`, and the low byte of
   `R0 = 0x0`. `0xC0700` appears zero times as an immediate anywhere in the disassembly, and the other
   occurrence in the corpus sits in high-entropy bytes.
2. **The function that loads 42 and 43 is not a record reader.** Those are object selectors passed to a
   helper at 0xb2a62; the reads at `+0x1a`/`+0x1e` are a delta between two sibling objects, then a
   virtual call. The 42-equals-our-string-offset-table-size match was numerology.

### Consequence

The player-side code that reads the USB database is not present in readable form in these images, so
the unknown fields of the track-row map cannot be named from firmware. The `0x24` at offset 0, the
`0xC0700` at offset 4, the auto-gain pair at 24/26, the `0x29` at 86 and the `0x03` at 92 remain
justified only by native-file observation and the public format descriptions, and the firmware neither
corroborates nor contradicts them. Note that `0xC0700` is a value our writer copies from
`exportLibrary.db`'s `contentLink` column, which is a producer-side identification and not a guess.

To go further one would need one of: a finished container decode of the run1 streams, an already
plaintext flash read from hardware, or dynamic analysis on a real player. Field naming therefore has to
come from the producer side, which is what the PDB differential section above does.

## Row layouts for the other tables

Every row begins with a 2-byte subtype that identifies the row kind within its table, followed by an
`IndexShift` (u16) in the tables that carry one, then the payload. Rows that hold text end with a
DeviceSQL string; the byte just before it is a small "string kind" marker (`0x03`), and the final byte
of the fixed header is the name's byte offset within the row (`0x0a` for artist rows, `22` for album
rows, and so on). Where a row has several strings, their offsets are listed in a u16 table whose own
offset is fixed by the subtype; track rows use 21 of them, 42 bytes at offsets 94 to 136.

| Table (type) | Subtype / first field | Layout |
| ------------ | --------------------- | ------ |
| tracks (0) | `0x24` | 94-byte header, then 21 x u16 string offsets (42 B), then the string heap. Offset 4 is `0xC0700`, the same value as `contentLink` in `exportLibrary.db`. Offsets 24 and 26 are the two auto-gain words; the reference values 13940 and 17802 correspond to 0 dB, and a replay-gain value scales them as `10 ** (dB / 20) * reference` |
| genres (1) | not written by us | shape not verified here. The public descriptions give subtype `0x64` and the artist shape, but neither this application's code nor the ground-truth files examined so far confirm it |
| artists (2) | `0x60` | subtype u16, IndexShift u16, Id u32, `0x03`, name offset `0x0a`, string |
| albums (3) | `0x80` | first two bytes are the subtype, then IndexShift u16, u32 zero, ArtistId u32 at 8, Id u32 at 12, u32 zero, `0x03`, name offset 22, string |
| labels (4) | not written by us | not verified here |
| keys (5) | id as u16 | SmallId u16 (equals the Id), u16 zero, Id u32, string at offset 8 |
| colours (6) | - | u32, u8, ID u16 at 5, u8, string at offset 8 |
| playlist_tree (7) | - | ParentId u32, u32 zero, SortOrder u32, Id u32, RawIsFolder u32 (1 for a folder, 0 for a playlist), string at offset 20 |
| playlist_entries (8) | - | exactly 12 bytes: EntryIndex u32, TrackId u32, PlaylistId u32 |
| columns (16) | - | ID u16, u16 unknown, string at offset 4 |
| unknown 17, 18 | - | four u16 values, 8 bytes |

Rows marked "not written by us" are exactly that: this application creates those tables empty, so
the layouts above come from the public format descriptions only and are flagged rather than asserted.

The playlist pair is what makes an export usable: `playlist_tree` defines the tree (folders and
playlists, with `ParentId` 0 for the root level) and `playlist_entries` maps an entry index to a track
and a playlist. Anything that wants to offer smart lists in this application should evaluate its rules
and then write the result through these two tables, because players never evaluate rules themselves.

## exportExt.pdb — My Tags (rekordbox 6 and later)

This is the "new library type" companion file that rekordbox 6 and later write next to `export.pdb`,
and it is where **My Tags** live on a USB stick. It is a plain DeviceSQL database with the same file
header, 16-byte table pointers and 4096-byte pages as `export.pdb`, so the parser in this repository
reads it unchanged. Crucially it is **not** encrypted, unlike `exportLibrary.db`, which means My Tags
are reachable without touching SQLCipher.

Measured on the user's stick (`U:/PIONEER/rekordbox/exportExt.pdb`, 73,728 bytes = 18 pages), header:
`num_tables = 9`, `len_page = 4096`, `next_unused = 21`, `sequence = 8`. The nine tables are types 0
to 8, and only two of them carry rows:

| Type | Rows | Content |
| ---- | ---- | ------- |
| 3 | 28 | **the tag tree** |
| 7 | 1 | a single 60-byte row, not yet decoded |
| 0, 1, 2, 4, 5, 6, 8 | 0 | empty |

The 28 rows in table 3 are the default My Tag definitions, decoded by reading their names:

- **Genre**: AIl, Acid House, Deep House, Techno, Nu Disco, Electro House, Bass Music, Trap
- **Components**: Synth, Vocal, Beat, Sub Bass, Percussion, Piano, Dark, Upper
- **Situation**: Main Floor, Second Floor, Lounge, Mid Night, Morning, Build up, Peak Time, Build down
- **Untitled Column**: My Comment

That is four category rows plus 24 child rows, and the grouping is visible in the rows themselves:
row index 0 is `Genre`, indices 1 to 8 are its children, index 8 is `Components`, and so on, with the
`IndexShift` field (u16 at row offset 2) stepping by `0x20` per row, wrapping to `0x0100` at index 8
and `0x0200` at index 16. This matches the page header's `unknown3 = num_rows * 0x20` relationship
noted above.

Row layout as observed (48 to 56 bytes per row, little-endian):

```
0x00  u16   subtype, 0x0680 for every tag row
0x02  u16   IndexShift, row index * 0x20
0x04  u32   zero in every row observed
0x08  u32   zero in every row observed
0x0c  u32   group or parent id (0 for Genre, 1 for its children, 2 for Components, 3 for Situation,
             4 for Untitled Column)
...
      then a small field descriptor and the name as a DeviceSQL string
```

The payload between the ids and the name is **not fully decoded yet**: the last few bytes before the
name are consistent with a string-field descriptor plus a byte that varies with the row, and settling
it needs more samples, in particular a tag with a non-ASCII name. The name itself and the parent
relationships above are certain, since they are read straight out of the rows.

The second stick examined (`C:\shimi usb`, written in 2023) has the same nine tables and the same
default tag names, with `sequence = 18` instead of 8 and a larger allocation: its type 3 table holds 76
row slots, of which only the default names decode and the rest are free or deleted slots, and its type 7
table holds two slots instead of one. No user-created tag names were found on either stick.

The `tag_tracks` table (type 4), which would map tracks to tags, **is empty on both sticks**, because no
track in either library has a tag assigned. Its row layout therefore could not be verified and is left
open. The single row in table 7 (60 bytes) is also undecoded; it contains the byte run `22 23 24 25 26`
followed by `03` repeated five times, which looks like a small parallel array but its meaning is
unknown.

**Consequence for this application:** supporting My Tags needs no decryption, only a writer for this
file. The blocking pieces are the unverified `tag_tracks` row layout and the `...`-marked payload of
the tag rows.
