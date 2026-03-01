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

**Library** — Import audio files once; DJ Manager copies them into managed storage and deduplicates by content hash. Sort and filter by any column. Select multiple tracks with click, Shift+click, Ctrl+click, or Ctrl+A.

**Advanced search** — Type a query into the search bar to filter your library with precision. Filters can be stacked with `AND`:

```
GENRE is Psytrance AND BPM IN RANGE 140-145
KEY matches 8A AND BPM > 130
ARTIST contains Burial AND YEAR > 2010
TITLE contains intro AND LOUDNESS > -10
```

Supported fields: `TITLE`, `ARTIST`, `ALBUM`, `GENRE`, `BPM`, `KEY`, `YEAR`, `LOUDNESS`.
Supported operators vary by field — `is`, `is not`, `contains`, `in range`, `>`, `<` for numbers; `is`, `matches`, `adjacent`, `mode switch` for keys (Camelot notation: `8A`, `8B`, etc.).
The search bar shows field and operator suggestions as you type, and completed filters appear as removable chips above the track list.

**Analysis** — Every track is analysed automatically on import for BPM, musical key (Camelot notation), loudness (LUFS), replay gain, and intro/outro markers. Right-click any track to re-analyse, or halve/double the detected BPM if the analyzer picked the wrong grid.

**Find Similar** — Right-click a track to find others with a matching or adjacent Camelot key, or within a close BPM range. Results are applied as a live search filter.

**Playlists** — Create colour-coded playlists in the sidebar, drag tracks in from the library, reorder by drag-and-drop, and sort by any column. Track count and total duration are shown at all times. Exporting a playlist to M3U is one click.

**Player** — Full playback with seekbar, shuffle, repeat, previous/next, and hardware media key support. Intro and outro zones are shown visually on the seekbar so you know exactly when to mix. Double-click any track to play.

**Settings** — Move your library to any location, including an external drive. Update FFmpeg and the audio analyser in-app without reinstalling. Clear the track library, all playlists, or all user data from the Advanced tab.

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

Upcoming work is tracked on the [**Issues**](https://github.com/Radexito/djman/issues) page.

---

## How files are stored

Audio is stored at `~/.config/djman/audio/<xx>/<hash>.<ext>` (configurable via Settings → Library). The two-character hash prefix keeps directory sizes manageable. Playlists reference tracks by ID — no duplicates, no copies.

Logs are written daily to `~/.config/djman/logs/app-YYYY-MM-DD.log`.
