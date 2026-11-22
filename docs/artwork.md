# Artwork on a Pioneer medium

Covers are the part of an export a deck shows and a file listing cannot verify:
the PDB points at a path, and a missing file simply does not load. This is what
rekordbox writes, measured on a real `export.pdb` (one song, one cover) and
cross-checked with an independent parser.

## Where the files live

```
PIONEER/Artwork/00001/a1.jpg      large cover (the library's own image)
PIONEER/Artwork/00001/a1_m.jpg    small copy the lists use
```

The folder is five digits and holds a thousand covers: ids 1–1000 are in
`00001`, 1001–2000 in `00002`. The large file is the one the database names;
`_m` is a naming convention the player follows on its own, so both have to be
written even though only one path is stored.

Only JPEG is written. A PNG or TIFF cover from the library is converted first,
because a deck does not decode PNG. When no decoder is available the cover is
skipped rather than published as a file the player cannot show.

## What the database says

Table 13 (`artwork paths`) holds one row per cover:

| offset | type             | field      |
| ------ | ---------------- | ---------- |
| 0x00   | u32              | artwork id |
| 0x04   | DeviceSQL string | path       |

The path is absolute from the medium root and keeps the leading `/.`:

```
/.PIONEER/Artwork/00001/a1.jpg
```

Track rows point at it through `artwork_id` at offset `0x1c`; `0` means no
cover. Tracks that share a cover share the id, so a hundred tracks from one
album produce a single row and a single pair of files.

## What we write

- `planArtwork(tracks)` numbers the distinct `artwork_path` values in
  first-seen order and returns `id`, `sourcePath`, `pdbPath`, `relPath`.
- `buildPdbBuffer` writes the table 13 rows and stamps `artwork_id` into every
  track row.
- `writeArtworkFiles(root, plan)` copies or converts the covers into
  `PIONEER/Artwork/<folder>/` and derives the `_m` twin with ffmpeg
  (`scale=200:200`, aspect preserved). The reference export only proves the
  `_m` _name_, not its size; 200 px is our choice, to be confirmed on a deck.
- The sync runner writes them into staging and publishes them with the rest of
  the export, so a half-written cover never reaches the medium.

## Verification

`pdbArtwork.test.js` round-trips a generated file through `readLibrary`; the
same file was read by the independent `fragmede/rekordbox-pdb` parser, which
reported `artwork: [(1, '/.PIONEER/Artwork/00001/a1.jpg')]` and the expected
per-track ids. That parser's test data includes a real rekordbox export with
artwork and is the cheapest source of truth for this format:

```
git clone https://github.com/fragmede/rekordbox-pdb
PYTHONPATH=src python3 -m rekordbox_pdb tests/data/one-song-export.pdb
```
