# Pioneer Rekordbox USB Export Protocol

Reverse-engineered specification for writing Pioneer CDJ-compatible USB drives.
Confirmed working with Rekordbox 6 / CDJ-3000 / CDJ-NXS2 / CDJ-900.

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

| Offset | Size | Description                       |
| ------ | ---- | --------------------------------- | ------------- |
| 12     | 4    | `len_data` (always 400)           |
| 16     | 4    | `0x00010000` (constant)           |
| 20     | 400  | 400 bytes: `(whiteness[0–7] << 5) | height[0–31]` |

### PWV2 — Tiny Monochrome Preview (CDJ-900)

`len_header = 20`

Same structure as PWAV but 100 bytes of data. Byte format: `height & 0x0F`.

### PCOB × 2 — Cue Object Stubs (required, empty)

Two empty 24-byte stubs. First has `flag = 1`, second has `flag = 0`.
Both have `value = 0xFFFFFFFF`.

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

### PCO2 × 2 — Extended Cue Stubs (required, empty)

Two empty 20-byte stubs. First has `flag = 1`, second has `flag = 0`.

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
| 28     | `num_tables × 20` | Table pointers     |

### Table Pointer Entry (20 bytes)

| Offset | Size | Description                                                                                                                                                         |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 4    | `type` (0=tracks, 1=genres, 2=artists, 3=albums, 4=labels, 5=keys, 6=colours, 7=playlists, 8=playlist_entries, 9=history_playlists, 10=history_entries, 11=artwork) |
| 4      | 4    | `empty_candidate`                                                                                                                                                   |
| 8      | 4    | `first_page`                                                                                                                                                        |
| 12     | 4    | `last_page`                                                                                                                                                         |
| 16     | 4    | Unknown                                                                                                                                                             |

### Page Structure (4096 bytes)

| Offset | Size | Description        |
| ------ | ---- | ------------------ |
| 0      | 4    | `page_index`       |
| 4      | 4    | `type`             |
| 8      | 4    | `next_page`        |
| 12     | 4    | `Unknown`          |
| 16     | 4    | `num_rows_large`   |
| 20     | 2    | `num_rows`         |
| 22     | 2    | `free_size`        |
| 24     | 2    | `used_size`        |
| 26     | 2    | Unknown            |
| 28     | 2    | `free_list_size`   |
| 30     | 2    | `num_rows_large_2` |
| 32     | 4064 | Row heap           |

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

- `0x40` + length → ASCII string (length bytes follow)
- `0x90` + length × 2 (u16BE) → UTF-16BE string (length × 2 bytes follow)

---

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

## Key Gotchas

1. **PVBR is mandatory** — Rekordbox will not show waveforms or beatgrid without it, even if those sections are present and correct. No error is shown; data is silently ignored.

2. **PQT2 entry_count must be > 0** — Rekordbox 6 checks this before displaying the beatgrid. An entry_count of 0 results in a flat beatgrid display even if PQTZ in the DAT file is correct.

3. **len_header varies by section** — It is NOT always 12 (the common header size). Values seen in native files: PPTH=16, PVBR=16, PQTZ=24, PWAV=20, PWV2=20, PWV3=24, PWV4=24, PWV5=24, PQT2=56, PWV6=20, PWVC=14. Using the wrong value causes CDJs to misparse the section body.

4. **PPTH null terminator is counted in len_path** — A path of N characters has `len_path = N*2 + 2`.

5. **Section order matters** — CDJs parse sections sequentially and expect specific ordering. Sections out of order may be ignored or cause parse errors.

6. **2EX is only written when waveform data is available** — It is not required for basic CDJ playback, only for CDJ-3000 colour waveforms.

7. **`analyzePath` in PDB points to the folder** (without trailing slash), not to the `.DAT` file. CDJs append `/ANLZ0000.DAT` themselves.

8. **Electron `protocol.handle` cannot be used for audio** — Range request handling is unreliable in Electron 28+. Use a local HTTP server (`127.0.0.1:ephemeral`) instead.
