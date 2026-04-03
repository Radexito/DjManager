# Pioneer Rekordbox USB Library Protocol

This document describes the binary file formats Pioneer CDJs and Rekordbox use to store and read track analysis data from USB drives. It is based on reverse-engineering of real Rekordbox-generated files, cross-referenced against the open-source projects `rekordcrate` (Holzhaus), `pyrekordbox` (dylanljones), `crate-digger` (brunchboy/Deep Symmetry), `rekordbox-explorer` (CarlosFranzetti), and `dj-library-converter` (sowens81).

---

## 1. USB Directory Structure

```
<USB root>/
├── PIONEER/
│   ├── USBANLZ/
│   │   ├── P000/
│   │   │   └── 00000001/
│   │   │       ├── ANLZ0000.DAT   ← primary analysis file
│   │   │       └── ANLZ0000.EXT   ← extended analysis file
│   │   ├── P016/
│   │   │   └── 000058E3/
│   │   │       ├── ANLZ0000.DAT
│   │   │       └── ANLZ0000.EXT
│   │   └── ...
│   └── rekordbox/
│       └── export.pdb             ← track/playlist/artist database
└── Contents/
    └── <artist>/
        └── <album>/
            └── track.mp3          ← audio files (Rekordbox-managed layout)
```

Music added manually (not via Rekordbox) typically lives anywhere on the USB. When exported through Rekordbox, audio files are placed under `Contents/`. Tracks added by third-party tools (like this application) are placed under `/music/` or any user-chosen path.

---

## 2. ANLZ Folder Path Hashing

Each track's ANLZ files are stored at a path derived from the **USB-relative file path** of the track, using a Pioneer-specific hash. The path must use forward slashes and begin with `/`.

### Hash algorithm

```javascript
function getFolderName(usbFilePath) {
  // Normalize: forward slashes, leading slash required
  let filename = usbFilePath.replace(/\\/g, '/');
  if (!filename.startsWith('/')) filename = '/' + filename;

  // Polynomial hash over UTF-16 char codes (uint32 arithmetic)
  let hash = 0;
  for (let i = 0; i < filename.length; i++) {
    const c = filename.charCodeAt(i);
    hash = (Math.imul(hash, 0x34f5501d) + Math.imul(c, 0x93b6)) >>> 0;
  }

  const part2 = hash % 0x30d43;

  // Bit-extraction to form directory index (part1)
  const part1 =
    ((((((((((part2 >> 2) & 0x4000) | (part2 & 0x2000)) >> 3) | (part2 & 0x200)) >> 1) |
      (part2 & 0xc0)) >>
      3) |
      (part2 & 0x4)) >>
      1) |
    (part2 & 0x1);

  return (
    `P${part1.toString(16).toUpperCase().padStart(3, '0')}` +
    `/${part2.toString(16).toUpperCase().padStart(8, '0')}`
  );
}
```

**Example:** USB path `/music/Artist - Title.mp3` → folder `P02F/0000BE42` → files at `PIONEER/USBANLZ/P02F/0000BE42/ANLZ0000.DAT`.

The top-level folder (`P000`–`PFFF`) acts as a bucket to avoid too many entries in one directory. The 8-character hex subfolder is unique per path.

---

## 3. ANLZ File Overview

Both `.DAT` and `.EXT` files share the same binary container format:

```
[28-byte PMAI file header]
[Section 1]
[Section 2]
...
```

### 3.1 PMAI File Header (28 bytes)

| Offset | Size | Type   | Value / Description                   |
| ------ | ---- | ------ | ------------------------------------- |
| 0      | 4    | ASCII  | `"PMAI"` magic bytes                  |
| 4      | 4    | u32 BE | `len_header` = `0x1C` (28)            |
| 8      | 4    | u32 BE | `len_file` = total file size in bytes |
| 12     | 4    | u32 BE | `0x00000001` (observed constant)      |
| 16     | 4    | u32 BE | `0x00010000` (observed constant)      |
| 20     | 4    | u32 BE | `0x00010000` (observed constant)      |
| 24     | 4    | u32 BE | `0x00000000` (reserved)               |

### 3.2 Universal Section Header (12 bytes)

Every section, regardless of type, begins with this 12-byte header:

| Offset | Size | Type   | Description                                                  |
| ------ | ---- | ------ | ------------------------------------------------------------ |
| 0      | 4    | ASCII  | FourCC tag (e.g. `"PPTH"`, `"PQTZ"`)                         |
| 4      | 4    | u32 BE | `len_header` — byte offset from section start to body data   |
| 8      | 4    | u32 BE | `len_tag` — total section size including this 12-byte header |

