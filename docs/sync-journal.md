# Sync journal, lock and staging

Every medium this application exports to gets a hidden `.djmanager/` folder at its
root. It holds everything needed to explain and finish a sync from the stick
alone, without the application's database.

```
.djmanager/
  sync.lock                     one writer, with its owner recorded
  journal/<jobId>.jsonl         append-only history of one job
  staging/<jobId>/...           new files, before they are published
  generations/<jobId>/...       the files this job replaced
```

Nothing under `.djmanager/` is read by a CDJ. Deleting it costs the ability to
explain the next sync and the previous generation kept for a rollback; no audio,
database or playlist file is affected.

## Phases

A job moves through `plan`, `copy`, `analysis`, `database`, `publish` and `done`.
Progress is reported per phase. Cancellation is checked between phases and
between files, and is refused once `publish` starts: a rename set that stops half
way is the one state no journal can make safe.

## Journal events

One JSON object per line, written with `fsync` before the caller continues. A
half-written last line is discarded on read, which is exactly the event that was
still in flight.

| event              | written when                                      | fields                                                          |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------------- |
| `job-start`        | the lock was taken                                | `trigger`, `fingerprint`, `pid`, `host`, `tookOver`, `previous` |
| `phase`            | a phase begins                                    | `phase`, `pct`, optional `msg`                                  |
| `cancel-requested` | a stop was accepted                               | `phase`                                                         |
| `staged`           | a file is complete in staging                     | `relPath`, `size`, `sha256`                                     |
| `verified`         | the staged file passed its check                  | `relPath`, `sha256`, `size`                                     |
| `publishing`       | the target is about to be replaced                | `relPath`, `sha256`                                             |
| `backup`           | the current target was copied to the generation   | `relPath`, `backup`, `size`                                     |
| `published`        | the rename landed                                 | `relPath`, `sha256`, `size`, optional `recovered`               |
| `restored`         | a crash was rolled back from the generation       | `relPath`, `from`                                               |
| `recovered-absent` | a published file had neither target nor backup    | `relPath`                                                       |
| `artifact`         | an audio or playlist file was moved into place    | `relPath`, `size`                                               |
| `committed`        | the job is finished                               | `fingerprint`, `summary`                                        |
| `failed`           | the job stopped with an error                     | `code`, `message`                                               |
| `abandoned`        | a later job settled a journal that never finished | `reason`, `pending`                                             |

Every entry also carries `seq` (per job, starting at 1), `at` (epoch ms) and
`jobId`. Paths are relative to the mount point and always use forward slashes, so
one journal reads the same on Windows and Linux.

## Publication order

For every file the players read (`export.pdb` and, when those features land,
`exportExt.pdb` and `exportLibrary.db`):

1. the file is written under `staging/<jobId>/` and marked `staged`;
2. its size and SHA-256 are checked against what was staged, and a reader runs
   over it (`export.pdb` is parsed with the same reader the exporter uses). A
   failure marks the job `failed` and nothing on the medium changes;
3. the file already at the target is copied to `generations/<jobId>/`, marked
   `backup`;
4. the staged file is renamed over the target, marked `published`. A rename on
   one filesystem is atomic: a reader sees the old file or the new one.

The target is never opened for writing. The previous generation is kept until
the journal records `committed`.

Audio files and playlist files go through staging too, but they are moved with
`artifact` rather than `published`: they are regenerable, so recovery does not
restore an older track over a newer one.

## What a later job does with an unfinished journal

A job that starts on a medium first settles every journal that never reached a
terminal event:

- for each `publishing` line with no matching `published`: if the target already
  carries the recorded digest, the rename landed before the crash and the line is
  written as `published` with `recovered: true`;
- if the target is missing or different, the generation the same job kept is
  copied back and the line is written as `restored`;
- if there is neither target nor backup, `recovered-absent` is written;
- the journal is closed with `abandoned`, and its staging folder is removed.

Then the new job runs. Nothing is guessed: each decision is made from the digest
recorded before the rename.

## Lock

`.djmanager/sync.lock` is created with an exclusive create and replaced through a
temporary file. It names `jobId`, `pid`, `host`, `trigger`, `phase`, `startedAt`
and `heartbeatAt`. The heartbeat is refreshed on every phase.

A record is stale when its heartbeat is older than 120 seconds, or when it comes
from this host and the pid is gone. Taking over a stale record writes a fresh one
and re-reads it, so two contenders cannot both believe they won. A refusal names
the holder: host, pid, job and phase.

## Automatic sync

The engine polls removable media every 15 seconds. A medium is considered only
when it carries `PIONEER/rekordbox/export-manifest.json`, which means this
application exported to it before. The scope of an automatic sync is the set of
playlists the manifest already lists, so it never invents a selection.

It compares the fingerprint of what would be exported against the `fingerprint`
of the last `committed` journal. If they match, no job starts and nothing is
written to the medium, not even a lock file. If they differ, the fingerprint must
stay unchanged for a debounce window (3 seconds) before the job starts.

Automatic sync does not start while an import or an analysis run is writing the
library, and it does not start while another sync job is running.

## Not covered here

- Selective sync, previews and removal through a device trash belong to issue #14.
- Per-track revisions, a device identity that survives a remount and manifest v2
  belong to issue #12. The scope above is deliberately read from the current
  manifest rather than a new model.
- There is no eject action in the application yet. The engine reports
  `canEject: false` while publishing, so a future eject path has one check to
  call and no excuse to skip it.
