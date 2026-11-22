# Device library (`exportLibrary.db`)

rekordbox writes a second database next to `export.pdb`, at
`PIONEER/rekordbox/exportLibrary.db`. A player reads the PDB; rekordbox reads
this file to show the stick as a device library with metadata, playlists and
My Tags. Without it, rekordbox rebuilds its own view and the two disagree.

## Encryption

The file is SQLCipher 4 with **default** parameters, contrary to the older note
in `protocol_rekordbox.md`:

- page size 4096, HMAC-SHA512, PBKDF2-HMAC-SHA512, 256000 iterations
- the first 16 bytes are the salt, not `SQLite format 3`
- the key is a 64-character constant of the format: the same key opens an export
  from April 2026 and one from November 2026

`better-sqlite3-multiple-ciphers` opens it with `cipher='sqlcipher'`,
`legacy=4`, then `key='…'`. The package is N-API (`NAPI_VERSION=10`) and ships
prebuilds for linux/darwin/win32 x64 and arm64, so no compiler is needed and the
same binary works under Electron.

On a machine without a C++ toolchain, install with `npm install --ignore-scripts`
(or `npm ci --ignore-scripts`): the package ships the prebuilds, but npm still
tries `node-gyp` because `binding.gyp` is present. CI has a compiler and builds
it normally.

**The key is not in this repository.** `resolveLibraryKey()` reads
`REKORDBOX_LIBRARY_KEY` or the `rekordbox_library_key` setting. Without a key the
feature stays off and the export is the same as before.

## What the writer produces

`writeLibrary()` creates the 22 tables rekordbox creates, fills the four UI
dictionaries (`category` 22, `color` 8, `menuItem` 27, `sort` 17), then writes:

- `artist` and `key`, deduplicated from the export's rows
- `content`, one row per track, with the fields the PDB also carries: title,
  `bpmx100`, length in seconds, path on the medium, file name, file type code,
  bitrate in kbit/s, bit depth, sample rate, rating (0..5), year, the ANLZ path
- `playlist` and `playlist_content`, membership limited to tracks that are on
  the medium

Fields that only rekordbox's master library can supply are written as zero:
`masterDbId`, `masterContentId`, `contentLink`. `fileSize` is zero, which is what
a native export writes too.

My Tags are **not** invented. `writeLibrary()` takes `myTags` from the caller and
writes an empty tree when it has none, because the application has no tag model
yet. The default tree a user builds in rekordbox is their data and must not be
shipped with the code.

## Consistency check

`checkConsistency()` compares the library's content and playlist counts with the
counts of the PDB that was published. A mismatch means the two databases disagree
about the medium, which is the failure #10 describes.

## Still open

- `exportExt.pdb` (the tag dictionary the players read) needs the My Tags model
  first, and a `property` row in `export.pdb` that points at it.
- Cue and history rows are empty in a native export as well; they live in the
  ANLZ files and are not part of this writer.
- The writer runs in the pipeline behind the `export_onelibrary` setting plus a
  key. It is staged and published with the PDB, and publication fails if the
  consistency check disagrees. The setting is off by default until a rekordbox
  round trip confirms the file.
- rekordbox has not been asked to open a generated library yet; the file was
  verified with rekordbox's own `sqlite3.dll`, which reads 22 tables and the
  expected rows.
