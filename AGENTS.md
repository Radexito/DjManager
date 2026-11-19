# AGENTS.md

Guidance for coding agents working in this repository. Facts here are meant to be
checked against the code, not assumed: every claim below was measured on `dev`
after the `src/main.js` refactor (2026-11-04).

## Test projects

`vitest.config.js` declares three projects. The `include` lists are explicit, so a
new test file is **not** picked up by a glob: add it to the right project or it
silently never runs (this already happened twice, with `rendererBridge.test.js`
and `pioneerExportService.test.js`).

| project | needs                                                                       | what it holds                                                         |
| ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `db`    | real SQLite (`DB_PATH=:memory:`) plus `src/__tests__/setup.js` (`initDB()`) | repository tests, `sampleInfo`                                        |
| `main`  | real SQLite plus the same setup file                                        | the contract suite for `src/main.js`                                  |
| `unit`  | nothing                                                                     | everything else, including the IPC modules, services and pure helpers |

## The `main` contract suite

`src/__tests__/main.test.js` imports the real Electron entry point against an
in-memory database and stubs only the OS boundaries (Electron, ffmpeg/ffprobe,
yt-dlp, tidal-dl-ng, dependency downloads, the media-server socket, chokidar, the
PDB/ANLZ/ID3 writers). It asserts channel names, payloads and answer shapes, so a
refactor that changes behaviour turns it red while a refactor that moves code does
not. When a channel moves to a module, the test stays where it is: `main.js`
remains the entry point (`package.json` `main`), and the suite keeps importing it.

Handlers attach their fake renderer through the runtime, not a global:

```js
const main = await import('../main.js');
main.runtime.mainWindow = { webContents: { send: vi.fn() } };
```

## Coverage gate

```bash
npm run test:coverage:main
```

Runs projects `main` and `unit` over `src/main.js` **and** `src/main/**/*.js`
(IPC modules, services, runtime, renderer bridge, graphics) with thresholds
80 statements / 60 branches / 80 functions / 80 lines. The tree scope matters:
after the refactor the entry file holds bootstrap only, and measuring it alone
reported 66% while the code that moved out sat at 90%+.

Measured on `dev` (2026-11-04): 88.41 / 72.99 / 82.93 / 90.76.

The `pre`/`post` hooks rebuild `better-sqlite3` for Node and then back for
Electron. The Electron app must be closed while that runs, otherwise the rebuild
fails on a file held open (EBUSY).

## IPC answer contract

Every channel in `src/main/ipc/` registers through `handle()` from
`src/main/ipc/response.js`:

- success: `{ ok: true, ...payload }` (a handler that returns nothing answers `{ ok: true }`)
- failure: `{ ok: false, code, error, message }`, where `code` is the machine value,
  `error` is kept as an alias so older callers that read `.error` keep working,
  and `message` is for humans
- a thrown `AppError` keeps its own `code`; anything else becomes `internal`

One consequence worth remembering: `undefined` becomes `{ ok: true }`, so a getter
must answer `null` for "not found" (`get-playlist`, `get-setting` do). The wrapper
is async for every channel, which means a unit test awaits the handler even when
the handler itself is synchronous.

## README screenshots

The README images are generated from a throwaway library, never from a real one:

```bash
node scripts/demo-library.mjs        # synthetic audio, covers, waveforms, invented metadata
node scripts/readme-screenshots.mjs  # writes docs/screenshots/library.png and prepare-track.png
```

`scripts/demo-library.mjs` downloads the public 8-Bit No Copyright Music playlist with yt-dlp,
runs the app's own analyzer and waveform generator over it, and adds eight synthetic tracks around
140 BPM/8A so harmonic filtering has something to show. Cover art is CC0/public domain from Openverse.
`scripts/readme-screenshots.mjs` launches the built app against that library and writes:

- `library.png` and `ytdlp.png` (the playlist fetch, with exactly two tracks ticked),
- `prepare-track.gif` (seek to 42%, play, pause, drag the waveform until a bar line sits under the
  playhead, add a hot cue, apply),
- `find-similar.gif` (right-click, hover the submenu, take the combined key + tempo query, drop the
  key chip: five rows become nine),

It verifies each step: rows and covers rendered, playback started mid-track, the cue lands within a
few milliseconds of a beatgrid beat (checked in the database after the run), and the key filter
changes the result count. A demo cursor is injected into the page, because Electron does not draw
the system pointer into screenshots.
The YT-DLP screenshot needs a `yt-dlp` binary in `<tmpdir>/djman-demo/userdata/bin`; the app installs
one on a normal first run. Rebuild the renderer first (`npm run build-renderer`) so the screenshots
match the code.