`len_tag - len_header` = size of the body (payload) data.

---

## 4. Section Types

### 4.1 `.DAT` File Sections

A `.DAT` file typically contains, in order:

| Section | Description                                          |
| ------- | ---------------------------------------------------- |
| `PPTH`  | Track file path (UTF-16 BE)                          |
| `PVBR`  | VBR seek table (MP3 only)                            |
| `PQTZ`  | Beat grid (CDJ beat/tempo map)                       |
| `PWAV`  | Monochrome overview waveform (touch strip, 400 cols) |
| `PWV2`  | Tiny monochrome overview (CDJ-900, 100 cols)         |
| `PCOB`  | Cue/loop points (hot cues, memory cues)              |

---

### 4.2 `.EXT` File Sections

An `.EXT` file typically contains, in order:

| Section | Description                                           |
| ------- | ----------------------------------------------------- |
| `PPTH`  | Track file path (UTF-16 BE, same as DAT)              |
| `PWV3`  | Monochrome scroll waveform (1 byte/col, 10 ms/col)    |
| `PCOB`  | Cue/loop objects (repeated from DAT)                  |
| `PCO2`  | Extended cue objects (Rekordbox 6+)                   |
| `PQT2`  | Extended beat grid (Rekordbox 6+ software display)    |
| `PWV5`  | Colour scroll waveform (2 bytes/col, 10 ms/col)       |
| `PWV4`  | Colour overview waveform (6 bytes/col, 1200 cols)     |
| `PSSI`  | Song structure / phrase analysis (intro/verse/chorus) |

---

## 5. Section Formats in Detail

### 5.1 PPTH — Track Path

Stores the USB-relative path of the track (e.g. `/music/Artist - Title.mp3`).

`len_header` = 16 (12 standard + 4 for `len_path` field)

| Offset | Size       | Type     | Description                                      |
| ------ | ---------- | -------- | ------------------------------------------------ |
| 0      | 4          | ASCII    | `"PPTH"`                                         |
| 4      | 4          | u32 BE   | `len_header` = 16                                |
| 8      | 4          | u32 BE   | `len_tag` = 16 + path buffer size                |
| 12     | 4          | u32 BE   | `len_path` = byte length of the UTF-16 BE string |
| 16     | len_path+2 | UTF-16BE | Path string followed by 2-byte null terminator   |

The string is encoded as UTF-16 Big Endian with a 2-byte null terminator (`0x0000`). Character count = `len_path / 2`. Body size = `len_path + 2`.

---

### 5.2 PVBR — VBR Seek Table

Present only in `.DAT` files for variable-bitrate MP3 tracks. Provides fast random-access seeking by mapping percentage positions to byte offsets in the audio file.

`len_header` = 16

| Offset | Size | Type   | Description                                        |
| ------ | ---- | ------ | -------------------------------------------------- |
| 0      | 4    | ASCII  | `"PVBR"`                                           |
| 4      | 4    | u32 BE | `len_header` = 16                                  |
| 8      | 4    | u32 BE | `len_tag`                                          |
| 12     | 4    | u32 BE | Unknown/index                                      |
| 16     | 1608 | u32 BE | 402 × u32 BE seek offsets (byte positions in file) |

The 402 entries span from 0% to 100% of the track in roughly 0.25% increments. Entry `i` gives the byte offset in the audio file corresponding to position `i/401 * 100%`.

---

### 5.3 PQTZ — Beat Grid

Primary beat grid section, used by CDJ hardware in performance mode. Contains one entry per beat with absolute time and beat phase.

`len_header` = 24 (12 standard + 12 section-specific)

**Section-specific header (12 bytes, at offsets 12–23):**

| Offset | Size | Type   | Value / Description                   |
| ------ | ---- | ------ | ------------------------------------- |
| 12     | 4    | u32 BE | `0x00000000` (unknown/padding)        |
| 16     | 4    | u32 BE | `0x00080000` (observed constant)      |
| 20     | 4    | u32 BE | `beat_count` — number of beat entries |

**Beat entries** (8 bytes each, starting at offset 24):

| Offset | Size | Type   | Description                                     |
| ------ | ---- | ------ | ----------------------------------------------- |
| +0     | 2    | u16 BE | `beat_number` — position within bar: 1, 2, 3, 4 |
| +2     | 2    | u16 BE | `tempo` — BPM × 100 (e.g. 128.0 BPM → 12800)    |
| +4     | 4    | u32 BE | `time_ms` — absolute beat time in milliseconds  |

