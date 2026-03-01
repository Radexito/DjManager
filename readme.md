# DJ Manager

Your music library, built for DJs. Import tracks, analyse BPM and key automatically, build playlists, and prepare sets — all offline, all on your machine.

[![CI](https://github.com/Radexito/djman/actions/workflows/ci.yml/badge.svg)](https://github.com/Radexito/djman/actions/workflows/ci.yml)
[![Release](https://github.com/Radexito/djman/actions/workflows/release.yml/badge.svg)](https://github.com/Radexito/djman/actions/workflows/release.yml)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![ESLint](https://img.shields.io/badge/linting-ESLint-4B32C3)](https://eslint.org/)
[![Tested with Vitest](https://img.shields.io/badge/tested_with-Vitest-6E9F18)](https://vitest.dev/)
[![E2E with Playwright](https://img.shields.io/badge/e2e-Playwright-45ba4b)](https://playwright.dev/)

![DJ Manager screenshot](screenshot.png)

---

## Download

Grab the latest build for your platform from [**Releases**](https://github.com/Radexito/djman/releases).

FFmpeg and the audio analyser download automatically on first launch — no manual setup required.

| Platform | File                                              |
| -------- | ------------------------------------------------- |
| Linux    | `DJ.Manager-x.x.x-Linux` (AppImage — just run it) |
| Windows  | `DJ.Manager-x.x.x-Setup.exe`                      |
| macOS    | `DJ.Manager-x.x.x.dmg`                            |

---

## What it does

**Library** — Import audio files once; DJ Manager manages storage and keeps everything organised. Search, sort, and filter by BPM, key, title, duration, and more. Use the advanced query syntax to stack filters — e.g. `GENRE is Psytrance AND BPM IN RANGE 140-145` or `KEY matches 8A AND BPM > 130`.

**Analysis** — Every track is analysed automatically for BPM, musical key (displayed in Camelot notation for harmonic mixing), loudness (LUFS), replay gain, and intro/outro markers. Re-analyse any track with a right-click.

**Playlists** — Create colour-coded playlists, drag tracks in, reorder by drag-and-drop, and sort by any column. Track count and total duration shown at all times.

**Player** — Full playback with seekbar, shuffle, repeat, previous/next, hardware media key support, and per-track intro/outro zones shown visually on the seek bar. Double-click any track to play.

**Settings** — Move your library to any location (e.g. an external drive). Update FFmpeg and the audio analyser from inside the app. Clear library or all user data from the Advanced tab.

---

## Running from source

```bash
git clone https://github.com/Radexito/djman.git
cd djman
npm install
cd renderer && npm install && cd ..
npm start
```

FFmpeg and mixxx-analyzer are downloaded automatically to `~/.config/djman/bin/` on first run.

---

## What's been built

| Feature                                                    | Status |
| ---------------------------------------------------------- | ------ |
| Import + managed library storage                           | ✅     |
| FFmpeg metadata extraction                                 | ✅     |
| BPM / key / loudness / intro+outro analysis                | ✅     |
| Advanced query search (field filters, ranges, Camelot key) | ✅     |
| Re-analyse, BPM halve/double via right-click Analysis menu | ✅     |
| Find Similar tracks by key or BPM via context menu         | ✅     |
| Multi-select (click, Shift, Ctrl, Ctrl+A)                  | ✅     |
| Playlists (create, colour, reorder, drag-and-drop)         | ✅     |
| Audio player with seekbar and intro/outro zones            | ✅     |
| Hardware media keys                                        | ✅     |
| Loudness normalisation (LUFS target)                       | ✅     |
| Runtime dependency downloads (FFmpeg + analyser)           | ✅     |
| In-app dependency updates                                  | ✅     |
| Standalone builds for Linux / Windows / macOS              | ✅     |
| Move library to custom location                            | ✅     |
| App logging to `~/.config/djman/logs/`                     | ✅     |

Issues tracking upcoming work are on the [**Issues**](https://github.com/Radexito/djman/issues) page.

---

## How files are stored

Audio is stored at `~/.config/djman/audio/<xx>/<hash>.<ext>` (configurable via Settings → Library). The two-character hash prefix keeps directory sizes manageable. Playlists reference tracks by ID — no duplicates, no copies.

Logs are written daily to `~/.config/djman/logs/app-YYYY-MM-DD.log`.
