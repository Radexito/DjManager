# Artwork on a Pioneer medium

Covers are the part of an export a deck shows and a file listing cannot verify:
the PDB points at a path, and a missing file simply does not load.

Everything below was measured on a live export from rekordbox 7.2.19
(2026-11-22), not inferred from a format document.

## What a rekordbox export contains

```
PIONEER/Artwork/00001/a1.jpg     80x80
PIONEER/Artwork/00001/a1_m.jpg   240x240
```

- The PDB references the 80 px file, not the 240 px one:

  ```
  artwork row: id=1, path='/PIONEER/Artwork/00001/a1.jpg'
  track:       artwork_id=1
  ```

- `a<id>.jpg` is the 80x80 rendition and `a<id>_m.jpg` is the 240x240 one. That
  is the opposite of what the names suggest, and it matches the renditions
  rekordbox keeps in its own share folder: `artwork_s.jpg` (80x80) and
  `artwork_m.jpg` (240x240).
- Sources larger than that are scaled down and centre-cropped to a square: the
  exported track carried a 1500x1500 cover and the medium got 80 and 240.
- A folder holds twenty covers: a rekordbox-prepared stick seen in the field has
  `00001` with a1..a19, `00002` with a20..a39 and `00003` starting at a40. The
  boundaries fall on multiples of twenty, so the folder of an id is
  `floor(id / 20) + 1` and the first folder holds one fewer.
- The same export also wrote `b1.jpg` and `b1_m.jpg`, byte-identical to the `a`
  pair, with no row in the PDB pointing at them. We do not write `b`.
- Re-exporting a track does not necessarily rewrite its artwork files:
  rekordbox reused a pair whose timestamps predated the export. Our writer
  overwrites both files every time, which is harmless.

An older public fixture (`fragmede/rekordbox-pdb`, one song) stores the path as
`/.PIONEER/Artwork/00001/a1.jpg`, with a dot. rekordbox 7.2.19 does not write
that dot, so neither do we.

## What the writer does

- `planArtwork(tracks, { previous })` gives every distinct `artwork_path` one id;
  tracks that share a cover share an id. `previous` is the set of track rows the
  manifest carried, and their `artwork_id` is the record of what was already
  handed out: the same source keeps its number, a source seen for the first time
  gets a number above every recorded one, and a retired cover's number stays
  unused instead of being reused by a different file. A deck caches a cover by
  this number, so renumbering by position is what makes a cover show up wrong or
  blank after an unrelated track leaves the set.
- `artwork_id` is written on the track row in the manifest at every export, and
  `artwork_path` is part of the export fingerprint, so adding or changing a cover
  makes an automatic sync start a job instead of deciding there is nothing to do.
- The manifest also records `artwork_source_hash`, the digest of the cover file
  that produced the pair. On the next export a cover whose source still has that
  digest, and whose `a<id>.jpg` and `a<id>_m.jpg` are already on the medium as
  JPEG, is not encoded again and not written over. Encoding costs two ffmpeg runs
  per cover, which is most of what a second export of the same library spends its
  time on; a cover that changed content under the same path is encoded again.
- The cover is detected by its first bytes, not its extension: a PNG saved as
  `.jpg` is common (artwork fetched from the web keeps its content type) and a
  FLAC picture is often PNG too.
- Every cover goes through ffmpeg to the two sizes, 80 and 240, square. Both
  outputs are checked for the JPEG signature; a cover that cannot be turned into
  JPEG is reported and left out of the PDB, so the deck never sees a row that
  points at nothing.
- Without a decoder, a JPEG is copied at its own size (the deck scales it; the
  sizes just do not match rekordbox's) and a PNG is skipped.
- Covers are written into staging before the PDB, and published with the rest of
  the export.

## Not verified

No CDJ has displayed one of these covers yet. The path and the two sizes now
match a real rekordbox export byte for byte, which is as far as a machine can
take this.
