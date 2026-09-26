# Pioneer DeviceSQL PDB: exportExt.pdb spec + DjManager export.pdb differential

Status: COMPLETE. All four requested deliverables are in this file:
(1) exportExt.pdb byte-level spec + decoded example rows + agreement verdict -> section 1;
(2) ours vs rekordbox export.pdb differential -> section 2;
(3) player-visible differences with offsets -> section 3;
(4) the two extra checks: empty_candidate/columns tables -> section 2.2-2.4, track-row
byte 92 file type -> section 4.

Tools written for this analysis (read-only use of the repo, all output under /tmp/pdb/):
`pdb_parse.py` (parser; fixed in this pass: it now walks `num_row_offsets` slots instead of
`num_rows` and honours the row-presence bitmask, which is required for rekordbox-written
files that contain stale slots), `rowdump.py`, `tags.py`. Raw logs: out_tags_our.txt,
out_tags_shimi.txt, out_tables.txt, out_empty.txt, out_diff.txt, out_scan.txt,
out_author.txt, out_ftype.txt.

Machine: Arch Linux, python3 3.11 (no pip, uv available). Work read-only; all output under /tmp/pdb/.
No repo file was edited.

## Files under analysis

| role | path | size |
|---|---|---|
| our output | /tmp/pdb/export.pdb | 163840 B |
| rekordbox/device output | /tmp/anlz-gt/shimi_rekordbox/export.pdb | 167936 B |
| our tags ground truth (rekordbox) | /tmp/pdb/exportExt.pdb | 73728 B |
| rekordbox/device tags | /tmp/anlz-gt/shimi_rekordbox/exportExt.pdb | 81920 B |
| rex test data (3rd party) | /tmp/pdb/pristine.pdb | 167936 B |
| our writer | /tmp/djm-517/src/usb/pdbWriter.js | - |

## Method

- Parser reused and improved from /tmp/pdb/pdb_parse.py (file header, 16-byte table
  pointers at offset 28, 32-byte page header, 8-byte data header, rows from offset 40,
  reversed rowsets at end of page, DeviceSQL strings with u16 row-relative offsets).
- All offsets quoted below are absolute byte offsets in the file named.

---

## 1. exportExt.pdb byte-level specification

Two rekordbox/player-written files analysed: `/tmp/pdb/exportExt.pdb` ("ours/user stick",
73728 B) and `/tmp/anlz-gt/shimi_rekordbox/exportExt.pdb` ("shimi", 81920 B).

### 1.1 File header (bytes 0x00-0x1b) + table pointers (0x1c-0xab)

All multibyte values little-endian. Same layout as export.pdb; only `num_tables` differs.

| offset | size | field | ours | shimi |
|---|---|---|---|---|
| 0x00 | 4 | Magic (four zero bytes) | 0x00000000 | 0x00000000 |
| 0x04 | 4 | LenPage | 4096 | 4096 |
| 0x08 | 4 | NumTables | **9** | **9** |
| 0x0c | 4 | NextUnusedPage | 21 | 22 |
| 0x10 | 4 | Unknown1 (u32@16) | 5 | 1 |
| 0x14 | 4 | SeqDb | 8 | 18 |
| 0x18 | 4 | Gap (zeros, part of SeqDb as u64) | 0 | 0 |
| 0x1c | 9x16 | table pointers (Type, EmptyCandidate, FirstPage, LastPage) | see 1.2 | see 1.2 |

Raw header bytes, ours: `00000000 00100000 09000000 15000000 05000000 08000000 00000000`
Raw header bytes, shimi: `00000000 00100000 09000000 16000000 01000000 12000000 00000000`

### 1.2 Table list (identical type set in both files)