**Notes:**

- `beat_number` cycles 1→2→3→4→1→… and identifies the downbeat (beat 1 = downbeat).
- `tempo` is constant for constant-BPM tracks, but can vary per-entry for tempo-mapped tracks.
- CDJ hardware uses this section exclusively; it does not read `PQT2`.

---

### 5.4 PQT2 — Extended Beat Grid (Rekordbox 6+)

Extended beat grid section used by Rekordbox software (not CDJ hardware) for in-software beat display and analysis. Present only in `.EXT` files.

`len_header` = 56 (12 standard + 44 section-specific)

**Full 56-byte header layout:**

| Offset | Size | Type   | Value / Description                                        |
| ------ | ---- | ------ | ---------------------------------------------------------- |
| 0      | 4    | ASCII  | `"PQT2"`                                                   |
| 4      | 4    | u32 BE | `len_header` = 56                                          |
| 8      | 4    | u32 BE | `len_tag` = 56 + (entry_count × 2)                         |
| 12     | 4    | u32 BE | `0x00000000` (padding)                                     |
| 16     | 4    | u32 BE | `0x01000002` (type constant, observed in all native files) |
| 20     | 4    | u32 BE | `0x00000000` (padding)                                     |
| 24     | 2    | u16 BE | First beat anchor: `beat_number`                           |
| 26     | 2    | u16 BE | First beat anchor: `tempo` (BPM × 100)                     |
| 28     | 4    | u32 BE | First beat anchor: `time_ms`                               |
| 32     | 2    | u16 BE | Last beat anchor: `beat_number`                            |
| 34     | 2    | u16 BE | Last beat anchor: `tempo` (BPM × 100)                      |
| 36     | 4    | u32 BE | Last beat anchor: `time_ms`                                |
| 40     | 4    | u32 BE | `entry_count`                                              |
| 44     | 4    | u32 BE | Unknown (observed as large value or zero)                  |
| 48     | 4    | u32 BE | `0x00000000` (reserved)                                    |
| 52     | 4    | u32 BE | `0x00000000` (reserved)                                    |

**Body:** `entry_count × 2 bytes`. Format not fully documented. Per `pyrekordbox`, parsing stops if `entry_count == 0`, making an empty body a valid fallback. The beat anchors in the header are sufficient for Rekordbox to display the beatgrid overlay.

---

### 5.5 PWAV — Monochrome Overview Waveform

Fixed-size overview waveform for the touch strip scrubber on CDJ-2000/NXS. Always exactly 400 columns. Each column = 1 byte.

`len_header` = 20 (12 standard + 8 section-specific)

**Body layout:**

| Offset | Size | Type   | Description                      |
| ------ | ---- | ------ | -------------------------------- |
| 12     | 4    | u32 BE | `len_data` = 400 (column count)  |
| 16     | 4    | u32 BE | `0x00010000` (observed constant) |
| 20     | 400  | bytes  | Waveform column data             |

**Column byte encoding:**

```
bits 7–5 (3 bits): whiteness  — 0=dark, 7=white (transient brightness)
bits 4–0 (5 bits): height     — 0=silent, 31=full amplitude
```

`byte = (whiteness << 5) | height`

Columns represent evenly-spaced time slices across the full track duration (not 10 ms/col).

---

### 5.6 PWV2 — Tiny Monochrome Overview (CDJ-900)

Minimal overview waveform for the CDJ-900. Always 100 columns, 1 byte each.

`len_header` = 20

**Body layout:** Same structure as PWAV (len_data + constant + data), but `len_data` = 100.

**Column byte encoding:**

```
bits 3–0 (4 bits): height — 0=silent, 15=full
bits 7–4: zero
```

`byte = height & 0x0F`

No whiteness field — CDJ-900 only displays height.

---

### 5.7 PWV3 — Monochrome Scroll Waveform

Variable-length scrolling waveform displayed on the CDJ main waveform area (white/grey). Columns are 10 ms wide, so `num_cols = floor(duration_ms / 10)`.

`len_header` = 24 (12 standard + 12 section-specific)

**Section-specific header (at offsets 12–23):**

| Offset | Size | Type   | Value / Description               |
| ------ | ---- | ------ | --------------------------------- |
| 12     | 4    | u32 BE | `len_entry_bytes` = 1             |
| 16     | 4    | u32 BE | `len_entries` = number of columns |
| 20     | 4    | u32 BE | `0x00960000` (observed constant)  |

