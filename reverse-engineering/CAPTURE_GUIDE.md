# Rekordbox USB Export Capture Guide

Master reference for all reverse-engineering captures. Read this file first.
Actual capture steps are split into two files:

- **`software_captures.md`** — everything you can do with Rekordbox + a USB drive alone
- **`hardware_captures.md`** — captures that require a CDJ-2000NXS2 or CDJ-3000

**Software required:**

- Rekordbox 6.x (latest stable)
- A USB drive formatted as FAT32 or exFAT (call it `RBDECK` throughout)
- A hex viewer: `xxd`, `hexdump`, or [ImHex](https://github.com/WerWolv/ImHex)

**Hardware required (for `hardware_captures.md` only):**

- CDJ-2000NXS2 or CDJ-3000

**Golden rule:** change exactly ONE thing between consecutive captures. If you
change two things at once the diff is unreadable.

---

## Setup — Test Tracks

All test tracks live in `test-tracks/` at the root of this repository. They
are gitignored and must be generated locally before starting.

| File                       | Description                                        | How to generate                                                                                           |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `track-silence.wav`        | 3 minutes of silence                               | `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 180 track-silence.wav`                                    |
| `track-sine-60hz.wav`      | 3 min, 60 Hz sine at −6 dBFS                       | `ffmpeg -f lavfi -i sine=frequency=60:sample_rate=44100 -af volume=0.5 -t 180 track-sine-60hz.wav`        |
| `track-sine-500hz.wav`     | 3 min, 500 Hz sine at −6 dBFS                      | same, `frequency=500`                                                                                     |
| `track-sine-8khz.wav`      | 3 min, 8 kHz sine at −6 dBFS                       | same, `frequency=8000`                                                                                    |
| `track-normal.mp3`         | Real music track, 3–5 min, 320 kbps MP3            | Copy from your library                                                                                    |
| `track-normal.flac`        | Same content as `track-normal.mp3`, FLAC           | `ffmpeg -i track-normal.mp3 track-normal.flac`                                                            |
| `track-normal.wav`         | Same content as WAV (44.1 kHz)                     | `ffmpeg -i track-normal.mp3 track-normal.wav`                                                             |
| `track-normal.m4a`         | Same content as M4A/AAC                            | `ffmpeg -i track-normal.mp3 track-normal.m4a`                                                             |
| `track-normal-128kbps.mp3` | Same content re-encoded at 128 kbps                | `ffmpeg -i track-normal.mp3 -b:a 128k track-normal-128kbps.mp3`                                           |
| `track-normal-48khz.wav`   | Same content resampled to 48 kHz                   | `ffmpeg -i track-normal.wav -ar 48000 track-normal-48khz.wav`                                             |
| `track-160bpm.mp3`         | Real track with constant ~160 BPM, clear beats     | Copy from your library                                                                                    |
| `track-190bpm.mp3`         | Real track with constant ~140 BPM, clear beats     | Copy from your library                                                                                    |
| `track-variable-bpm.mp3`   | Synthetic sine, linear ramp 120→130 BPM over 3 min | `ffmpeg -f lavfi -i "aevalsrc=0.5*sin(2*PI*(2*t+t*t/2160)):s=44100:c=mono" -t 180 track-variable-bpm.mp3` |
| `artwork.jpg`              | 500×500 JPEG for artwork captures                  | `ffmpeg -f lavfi -i color=c=0x1a1a2e:size=500x500:rate=1 -vframes 1 artwork.jpg`                          |
| `artwork.png`              | 500×500 PNG version of the same artwork            | `ffmpeg -i artwork.jpg artwork.png`                                                                       |
| `artwork-large.jpg`        | 3000×3000 JPEG for the large-artwork capture       | `ffmpeg -f lavfi -i color=c=0x1a1a2e:size=3000x3000:rate=1 -vframes 1 artwork-large.jpg`                  |

**Before capture 32 only** — create 8 extra copies of `track-normal.mp3` for
the all-12-keys capture (Rekordbox requires each imported file to be unique):

```bash
for key in d dm eb ebm e em f fm; do
  cp test-tracks/track-normal.mp3 test-tracks/track-key-$key.mp3
done
```

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
