# Software Captures

All captures in this file require only **Rekordbox 6.x** and a USB drive.
No CDJ hardware is needed.

Read `CAPTURE_GUIDE.md` first — it covers test-track setup, how to export to
USB, the per-capture file checklist, and the diff workflow.

Every capture folder goes into `captures/<NN-slug>/`.

---

## 00 — Baseline

**Goal:** Minimum valid export. `test-tracks/track-normal.mp3`, no analysis,
no cues, no artwork, no playlists.

1. Create a fresh Rekordbox collection (File → Manage Library → Delete All if needed).
2. Import `test-tracks/track-normal.mp3`.
3. Do **not** run Beat/BPM analysis. Do **not** add any cues. Do **not** add artwork.
4. Export to a freshly formatted USB.

**Copy from USB:**

```
export.pdb
PIONEER/USBANLZ/<hash>/ANLZ0000.DAT
PIONEER/USBANLZ/<hash>/ANLZ0000.EXT
PIONEER/MYSETTING.DAT
PIONEER/MYSETTING2.DAT
PIONEER/DEVSETTING.DAT
```

Save in `captures/00-baseline/`. Preserve subfolder structure.

---

## 01–05 — Waveforms

These captures use the synthetic sine-wave tracks to confirm the frequency-band
encoding in the colour waveform sections (PWV5, PWV7, PWV4).

**For each capture 01–05:**

1. Clear the collection.
2. Import the specified track from `test-tracks/` (see table below).
3. In Rekordbox Preferences → Analysis → **Track Analysis Setting**:
   check **BPM / Grid** only. Uncheck KEY, Phrase, and Vocal.
   Waveform data is generated automatically — there is no separate toggle.
4. Right-click the track → **Analyze**.
5. Export to USB.

| Capture                    | Track to import                    |
| -------------------------- | ---------------------------------- |
| `01-waveform-silence/`     | `test-tracks/track-silence.wav`    |
| `02-waveform-sine-bass/`   | `test-tracks/track-sine-60hz.wav`  |
| `03-waveform-sine-mid/`    | `test-tracks/track-sine-500hz.wav` |
| `04-waveform-sine-treble/` | `test-tracks/track-sine-8khz.wav`  |
| `05-waveform-normal/`      | `test-tracks/track-normal.mp3`     |

**Copy from USB for each:** `export.pdb` + full `PIONEER/USBANLZ/` tree.

---

## 10–13 — Beat Grid

### 10 — Constant 160 BPM

1. Import `test-tracks/track-160bpm.mp3`.
2. Before analyzing, go to Preferences → Analysis → BPM Range and set it to
   **145–200** (or any range that includes 160) so Rekordbox doesn't
   half-tempo detect it as 80 BPM.
3. Run full analysis.
4. Open the Beat Grid editor. Confirm the BPM reads close to 160.
   Note the exact BPM Rekordbox detected (write it down).
5. Export to USB.

Save in `captures/10-beatgrid-constant-160/`. Include a `notes.txt` with the
exact detected BPM.

### 11 — Constant 190 BPM

1. Import `test-tracks/track-190bpm.mp3`.
2. Before analyzing, go to Preferences → Analysis → BPM Range and set it to
   **165–200** (or any range that includes 190) so Rekordbox doesn't
   half-tempo detect it.
3. Run full analysis.
4. Open the Beat Grid editor. Confirm the BPM reads close to 190.
   Note the exact detected BPM (write it down).
5. Export to USB.

Save in `captures/11-beatgrid-constant-190/`. Include `notes.txt` with the
exact detected BPM.

### 12 — Variable BPM

1. Import `test-tracks/track-variable-bpm.mp3`.
2. Run full analysis.
3. Export to USB.
4. Note the single BPM value Rekordbox detected (it will not show a range).

Save in `captures/12-beatgrid-variable/`. Include `notes.txt` with the detected BPM.

### 13 — Beatgrid Offset

1. Import `test-tracks/track-160bpm.mp3`.
2. Run full analysis.
3. Open the Beat Grid editor → click the single-step **move right** arrow (►) once
   to shift the grid forward by one step.
4. Export to USB.

