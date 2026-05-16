# Reverse Engineering Captures — Index

Internal reference only. Each subdirectory under `captures/` holds a complete
Rekordbox USB export (or the relevant slice of one) for a single isolated
feature. The naming convention is `NN-slug/` where `NN` is the capture number
and `slug` describes what was changed from the baseline.

**How to use:** diff two capture folders side-by-side with a hex viewer
(e.g. `xxd`, `hexdump`, or ImHex). The delta between two exports reveals
which bytes encode a specific feature.

---

## Capture Index

### Baseline

| Folder         | What it captures                                        | Decodes                            |
| -------------- | ------------------------------------------------------- | ---------------------------------- |
| `00-baseline/` | 1 track, no analysis, no cues, no artwork, no playlists | Minimum valid PDB + ANLZ structure |

---

### Waveforms

| Folder                     | What it captures                      | Decodes                                                       |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `01-waveform-silence/`     | Track that is pure silence            | Zero waveform baseline (all sections present but data = 0)    |
| `02-waveform-sine-bass/`   | 60 Hz sine wave (bass-only content)   | PWV5/PWV7 bass channel mapping; confirms band-separation math |
| `03-waveform-sine-mid/`    | 500 Hz sine wave (mid-only content)   | PWV5/PWV7 mid channel; confirms green channel in u16BE        |
| `04-waveform-sine-treble/` | 8 kHz sine wave (treble-only content) | PWV5/PWV7 treble channel; confirms red channel                |
| `05-waveform-normal/`      | Normal music track, fully analyzed    | Full waveform set; validates PWV4 byte 1 complement formula   |

---

### Beat Grid

| Folder                      | What it captures                                      | Decodes                                                              |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `10-beatgrid-constant-120/` | 120 BPM constant track, analyzed                      | PQTZ entry format; PQT2 body u16 values at known BPM                 |
| `11-beatgrid-constant-140/` | 140 BPM constant track, analyzed                      | PQT2 body values at different BPM — finds the exact encoding formula |
| `12-beatgrid-variable/`     | Track with tempo automation (start 120 → end 130 BPM) | Whether PQTZ tempo field varies per-entry or is constant             |
| `13-beatgrid-offset/`       | Track with beatgrid manually shifted by exactly 10 ms | Confirms beatgrid_offset storage location                            |

---

### Gain / Loudness / Normalization ← **primary unknown**

| Folder              | What it captures                                 | Decodes                                                    |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| `20-gain-default/`  | Track with no gain change (factory default)      | Baseline gain bytes in PDB track row and all ANLZ sections |
| `21-gain-plus6db/`  | Same track, track gain set to +6 dB in Rekordbox | Which byte(s) encode gain; field size and scale factor     |
| `22-gain-minus6db/` | Same track, track gain set to −6 dB              | Negative gain encoding (signed? float? fixed-point?)       |
| `23-gain-zero/`     | Same track, gain explicitly set to 0 dB          | Confirms zero-gain encoding is 0x00 or some other sentinel |
| `24-autogain-on/`   | Auto-gain analysis enabled before export         | Whether auto-gain writes to PDB row or a separate section  |
| `25-autogain-off/`  | Same track, auto-gain disabled in preferences    | What changes when auto-gain is skipped                     |

---

### Key

| Folder            | What it captures               | Decodes                                                           |
| ----------------- | ------------------------------ | ----------------------------------------------------------------- |
| `30-key-c-major/` | Track with key = C major       | Key row format; whether ID is sequential or musically fixed       |
| `31-key-a-minor/` | Track with key = A minor       | Minor key abbreviated name (`Am` vs `A minor`)                    |
| `32-key-all-12/`  | 12 tracks covering all 12 keys | Full key ID → name mapping; confirms IDs are sequential not fixed |

---

### Cue Points

