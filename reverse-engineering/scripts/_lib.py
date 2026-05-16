"""
_lib.py — Shared binary parsing library for rekordbox reverse-engineering scripts.
"""

import struct
import os

# ── ANLZ ─────────────────────────────────────────────────────────────────────

KNOWN_SECTIONS = {
    "PPTH": "File path",
    "PVBR": "VBR seek table",
    "PQTZ": "Beat grid (legacy, CDJ-NXS2 and below)",
    "PQT2": "Beat grid (extended, Rekordbox 6+ / CDJ-3000)",
    "PWAV": "Mono overview waveform (400 cols)",
    "PWV2": "Tiny mono overview (CDJ-900, 100 cols)",
    "PWV3": "Mono scroll waveform (10 ms/col)",
    "PWV4": "Colour overview (NXS2, 1200 × 6 bytes/col)",
    "PWV5": "Colour scroll waveform (NXS2/3000, 10 ms/col)",
    "PWV6": "RGB overview (CDJ-3000, 1200 × 3 bytes/col)",
    "PWV7": "RGB scroll waveform (CDJ-3000, 10 ms/col)",
    "PWVC": "Colour waveform calibration",
    "PCOB": "Cue object container (PCPT sub-tags)",
    "PCPT": "Hot/memory cue point",
    "PCO2": "Extended cue container (PCP2 sub-tags)",
    "PCP2": "Extended cue point with label + colour",
}


def u32be(data, off):
    return struct.unpack_from(">I", data, off)[0]


def u32le(data, off):
    return struct.unpack_from("<I", data, off)[0]


def u16be(data, off):
    return struct.unpack_from(">H", data, off)[0]


def u16le(data, off):
    return struct.unpack_from("<H", data, off)[0]


def u8(data, off):
    return data[off]


def hexlines(data, limit=None, indent="    "):
    """Return xxd-style hex+ascii lines."""
    if limit and len(data) > limit:
        data = data[:limit]
        truncated = True
    else:
        truncated = False
    lines = []
    for i in range(0, len(data), 16):
        chunk = data[i : i + 16]
        hex_part = " ".join(f"{b:02x}" for b in chunk).ljust(47)
        asc_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"{indent}{i:04x}  {hex_part}  {asc_part}")
    if truncated:
        lines.append(f"{indent}... (truncated at {limit} bytes)")
    return "\n".join(lines)


def hexdiff_row(row_off, chunk_a, chunk_b):
    """Return two coloured hex rows highlighting bytes that differ."""
    RED = "\033[1;31m"
    RST = "\033[0m"

    def fmt(chunk, ref):
        parts = []
        for i in range(16):
            a = chunk[i] if i < len(chunk) else None
            r = ref[i] if i < len(ref) else None
            s = f"{a:02x}" if a is not None else "  "
            if a != r:
                s = f"{RED}{s}{RST}"
            parts.append(s)
        return " ".join(parts)

    return (
        f"  +{row_off:04x}  A: {fmt(chunk_a, chunk_b)}\n"
        f"         B: {fmt(chunk_b, chunk_a)}"
    )


def parse_anlz(data):
    """Parse a PMAI file → list of section dicts."""
    if data[:4] != b"PMAI":
        raise ValueError("Not a PMAI file (wrong magic bytes)")
    file_len = u32be(data, 8)
    sections = []
    offset = 28
    while offset < len(data):
        if offset + 12 > len(data):
            break
        tag = data[offset : offset + 4].decode("ascii", errors="replace")
        len_header = u32be(data, offset + 4)
        len_tag = u32be(data, offset + 8)
        if len_tag == 0:
            break
        body_start = offset + len_header
        body_end = offset + len_tag
        sections.append({
            "tag": tag,
            "offset": offset,
            "len_header": len_header,
            "len_tag": len_tag,
            "body": data[body_start:body_end],
            "raw": data[offset : offset + len_tag],
        })
        offset += len_tag
    return sections, file_len