Save in `captures/13-beatgrid-offset/`. In `notes.txt` record how many times
you clicked and in which direction.

---

## 20–25 — Gain / Loudness ← most important section

The location of gain data in the binary is completely unknown. These captures
are designed to isolate every candidate field through diffing.

**Use `test-tracks/track-normal.mp3` for all gain captures.** The audio content
must be identical across all six so that waveform and beatgrid data stays constant.

### 20 — Gain Default

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Open the Beat Grid editor for the track. The **Auto Gain** value is shown there.
3. Note the displayed gain value. Do not change it.
4. Export to USB.

Save in `captures/20-gain-default/`. Record the displayed gain value in `notes.txt`.

### 21 — Gain +6 dB

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Open the Beat Grid editor. Adjust the **Auto Gain** to `+6.1 dB`
   (Rekordbox does not allow exact +6 dB; +6.1 dB is the closest available step).
3. Export to USB.

Save in `captures/21-gain-6.1db/`.

### 22 — Gain −6 dB

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Open the Beat Grid editor. Adjust the **Auto Gain** to `−6 dB`.
3. Export to USB.

Save in `captures/22-gain-minus6db/`.

### 23 — Gain 0 dB (explicit)

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Open the Beat Grid editor. Adjust the **Auto Gain** to exactly `0 dB`.
3. Export to USB.

Save in `captures/23-gain-zero/`.

**Diff strategy:** Start with `diff(20-gain-default, 21-gain-plus6db)` on the
`export.pdb`. Any byte that changes is a gain candidate. Then diff the ANLZ
files to check whether gain is also stored there.

---

## 30–32 — Key

### 30 — C Major

1. Import `test-tracks/track-normal.mp3`.
2. In the track Properties panel, manually set **Key** to `C`.
3. Export to USB.

Save in `captures/30-key-c-major/`.

### 31 — A Minor

1. Import `test-tracks/track-normal.mp3`.
2. In the track Properties panel, manually set **Key** to `Am`.
3. Export to USB.

Save in `captures/31-key-a-minor/`.

### 32 — All 12 Keys

**Prerequisite:** generate the 8 extra key copies listed in the Setup section
of `CAPTURE_GUIDE.md` (`track-key-d.mp3` through `track-key-fm.mp3`) before
starting.

1. Import all 12 files listed in the table below.
2. Assign keys exactly as shown — one key per file.
3. Export all 12 tracks to USB.
4. Copy `notes.txt` from the table into `captures/32-key-all-12/notes.txt`.

| File                                 | Key to assign |
| ------------------------------------ | ------------- |
| `test-tracks/track-normal.mp3`       | C             |
| `test-tracks/track-160bpm.mp3`       | Cm            |
| `test-tracks/track-190bpm.mp3`       | Db            |
| `test-tracks/track-variable-bpm.mp3` | Dbm           |
| `test-tracks/track-key-d.mp3`        | D             |
| `test-tracks/track-key-dm.mp3`       | Dm            |
| `test-tracks/track-key-eb.mp3`       | Eb            |
| `test-tracks/track-key-ebm.mp3`      | Ebm           |
| `test-tracks/track-key-e.mp3`        | E             |
| `test-tracks/track-key-em.mp3`       | Em            |
| `test-tracks/track-key-f.mp3`        | F             |
| `test-tracks/track-key-fm.mp3`       | Fm            |

Save in `captures/32-key-all-12/`. Include `notes.txt` recording which file
received which key (copy the table above).

---

## 40–47 — Cue Points

All cue captures use `test-tracks/track-normal.mp3`, fully analyzed. Clear the
collection and re-import between each capture so cue data from a previous
capture does not carry over.

### 40 — Hot Cues A, B, C Only

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. In the Cue section, set **Hot Cue A** at 5 s, **B** at 10 s, **C** at 15 s.
3. Do not set D–H or any memory cues.
4. Export.

### 41 — All 8 Hot Cues A–H

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Set A=5 s, B=10 s, C=15 s, D=20 s, E=25 s, F=30 s, G=35 s, H=40 s.
3. Export.

Record positions in `notes.txt`.