| ptr offset | type | empty_candidate | first | last | ours chain | shimi chain |
|---|---|---|---|---|---|---|
| 0x1c | 0 | 2 | 1 | 1 | [1] index only | [1] index only |
| 0x2c | 1 | 4 | 3 | 3 | [3] index only | [3] index only |
| 0x3c | 2 | 6 | 5 | 5 | [5] index only | [5] index only |
| 0x4c | 3 | 20 | 7 | 8 | [7,8] index + 1 data, **28 rows** | [7,8] index + 1 data, **28 rows** |
| 0x5c | 4 | 10 | 9 | 9 | [9] index only | [9] index only |
| 0x6c | 5 | 12 | 11 | 11 | [11] index only | [11] index only |
| 0x7c | 6 | 14 | 13 | 13 | [13] index only | [13] index only |
| 0x8c | 7 | **19** | 15 | **16** | [15,16] index + 1 data, **1 row** | empty_c=**21**, first 15, last **19**, chain [15,16,19]: index + 1 stale data page (0 live rows) + 1 live data page |
| 0x9c | 8 | 18 | 17 | 17 | [17] index only | [17] index only |

So the two files contain exactly the same 9 tables, and only two of them hold data:
`type 3 = tags` (28 rows, documented) and `type 7` (1 row, purpose not identified).
Every other table is an index page (flags 0x64) with no rows.
**Type 4 is empty in both files**, i.e. the table that the public documentation places
tag_tracks in contains no rows here (see 1.5).

Page header (32 B) for the tags data page:

| | ours page 8 | shimi page 8 |
|---|---|---|
| Magic u32@0 | 0 | 0 |
| PageIndex u32@4 | 8 | 8 |
| Type u32@8 | 3 | 3 |
| NextPage u32@12 | 20 (= empty candidate) | 20 (= empty candidate) |
| SeqPage u32@16 | 7 | 2 |
| Unknown2 u32@20 | 0 | 0 |
| u24@24: low 13 = num_row_offsets, high 11 = num_rows | 0x03801c -> 28 / 28 | 0x03804c -> **76** slots / 28 live |
| PageFlags u8@27 | 0x24 | **0x34** (bit 4 = deleted rows present) |
| FreeSize u16@28 | 2568 | 24 |
| UsedSize u16@30 | 1424 | 3860 |
| data hdr u16x4 @32 | 28, 0, 0, 0 | 28, 0, 0, 0 |

Read this page as: 28 row-offset slots (2 row groups of 16, last group 12 used) in the
ours file; the shimi page has 5 row groups (76 slots ever allocated), of which only
28 slots carry the presence bit - the rest are stale slots from earlier in-place updates.
Rows live from page offset 40 (heap+0); rowset groups are 36 bytes at the end of the page,
offsets u16 reversed within a group, then row presence flags u16 + last-transaction flags u16.

### 1.3 tags row layout (type 3) - verified on all 28 rows in both files

| row offset | size | field | value / meaning |
|---|---|---|---|
| 0x00 | u16 | subtype | 0x0680 = "near" (1-byte string offsets), 0x0684 = "far" (2-byte offsets). All 56 rows in both files are 0x0680 |
| 0x02 | u16 | tag_index | 0, 32, 64, ... = +32 per row, in row order |
| 0x04 | 8 B | unknown | always zero in both files |
| 0x0c | u32 | category | id of the parent category; **0 when this row IS a category** |
| 0x10 | u32 | category_pos | 0-based position inside the category; for a category row, its own position in the category list |
| 0x14 | u32 | id | 1..4 for the four categories, otherwise a large pseudo-random u32 (per database) |
| 0x18 | 4 B | raw_is_category | `00 00 00 00` = tag, `00 00 00 01` = category (non-zero) |
| 0x1c | u8 | constant 3 | the "3" that precedes string offsets in every string-bearing row |
| 0x1d | u8 | ofs_name | offset of the name string, relative to the row start (near variant) |
| 0x1e | u8 | ofs_unknown | offset of a second string, always the 1-byte empty string 0x03 |
| 0x1f | - | name string | DeviceSQL string; short ASCII = len byte `2*n+3`, long = `0x40`+u16 len+pad |
| - | - | unknown string | 0x03 (empty short string) |
| tail | 8-11 B | zeros | 8 zero bytes + 0-3 zero pad bytes to a 4-byte boundary |

