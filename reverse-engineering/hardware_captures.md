# Hardware Captures

All captures in this file require a **CDJ-2000NXS2 or CDJ-3000**.

Read `CAPTURE_GUIDE.md` first — it covers the per-capture file checklist and
the diff workflow.

---

## Before you start

You will receive a USB drive pre-loaded by the person running
`software_captures.md`. **Do not reformat or re-export anything to that USB.**
The USB already contains 3 analyzed tracks exported from Rekordbox and an
`export.pdb` baseline saved as `captures/100-history-empty/export.pdb` on
the computer. Your job is to play the tracks on the CDJ and then hand the USB
back so the post-playback `export.pdb` can be compared against the baseline.

---

## 101 — History After Playback

**Goal:** Capture the `export.pdb` after the CDJ has written playback history
to the USB on eject. This lets us diff the HistoryPlaylists and HistoryEntries
row formats against the pre-playback baseline from capture 100.

**Tracks on the USB:**

- `track-normal.mp3`
- `track-160bpm.mp3`
- `track-190bpm.mp3`

**Steps:**

1. Insert the USB into the CDJ-2000NXS2 or CDJ-3000.
2. Browse to the USB on the CDJ and load `track-normal.mp3` into a deck.
3. Play it for at least 30 seconds, then let it play to the end (or skip to
   the end). The CDJ must register it as played.
4. Repeat for `track-160bpm.mp3` and `track-190bpm.mp3`.
5. **Eject the USB using the CDJ eject button** — do not pull it out while the
   CDJ is on. The CDJ writes history data to `export.pdb` on safe eject.
6. Copy `export.pdb` from the USB root into `captures/101-history-played/`.

**Copy from USB:**

```
export.pdb   →   captures/101-history-played/export.pdb
```

Return the USB and the `captures/101-history-played/` folder to the person
running the software captures so they can run the diff:

```bash
cmp -l captures/100-history-empty/export.pdb \
       captures/101-history-played/export.pdb | head -60
```