### 42 — Memory Cues Only

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Set 3 **memory cues** at 5 s, 10 s, 15 s. No hot cues.
3. Export.

### 43 — All 8 Hot Cues, All 8 Colors

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Set hot cues A–H at 5 s, 10 s, 15 s, 20 s, 25 s, 30 s, 35 s, 40 s.
3. Color them: A=red, B=orange, C=yellow, D=green, E=cyan, F=blue, G=violet, H=pink
   (the exact Rekordbox color names — pick one color per slot using the palette picker).
4. Export.
5. In `notes.txt`: record which color name was assigned to which slot.

### 44 — Labeled Cues (short labels)

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Set hot cues A, B, C with labels:
   - A at 5 s = `Intro` (5 chars)
   - B at 10 s = `Drop` (4 chars)
   - C at 15 s = `Break` (5 chars)
3. Export.

### 45 — Labeled Cue (long label)

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Set hot cue A at 5 s with label `This is a very long label` (25 chars).
3. Export.

### 46 — Loop Cue

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Set **hot cue A as a loop**: position = 10 s, loop length = 4 beats
   (use the Loop section → Set Loop, then assign to Hot Cue A).
3. Export.
4. In `notes.txt`: record loop start time (ms) and loop end time (ms) exactly
   as displayed by Rekordbox.

### 47 — Multiple Loops

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Set 4 loop hot cues:
   - A = 1-beat loop at 5 s
   - B = 2-beat loop at 10 s
   - C = 4-beat loop at 15 s
   - D = 8-beat loop at 20 s
3. Export.
4. Record all loop start and end times in ms in `notes.txt`.

---

## 50–62 — Track Metadata (PDB fields)

All metadata captures use `test-tracks/track-normal.mp3` as the audio file.
Clear the collection and re-import between each capture so metadata from a
previous capture does not carry over.

### 50 — Minimal (title only)

1. Import `test-tracks/track-normal.mp3`.
2. Set only the **Title** field to `Test Track`. Leave all other metadata blank.
3. Export.

### 51 — Full Metadata

1. Import `test-tracks/track-normal.mp3`.
2. Fill every editable field:
   - Title, Artist, Album, Genre, Label, Year, Track Number, Comment, ISRC,
     Composer, Mix Name, Release Date, Rating (3 stars), Color tag.
3. Export.

### 52 — Single Genre

1. Import `test-tracks/track-normal.mp3`.
2. Set Genre to `Techno`. Leave all other metadata blank.
3. Export.

### 53 — Two Tracks, Two Different Genres

1. Import `test-tracks/track-normal.mp3`. Set Genre = `Techno`. Leave all else blank.
2. Import `test-tracks/track-160bpm.mp3`. Set Genre = `House`. Leave all else blank.
3. Export both.

### 54 — Label Set

1. Import `test-tracks/track-normal.mp3`.
2. Set Label to `Drumcode`. Leave genre and all other fields empty.
3. Export.

### 55 — Album with Artist

1. Import `test-tracks/track-normal.mp3`.
2. Set Artist = `Test Artist`, Album = `Test Album`. Leave all other fields empty.
3. Export.

### 56 — Comment Field

1. Import `test-tracks/track-normal.mp3`.
2. Set Comment = `This is a test comment with unicode: ñ é ü`. Leave all other fields empty.
3. Export.

### 57 — ISRC

1. Import `test-tracks/track-normal.mp3`.
2. Set ISRC = `USRC17607839`. Leave all other fields empty.
3. Export.

### 58 — Rating 1 Star

1. Import `test-tracks/track-normal.mp3`.
2. Set rating to 1 star. Leave all other fields empty.
3. Export.

### 59 — Rating 5 Stars

1. Import `test-tracks/track-normal.mp3`.
2. Set rating to 5 stars. Leave all other fields empty.
3. Export.

### 60 — Color Tag

1. Import `test-tracks/track-normal.mp3`.
2. Apply a **Color** tag using the Rekordbox label color
   (the colored dot shown in the track list — pink, red, orange, etc.).
3. Export. Record which color was used in `notes.txt`.

### 61 — Year

1. Import `test-tracks/track-normal.mp3`.
2. Set Year = `2024`. Leave all other fields empty.
3. Export.