far variant (not present in either file, from the public spec): ofs_name u16 @0x1e,
ofs_unknown u16 @0x20.

**Row length rule (verified exactly on our 28 rows):**
`len = round_up(31 + len(name string) + 1 + 8, 4)` -> observed lengths 48, 52, 56.
In the shimi file three rows are longer than the rule because the row was updated in
place with a shorter name and stale bytes of the previous name remain
(row 2 abs 140: current name "Morning", then stale ASCII "se" at row+40..41, then 0x03;
row 5 abs 292: "Peak Time" then stale "use" then 0x03). Those stale bytes are inside
the allocated row, so a parser must use the index offsets, not the strings, to walk rows.

### 1.4 Decoded example rows

**A. ours `/tmp/pdb/exportExt.pdb`, tags row 0, absolute offset 40, length 48**
(`8006 00000000 00000000 00000000 00000000 01000000 00000001 03 1f 25 0d 47656e7265 03 00*10`)

```
+0x00 u16 = 0x0680  subtype near
+0x02 u16 = 0       tag_index
+0x0c u32 = 0       category  (this row is itself a category)
+0x10 u32 = 0       category_pos 0
+0x14 u32 = 1       id  (first of the four fixed category ids)
+0x18     = 00 00 00 01   raw_is_category (non-zero -> category)
+0x1c     = 03
+0x1d     = 0x1f (31) -> name string at row+31 = 0x0d "Genre"   (0x0d = short, 5 chars)
+0x1e     = 0x25 (37) -> string at row+37 = 0x03 = ""           (empty)
```

**B. ours, tags row 1, absolute offset 88, length 52** - an ordinary tag
(`8006 20000000 ... 01000000 00000000 9041496c 00000000 03 1f 2a 17 416369642048656f757365 03 ...`)

```
+0x02 u16 = 0x0020 (32)   tag_index
+0x0c u32 = 1             category = 1 (belongs to the "Genre" category from A)
+0x10 u32 = 0             category_pos 0 (first tag in that category)
+0x14 u32 = 1816740240    id (0x6C494190) pseudo-random tag id
+0x18     = 00 00 00 00   raw_is_category -> ordinary tag
+0x1d     = 0x1f (31) -> 0x17 = short string, 10 chars -> "Acid House"
+0x1e     = 0x2a (42) -> 0x03 = ""
```

**C. shimi `/tmp/anlz-gt/shimi_rekordbox/exportExt.pdb`, tags row 0, absolute offset 40, length 48**
(`8006 00000000 00000000 03000000 02000000 a10ee16d 00000000 03 1f 26 0f 4c6f756e6765 03 00*10`)

```
+0x02 u16 = 0            tag_index
+0x0c u32 = 3            category = 3
+0x10 u32 = 2            category_pos = 2
+0x14 u32 = 1843465889   id (0x6DE10EA1)
+0x18     = 00 00 00 00  raw_is_category -> ordinary tag
+0x1d     = 0x1f (31) -> 0x0f = short string, 6 chars -> "Lounge"
+0x1e     = 0x26 (38) -> 0x03 = "" (empty)
```

### 1.5 type 07 row (1 row in each file) - observed layout, semantics NOT identified

Page 16 in ours (flags 0x24, 1 live row, UsedSize 60) and page 19 in shimi (same), plus an
older deleted copy on shimi page 16 (num_rows 0, UsedSize 60). Row bytes (ours, abs 40):

