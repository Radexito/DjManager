# What an export writes, and what it no longer writes

Reported in #18: "The verify job, once the export is done is very I/O intensive on the USB stick, so
additional delays are added. The more songs are exported, the longer the delays." The delay grew with
the track count because of repeated work, not because of the audio copy. This file records what was
made skippable and what is still left on the medium (#44).

## Skipping a file whose output cannot have changed

Both skips are content decisions recorded in the manifest, not timestamp guesses.

**ANLZ.** The manifest keeps `anlz_digest` per track: a digest of everything `writeAnlz` reads, which
is the beat grid, the offset, the tempo, the cue signature, the source path and the path on the
medium, plus a writer version constant. On the next export a track whose digest is unchanged and whose
`ANLZ0000.DAT` and `ANLZ0000.EXT` are still on the medium is not written again, which also skips the
ffmpeg pass that cuts the waveform. A track whose digest changed, or whose file was removed, is written
again. A write that fails records no digest, so the next export retries instead of remembering a
failure as success.

**Covers.** The same idea with `artwork_source_hash`, described in `docs/artwork.md`.

The export summary reports `anlzWrittenCount`, `anlzSkippedCount`, `coverCount` and
`coverWrittenCount`, so "planned" and "actually encoded" can be compared without reading the manifest.

## Verifying what lands without reading it twice

`publishStaged` used to read every staged file completely to hash it, and read it a second time before
publishing. Now it stats the staged file, then copies it to a temporary name beside the target while
computing the digest of the bytes as they are written. The digest is compared with the one the writer
promised; only then is the temporary file renamed over the target. What lands is exactly what was
verified, the target never shows a partial file, and the medium is read once per published file
instead of twice.

The journal records the digest that actually landed, not the one that was expected.

## What is still on the medium

Staging (`.djmanager/staging/<jobId>/`) and the previous generation
(`.djmanager/generations/<jobId>/`) still live on the stick, so publishing audio is a rename rather
than a copy. Moving them to local disk would remove the staging write and the generation copy from the
medium, at the price of a copy for every published file, and it changes where crash recovery has to
look. That is its own change, tracked separately.

## Not covered here

No timing comparison on a real stick. The counts above are asserted in tests; the seconds are not.
