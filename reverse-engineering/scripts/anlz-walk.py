#!/usr/bin/env python3
"""ANLZ section walker + cue decoder. Read-only analysis of copied files."""
import sys, os, struct, math, json, glob

def u8(b,o): return b[o]
def u16(b,o): return struct.unpack('>H', b[o:o+2])[0]
def u32(b,o): return struct.unpack('>I', b[o:o+4])[0]

def entropy(b):
    if not b: return 0.0
    from collections import Counter
    c = Counter(b); n = len(b)
    return -sum((v/n) * math.log2(v/n) for v in c.values())

def file_header(b):
    magic = b[0:4].decode('ascii','replace')
    return magic, u32(b,4), u32(b,8)

def walk_sections(b):
    """Yield dicts for each section."""
    magic, fhdr, flen = file_header(b)
    off = fhdr
    out = []
    guard = 0
    while off + 12 <= len(b) and guard < 200:
        guard += 1
        tag = b[off:off+4].decode('ascii','replace')
        lenh = u32(b,off+4)
        lent = u32(b,off+8)
        if not (tag.isprintable()) or lent < 12 or off+lent > len(b):
            out.append(dict(tag=tag, offset=off, lenHdr=lenh, lenTag=lent,
                            error='implausible', remaining=len(b)-off))
            break
        body = b[off+lenh:off+lent]
        out.append(dict(tag=tag, offset=off, lenHdr=lenh, lenTag=lent,
                        bodyLen=len(body), nonZero=sum(1 for x in body if x),
                        entropy=round(entropy(body),3),
                        body_off=off+lenh))
        off += lent
    return magic, fhdr, flen, out

# ---- decoders ----
def decode_ppth(b, s):
    o = s['offset']
    len_path = u32(b, o+12)
    raw = b[o+16:o+16+len_path]
    try: txt = raw.decode('utf-16-be').rstrip('\x00')
    except Exception: txt = repr(raw[:60])
    return dict(len_path=len_path, path=txt)