```
+0x00 u32 = 0x00000700
+0x04 u32 = 0
+0x08 u32 = 0
+0x0c u32 = 0
+0x10 u32 = 0
+0x14 u32 = 0
+0x18 u32 = 0xBB52C102   <- the only field that differs between the two files
+0x1c u8  = 0x03
+0x1d u8  = 0x22 (34) -> string at row+34 = 0x03 ""
+0x1e u8  = 0x23 (35) -> 0x03 ""
+0x1f u8  = 0x24 (36) -> 0x03 ""
+0x20 u8  = 0x25 (37) -> 0x03 ""
+0x21 u8  = 0x26 (38) -> 0x03 ""
+0x22..0x26 = 03 03 03 03 03   (the five empty strings themselves)
+0x27..0x3b = zero padding to length 60
```

Shimi values of the varying field: page 19 (live) = 0x8A68985A, page 16 (deleted) = 0x00C84A5E.
Everything else is byte-identical between the files. It is rewritten with a new random
value on each write (shimi keeps the previous copy as a deleted row).

Interpretation status: **still unknown**. It is not the documented 16-byte tag_track row
(that row is `u32 zero, u32 track_id, u32 tag_id, 0x03, 3 zero bytes` = 16 bytes, and the
table type that should hold it, type 4, has zero rows in both files). It shares the
trailing shape of a string-bearing row (`... , 0x03, N one-byte string offsets, N strings`),
which is also how tag rows are built, so it is probably a single bookkeeping/root row of
the My Tags store rather than a per-association row. Do not build anything on it yet.

### 1.6 Do the two files agree?

- **Format: yes.** Identical header layout and field values except NextUnusedPage,
  Unknown1 and SeqDb; identical table pointer list except the type-7 entries; identical
  tags row layout (field offsets, widths, the constant 0x03, the near-string scheme,
  the 8-byte zero tail and the 4-byte alignment).
- **Tags content: same 28 rows, same 28 names, same order, different everything else.**
  Verified 1:1 by name: Genre, Acid House, Deep House, Techno, Nu Disco, Electro House,
  Bass Music, Trap, Components, Synth, Vocal, Beat, Sub Bass, Percussion, Piano, Dark,
  Upper, Situation, Main Floor, Second Floor, Lounge, Mid Night, Morning, Build up,
  Peak Time, Build down, Untitled Column, My Comment.
  But the four rows flagged as categories differ (ours: Genre/Components/Situation/
  Untitled Column at category_pos 0..3; shimi: Trap/Components/Upper/Build down at
  category_pos 3/0/1/2), every category assignment differs, and every tag id differs
  (ids are per-database random values; only the four category ids 1..4 are stable).
- **Paging: differs, and the shimi file is the more "used" one.** ours 18 pages /
  next_unused 21 / 28 slots / UsedSize 1424 / flags 0x24; shimi 20 pages / next_unused 22 /
  76 slots / UsedSize 3860 / flags 0x34, with a stale type-7 page kept as a deleted row.
- **Implication for DjManager:** our writer never writes exportExt.pdb at all
  (`exportExt` has 0 hits in the DjManager repo), so sticks we build carry no My Tags
  data; the player shows an empty My Tags list and no tag categories. The format is
  fully specified above and is small: 9 table pointers, 1 index page + 1 data page for
  the tags table, 28 rows of <=56 bytes.


---

## 2. Differential: ours (`/tmp/pdb/export.pdb`) vs rekordbox/device (`/tmp/anlz-gt/shimi_rekordbox/export.pdb`)

### 2.1 File header

| offset | field | ours | rekordbox/device |
|---|---|---|---|
| 0x00 | Magic | 0 | 0 |
| 0x04 | LenPage | 4096 | 4096 |
| 0x08 | NumTables | 20 | 20 |
| 0x0c | NextUnusedPage | 49 | 46 |
| 0x10 | Unknown1 | 5 | 4 |
| 0x14 | SeqDb | 16 | 16 |
| 0x18 | Gap (zeros) | 0 | 0 |
| - | file size / pages | 163840 / 40 | 167936 / 41 |