**Column byte encoding:** Same as PWAV.

```
bits 7–5: whiteness (0–7)
bits 4–0: height    (0–31)
byte = (whiteness << 5) | height
```

---

### 5.8 PWV5 — Colour Scroll Waveform (CDJ-3000)

RGB colour scrolling waveform, introduced for the CDJ-3000. Two bytes per column (u16 BE), 10 ms/col.

`len_header` = 24

**Section-specific header:** Same layout as PWV3, with `len_entry_bytes` = 2.

**Column u16 BE encoding (per Pioneer / crate-digger spec):**

```
bits 15–13 (3 bits): red   — treble energy (0–7)
bits 12–10 (3 bits): green — mid energy    (0–7)
bits  9– 7 (3 bits): blue  — bass energy   (0–7)
bits  6– 2 (5 bits): height                (0–31)
bits  1– 0          : unused (zero)
```

`u16 = (r << 13) | (g << 10) | (b << 7) | (height << 2)`

---

### 5.9 PWV4 — Colour Overview Waveform (CDJ-NXS2)

Fixed-size colour overview waveform for the CDJ-NXS2 jog wheel display. Always 1200 columns × 6 bytes = 7200 bytes of data.

`len_header` = 24

**Section-specific header:** Same layout as PWV3, with `len_entry_bytes` = 6, `len_entries` = 1200.

**Column layout (6 bytes per column, per rekordcrate spec):**

| Byte | Description                                  |
| ---- | -------------------------------------------- |
| 0    | Whiteness / brightness (transient indicator) |
| 1    | Whiteness / brightness (duplicate)           |
| 2    | Overall energy (full-spectrum RMS)           |
| 3    | Bass energy (< ~500 Hz)                      |
| 4    | Mid energy (~500 Hz – 2 kHz)                 |
| 5    | Treble energy (> ~2 kHz)                     |

All 6 values are in the range 0–255. Columns evenly span the track duration (not 10 ms/col).

---

### 5.10 PCOB — Cue/Loop Objects

Hot cues, memory cues, and loop points. Used by CDJ hardware in performance mode. Contains one entry per cue/loop.

`len_header` = 24

**Section-specific header (at offsets 12–23):**

| Offset | Size | Type   | Description   |
| ------ | ---- | ------ | ------------- |
| 12     | 4    | u32 BE | Unknown       |
| 16     | 4    | u32 BE | `entry_count` |
| 20     | 4    | u32 BE | Unknown       |

**Cue entry (36 bytes):**

| Offset | Size | Type   | Description                                      |
| ------ | ---- | ------ | ------------------------------------------------ |
| 0      | 4    | ASCII  | `"PCPT"` entry tag                               |
| 4      | 4    | u32 BE | Entry `len_header`                               |
| 8      | 4    | u32 BE | Entry `len_tag`                                  |
| 12     | 1    | u8     | Hot cue status: `0`=memory, `1`=hot cue          |
| 13     | 1    | u8     | Unknown                                          |
| 14     | 2    | u16 BE | Hot cue number (0-indexed; memory cues = 0)      |
| 16     | 4    | u32 BE | Unknown                                          |
| 20     | 4    | u32 BE | `cue_time_ms` — cue point absolute time          |
| 24     | 4    | u32 BE | `loop_time_ms` — loop end time (0 if not a loop) |
| 28     | 4    | u32 BE | Unknown                                          |
| 32     | 4    | u32 BE | Unknown                                          |

Cue colour is stored in the `PCO2` extended version (Rekordbox 6+).

---

### 5.11 PCO2 — Extended Cue Objects (Rekordbox 6+)

Same purpose as `PCOB` but with extended fields including RGB colour and cue labels. Present only in `.EXT` files. The entry format adds a `color_id` field and optional UTF-16 label string.

---

### 5.12 PSSI — Song Structure / Phrase Analysis

Stores Rekordbox's automatic phrase/structure analysis: intro, verse, chorus, breakdown, outro, etc. Present in `.EXT` files only. Format is not fully public; generated exclusively by Rekordbox software's AI analysis engine.

---

## 6. String Encoding

All strings in ANLZ files are encoded as **UTF-16 Big Endian** with a **2-byte null terminator** (`0x00 0x00`).

```
len_path = number_of_characters × 2        (byte count, excluding null terminator)
buffer_size = len_path + 2                  (includes null terminator)
```