def decode_section_body(tag, body):
    """Return a human-readable string for a section's body."""
    try:
        if tag == "PPTH":
            lp = u32be(body, 0)
            raw = body[4 : 4 + lp - 2]
            return f"path: {raw.decode('utf-16-be', errors='replace')}"
        if tag == "PVBR":
            unk = u32be(body, 0)
            entries = [u32be(body, 4 + i * 4) for i in range(min(6, 400))]
            return f"unknown={unk:#010x}  seek[0..5]={entries}"
        if tag == "PQTZ":
            count = u32be(body, 8)
            beats = []
            for i in range(min(count, 4)):
                bn = u16be(body, 12 + i * 8)
                t = u16be(body, 14 + i * 8)
                ms = u32be(body, 16 + i * 8)
                beats.append(f"  beat#{i}: num={bn} bpm={t/100:.2f} t={ms}ms")
            return (f"beat_count={count}" +
                    (" (showing first 4)" if count > 4 else "") +
                    ("\n" + "\n".join(beats) if beats else ""))
        if tag == "PQT2":
            const = u32be(body, 4)
            ec = u32be(body, 28)
            fb_ms = u32be(body, 16)
            lb_ms = u32be(body, 24)
            bpm = u16be(body, 14) / 100
            vals = [u16be(body, 36 + i * 2) for i in range(min(ec, 8))]
            return (f"const={const:#010x} entry_count={ec} bpm={bpm:.2f}\n"
                    f"    first_beat_ms={fb_ms}  last_beat_ms={lb_ms}\n"
                    f"    body u16[0..7]={vals}")
        if tag in ("PWAV", "PWV2", "PWV3", "PWV4", "PWV5", "PWV6", "PWV7"):
            bpe_map = {"PWAV": None, "PWV2": None, "PWV3": 1, "PWV4": 6, "PWV5": 2, "PWV6": 3, "PWV7": 3}
            bpe = bpe_map[tag] or u32be(body, 0)
            num = u32be(body, 4)
            const = u32be(body, 8)
            return (f"bytes_per_entry={bpe}  num_entries={num}  const={const:#010x}"
                    f"  data_size={num * bpe}")
        if tag == "PWVC":
            v1, v2, v3 = u16be(body, 2), u16be(body, 4), u16be(body, 6)
            return f"calibration values: {v1} {v2} {v3}"
        if tag == "PCOB":
            slot = u32be(body, 0)
            nc = u16be(body, 6)
            sentinel = u32be(body, 8)
            return f"slot={'hot_cues' if slot==1 else 'memory_cues'}  num_cues={nc}  sentinel={sentinel:#010x}"
        if tag == "PCO2":
            slot = u32be(body, 0)
            nc = u16be(body, 4)
            return f"slot={'hot_cues' if slot==1 else 'memory_cues'}  num_cues={nc}"
    except Exception as e:
        return f"(decode error: {e})"
    return ""


def find_anlz(root, ext=".DAT"):
    """Walk root directory, return path to first matching ANLZ file."""
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.upper() == f"ANLZ0000{ext.upper()}":
                return os.path.join(dirpath, f)
    return None


# ── PDB ──────────────────────────────────────────────────────────────────────

PAGE_SIZE = 4096
TABLE_NAMES = {
    0: "Tracks", 1: "Genres", 2: "Artists", 3: "Albums", 4: "Labels",
    5: "Keys", 6: "Colors", 7: "PlaylistTree", 8: "PlaylistEntries",
    9: "Unknown9", 10: "Unknown10", 11: "HistoryPlaylists",
    12: "HistoryEntries", 13: "Artwork", 14: "Unknown14", 15: "Unknown15",
    16: "Columns", 17: "Unknown17", 18: "Unknown18", 19: "History",
}