`/tmp/pdb/pristine.pdb` (rex corpus, 167936 B) shares its table-pointer structure with the
device file (same first/last/empty_candidate for all 20 tables) and also has no tracks.

### 2.2 Table list, page counts, row counts

| type | table | ours: empty_c / first / last / data pages / rows | device: same |
|---|---|---|---|
| 0 | tracks | 41 / 1 / 2 / 1 / **2 rows** | 2 / 1 / 1 / 0 / 0 |
| 1 | genres | 4 / 3 / 3 / 0 / **0** | 4 / 3 / 3 / 0 / 0 |
| 2 | artists | 42 / 5 / 6 / 1 / **1 row** | 6 / 5 / 5 / 0 / 0 |
| 3 | albums | 8 / 7 / 7 / 0 / 0 | 8 / 7 / 7 / 0 / 0 |
| 4 | labels | 10 / 9 / 9 / 0 / 0 | 10 / 9 / 9 / 0 / 0 |
| 5 | keys | 12 / 11 / 11 / 0 / 0 | 12 / 11 / 11 / 0 / 0 |
| 6 | colors | 43 / 13 / 14 / 1 / 8 rows | 42 / 13 / 14 / 1 / 8 rows |
| 7 | playlist_tree | 44 / 15 / 16 / 1 / 1 row | 16 / 15 / 15 / 0 / 0 |
| 8 | playlist_entries | 45 / 17 / 18 / 1 / 2 rows | 18 / 17 / 17 / 0 / 0 |
| 9..15 | unknown9..15 | 20,22,24,26,28,30,32 / index page only / 0 rows | identical (same empty_c, index page only) |
| 16 | columns | 46 / 33 / 34 / 1 / 27 rows | 43 / 33 / 34 / 1 / 27 rows |
| 17 | unknown17 | 47 / 35 / 36 / 1 / 22 rows | 44 / 35 / 36 / 1 / 22 rows |
| 18 | unknown18 | 48 / 37 / 38 / 1 / 17 rows | 45 / 37 / 38 / 1 / 17 rows |
| 19 | history | 40 / 39 / 39 / 0 / 0 | 41 / 39 / 40 / 1 / **1 row** |

Table set, types, order, index-page placement (every table starts with a flags-0x64 index
page) and empty-candidate numbering are structurally identical. What differs: the device
file has no tracks/artists/playlists at all and instead carries one history row; our file
has no genres and no history.

Row sizes: colors 12/16 B (both files), columns 20..44 B, unknown17 8 B, unknown18 8 B -
identical between the files. Our tracks are 316 B and 416 B; our artist row 16 B; our
playlist-tree row 40 B; our playlist-entry rows 12 B.

### 2.3 EmptyCandidate check (requested)

For all 20 tables in **both** files:

- Every table has its **own distinct** empty_candidate page number (20 distinct values per
  file, no sharing).
- In **both** files, EmptyCandidate equals the NextPage of the table's last page, i.e. the
  final link of that table's chain (verified for all 20 tables in both files, no exception).
- In **both** files the empty_candidate pages that physically exist inside the file are
  **all zero** pages: ours 11 of 20 (4, 8, 10, 12, 20, 22, 24, 26, 28, 30, 32), device 15 of
  20 (2, 4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 28, 30, 32).
- In **both** files the remaining candidates point **past the end of the file**: ours 9
  (40, 41, 42, 43, 44, 45, 46, 47, 48; file ends at page 39), device 5 (41, 42, 43, 44, 45;
  file ends at page 40). In both files this is exactly the set of tables that own a data
  page - the original candidate slot was reused as the first data page and the writer
  reserved a fresh (never materialised) candidate page number.

Conclusion: on this evidence our file satisfies the empty_candidate rule and matches the
device's own pattern, so the "shared empty page" failure mode is not present in
/tmp/pdb/export.pdb. (Caveat: neither available file has a shared candidate, so the
rejection mode itself could not be reproduced here.)

