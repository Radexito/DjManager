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
