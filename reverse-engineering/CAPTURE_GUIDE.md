# Rekordbox USB Export Capture Guide

Step-by-step instructions for producing binary exports used to reverse-engineer
the Pioneer/Rekordbox protocol. Follow each section in order. Every capture
goes into `captures/<NN-slug>/` and must include the files listed at the end
of each section.

**Software required:**

- Rekordbox 6.x (latest stable)
- A USB drive formatted as FAT32 or exFAT (call it `RBDECK` throughout)
- A hex viewer: `xxd`, `hexdump`, or [ImHex](https://github.com/WerWolv/ImHex)
- Optional: CDJ-2000NXS2 or CDJ-3000 for captures that require hardware

**Golden rule:** change exactly ONE thing between consecutive captures. If you
change two things at once the diff is unreadable.

---

## Setup — Test Tracks

Prepare these audio files before starting. Use Audacity or ffmpeg to generate
the synthetic ones.

| ID                       | File                                                | How to generate                                                                                     |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `track-silence.wav`      | 3 minutes of silence                                | `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 180 track-silence.wav`                              |
| `track-sine-60hz.wav`    | 3 min, 60 Hz sine at −6 dBFS                        | `ffmpeg -f lavfi -i "sine=frequency=60:amplitude=0.5:sample_rate=44100" -t 180 track-sine-60hz.wav` |
| `track-sine-500hz.wav`   | 3 min, 500 Hz sine at −6 dBFS                       | same, `frequency=500`                                                                               |
| `track-sine-8khz.wav`    | 3 min, 8 kHz sine at −6 dBFS                        | same, `frequency=8000`                                                                              |
| `track-normal.mp3`       | Any real music track, 3–5 min, 320 kbps MP3         | Use any file you own                                                                                |
| `track-normal.flac`      | Same content as track-normal.mp3 but FLAC           | `ffmpeg -i track-normal.mp3 track-normal.flac`                                                      |
| `track-normal.wav`       | Same content as WAV                                 | `ffmpeg -i track-normal.mp3 track-normal.wav`                                                       |
| `track-normal.m4a`       | Same content as M4A/AAC                             | `ffmpeg -i track-normal.mp3 track-normal.m4a`                                                       |
| `track-120bpm.mp3`       | 3 min constant 120 BPM — any music with clear beats | Pick a known-BPM track                                                                              |
| `track-140bpm.mp3`       | 3 min constant 140 BPM                              | Pick a different known-BPM track                                                                    |
| `track-variable-bpm.mp3` | Track that accelerates from ≈120 to ≈130 BPM        | Any live recording with tempo drift                                                                 |

For all captures that require artwork, use a 500×500 JPEG named `artwork.jpg`.

---

## How to Export to USB in Rekordbox

1. Open Rekordbox 6.
2. Drag the track(s) into a Collection or playlist as instructed per capture.
3. Connect the USB drive.
4. In the left sidebar, expand **Devices** → your USB.
5. Drag tracks or playlists to the device as instructed.
6. Click **Sync** (cloud icon) or right-click → **Export to Device**.
7. After export completes, eject the USB safely.
8. Copy the required files from the USB into the capture folder on your computer.

---

## 00 — Baseline

**Goal:** Minimum valid export. 1 track, no analysis run, no cues, no artwork,
no playlists.

**Steps:**

1. Create a fresh Rekordbox collection (File → Manage Library → Delete All if needed).
2. Import `track-normal.mp3`.
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
2. Import the specified track (see table below).
3. In Rekordbox Preferences → Analysis, enable **Waveform analysis** and
   **Beat/BPM** analysis. Disable all other analysis.
4. Right-click the track → **Analyze (Beat/BPM & Waveform)**.
5. Export to USB.

| Capture                    | Track to import        |
| -------------------------- | ---------------------- |
| `01-waveform-silence/`     | `track-silence.wav`    |
| `02-waveform-sine-bass/`   | `track-sine-60hz.wav`  |
| `03-waveform-sine-mid/`    | `track-sine-500hz.wav` |
| `04-waveform-sine-treble/` | `track-sine-8khz.wav`  |
| `05-waveform-normal/`      | `track-normal.mp3`     |

**Copy from USB for each:** `export.pdb` + full `PIONEER/USBANLZ/` tree.

---

## 10–13 — Beat Grid

### 10 — Constant 120 BPM

1. Import `track-120bpm.mp3`.
2. Run full analysis.
3. Open the Beat Grid editor. Confirm the BPM reads as close to 120 as possible.
   Note the exact BPM Rekordbox detected (write it down).
4. Export to USB.

Save in `captures/10-beatgrid-constant-120/`. Include a `notes.txt` with the
exact detected BPM.

### 11 — Constant 140 BPM

Same steps with `track-140bpm.mp3`. Save in `captures/11-beatgrid-constant-140/`.

### 12 — Variable BPM

1. Import `track-variable-bpm.mp3`.
2. Run full analysis.
3. Export to USB.
4. Note the start and end BPM shown in the Beat Grid editor.

Save in `captures/12-beatgrid-variable/`. Include `notes.txt` with start/end BPM.

### 13 — Beatgrid Offset

1. Import `track-120bpm.mp3` (same as capture 10).
2. Run full analysis.
3. Open the Beat Grid editor → use the **Shift** control to move the grid exactly
   **+10 ms** (one tap of the fine-shift button if available).
4. Export to USB.

Save in `captures/13-beatgrid-offset/`. Note the exact offset applied in `notes.txt`.

---

## 20–25 — Gain / Loudness ← most important section

The location of gain data in the binary is completely unknown. These captures
are designed to isolate every candidate field through diffing.

**Use the same file for all gain captures** — copy `track-normal.mp3` to the
USB every time. The audio content must be identical so that the waveform and
beatgrid data doesn't change between captures.

### 20 — Gain Default

1. Import `track-normal.mp3`. Run full analysis.
2. Open track Properties (right-click → Properties or press `I`).
3. Note the **Gain** value shown. Do not change it.
4. Export to USB.

Save in `captures/20-gain-default/`. Record the displayed gain value in `notes.txt`.

### 21 — Gain +6 dB

1. Same track. Open Properties.
2. Set **Gain** to `+6 dB` (or the closest available step).
3. Export to USB.

Save in `captures/21-gain-plus6db/`.

### 22 — Gain −6 dB

Same, set **Gain** to `−6 dB`. Save in `captures/22-gain-minus6db/`.

### 23 — Gain 0 dB (explicit)

Same, set **Gain** to exactly `0 dB`. Save in `captures/23-gain-zero/`.

### 24 — Auto-Gain ON

1. Rekordbox Preferences → Analysis → enable **Auto Gain**.
2. Clear the track from the collection and re-import `track-normal.mp3`.
3. Run full analysis (auto-gain will run as part of it).
4. Export to USB.

Save in `captures/24-autogain-on/`.

### 25 — Auto-Gain OFF

1. Rekordbox Preferences → Analysis → disable **Auto Gain**.
2. Clear the track, re-import `track-normal.mp3`.
3. Run full analysis.
4. Export to USB.

Save in `captures/25-autogain-off/`.

**Diff strategy:** Start with `diff(20-gain-default, 21-gain-plus6db)` on the
`export.pdb`. Any byte that changes is a gain candidate. Then diff the ANLZ
files to check whether gain is also stored there.

---

## 30–32 — Key

### 30 — C Major

1. Import any track. In the track Properties panel, manually set **Key** to `C`.
2. Export to USB.

### 31 — A Minor

1. Same or different track. Set **Key** to `Am`.
2. Export.

### 32 — All 12 Keys

1. Import 12 different tracks.
2. Assign one key to each: C, Cm, Db, Dbm, D, Dm, Eb, Ebm, E, Em, F, Fm
   (or use the Camelot equivalents).
3. Export all to USB.
4. Record which track has which key in `notes.txt`.

Save each in `captures/30-key-c-major/`, `captures/31-key-a-minor/`,
`captures/32-key-all-12/`.

---

## 40–47 — Cue Points

All cue captures use `track-normal.mp3`, fully analyzed.

### 40 — Hot Cues A, B, C Only

1. Import and analyze `track-normal.mp3`.
2. In the Cue section, set **Hot Cue A** at 5 s, **B** at 10 s, **C** at 15 s.
3. Do not set D–H or any memory cues.
4. Export.

### 41 — All 8 Hot Cues A–H

1. Same track.
2. Set A=5s, B=10s, C=15s, D=20s, E=25s, F=30s, G=35s, H=40s.
3. Export.

Record positions in `notes.txt`.

### 42 — Memory Cues Only

1. Same track.
2. Set 3 **memory cues** at 5 s, 10 s, 15 s. No hot cues.
3. Export.

### 43 — All 8 Hot Cues, All 8 Colors

1. Same track.
2. Set hot cues A–H.
3. Color them: A=red, B=orange, C=yellow, D=green, E=cyan, F=blue, G=violet, H=pink
   (the exact Rekordbox color names — pick one color per slot using the palette picker).
4. Export.
5. In `notes.txt`: record which color name was assigned to which slot.

### 44 — Labeled Cues (short labels)

1. Set hot cues A, B, C with labels:
   - A = `Intro` (5 chars)
   - B = `Drop` (4 chars)
   - C = `Break` (5 chars)
2. Export.

### 45 — Labeled Cue (long label)

1. Set hot cue A with label `This is a very long label` (25 chars).
2. Export.

### 46 — Loop Cue

1. Set **hot cue A as a loop**: position = 10 s, loop length = 4 beats
   (use the Loop section → Set Loop, then assign to Hot Cue A).
2. Export.
3. In `notes.txt`: record loop start time (ms) and loop end time (ms) exactly
   as displayed by Rekordbox.

### 47 — Multiple Loops

1. Set 4 loop hot cues:
   - A = 1-beat loop at 5 s
   - B = 2-beat loop at 10 s
   - C = 4-beat loop at 15 s
   - D = 8-beat loop at 20 s
2. Export.
3. Record all loop start and end times in ms in `notes.txt`.

---

## 50–62 — Track Metadata (PDB fields)

All metadata captures use `track-normal.mp3` as the audio file.

### 50 — Minimal (title only)

1. Import track. Set only the **Title** field. Leave all other metadata blank.
2. Export.

### 51 — Full Metadata

1. Import track. Fill every editable field:
   - Title, Artist, Album, Genre, Label, Year, Track Number, Comment, ISRC,
     Composer, Mix Name, Release Date, Rating (3 stars), Color tag.
2. Export.

### 52 — Single Genre

1. Import track. Set Genre to `Techno`. Leave all else empty.
2. Export.

### 53 — Two Tracks, Two Different Genres

1. Import `track-normal.mp3` → Genre = `Techno`.
2. Import `track-120bpm.mp3` → Genre = `House`.
3. Export both.

### 54 — Label Set

1. Import track. Set Label to `Drumcode`. Leave genre empty.
2. Export.

### 55 — Album with Artist

1. Import track. Set Artist = `Test Artist`, Album = `Test Album`.
2. Export.

### 56 — Comment Field

1. Import track. Set Comment = `This is a test comment with unicode: ñ é ü`.
2. Export.

### 57 — ISRC

1. Import track. Set ISRC = `USRC17607839`.
2. Export.

### 58 — Rating 1 Star

1. Import track. Set rating to 1 star. Export.

### 59 — Rating 5 Stars

1. Import track. Set rating to 5 stars. Export.

### 60 — Color Tag

1. Import track. Apply a **Color** tag using the Rekordbox label color
   (the colored dot shown in the track list — pink, red, orange, etc.).
2. Export. Record which color in `notes.txt`.

### 61 — Year

1. Import track. Set Year = `2024`. Export.

### 62 — Track Number

1. Import track. Set Track Number = `7`. Export.

---

## 70–73 — PDB Track Row Unknown Fields

These captures probe the constant-looking bytes in the track row binary.

### 70 — Same Content, Four File Types

1. Import `track-normal.mp3`, export → save `export.pdb` as `pdb-mp3.bin` inside the folder.
2. Import `track-normal.flac`, export → save as `pdb-flac.bin`.
3. Import `track-normal.wav`, export → save as `pdb-wav.bin`.
4. Import `track-normal.m4a`, export → save as `pdb-m4a.bin`.

Save all four in `captures/70-trackrow-bitmask/`.

### 71 — Analyzed vs Unanalyzed

1. Import `track-normal.mp3`. **Do not run analysis.** Export → `pdb-unanalyzed.bin`.
2. Run full analysis on same track. Export → `pdb-analyzed.bin`.

Save in `captures/71-trackrow-unnamed78/`.

### 72 — Checksum Field

1. Make two copies of `track-normal.mp3`: `track-a.mp3` (original) and
   `track-b.mp3` (open in a hex editor, change 1 byte somewhere in the audio payload).
2. Import both. Export. Compare track rows in `export.pdb`.

Save in `captures/72-trackrow-checksum/`.

### 73 — Bitrate and Sample Depth

1. Import the 320 kbps MP3 → export → `pdb-320kbps.bin`.
2. Convert to 128 kbps MP3, import → export → `pdb-128kbps.bin`.
3. Import the 44.1 kHz WAV → export → `pdb-44100.bin`.
4. Convert WAV to 48 kHz, import → export → `pdb-48000.bin`.

Save all in `captures/73-trackrow-unnamed26/`.

---

## 80–84 — Artwork

### 80 — No Artwork (baseline)

1. Import `track-normal.mp3` with no artwork. Export.

### 81 — JPEG Artwork

1. Import `track-normal.mp3`.
2. In Properties, add `artwork.jpg` (500×500 JPEG).
3. Export. Copy the entire `PIONEER/Artwork/` folder from the USB.

### 82 — PNG Artwork

1. Same track, replace artwork with a 500×500 PNG.
2. Export. Copy `PIONEER/Artwork/`.

### 83 — Large Artwork

1. Same track, use a 3000×3000 JPEG as artwork.
2. Export. Note the file size stored on USB in `notes.txt`.

### 84 — Two Tracks Sharing Artwork

1. Import `track-normal.mp3` and `track-120bpm.mp3`.
2. Give both the exact same `artwork.jpg`.
3. Export both. Check whether `PIONEER/Artwork/` has 1 or 2 files, record in `notes.txt`.

---

## 90–92 — Playlists

### 90 — Flat Playlist

1. Import 3 tracks. Create a playlist named `TestPlaylist`.
2. Add all 3 tracks to it.
3. Export the playlist to USB.

### 91 — Nested Playlist (Folder)

1. Import 4 tracks.
2. Create a **folder** named `TestFolder`.
3. Create 2 playlists inside it: `SubA` (2 tracks) and `SubB` (2 tracks).
4. Export to USB.

### 92 — Playlist Track Order

1. Import 3 tracks.
2. Create a playlist. Add them in this order: track 3, track 1, track 2 (non-default order).
3. Export. Record the intended playback order in `notes.txt`.

---

## 100–101 — History (requires CDJ hardware)

### 100 — Empty History (fresh export)

1. Export `track-normal.mp3` to USB (any settings). Do not load it on a CDJ.
2. Copy `export.pdb` as the baseline history state.

### 101 — History After Playback

1. Load the USB from capture 100 into a CDJ-2000NXS2 or CDJ-3000.
2. Play all 3 tracks to the end (or at least 30 seconds each).
3. Eject the USB safely using the CDJ eject button — the CDJ writes history on eject.
4. Copy `export.pdb` from the USB.

Compare `100-history-empty/export.pdb` vs `101-history-played/export.pdb` to
find the HistoryPlaylists and HistoryEntries row formats.

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

---

## Files to Copy Per Capture — Checklist

```
[ ] export.pdb
[ ] PIONEER/USBANLZ/<hash>/ANLZ0000.DAT
[ ] PIONEER/USBANLZ/<hash>/ANLZ0000.EXT
[ ] PIONEER/USBANLZ/<hash>/ANLZ0000.2EX    (if present — CDJ-3000 format)
[ ] PIONEER/MYSETTING.DAT
[ ] PIONEER/MYSETTING2.DAT
[ ] PIONEER/DEVSETTING.DAT
[ ] PIONEER/Artwork/                        (artwork captures only)
[ ] notes.txt                               (any measured values: BPM, times, gain dB)
```

When multiple tracks are exported, copy the ANLZ folder for each track.
Name them `ANLZ-track1/`, `ANLZ-track2/` etc. and record which is which in
`notes.txt`.

---

## Diff Workflow

```bash
# Quick binary diff — prints byte offset + both values for every difference
cmp -l captures/20-gain-default/export.pdb \
       captures/21-gain-plus6db/export.pdb | head -40

# Human-readable hex diff
xxd captures/20-gain-default/export.pdb > /tmp/a.hex
xxd captures/21-gain-plus6db/export.pdb > /tmp/b.hex
diff /tmp/a.hex /tmp/b.hex

# Find a known section tag in an ANLZ file
xxd captures/10-beatgrid-constant-120/PIONEER/USBANLZ/.../ANLZ0000.EXT \
  | grep -A 4 "5051 5432"   # PQT2 in hex

# ImHex (recommended for large files)
# File → Open both files → View → Diff
```

SETTING.DAT: always mask bytes 6–7 before comparing:

```bash
# Strip CRC bytes before diff
python3 -c "
import sys
d = open(sys.argv[1],'rb').read()
print(d[:6].hex(), '????', d[8:].hex())
" captures/110-settings-default/PIONEER/MYSETTING.DAT
```
