# Noticing a USB medium while the application runs

The sidebar is meant to show a stick when it is plugged in and to drop it when it
is removed, without a manual refresh. Two settings control that, and both are
plain settings rows, so they can be changed without a rebuild.

| setting             | default | meaning                                                                                                                                   |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `usb_watch_enabled` | `1`     | `0` turns the whole watcher off: nothing is polled and the device list is reported empty                                                  |
| `usb_watch_roots`   | empty   | directories to watch. Empty means the platform defaults below. Accepts a JSON array or a list separated by commas, semicolons or newlines |

## Platform defaults

Taken from `src/usb/generic/roots.js`:

| platform | watched                                                |
| -------- | ------------------------------------------------------ |
| Linux    | `/run/media/<user>`, `/media/<user>`, `/media`, `/mnt` |
| macOS    | `/Volumes`                                             |
| Windows  | drive letters from `D:\` to `Z:\`                      |

A stick that mounts somewhere else is a case for `usb_watch_roots`: point it at
the folder the stick appears in, for example `/srv/sticks`, and it is watched
instead of the defaults.

## What counts as a medium

A directory directly under a watch root counts when it carries a `PIONEER`
folder. That covers both sticks this application exported to and sticks
rekordbox prepared, and it keeps a plain external disk out of the list.

## How it reaches the renderer

`get-usb-devices` returns the current list and starts the watcher on first call,
so an application that never shows the list never polls. After that, every
change is pushed as `usb-devices-changed` with the same list. The list is
`[{ mount, name }]`, sorted by mount point.

The watcher polls one directory read per root every four seconds and compares
only the mount points, not the contents, so an export running in the background
does not look like a device change. Changing either setting restarts it.

## What the sidebar shows

A detected medium appears as its own collapsible entry below the playlists. Expanding it reads the
medium, not our records of it:

- **Library** with the number of tracks the database carries.
- **Playlists** with their track counts.
- **The tag tree** with the number of tags per category; the category line names them on hover.

Clicking Library or a playlist opens it in the main area, drawn with the same table the library and
playlist tabs use: the same column definitions, the same cell rendering, the same row styles. It is a
read-only view, since the tracks belong to the medium, so the play button, drag and rating changes are
not wired; the header carries the mount point and a "read only" note. The table cannot reuse their data
path either, because that path reads this application's library database while a medium answers from its
own `export.pdb`; the rows therefore arrive mapped, but they are drawn by the same code.

The tree itself never lists tracks: it is the structure of the medium, not a second table. The section
lives inside the scrollable playlist area, so every line stays reachable however long the playlist list
is.

The data comes from `PIONEER/rekordbox/export.pdb` and `exportExt.pdb` (`src/usb/pioneer/contents.js`),
so a stick rekordbox prepared shows exactly the same way as one this application wrote. The manifest is
only used to say whether the stick is ours. Nothing in the section writes to the medium.

## Tags

The tag tree comes from `exportExt.pdb`, table 3. Two things are worth knowing.

Rows are keyed by id, and an export that ran more than once can leave the same row in the file several
times: one measured medium carried 75 tag rows for 28 distinct tags and listed every category three
times. The reader keeps the first row per id, so the tree is the size of the tag set rather than of the
file. That is a read-side guard; the writing side still has to stop duplicating rows (see #62).

Table 4 holds the "this tag belongs to this track" rows, `0, track id, tag id, 3`. They are read, but a
row is only turned into a track when the id it names is a track of that same medium. On the measured
stick, 18 of them named ids 10 to 16 while the medium carried ids 1 to 9, so nothing was shown: a tag
whose assignments do not resolve is listed with its name only, and clicking it opens an empty list with
an explanation instead of a list of the wrong tracks.

## The medium is a source of the library view

There is no separate view. `MusicLibrary.jsx` takes a `usbSource` (`{ mount, playlistId, tagId }`) and,
when it is set, reads the medium instead of the library database: the search box, the sortable header,
the rows, the row heights, the selection and the player are the ones the music and playlist tabs use,
because it is the same component. Rows come from `readMedium`, the query is applied in memory by
`mediumVisible` with the same parser the table uses for the database, and sorting happens on the same
sort state the header writes, so a click on a column header sorts a medium the way it sorts the library.

Playing needs one thing outside the renderer: the media server only serves files under a base it knows.
Opening a medium puts its mount point on that list (`allowExplorerBase`), which is what turns
`http://127.0.0.1:<port>/D%3A/Contents/<file>` from a 404 the audio element reports as
"no supported source" into the file itself.

The row menu for a medium offers Play and Copy file path and says so, because the library actions address
tracks by this application's ids: re-analysing or adding to a playlist from a medium's row would act on an
unrelated library track.