### 62 — Track Number

1. Import `test-tracks/track-normal.mp3`.
2. Set Track Number = `7`. Leave all other fields empty.
3. Export.

---

## 70–73 — PDB Track Row Unknown Fields

These captures probe the constant-looking bytes in the track row binary.

### 70 — Same Content, Four File Types

1. Import `test-tracks/track-normal.mp3`. Run full analysis. Export → rename `export.pdb` to `pdb-mp3.bin`.
2. Clear collection. Import `test-tracks/track-normal.flac`. Run full analysis. Export → `pdb-flac.bin`.
3. Clear collection. Import `test-tracks/track-normal.wav`. Run full analysis. Export → `pdb-wav.bin`.
4. Clear collection. Import `test-tracks/track-normal.m4a`. Run full analysis. Export → `pdb-m4a.bin`.

Save all four in `captures/70-trackrow-bitmask/`.

### 71 — Analyzed vs Unanalyzed

1. Import `test-tracks/track-normal.mp3`. **Do not run analysis.** Export → `pdb-unanalyzed.bin`.
2. Run full analysis on the same track (right-click → Analyze). Export → `pdb-analyzed.bin`.

Save in `captures/71-trackrow-unnamed78/`.

### 72 — Checksum Field

1. Copy `test-tracks/track-normal.mp3` to `test-tracks/track-checksum-b.mp3`.
2. Open `test-tracks/track-checksum-b.mp3` in a hex editor and change exactly
   1 byte somewhere in the audio payload (not the ID3 header).
3. Import `test-tracks/track-normal.mp3`. Run full analysis. Export → `pdb-original.bin`.
4. Clear collection. Import `test-tracks/track-checksum-b.mp3`. Run full analysis.
   Export → `pdb-modified.bin`.
5. Compare the two track rows in the PDB to find the checksum field.

Save in `captures/72-trackrow-checksum/`.

### 73 — Bitrate and Sample Depth

1. Import `test-tracks/track-normal.mp3` (320 kbps). Run full analysis. Export → `pdb-320kbps.bin`.
2. Clear collection. Import `test-tracks/track-normal-128kbps.mp3` (128 kbps). Run full analysis.
   Export → `pdb-128kbps.bin`.
3. Clear collection. Import `test-tracks/track-normal.wav` (44.1 kHz). Run full analysis.
   Export → `pdb-44100.bin`.
4. Clear collection. Import `test-tracks/track-normal-48khz.wav` (48 kHz). Run full analysis.
   Export → `pdb-48000.bin`.

Save all four in `captures/73-trackrow-unnamed26/`.

---

## 80–84 — Artwork

### 80 — No Artwork (baseline)

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. Confirm no artwork is set in Properties.
3. Export.

### 81 — JPEG Artwork

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. In Properties, add `test-tracks/artwork.jpg` (500×500 JPEG).
3. Export. Copy the entire `PIONEER/Artwork/` folder from the USB.

### 82 — PNG Artwork

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. In Properties, replace the artwork with `test-tracks/artwork.png` (500×500 PNG).
3. Export. Copy `PIONEER/Artwork/`.

### 83 — Large Artwork

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
2. In Properties, add `test-tracks/artwork-large.jpg` (3000×3000 JPEG).
3. Export. Note the file size stored on USB in `notes.txt`.

### 84 — Two Tracks Sharing Artwork

1. Import `test-tracks/track-normal.mp3`. Run full analysis.
   In Properties, add `test-tracks/artwork.jpg`.
2. Import `test-tracks/track-160bpm.mp3`. Run full analysis.
   In Properties, add the exact same `test-tracks/artwork.jpg`.
3. Export both. Check whether `PIONEER/Artwork/` has 1 or 2 files; record in `notes.txt`.

---

## 90–92 — Playlists

### 90 — Flat Playlist

1. Import `test-tracks/track-normal.mp3`, `test-tracks/track-160bpm.mp3`,
   and `test-tracks/track-190bpm.mp3`. Run full analysis on all three.
2. Create a playlist named `TestPlaylist`.
3. Add all 3 tracks to it.
4. Export the playlist to USB.