### 2.4 Row-level comparison

Byte-identical between our file and the device file:

- **colors (type 6)**: all 8 rows identical, e.g. row 0 = `00000000 01 01 0000 0b 50696e6b 000000`.
- **columns (type 16)**: all 27 rows identical (GENRE/ARTIST/... browse-menu schema,
  long UTF-16 strings, e.g. row 0 = `0100 8000 90120000 faff 470045004e0052004500 fbff 0000`).
- **unknown17 (type 17)**: all 22 rows identical, 8 B each.
- **unknown18 (type 18)**: 16 of 17 rows identical.

Only row-level difference found in these static tables:
**unknown18 row 12** - ours `02000200 0203 0000`, device `02000200 0003 0000`.
That is the u16 at row+4: ours 0x0302, device 0x0300; the row sits on page 38 which starts
at file offset 155648, the row starts at 155784, so the wrong byte is **file offset 155788**
(ours 0x02, device 0x00). The rest of that sequence is 0x0100, 0x0200, 0x0300, 0x0400,
0x0500, 0x0600, 0x0700, so our 0x0302 is a defect in `UNKNOWN18_DATASET`
(`{Unknown1:0x02, Unknown2:0x02, Unknown3:0x302, Unknown4:0x00}`), value must be 0x300.

Tables that exist only on one side (nothing to compare): our tracks (2), artist (1),
playlist tree (1), playlist entries (2); device history row (1). Our genres table is empty
although our own `export-manifest.json` for this export lists genre "Blues" for one track,
and `pdbWriter.js` contains no genre-row code at all (only the track's GenreId u32 @60,
which is 0) - genres are silently dropped. This writer checkout also never writes
exportExt.pdb (0 references), so My Tags never reach the player.

### 2.5 Paths, ordering, string encodings

- **Path prefixes.** Our track rows hold `file_path` = `/music/<filename>` and
  `analyze_path` = `/PIONEER/USBANLZ/P037/00006F45/ANLZ0000.DAT` (row 0, string index 20 and
  14). The device export.pdb contains no track rows, so `/music/` vs `/Contents/` cannot be
  compared against rekordbox output from these files. `/Contents/<Artist>/<Album>/` appears
  only in DjManager's own capture corpus
  (`/home/radexito/github/DjManager/reverse-engineering/captures/*/PIONEER/rekordbox/export.pdb`),
  which is our own writer's output. No conclusion drawn.
- **Ordering.** Our playlist-tree row is `parentId 0, unknown 0, sortOrder 0, id 1,
  isFolder 0, name "hujemujedzikieweze"` (abs 40 page 16, 40 B). Our playlist entries are
  `entry_index 1 -> track_id 1` and `entry_index 2 -> track_id 2` (abs 40 and 52, page 18),
  which matches the manifest's playlist order (Drake first); the manifest uses database ids
  (Drake = 2) while the PDB assigns sequential ids in write order (Drake = 1), so no order
  bug. Entry indexes start at 1; unverified against rekordbox (no playlist data in the
  device file).
- **String encodings.** Where the same content exists in both files the encoding is
  byte-identical: columns rows use long UTF-16LE (`0x90` flag, u16 total length, pad byte,
  text wrapped in U+FFFA/U+FFFB), colors use short ASCII (`2*n+3` length byte). Our ISRC
  field is the 1-byte empty short string `0x03` (offsets 94+0 = 0x88 = 136 for both rows);
  our ASCII names use short ASCII, and `pdbWriter.js` falls back to 0x40 long ASCII or
  0x90 UTF-16LE for long/non-ASCII text.

### 2.6 Our Unnamed/Unknown fields - resolved or not