# Named fields in the 94-byte track row header (offset, size, name)
TRACK_HEADER_FIELDS = [
    (0,  2, "u16LE", "Unnamed0 (expect 0x0024)"),
    (2,  2, "u16LE", "IndexShift"),
    (4,  4, "u32LE", "Bitmask (expect 0x000C0700)"),
    (8,  4, "u32LE", "SampleRate"),
    (12, 4, "u32LE", "ComposerId"),
    (16, 4, "u32LE", "FileSize"),
    (20, 4, "u32LE", "Checksum ← unknown: CRC? always 0?"),
    (24, 2, "u16LE", "Unnamed7 (expect 0x758A) ← unknown"),
    (26, 2, "u16LE", "Unnamed8 (expect 0x57A2) ← unknown"),
    (28, 4, "u32LE", "ArtworkId"),
    (32, 4, "u32LE", "KeyId"),
    (36, 4, "u32LE", "OriginalArtistId"),
    (40, 4, "u32LE", "LabelId"),
    (44, 4, "u32LE", "RemixerId"),
    (48, 4, "u32LE", "Bitrate"),
    (52, 4, "u32LE", "TrackNumber"),
    (56, 4, "u32LE", "Tempo (BPM × 100)"),
    (60, 4, "u32LE", "GenreId"),
    (64, 4, "u32LE", "AlbumId"),
    (68, 4, "u32LE", "ArtistId"),
    (72, 4, "u32LE", "Id"),
    (76, 2, "u16LE", "DiscNumber"),
    (78, 2, "u16LE", "PlayCount"),
    (80, 2, "u16LE", "Year"),
    (82, 2, "u16LE", "SampleDepth"),
    (84, 2, "u16LE", "Duration (seconds)"),
    (86, 2, "u16LE", "Unnamed26 (expect 0x0029) ← unknown"),
    (88, 1, "u8",    "ColorId"),
    (89, 1, "u8",    "Rating (0/51/102/153/204/255)"),
    (90, 2, "u16LE", "FileType (1=mp3 4=aac 5=flac 11=wav)"),
    (92, 2, "u16LE", "Unnamed30 (expect 0x0003) ← unknown"),
]

STRING_SLOTS = [
    "ISRC", "Composer", "KeyAnalyzed(num1)", "PhraseAnalyzed(num2)",
    "UnknownStr4", "Message", "KuvoPublic", "AutoloadHotcues",
    "UnknownStr5", "UnknownStr6", "DateAdded", "ReleaseDate",
    "MixName", "UnknownStr7", "AnalyzePath", "AnalyzeDate",
    "Comment", "Title", "UnknownStr8", "Filename", "FilePath",
]


def read_devicesql_string(data, off):
    """Decode a DeviceSQL string at the given absolute offset."""
    if off >= len(data):
        return "(out of bounds)"
    b0 = data[off]
    if b0 & 1:  # short ASCII: header = ((len+1)<<1)|1
        length = (b0 >> 1) - 1
        return data[off + 1 : off + 1 + length].decode("ascii", errors="replace")
    elif b0 == 0x40:  # long ASCII
        total = u16le(data, off + 1)
        length = total - 4
        return data[off + 4 : off + 4 + length].decode("ascii", errors="replace")
    elif b0 == 0x90:  # UTF-16LE or ISRC
        total = u16le(data, off + 1)
        b3 = data[off + 3]
        if b3 == 0x03:  # ISRC variant
            length = total - 6
            return data[off + 5 : off + 5 + length].decode("ascii", errors="replace")
        else:
            length = total - 4
            return data[off + 4 : off + 4 + length].decode("utf-16-le", errors="replace")
    return f"(unknown string type 0x{b0:02x})"


def parse_pdb_header(data):
    """Parse page 0 file header. Returns (num_tables, tables) list."""
    if len(data) < PAGE_SIZE:
        raise ValueError("File too small to be a PDB")
    num_tables = u32le(data, 8)
    next_unused = u32le(data, 12)
    sequence = u32le(data, 20)
    tables = []
    for i in range(num_tables):
        off = 28 + i * 16
        tables.append({
            "type": u32le(data, off),
            "empty_candidate": u32le(data, off + 4),
            "first_page": u32le(data, off + 8),
            "last_page": u32le(data, off + 12),
        })
    return num_tables, next_unused, sequence, tables