def decode_pqtz(b, s):
    o = s['offset']; cnt = u32(b, o+20)
    beats = []
    p = o + s['lenHdr']
    avail = (s['offset']+s['lenTag']) - p
    n = min(cnt, avail // 8)
    for i in range(n):
        beats.append(dict(beat_number=u16(b,p), tempo=u16(b,p+2), time_ms=u32(b,p+4)))
        p += 8
    return dict(header_const0=u32(b,o+12), header_const1=hex(u32(b,o+16)),
                beat_count_declared=cnt, beats_parsed=n,
                first=beats[0] if beats else None, last=beats[-1] if beats else None,
                total_body_len=s['lenTag']-s['lenHdr'])

def decode_pqt2(b, s):
    o = s['offset']
    return dict(f0=hex(u32(b,o+12)), f1=hex(u32(b,o+16)), f2=hex(u32(b,o+20)),
                first=(u16(b,o+24), u16(b,o+26), u32(b,o+28)),
                last=(u16(b,o+32), u16(b,o+34), u32(b,o+36)),
                entry_count=u32(b,o+40), f44=hex(u32(b,o+44)),
                body_bytes=s['lenTag']-s['lenHdr'],
                expected_body=u32(b,o+40)*2)

def decode_pcob(b, s):
    """PCOB: header 24 (or as declared). Entries of len_entry bytes each."""
    o = s['offset']
    typ = u32(b,o+12)
    pad = u16(b,o+16)
    num = u16(b,o+18)
    sent = u32(b,o+20)
    entries = []
    if s['lenHdr'] >= 24:
        len_entry = u32(b, o+24) if s['lenTag'] >= 28 else 0
    else:
        len_entry = 0
    p = o + s['lenHdr']
    end = o + s['lenTag']
    eidx = 0
    while p + 12 <= end and eidx < 200:
        etag = b[p:p+4].decode('ascii','replace')
        elh = u32(b,p+4); elt = u32(b,p+8)
        ent = dict(index=eidx, tag=etag, offset=p, lenHdr=elh, lenTag=elt,
                   raw=b[p:p+min(elt,72)].hex())
        if etag == 'PCPT':
            ent.update(hot_cue=u32(b,p+12), status=u32(b,p+16),
                       c20=hex(u32(b,p+20)), order_first=u16(b,p+24), order_last=u16(b,p+26),
                       type=u8(b,p+28), b29=u8(b,p+29), c30=hex(u16(b,p+30)),
                       time_ms=u32(b,p+32), loop_time=u32(b,p+36),
                       color_code=u8(b,p+40), tail=b[p+41:p+elt].hex())
        entries.append(ent)
        eidx += 1
        step = elt if elt >= 12 else 56
        p += step
    return dict(type=typ, pad=pad, num_cues=num, sentinel=hex(sent),
                len_entry_declared=len_entry, entries=entries)

def decode_pco2(b, s):
    o = s['offset']
    typ = u32(b,o+12); num = u16(b,o+16); pad = u16(b,o+18)
    entries = []
    p = o + s['lenHdr']
    end = o + s['lenTag']
    eidx = 0
    while p + 12 <= end and eidx < 200:
        etag = b[p:p+4].decode('ascii','replace')
        elh = u32(b,p+4); elt = u32(b,p+8)
        if elt < 12 or p+elt > end:
            break
        ent = dict(index=eidx, tag=etag, offset=p, lenHdr=elh, lenTag=elt)
        if etag == 'PCP2':
            lc = u32(b,p+40)
            lab = b[p+44:p+44+lc]
            try: label = lab.decode('utf-16-be').rstrip('\x00')
            except Exception: label = repr(lab)
            base = p + 44 + lc
            ent.update(hot_cue=u32(b,p+12), type=u8(b,p+16), b17=u8(b,p+17),
                       c18=hex(u16(b,p+18)), time_ms=u32(b,p+20),
                       loop_time=u32(b,p+24), b28=u8(b,p+28), b29=u8(b,p+29),
                       b30_39=b[p+30:p+40].hex(),
                       len_comment=lc, label=label,
                       color_code=u8(b,base), rgb=(u8(b,base+1),u8(b,base+2),u8(b,base+3)),
                       tail_off=base+4, tail=b[base+4:p+elt].hex())
        entries.append(ent)
        eidx += 1
        p += elt
    return dict(type=typ, num_cues=num, pad=pad, entries=entries)

def decode_pwav(b, s, name):
    o = s['offset']
    return dict(name=name, f12=u32(b,o+12), f16=hex(u32(b,o+16)),
                body=s['lenTag']-s['lenHdr'])

DECODERS = {
    'PPTH': decode_ppth,
    'PQTZ': decode_pqtz,
    'PQT2': decode_pqt2,
    'PCOB': decode_pcob,
    'PCO2': decode_pco2,
}

def analyze(path, verbose=False):
    b = open(path,'rb').read()
    magic, fhdr, flen, secs = walk_sections(b)
    return b, dict(path=path, size=len(b), magic=magic, file_hdr_len=fhdr,
                   len_file_declared=flen, len_file_actual=len(b), sections=secs)

if __name__ == '__main__':
    for path in sys.argv[1:]:
        b, info = analyze(path)
        print('='*100)
        print(f"FILE {path}  size={info['size']}  magic={info['magic']} "
              f"hdrLen={info['file_hdr_len']} lenFile={info['len_file_declared']}")
        print(f"  raw first 32 bytes: {b[:32].hex(' ')}")
        for s in info['sections']:
            if 'error' in s:
                print(f"  ! {s}"); continue
            print(f"  {s['tag']} @0x{s['offset']:06x} lenHdr={s['lenHdr']:3d} "
                  f"lenTag={s['lenTag']:6d} body={s['bodyLen']:6d} nz={s['nonZero']:6d} "
                  f"H={s['entropy']}")
            d = DECODERS.get(s['tag'])
            if d:
                print('      ', json.dumps(d(b,s), default=str, ensure_ascii=False))
            elif s['tag'] in ('PWAV','PWV2','PWV3','PWV4','PWV5','PWV6','PWV7','PWV8','PWVC'):
                print('      ', json.dumps(decode_pwav(b,s,s['tag'])))