| Folder                  | What it captures                              | Decodes                                                             |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `40-cue-hot-abc/`       | Hot cues A, B, C only (first 3 slots)         | PCOB slot 1 in DAT — exactly which cues go here                     |
| `41-cue-hot-all/`       | All 8 hot cues A–H filled                     | EXT PCOB split — confirms D–H go only in EXT, not DAT               |
| `42-cue-memory/`        | Memory cues only (no hot cues)                | PCO2 slot 2 format in EXT; whether PCOB2 can be non-empty           |
| `43-cue-colors-all/`    | 8 hot cues, one per Pioneer color             | Full PCP2 64-step color wheel codes; PCPT 1–8 palette per slot      |
| `44-cue-labels/`        | 3 hot cues with text labels of varying length | PCP2 `len_comment` + UTF-16BE label encoding; padding rules         |
| `45-cue-label-long/`    | 1 cue with label > 7 characters               | PCP2 size growth for labels > 7 chars                               |
| `46-cue-loop/`          | 1 loop cue (A = 4-beat loop)                  | PCPT/PCP2 type=2; `loop_time` field — duration or end position?     |
| `47-cue-loop-multiple/` | 4 loop cues of different lengths              | Confirms loop_time units (ms) and whether it is end_ms or length_ms |

---

### Track Metadata (PDB)

| Folder                      | What it captures                            | Decodes                                                      |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `50-metadata-minimal/`      | Title only, no artist/album/genre/label     | Which string fields default to `""` vs absent                |
| `51-metadata-full/`         | All metadata fields filled                  | Artist, Album, Genre, Label rows; confirms row Subtype bytes |
| `52-metadata-genre/`        | Single genre set                            | Genre table row format + genreId link in track row           |
| `53-metadata-multi-genre/`  | Multiple genres (if Rekordbox allows)       | How Rekordbox encodes multi-genre — multiple rows? JSON?     |
| `54-metadata-label/`        | Label field set                             | Label table row format + labelId link                        |
| `55-metadata-album-artist/` | Album linked to an artist                   | Whether Album row ArtistId field is populated by Rekordbox   |
| `56-metadata-comment/`      | Comment / Notes field filled                | Comment string slot in track row (slot 16 in string heap)    |
| `57-metadata-isrc/`         | ISRC set                                    | ISRC string encoding (`0x90 … 0x03 … 0x00` variant)          |
| `58-metadata-rating-1star/` | 1-star rating                               | Rating encoding: 51 per star (0→0, 1→51, …5→255) — validate  |
| `59-metadata-rating-5star/` | 5-star rating                               | Confirms upper bound                                         |
| `60-metadata-color-tag/`    | Track color tag set (Rekordbox label color) | `ColorId` field in track row; Colors table ID mapping        |
| `61-metadata-year/`         | Year field set                              | `Year` u16LE in track row                                    |
| `62-metadata-track-number/` | Track number set                            | `TrackNumber` u32LE — is it disc+track or track only?        |

---

### PDB Track Row Unknown Fields

| Folder                   | What it captures                           | Decodes                                                             |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------- |
| `70-trackrow-bitmask/`   | Same track exported as MP3, FLAC, WAV, AAC | Whether `Bitmask = 0x000C0700` changes per file type                |
| `71-trackrow-unnamed78/` | Track analyzed vs not analyzed             | Whether `Unnamed7=0x758A` / `Unnamed8=0x57A2` change after analysis |
| `72-trackrow-checksum/`  | Same file duplicated with 1 byte changed   | Whether `Checksum` field is a CRC of the audio data                 |
| `73-trackrow-unnamed26/` | Vary bitrate and sample depth              | Whether `Unnamed26=0x0029` changes                                  |

---

### Artwork

| Folder                        | What it captures                     | Decodes                                                         |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `80-artwork-none/`            | Track with no artwork                | Confirms `artworkId = 0` sentinel in track row                  |
| `81-artwork-jpeg/`            | Track with JPEG artwork embedded     | Artwork table row format; `PIONEER/Artwork/` folder structure   |
| `82-artwork-png/`             | Track with PNG artwork               | Whether Rekordbox converts to JPEG or stores original format    |
| `83-artwork-large/`           | Track with very large artwork image  | Whether Rekordbox downscales; max stored dimensions             |
| `84-artwork-two-tracks-same/` | Two tracks sharing identical artwork | Whether Artwork table deduplicates (1 row shared) or duplicates |

