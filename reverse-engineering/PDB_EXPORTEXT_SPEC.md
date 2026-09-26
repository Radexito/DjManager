# Pioneer DeviceSQL PDB: exportExt.pdb spec + DjManager export.pdb differential

Status: IN PROGRESS (written incrementally; each section appended as its analysis completes)

Machine: Arch Linux, python3 3.11 (no pip, uv available). Work read-only; all output under /tmp/pdb/.
No repo file was edited.

## Files under analysis

| role                              | path                                       | size     |
| --------------------------------- | ------------------------------------------ | -------- |
| our output                        | /tmp/pdb/export.pdb                        | 163840 B |
| rekordbox/device output           | /tmp/anlz-gt/shimi_rekordbox/export.pdb    | 167936 B |
| our tags ground truth (rekordbox) | /tmp/pdb/exportExt.pdb                     | 73728 B  |
| rekordbox/device tags             | /tmp/anlz-gt/shimi_rekordbox/exportExt.pdb | 81920 B  |
| rex test data (3rd party)         | /tmp/pdb/pristine.pdb                      | 167936 B |
| our writer                        | /tmp/djm-517/src/usb/pdbWriter.js          | -        |

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

| offset | size | field                                                      | ours       | shimi      |
| ------ | ---- | ---------------------------------------------------------- | ---------- | ---------- |
| 0x00   | 4    | Magic (four zero bytes)                                    | 0x00000000 | 0x00000000 |
| 0x04   | 4    | LenPage                                                    | 4096       | 4096       |
| 0x08   | 4    | NumTables                                                  | **9**      | **9**      |
| 0x0c   | 4    | NextUnusedPage                                             | 21         | 22         |
| 0x10   | 4    | Unknown1 (u32@16)                                          | 5          | 1          |
| 0x14   | 4    | SeqDb                                                      | 8          | 18         |
| 0x18   | 4    | Gap (zeros, part of SeqDb as u64)                          | 0          | 0          |
| 0x1c   | 9x16 | table pointers (Type, EmptyCandidate, FirstPage, LastPage) | see 1.2    | see 1.2    |

Raw header bytes, ours: `00000000 00100000 09000000 15000000 05000000 08000000 00000000`
Raw header bytes, shimi: `00000000 00100000 09000000 16000000 01000000 12000000 00000000`

### 1.2 Table list (identical type set in both files)

| ptr offset | type | empty_candidate | first | last   | ours chain                        | shimi chain                                                                                                         |
| ---------- | ---- | --------------- | ----- | ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0x1c       | 0    | 2               | 1     | 1      | [1] index only                    | [1] index only                                                                                                      |
| 0x2c       | 1    | 4               | 3     | 3      | [3] index only                    | [3] index only                                                                                                      |
| 0x3c       | 2    | 6               | 5     | 5      | [5] index only                    | [5] index only                                                                                                      |
| 0x4c       | 3    | 20              | 7     | 8      | [7,8] index + 1 data, **28 rows** | [7,8] index + 1 data, **28 rows**                                                                                   |
| 0x5c       | 4    | 10              | 9     | 9      | [9] index only                    | [9] index only                                                                                                      |
| 0x6c       | 5    | 12              | 11    | 11     | [11] index only                   | [11] index only                                                                                                     |
| 0x7c       | 6    | 14              | 13    | 13     | [13] index only                   | [13] index only                                                                                                     |
| 0x8c       | 7    | **19**          | 15    | **16** | [15,16] index + 1 data, **1 row** | empty_c=**21**, first 15, last **19**, chain [15,16,19]: index + 1 stale data page (0 live rows) + 1 live data page |
| 0x9c       | 8    | 18              | 17    | 17     | [17] index only                   | [17] index only                                                                                                     |

So the two files contain exactly the same 9 tables, and only two of them hold data:
`type 3 = tags` (28 rows, documented) and `type 7` (1 row, purpose not identified).
Every other table is an index page (flags 0x64) with no rows.
**Type 4 is empty in both files**, i.e. the table that the public documentation places
tag_tracks in contains no rows here (see 1.5).

Page header (32 B) for the tags data page:

|                                                      | ours page 8            | shimi page 8                            |
| ---------------------------------------------------- | ---------------------- | --------------------------------------- |
| Magic u32@0                                          | 0                      | 0                                       |
| PageIndex u32@4                                      | 8                      | 8                                       |
| Type u32@8                                           | 3                      | 3                                       |
| NextPage u32@12                                      | 20 (= empty candidate) | 20 (= empty candidate)                  |
| SeqPage u32@16                                       | 7                      | 2                                       |
| Unknown2 u32@20                                      | 0                      | 0                                       |
| u24@24: low 13 = num_row_offsets, high 11 = num_rows | 0x03801c -> 28 / 28    | 0x03804c -> **76** slots / 28 live      |
| PageFlags u8@27                                      | 0x24                   | **0x34** (bit 4 = deleted rows present) |
| FreeSize u16@28                                      | 2568                   | 24                                      |
| UsedSize u16@30                                      | 1424                   | 3860                                    |
| data hdr u16x4 @32                                   | 28, 0, 0, 0            | 28, 0, 0, 0                             |

Read this page as: 28 row-offset slots (2 row groups of 16, last group 12 used) in the
ours file; the shimi page has 5 row groups (76 slots ever allocated), of which only
28 slots carry the presence bit - the rest are stale slots from earlier in-place updates.
Rows live from page offset 40 (heap+0); rowset groups are 36 bytes at the end of the page,
offsets u16 reversed within a group, then row presence flags u16 + last-transaction flags u16.

### 1.3 tags row layout (type 3) - verified on all 28 rows in both files

| row offset | size   | field           | value / meaning                                                                                                |
| ---------- | ------ | --------------- | -------------------------------------------------------------------------------------------------------------- |
| 0x00       | u16    | subtype         | 0x0680 = "near" (1-byte string offsets), 0x0684 = "far" (2-byte offsets). All 56 rows in both files are 0x0680 |
| 0x02       | u16    | tag_index       | 0, 32, 64, ... = +32 per row, in row order                                                                     |
| 0x04       | 8 B    | unknown         | always zero in both files                                                                                      |
| 0x0c       | u32    | category        | id of the parent category; **0 when this row IS a category**                                                   |
| 0x10       | u32    | category_pos    | 0-based position inside the category; for a category row, its own position in the category list                |
| 0x14       | u32    | id              | 1..4 for the four categories, otherwise a large pseudo-random u32 (per database)                               |
| 0x18       | 4 B    | raw_is_category | `00 00 00 00` = tag, `00 00 00 01` = category (non-zero)                                                       |
| 0x1c       | u8     | constant 3      | the "3" that precedes string offsets in every string-bearing row                                               |
| 0x1d       | u8     | ofs_name        | offset of the name string, relative to the row start (near variant)                                            |
| 0x1e       | u8     | ofs_unknown     | offset of a second string, always the 1-byte empty string 0x03                                                 |
| 0x1f       | -      | name string     | DeviceSQL string; short ASCII = len byte `2*n+3`, long = `0x40`+u16 len+pad                                    |
| -          | -      | unknown string  | 0x03 (empty short string)                                                                                      |
| tail       | 8-11 B | zeros           | 8 zero bytes + 0-3 zero pad bytes to a 4-byte boundary                                                         |

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

## 2. Differential: ours vs rekordbox export.pdb

(placeholder: filled after step 2)

---

## 3. Concrete player-visible differences and our errors

(placeholder: filled after step 3)
