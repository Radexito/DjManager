# DJ Manager

A DJ-focused music library manager built with Electron. Manage your tracks, analyze BPM and key, export to Pioneer CDJ USB drives, and download from streaming platforms — all in one offline-first desktop app.

![DJ Manager screenshot](screenshot.png)

---

## Features

- **Library management** — import audio files with full metadata (BPM, key, loudness, year, label, genre, ISRC). SHA-1 deduplication prevents duplicate imports.
- **Auto-analysis** — BPM, key, loudness, intro/outro detection via mixxx-analyzer, waveform generation via FFmpeg. Runs in background worker threads.
- **Rekordbox USB export** — full Pioneer CDJ-compatible export: ANLZ waveform/beatgrid files, PDB database, and SETTING.DAT files. Plug the USB into any CDJ and it just works.
- **yt-dlp download** — paste any YouTube, SoundCloud, Bandcamp, or 1000+ supported URL. Preview playlist tracks, select a subset, and import directly to your library.
- **TIDAL download** — download tracks, albums, playlists, and mixes at up to HiRes Lossless via [tidal-dl-ng](https://github.com/Radexito/tidal-dl-ng-For-DJ). Requires `pip install tidal-dl-ng`.
- **Auto-tagging** — search MusicBrainz, Discogs, iTunes, and Deezer to fill in missing metadata and fetch cover art.
- **Advanced search** — field-qualified queries directly in the search bar: `BPM >= 128 AND KEY:8A GENRE is Techno`.
- **Playlist management** — create playlists, drag-and-drop reorder, export as M3U.

## Download

Pre-built releases are available on the [GitHub Releases](https://github.com/Radexito/DjManager/releases) page.

| Platform | Format              |
| -------- | ------------------- |
| Linux    | AppImage (x64)      |
| macOS    | dmg (Apple Silicon) |
| Windows  | NSIS installer      |

On first launch, FFmpeg and the mixxx-analyzer binary are downloaded automatically.

## Development

```bash
# Install dependencies
npm install
cd renderer && npm install && cd ..

# Start dev server (Vite + Electron)
npm run dev

# Lint
npm run lint:all

# Format
npm run format

# Run tests
npm test                    # main process (Vitest)
cd renderer && npm test     # renderer (React Testing Library)

# Build distributable
npm run dist:linux          # or :mac / :win
```

> **Note:** Close the Electron app before running `npm test` — the pretest step rebuilds `better-sqlite3` for Node.js and will fail if Electron holds the binary open.

## Tech stack

- **Electron** + **React 19** + **Vite**
- **better-sqlite3** — synchronous SQLite for the track/playlist database
- **mixxx-analyzer** — BPM, key, loudness, beatgrid analysis
- **FFmpeg** — audio decode, waveform generation, format conversion
- **yt-dlp** — streaming download backend
- **tidal-dl-ng** — TIDAL download backend (optional, user-installed)
- **@dnd-kit** — drag-and-drop playlist reordering
- **react-window** — virtualized track list

## License

MIT © [Radexito](https://github.com/Radexito)