def iter_table_rows(data, first_page, table_type):
    """Yield raw row bytes for every row in a table's page chain."""
    PAGE_HEADER = 32
    DATA_HEADER = 8
    HEAP_OFFSET = PAGE_HEADER + DATA_HEADER  # 40
    ROWSET_SIZE = 36
    MAX_PER_ROWSET = 16

    visited = set()
    page_idx = first_page
    while True:
        if page_idx in visited or page_idx == 0x03FFFFFF or page_idx == 0:
            break
        visited.add(page_idx)
        page_off = page_idx * PAGE_SIZE
        if page_off + PAGE_SIZE > len(data):
            break
        page = data[page_off : page_off + PAGE_SIZE]

        flags = page[27]
        if flags == 0x64:  # index page — skip
            next_pg = u32le(page, 12)
            page_idx = next_pg
            continue

        num_rows = page[24]
        next_page = u32le(page, 12)

        # RowSets grow backwards from end of page
        num_rowsets = (num_rows + MAX_PER_ROWSET - 1) // MAX_PER_ROWSET
        for rs_i in range(num_rowsets):
            rs_off = PAGE_SIZE - (rs_i + 1) * ROWSET_SIZE
            # positions are reversed: pos[15] first, pos[0] last
            positions = []
            for j in range(MAX_PER_ROWSET):
                pos = u16le(page, rs_off + (MAX_PER_ROWSET - 1 - j) * 2)
                positions.append(pos)
            active = u16le(page, rs_off + MAX_PER_ROWSET * 2)
            for bit in range(MAX_PER_ROWSET):
                if active & (1 << bit):
                    row_heap_off = HEAP_OFFSET + positions[bit]
                    if row_heap_off < PAGE_SIZE:
                        yield page[row_heap_off:], page_off + row_heap_off

        page_idx = next_page


def decode_track_row(row_data, abs_row_off, full_pdb):
    """Parse a track row and return dict of named fields + strings."""
    if len(row_data) < 136:
        return None
    result = {"_raw_header": row_data[:94]}
    for off, size, fmt, name in TRACK_HEADER_FIELDS:
        if fmt == "u32LE":
            result[name] = u32le(row_data, off)
        elif fmt == "u16LE":
            result[name] = u16le(row_data, off)
        elif fmt == "u8":
            result[name] = u8(row_data, off)

    # String offsets (21 × u16LE at bytes 94–135, absolute into full_pdb)
    # The offset stored is relative to the start of the row in the file
    strings = {}
    for i, slot in enumerate(STRING_SLOTS):
        str_off = u16le(row_data, 94 + i * 2)
        abs_str_off = abs_row_off + str_off
        strings[slot] = read_devicesql_string(full_pdb, abs_str_off)
    result["_strings"] = strings
    return result


def decode_key_row(row_data):
    if len(row_data) < 8:
        return None
    small_id = u16le(row_data, 0)
    pk_id = u32le(row_data, 4)
    name = read_devicesql_string(row_data, 8)
    return {"SmallId": small_id, "Id": pk_id, "Name": name}


def decode_artist_row(row_data):
    if len(row_data) < 10:
        return None
    pk_id = u32le(row_data, 4)
    name = read_devicesql_string(row_data, 10)
    return {"Id": pk_id, "Name": name}


def decode_genre_row(row_data):
    if len(row_data) < 10:
        return None
    pk_id = u32le(row_data, 4)
    name = read_devicesql_string(row_data, 10)
    return {"Id": pk_id, "Name": name}


def decode_album_row(row_data):
    if len(row_data) < 22:
        return None
    artist_id = u32le(row_data, 8)
    pk_id = u32le(row_data, 12)
    name = read_devicesql_string(row_data, 22)
    return {"Id": pk_id, "ArtistId": artist_id, "Name": name}