### 91 — Nested Playlist (Folder)

1. Import `test-tracks/track-normal.mp3`, `test-tracks/track-160bpm.mp3`,
   `test-tracks/track-190bpm.mp3`, and `test-tracks/track-variable-bpm.mp3`.
   Run full analysis on all four.
2. Create a **folder** named `TestFolder`.
3. Create 2 playlists inside it:
   - `SubA`: add `track-normal.mp3` and `track-160bpm.mp3`
   - `SubB`: add `track-190bpm.mp3` and `track-variable-bpm.mp3`
4. Export `TestFolder` to USB.

### 92 — Playlist Track Order

1. Import `test-tracks/track-normal.mp3`, `test-tracks/track-160bpm.mp3`,
   and `test-tracks/track-190bpm.mp3`. Run full analysis on all three.
2. Create a playlist named `OrderTest`.
3. Add them in this deliberate non-alphabetical order:
   `track-190bpm.mp3` first, then `track-normal.mp3`, then `track-160bpm.mp3`.
4. Export. Record the intended playback order in `notes.txt`.

---

## 100 — History Baseline (prerequisite for hardware capture 101)

This capture prepares the USB that your friend will load into a CDJ for
`hardware_captures.md` capture 101. Do this capture first, then hand the USB
to your friend.

1. Import `test-tracks/track-normal.mp3`, `test-tracks/track-160bpm.mp3`,
   and `test-tracks/track-190bpm.mp3`. Run full analysis on all three.
2. Export all three to USB. Do **not** load the USB into a CDJ.
3. Copy `export.pdb` from the USB into `captures/100-history-empty/`.

Hand the USB (do not eject again after copying — keep the filesystem intact)
to your friend along with `hardware_captures.md`.

---

## 110–125 — SETTING.DAT Field Mapping

**Strategy:** Start from `110-settings-default/`. Change exactly one setting,
export, copy the three `.DAT` files. Diff against the default to find the byte
that changed.

Note: bytes 6–7 of every SETTING.DAT are the CRC — they change even if only
one unrelated byte changes. **Always ignore bytes 6–7 when comparing.**

### 110 — Default Settings

1. In Rekordbox, go to Preferences → My Settings.
2. Click **Restore Defaults** (or manually reset all settings to factory).
3. Export to USB. Copy:
   - `PIONEER/MYSETTING.DAT`
   - `PIONEER/MYSETTING2.DAT`
   - `PIONEER/DEVSETTING.DAT`

Save in `captures/110-settings-default/`.

### 111–125 — One Setting Each

For each capture below, restore defaults first, change only the listed setting,
then export. Copy only the three `.DAT` files (no audio or ANLZ needed).

| Capture                              | Menu path in Rekordbox                | Change    |
| ------------------------------------ | ------------------------------------- | --------- |
| `111-settings-quantize-off/`         | Preferences → My Settings → Quantize  | OFF       |
| `112-settings-sync-off/`             | My Settings → Sync                    | OFF       |
| `113-settings-jog-vinyl/`            | My Settings → Jog Mode                | Vinyl     |
| `114-settings-jog-cdj/`              | My Settings → Jog Mode                | CDJ       |
| `115-settings-needle-search-off/`    | My Settings → Needle Search           | OFF       |
| `116-settings-master-tempo-on/`      | My Settings → Master Tempo            | ON        |
| `117-settings-slip-on/`              | My Settings → Slip                    | ON        |
| `118-settings-hotcue-autoload-off/`  | My Settings → Hot Cue Auto Load       | OFF       |
| `119-settings-beat-jump-1/`          | My Settings → Beat Jump               | 1 Beat    |
| `120-settings-beat-jump-32/`         | My Settings → Beat Jump               | 32 Beats  |
| `121-settings-loop-1/`               | My Settings → Loop                    | 1 Beat    |
| `122-settings-loop-16/`              | My Settings → Loop                    | 16 Beats  |
| `123-settings-track-end-warning-on/` | My Settings → Track End Warning       | ON        |
| `124-settings-cue-play/`             | My Settings → Cue/Play                | Momentary |
| `125-settings-display-waveform/`     | My Settings → Display → Waveform Size | Large     |