| our name | file offset | status after this analysis |
|---|---|---|
| track Unnamed0 | row+0 u16 | RESOLVED: subtype, always 0x0024 (public spec) |
| track IndexShift | row+2 u16 | still unknown ("unexplained" in the spec); we write 0 |
| track Bitmask | row+4 u32 | still unknown; we write the constant 0x000C0700 |
| track Unnamed7 / Unnamed8 | row+24 / row+26 u16 | partly resolved: our writer emits auto-gain 10^(replayGain/20)*13940 and *17802 (our file: 0x5457/0x6BB4 and 0x3FFA/0x51B4 for replay gains 3.8 and 1.4 dB). The spec lists "always 19048?" and "always 30967?"; **unverified** - no rekordbox-written track row exists locally to compare |
| track Unnamed26 | row+86 u16 | RESOLVED: the spec's u5, normally 0x0029 (we write 0x29) |
| track Unnamed30 | row+92 u16 | RESOLVED: the spec's u7, "the mysterious 3 that always comes before the string offsets", 2 bytes in track rows (we write 0x0003) |
| page header u24@24 | page+24 | RESOLVED and this is where we are wrong: low 13 bits = num_row_offsets (slots ever allocated), high 11 bits = num_rows (live rows). Proven by the device exportExt page 8 (0x03804c = 76 slots / 28 live) and by every device data page (n slots / n live). Our own parser initially had the two fields swapped; corrected in /tmp/pdb/pdb_parse.py |
| page header Unknown2 u32@20 | page+20 | still unknown; 0 in both files |
| data page header @32 | page+32 u16 | partly resolved: transaction_row_count. Device writes the page's live row count (e.g. 27 on page 34, 8 on page 14); we write the constant 1 |
| data page header @34/@36/@38 | | still unknown; 0 in both |
| index page 0x1fff fields | | still unknown; we emit the rex-style template, device files differ slightly in these constants |

---

## 3. Concrete differences that matter to a player, with offsets, and what we write wrong

Ranked by likely impact. All offsets are absolute in the named file.

1. **num_rows field is wrong on every data page with 8 or more rows.**
   Page header bytes 24-26 hold the packed counters (low 13 bits num_row_offsets, high 11
   bits num_rows). Our writer (`pdbWriter.js:670-672`: `buf[24] = numRows & 0xff;
   buf[25] = (numRows*0x20) & 0xff; buf[26] = 0`) drops the carry into byte 26, so a reader
   computes num_rows = numRows mod 8.
   Evidence (ours -> device):
   - page 34 columns, byte 26 at file offset 139290: ours 0x00, device 0x03 -> we declare
     3 rows for a page holding 27 (device declares 27).
   - page 36 unknown17, offset 147482: ours 0x00, device 0x02 -> 6 vs 22.
   - page 38 unknown18, offset 155674: ours 0x00, device 0x02 -> 1 vs 17.
   - page 14 colors, offset 57370: ours 0x00, device 0x01 -> 0 vs 8.
   Pages with 1-7 rows are correct by accident (page 2 tracks 2/2, page 6 artists 1/1,
   page 16 playlist tree 1/1, page 18 entries 2/2). Fix: write the packed value itself,
   i.e. `buf.writeUIntLE(numRows | (numRows << 13), 24, 3)`.
2. **Data-page PageFlags claim deleted rows where there are none.**
   Page byte 27: ours always 0x34, device 0x24 on pages without stale slots (evidence: page
   34 offset 139291, page 38 offset 155675) and 0x34 only when stale slots really exist
   (device exportExt page 8, which has 48 stale slots). Bit 4 is documented as "data page
   contains deleted/invalid rows".
3. **Genres are dropped entirely.** Our PDB has 0 genre rows while our own
   `export-manifest.json` for the same export declares genre "Blues"; `pdbWriter.js` has no
   genre-row builder, and the track row's GenreId (row+60 u32) is 0 for both tracks. A
   player shows no genre for tracks that have one.
4. **unknown18 static row 12 is wrong** - file offset 155788 (page 38, row 12 at 155784,
   byte 4): ours 0x02, device 0x00; the u16 at row+4 should be 0x0300, we write 0x0302.
   Fix the `UNKNOWN18_DATASET` entry.