---

### Playlists

| Folder                | What it captures                               | Decodes                                                        |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `90-playlist-flat/`   | Single playlist with 3 tracks                  | PlaylistTree + PlaylistEntry row format — already mostly known |
| `91-playlist-nested/` | Folder containing 2 playlists                  | PlaylistTree `isFolder=1` + `parentId` nesting                 |
| `92-playlist-order/`  | Playlist with tracks in non-alphabetical order | `entryIndex` meaning — is it 0-based or 1-based?               |

---

### History (CDJ writes this on eject)

| Folder                | What it captures                                     | Decodes                                                       |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `100-history-empty/`  | Fresh export, no playback                            | Baseline empty History table pages                            |
| `101-history-played/` | Same USB after playing 3 tracks on CDJ then ejecting | HistoryPlaylists + HistoryEntries + History table row formats |

> **Note:** Captures 100/101 require a physical CDJ or XDJ. Load the USB,
> play the tracks, and eject. The CDJ writes the history back to the USB.

---

### SETTING.DAT Field Mapping

Each capture changes exactly **one setting** in Rekordbox then re-exports.
Diff against `110-settings-default/` to find the byte that changed.

| Folder                               | Setting changed                      |
| ------------------------------------ | ------------------------------------ |
| `110-settings-default/`              | Factory default — all settings reset |
| `111-settings-quantize-off/`         | Quantize → OFF                       |
| `112-settings-sync-off/`             | Sync → OFF                           |
| `113-settings-jog-vinyl/`            | Jog mode → Vinyl                     |
| `114-settings-jog-cdj/`              | Jog mode → CDJ                       |
| `115-settings-needle-search-off/`    | Needle search → OFF                  |
| `116-settings-master-tempo-on/`      | Master tempo → ON                    |
| `117-settings-slip-on/`              | Slip mode → ON                       |
| `118-settings-hotcue-autoload-off/`  | Hot cue auto-load → OFF              |
| `119-settings-beat-jump-1/`          | Beat jump size → 1 beat              |
| `120-settings-beat-jump-32/`         | Beat jump size → 32 beats            |
| `121-settings-loop-1/`               | Loop size → 1 beat                   |
| `122-settings-loop-16/`              | Loop size → 16 beats                 |
| `123-settings-track-end-warning-on/` | Track end warning → ON               |
| `124-settings-cue-play/`             | Cue/Play behaviour → momentary       |
| `125-settings-display-waveform/`     | Waveform display → large             |

---

## Files to Capture Per Export

For each export, copy the following from the USB root:

```
export.pdb
PIONEER/USBANLZ/<hash>/ANLZ0000.DAT
PIONEER/USBANLZ/<hash>/ANLZ0000.EXT
PIONEER/USBANLZ/<hash>/ANLZ0000.2EX   (if present — CDJ-3000 format)
PIONEER/MYSETTING.DAT
PIONEER/MYSETTING2.DAT
PIONEER/DEVSETTING.DAT
PIONEER/Artwork/                       (full folder, if present)
```

Preserve the subfolder structure inside each capture directory.

---

## Diff Commands

```bash
# Quick binary diff — shows byte offsets that differ
cmp -l captures/20-gain-default/export.pdb \
       captures/21-gain-plus6db/export.pdb | head -40

# Human-readable hex diff
xxd captures/20-gain-default/export.pdb > /tmp/a.hex
xxd captures/21-gain-plus6db/export.pdb > /tmp/b.hex
diff /tmp/a.hex /tmp/b.hex

# Diff a specific ANLZ section
xxd captures/20-gain-default/PIONEER/USBANLZ/.../ANLZ0000.DAT | grep -A2 -B2 "PQTZ"
```

For SETTING.DAT files, the CRC at bytes 6–7 will always change even if only
one setting byte changed — ignore bytes 6–7 when comparing.