Example: `/music/track.mp3` (16 chars) → `len_path = 32`, buffer = 34 bytes.

---

## 7. Waveform Resolution

| Section | Type     | Cols/sec | Columns | Bytes/col | Notes                   |
| ------- | -------- | -------- | ------- | --------- | ----------------------- |
| PWAV    | Overview | varies   | 400     | 1         | Fixed, spans full track |
| PWV2    | Overview | varies   | 100     | 1         | Fixed, spans full track |
| PWV4    | Overview | varies   | 1200    | 6         | Fixed, spans full track |
| PWV3    | Scroll   | 100      | dynamic | 1         | 10 ms/col, mono         |
| PWV5    | Scroll   | 100      | dynamic | 2         | 10 ms/col, RGB colour   |

Native Rekordbox generates scroll waveforms at 150 cols/sec (≈6.67 ms/col), but CDJ hardware accepts non-native resolutions. This application generates at 100 cols/sec (10 ms/col).

---

## 8. PDB Database (export.pdb)

The `PIONEER/rekordbox/export.pdb` file is a proprietary binary relational database used by CDJ hardware to look up track metadata (title, artist, album, BPM, key, rating, etc.) and link tracks to playlists and folders.

It uses a page-based format with fixed 4096-byte pages. Page types include:

| Page Type        | Content                          |
| ---------------- | -------------------------------- |
| Tracks           | One row per track, all metadata  |
| Artists          | Deduplicated artist name strings |
| Albums           | Deduplicated album strings       |
| Genres           | Deduplicated genre strings       |
| Labels           | Deduplicated label strings       |
| Keys             | Musical key values               |
| Colors           | Cue point colors                 |
| Playlists        | Playlist hierarchy nodes         |
| Playlist entries | Track-to-playlist mapping        |
| History          | Play history entries             |

Strings in PDB are stored as either UTF-16 LE (for longer strings) or LATIN-1 (short strings), prefixed with a length byte. The format is documented in depth by the `crate-digger` project (James Elliott / Deep Symmetry).

---

## 9. Export Process Summary

To make tracks readable by a CDJ from a USB drive:

1. **Copy audio files** to any path on the USB (e.g. `/music/Artist - Title.mp3`).
2. **Write `ANLZ0000.DAT`** at `PIONEER/USBANLZ/{hash(usbPath)}/ANLZ0000.DAT` containing:
   - `PPTH` (path) + `PQTZ` (beat grid) + `PWAV` (overview) + `PWV2` (tiny overview)
3. **Write `ANLZ0000.EXT`** at the same folder containing:
   - `PPTH` + `PWV3` (scroll mono) + `PQT2` (extended beatgrid) + `PWV5` (colour scroll) + `PWV4` (colour overview)
4. **Write `export.pdb`** at `PIONEER/rekordbox/export.pdb` with track metadata rows and playlist structure.

Without a valid `export.pdb` the CDJ cannot search or browse by metadata and will show unknown track info, though ANLZ-based waveform and beat grid data will still load when the track is played directly.

---

## 10. Known Quirks and Compatibility Notes

- **len_tag vs len_header**: `len_tag` is the _total_ section size (including the 12-byte standard header). `len_header` is the byte offset where the body/payload begins. These are frequently confused — using `len_header` where `len_tag` is expected shifts all subsequent section reads by a fixed offset.
- **PWV3/PWV4/PWV5 header size**: These sections have a 24-byte header (12 standard + 12 section-specific). `len_tag = 24 + data_size`, not `36 + data_size`.
- **PVBR required for VBR MP3**: Without this section, CDJs cannot accurately seek into variable-bitrate MP3 files. Constant bitrate MP3 and lossless formats do not need it.
- **PQT2 entry_count = 0**: If the body format is unknown, writing `entry_count = 0` with no body is valid. Rekordbox reads the first/last beat anchors from the header and still shows a beatgrid overlay.
- **PQTZ unknown2 constant**: The second 4-byte field of the PQTZ section-specific header must be `0x00080000`. Using `0x00080000` is confirmed by real CDJ files; other values may cause the CDJ to reject the beatgrid.
- **UTF-16 path encoding**: PPTH paths must be UTF-16 Big Endian with a null terminator. Using UTF-8 or Little Endian encoding results in the CDJ failing to match ANLZ files to their audio track.
- **Section ordering**: While CDJs are generally tolerant of section reordering within a file, Rekordbox software is stricter. The EXT ordering `PPTH → PWV3 → PQT2 → PWV5 → PWV4` matches native Rekordbox output.
