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

### PCOB × 2 — Cue Object Stubs (EXT file — always empty)

Both EXT PCOB sections are always the empty 24-byte stub (same header format as DAT PCOB).
Populated cue data is **not** placed in EXT PCOB; use EXT PCO2 instead.

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
| 0      | 4    | `type` (0=tracks, 1=genres, 2=artists, 3=albums, 4=labels, 5=keys, 6=colours, 7=playlists, 8=playlist_entries, 9=history_playlists, 10=history_entries, 11=artwork) |
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

* **`PSSI`** — 32-byte header, 384-696 byte body, present in **72 of 97** rekordbox EXT files and in
  every cue capture, always the last section. Purpose still unknown; we never write it. It is present
  in files whose cues work, so it is not a prerequisite for cue display, but its absence is a real
  difference from native output.
* **`.3EX`** — **not an ANLZ container at all.** Its first bytes are a msgpack-style map containing the
  ASCII string `embedding` plus a UUID and float payload. Treat it as a separate format, unrelated to
  deck playback.

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

1. The `columns` tables (**types 17 and 18**, `0x11`/`0x12`) must carry rekordbox's static
   browse-menu schema rows (the GENRE/ARTIST/... column definitions). Empty `columns` tables are
   rejected. DjManager does write a columns table from `COLUMN_DATASET`
   (`src/usb/pdbWriter.js:86`, emitted at line 921), so we should already satisfy this, but the row
   contents have not been diffed against rekordbox's own until now.
2. **Each table's `empty_candidate` must be its own all-zero page and be the final link of that
   table's chain.** One shared zero page for every table is rejected. DjManager gives each table its
   own candidate (`emptyCandidate = indexPageIndex + 1`, line 937) and advances it as pages are
   allocated (lines 964-990), which looks right but has not been confirmed byte for byte.
3. `exportExt.pdb` must exist, even when it contains nothing but empty tables (they wrote nine).

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