5. **exportExt.pdb (My Tags) is never written.** Players show an empty My Tags list and no
   tag categories; the format is fully specified in section 1 (9 table pointers, tags at
   type 3, one index + one data page, 28 rows of <=56 B).
6. **transaction_row_count** (data page header u16@32): we write the constant 1, device
   writes the live row count of the page (27 on page 34, 22 on page 36, 17 on page 38,
   8 on page 14). Low risk, but free to fix.
7. Unverified / open risks (not proven wrong here):
   - Unnamed7/Unnamed8 gain fields (see 2.6) - our replay-gain-derived values are not
     confirmed against rekordbox.
   - `/music/` file_path prefix: never compared against a rekordbox track row (none exist
     locally). If a player resolves paths relative to the media root, `/music/x.mp3` and
     `/Contents/Artist/Album/x.mp3` are equivalent as long as the file is where the string
     says; ours is (we copy to `<usb>/music/` and write `/music/<name>`).
   - Playlist entry_index starts at 1 in our output; unverified.
   - Our file has no history row where the device file has one (device page 40, 1 row).

Verified NOT wrong (byte-identical with the device where comparable): file header layout,
20 table pointers and their order, index page flags 0x64, zero-filled empty-candidate pages,
rowset layout and presence flags, colors/columns/unknown17/unknown18 datasets (except the
single byte above), DeviceSQL string encodings, artist row (subtype 0x0060 + 1-byte name
offset), playlist tree and playlist entry row layouts.

---

## 4. Requested check: our track-row byte 92 file-type claim - CONTRADICTED

Claim under test: "byte 92 of a track row is the file type code: mp3=1, m4a=4, flac=5,
wav=0x0b".

- The public spec's track-row field diagram places `file_type` (`ft`) at row bytes
  0x5a-0x5b = **90-91** (u16) and `u7` - "the mysterious 3 which always seems to come
  before string offsets", two bytes in track rows - at 0x5c-0x5d = **92-93**. The prose text
  in that document says "bytes 60-61" for file_type, which contradicts its own diagram and
  the 21 u16 string offsets that start at 94; the diagram is the consistent reading.
- Our writer agrees with the diagram: `pdbWriter.js` writes `detectFileType()` as u16 at
  **90** and the constant 0x0003 at **92**. `detectFileType` maps mp3 -> 1, m4a/aac -> 4,
  flac -> 5, wav -> 0x0b, default 1 - exactly the codes quoted in the claim, but at 90.
- Local corpus: in every track row with a known extension, bytes 90-91 carry the code and
  byte 92 is 3. Examples: `/home/radexito/Downloads/123/PIONEER/rekordbox/export.pdb`
  (15 m4a tracks) byte 90-91 = `04 00`, byte 92 = `03` in all 15; the 41-page
  `.../captures/*/PIONEER/rekordbox/export.pdb` captures (mp3): byte 90-91 = `01 00`,
  byte 92 = `03`; `/tmp/pdb/export.pdb` both rows: `... 01 00 03 00 88 00` at offsets
  90,92,94 (0x88 = 136 = first string offset).
- Honest limitation: every track-bearing file on this machine was written by DjManager's
  own writer (signature: Unknown1 = 5 and NextUnusedPage 48-53 with the phantom
  empty-candidate pattern). The rekordbox-native databases here
  (`/tmp/anlz-gt/shimi_rekordbox/export.pdb`, `/tmp/pdb/pristine.pdb`, `/tmp/pdb/dbengine.pdb`)
  contain **zero track rows**, so I cannot confirm the offset from rekordbox's own output.
  What I can say: the claim is contradicted by the public spec's diagram, by the rex-derived
  track struct our writer ports, and by every local track row; the *values* quoted are the
  correct file-type codes, and should be read as a u16 at offset 90.

