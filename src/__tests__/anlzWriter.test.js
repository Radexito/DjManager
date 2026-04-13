import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

vi.mock('../audio/waveformGenerator.js', () => ({
  generateWaveform: vi.fn().mockResolvedValue({
    pwv3: Buffer.alloc(100, 0x21),
    pwv5: Buffer.alloc(200, 0x11),
    pwav: Buffer.alloc(400, 0x41),
    pwv2: Buffer.alloc(100, 0x22),
    pwv4: Buffer.alloc(7200, 0x33),
    pwv7: Buffer.alloc(300, 0x44),
    pwv6: Buffer.alloc(3600, 0x55),
    numCols: 100,
  }),
}));

vi.mock('fs', () => {
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const existsSync = vi.fn().mockReturnValue(false);
  const statSync = vi.fn().mockReturnValue({ size: 1234567 });
  const mod = { writeFileSync, mkdirSync, existsSync, statSync };
  return { default: mod, ...mod };
});

// Import after mocks
import {
  writeAnlz,
  getAnlzFolder,
  buildPcobSections,
  buildExtPcobSections,
  buildPco2Sections,
} from '../audio/anlzWriter.js';
import fs from 'fs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse sections from a PMAI buffer, starting after the 28-byte file header. */
function parseSections(buf) {
  const sections = [];
  let pos = 28; // skip PMAI header
  while (pos < buf.length - 8) {
    const tag = buf.slice(pos, pos + 4).toString('ascii');
    const lenHdr = buf.readUInt32BE(pos + 4);
    const lenTag = buf.readUInt32BE(pos + 8);
    if (lenTag === 0 || lenTag > buf.length - pos) break;
    sections.push({ tag, lenHdr, lenTag, pos });
    pos += lenTag;
  }
  return sections;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getAnlzFolder', () => {
  it('returns path in PIONEER/USBANLZ/P{3hex}/{8hex} format', () => {
    const result = getAnlzFolder('/music/testsong.mp3');
    expect(result).toMatch(/PIONEER[/\\]USBANLZ[/\\]P[0-9A-F]{3}[/\\][0-9A-F]{8}$/);
  });

  it('is deterministic — same path gives same folder', () => {
    const a = getAnlzFolder('/music/artist/track.mp3');
    const b = getAnlzFolder('/music/artist/track.mp3');
    expect(a).toBe(b);
  });

  it('different paths give different folders', () => {
    const a = getAnlzFolder('/music/track1.mp3');
    const b = getAnlzFolder('/music/track2.mp3');
    expect(a).not.toBe(b);
  });

  it('normalises Windows backslashes before hashing', () => {
    const forward = getAnlzFolder('/music/track.mp3');
    const backward = getAnlzFolder('\\music\\track.mp3');
    expect(forward).toBe(backward);
  });

  it('adds leading slash if missing', () => {
    const withSlash = getAnlzFolder('/music/track.mp3');
    const withoutSlash = getAnlzFolder('music/track.mp3');
    expect(withSlash).toBe(withoutSlash);
  });
});

describe('writeAnlz', () => {
  const baseOpts = {
    usbFilePath: '/music/testsong.mp3',
    sourceFilePath: '/local/testsong.mp3',
    beatgrid: null,
    bpm: 128,
    usbRoot: '/tmp/usb',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: statSync returns a real file size
    fs.statSync.mockReturnValue({ size: 1234567 });
  });

  it('writes three files: ANLZ0000.DAT, ANLZ0000.EXT, ANLZ0000.2EX (with waveforms)', async () => {
    await writeAnlz(baseOpts);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
    const paths = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(paths.some((p) => p.endsWith('ANLZ0000.DAT'))).toBe(true);
    expect(paths.some((p) => p.endsWith('ANLZ0000.EXT'))).toBe(true);
    expect(paths.some((p) => p.endsWith('ANLZ0000.2EX'))).toBe(true);
  });

  it('writes only DAT and EXT (no 2EX) when sourceFilePath is null', async () => {
    await writeAnlz({ ...baseOpts, sourceFilePath: null });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    const paths = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(paths.some((p) => p.endsWith('ANLZ0000.DAT'))).toBe(true);
    expect(paths.some((p) => p.endsWith('ANLZ0000.EXT'))).toBe(true);
    expect(paths.some((p) => p.endsWith('ANLZ0000.2EX'))).toBe(false);
  });

  it('creates the ANLZ directory with recursive: true', async () => {
    await writeAnlz(baseOpts);

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('PIONEER'), {
      recursive: true,
    });
  });

  it('DAT file starts with PMAI magic bytes', async () => {
    await writeAnlz(baseOpts);

    const datCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('ANLZ0000.DAT'));
    expect(datCall).toBeDefined();
    expect(datCall[1].slice(0, 4).toString('ascii')).toBe('PMAI');
  });

  it('EXT file starts with PMAI magic bytes', async () => {
    await writeAnlz(baseOpts);

    const extCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('ANLZ0000.EXT'));
    expect(extCall).toBeDefined();
    expect(extCall[1].slice(0, 4).toString('ascii')).toBe('PMAI');
  });

  it('2EX file starts with PMAI magic bytes', async () => {
    await writeAnlz(baseOpts);

    const exCall = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('ANLZ0000.2EX'));
    expect(exCall).toBeDefined();
    expect(exCall[1].slice(0, 4).toString('ascii')).toBe('PMAI');
  });

  it('DAT file contains PPTH (path tag) section', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    expect(datBuf.toString('binary')).toContain('PPTH');
  });

  it('DAT file contains PQTZ (beat grid) section', async () => {
    await writeAnlz({ ...baseOpts, beatgrid: JSON.stringify([0.5, 0.97, 1.44]) });

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    expect(datBuf.toString('binary')).toContain('PQTZ');
  });

  it('EXT file contains PWV3 waveform section', async () => {
    await writeAnlz(baseOpts);

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    expect(extBuf.toString('binary')).toContain('PWV3');
  });

  it('EXT file contains PPTH section', async () => {
    await writeAnlz(baseOpts);

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    expect(extBuf.toString('binary')).toContain('PPTH');
  });

  it('returns path to the DAT file', async () => {
    const result = await writeAnlz(baseOpts);

    expect(result).toMatch(/ANLZ0000\.DAT$/);
  });

  it('skips waveform generation when sourceFilePath is null', async () => {
    const { generateWaveform } = await import('../audio/waveformGenerator.js');
    await writeAnlz({ ...baseOpts, sourceFilePath: null });

    expect(generateWaveform).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('still writes DAT+EXT when waveform generation fails (graceful fallback)', async () => {
    const { generateWaveform } = await import('../audio/waveformGenerator.js');
    generateWaveform.mockRejectedValueOnce(new Error('ffmpeg not found'));

    await expect(writeAnlz(baseOpts)).resolves.not.toThrow();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('ANLZ dir is inside usbRoot/PIONEER/USBANLZ', async () => {
    await writeAnlz({ ...baseOpts, usbRoot: '/mnt/usb' });

    const mkdirPath = fs.mkdirSync.mock.calls[0][0].replace(/\\/g, '/');
    expect(mkdirPath).toContain('/mnt/usb/PIONEER/USBANLZ');
  });

  it('DAT file contains PWV2 tiny waveform section', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    expect(datBuf.toString('binary')).toContain('PWV2');
  });

  it('EXT file contains PWV4 colour preview section', async () => {
    await writeAnlz(baseOpts);

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    expect(extBuf.toString('binary')).toContain('PWV4');
  });

  it('EXT file contains PWV5 colour scroll section', async () => {
    await writeAnlz(baseOpts);

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    expect(extBuf.toString('binary')).toContain('PWV5');
  });

  it('PWAV section has unknown field 0x00010000', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const pwavIdx = datBuf.indexOf(Buffer.from('PWAV', 'ascii'));
    expect(pwavIdx).toBeGreaterThan(-1);
    // PWAV body starts at pwavIdx+12: first 4 = len_data, next 4 = unknown
    const unknown = datBuf.readUInt32BE(pwavIdx + 12 + 4);
    expect(unknown).toBe(0x00010000);
  });

  // ── PVBR section ─────────────────────────────────────────────────────────────

  it('DAT file contains PVBR section', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    expect(datBuf.toString('binary')).toContain('PVBR');
  });

  it('PVBR section is positioned between PPTH and PQTZ in DAT', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const sections = parseSections(datBuf);
    const tags = sections.map((s) => s.tag);
    const ppthIdx = tags.indexOf('PPTH');
    const pvbrIdx = tags.indexOf('PVBR');
    const pqtzIdx = tags.indexOf('PQTZ');
    expect(ppthIdx).toBeLessThan(pvbrIdx);
    expect(pvbrIdx).toBeLessThan(pqtzIdx);
  });

  it('PVBR section has len_header=16', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const pvbrIdx = datBuf.indexOf(Buffer.from('PVBR', 'ascii'));
    expect(pvbrIdx).toBeGreaterThan(-1);
    const lenHdr = datBuf.readUInt32BE(pvbrIdx + 4);
    expect(lenHdr).toBe(16);
  });

  it('PVBR body is 1604 bytes (4 unknown + 400×u32)', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const sections = parseSections(datBuf);
    const pvbr = sections.find((s) => s.tag === 'PVBR');
    expect(pvbr).toBeDefined();
    const bodyLen = pvbr.lenTag - 12; // lenTag = 12 header + body
    expect(bodyLen).toBe(4 + 400 * 4); // 1604
  });

  it('PVBR seek table is monotonically non-decreasing', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const pvbrPos = datBuf.indexOf(Buffer.from('PVBR', 'ascii'));
    // Body starts at pvbrPos+12 (common header), skip 4 unknown bytes
    const tableStart = pvbrPos + 12 + 4;
    let prev = 0;
    for (let i = 0; i < 400; i++) {
      const val = datBuf.readUInt32BE(tableStart + i * 4);
      expect(val).toBeGreaterThanOrEqual(prev);
      prev = val;
    }
  });

  it('PVBR seek table entry[0] = 0 and entry[399] < fileSize', async () => {
    const fileSize = 1234567;
    fs.statSync.mockReturnValue({ size: fileSize });

    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const pvbrPos = datBuf.indexOf(Buffer.from('PVBR', 'ascii'));
    const tableStart = pvbrPos + 12 + 4;
    expect(datBuf.readUInt32BE(tableStart)).toBe(0); // entry[0]
    const last = datBuf.readUInt32BE(tableStart + 399 * 4);
    expect(last).toBeLessThan(fileSize);
  });

  it('PVBR seek table is all zeros when sourceFilePath is null (no size)', async () => {
    await writeAnlz({ ...baseOpts, sourceFilePath: null });

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const pvbrPos = datBuf.indexOf(Buffer.from('PVBR', 'ascii'));
    expect(pvbrPos).toBeGreaterThan(-1);
    const tableStart = pvbrPos + 12 + 4;
    for (let i = 0; i < 400; i++) {
      expect(datBuf.readUInt32BE(tableStart + i * 4)).toBe(0);
    }
  });

  // ── PMAI file header ──────────────────────────────────────────────────────────

  it('DAT len_file in PMAI header matches actual buffer size', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const lenFile = datBuf.readUInt32BE(8);
    expect(lenFile).toBe(datBuf.length);
  });

  it('EXT len_file in PMAI header matches actual buffer size', async () => {
    await writeAnlz(baseOpts);

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    const lenFile = extBuf.readUInt32BE(8);
    expect(lenFile).toBe(extBuf.length);
  });

  // ── PQT2 section ──────────────────────────────────────────────────────────────

  it('EXT file contains PQT2 section', async () => {
    await writeAnlz({ ...baseOpts, beatgrid: JSON.stringify([0.5, 0.97, 1.44]) });

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    expect(extBuf.toString('binary')).toContain('PQT2');
  });

  it('PQT2 section has entry_count > 0 when beats are provided', async () => {
    await writeAnlz({ ...baseOpts, beatgrid: JSON.stringify([0.5, 0.97, 1.44, 1.91]) });

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    const pqt2Pos = extBuf.indexOf(Buffer.from('PQT2', 'ascii'));
    expect(pqt2Pos).toBeGreaterThan(-1);
    // entry_count is at offset 40 from section start (per buildPqt2Section)
    const entryCount = extBuf.readUInt32BE(pqt2Pos + 40);
    expect(entryCount).toBe(4);
  });

  it('PQT2 has constant 0x01000002 at offset 16', async () => {
    await writeAnlz({ ...baseOpts, beatgrid: JSON.stringify([0.5, 0.97]) });

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    const pqt2Pos = extBuf.indexOf(Buffer.from('PQT2', 'ascii'));
    expect(pqt2Pos).toBeGreaterThan(-1);
    expect(extBuf.readUInt32BE(pqt2Pos + 16)).toBe(0x01000002);
  });

  it('PQT2 len_header is 56', async () => {
    await writeAnlz({ ...baseOpts, beatgrid: JSON.stringify([0.5]) });

    const extBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.EXT'))[1];
    const pqt2Pos = extBuf.indexOf(Buffer.from('PQT2', 'ascii'));
    const lenHdr = extBuf.readUInt32BE(pqt2Pos + 4);
    expect(lenHdr).toBe(56);
  });

  // ── PPTH len_header ───────────────────────────────────────────────────────────

  it('PPTH section has len_header=16', async () => {
    await writeAnlz(baseOpts);

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const ppthPos = datBuf.indexOf(Buffer.from('PPTH', 'ascii'));
    expect(ppthPos).toBeGreaterThan(-1);
    const lenHdr = datBuf.readUInt32BE(ppthPos + 4);
    expect(lenHdr).toBe(16);
  });

  // ── PQTZ len_header ───────────────────────────────────────────────────────────

  it('PQTZ section has len_header=24', async () => {
    await writeAnlz({ ...baseOpts, beatgrid: JSON.stringify([0.5, 0.97]) });

    const datBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.DAT'))[1];
    const pqtzPos = datBuf.indexOf(Buffer.from('PQTZ', 'ascii'));
    expect(pqtzPos).toBeGreaterThan(-1);
    const lenHdr = datBuf.readUInt32BE(pqtzPos + 4);
    expect(lenHdr).toBe(24);
  });

  // ── 2EX sections ──────────────────────────────────────────────────────────────

  it('2EX file contains PWV7 colour scroll section', async () => {
    await writeAnlz(baseOpts);

    const exBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.2EX'))[1];
    expect(exBuf.toString('binary')).toContain('PWV7');
  });

  it('2EX file contains PWV6 colour overview section', async () => {
    await writeAnlz(baseOpts);

    const exBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.2EX'))[1];
    expect(exBuf.toString('binary')).toContain('PWV6');
  });

  it('2EX file contains PWVC calibration section', async () => {
    await writeAnlz(baseOpts);

    const exBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.2EX'))[1];
    expect(exBuf.toString('binary')).toContain('PWVC');
  });

  it('PWVC body has the constant values 0x0064 0x0068 0x00C5', async () => {
    await writeAnlz(baseOpts);

    const exBuf = fs.writeFileSync.mock.calls.find((c) => c[0].endsWith('.2EX'))[1];
    const pwvcPos = exBuf.indexOf(Buffer.from('PWVC', 'ascii'));
    expect(pwvcPos).toBeGreaterThan(-1);
    // PWVC len_header=14, body starts at pwvcPos+14
    expect(exBuf.readUInt16BE(pwvcPos + 14)).toBe(0x0064);
    expect(exBuf.readUInt16BE(pwvcPos + 16)).toBe(0x0068);
    expect(exBuf.readUInt16BE(pwvcPos + 18)).toBe(0x00c5);
  });
});

// ── buildPcobSections ─────────────────────────────────────────────────────────

describe('buildPcobSections', () => {
  const hotCue = { position_ms: 1000, color: '#ff0000', hot_cue_index: 0 }; // A
  const memoryCue = { position_ms: 5000, color: '#00ff00', hot_cue_index: -1 };

  it('returns empty stubs when cuePoints is empty', () => {
    const [pcob1, pcob2] = buildPcobSections([]);
    expect(pcob1.slice(0, 4).toString('ascii')).toBe('PCOB');
    expect(pcob2.slice(0, 4).toString('ascii')).toBe('PCOB');
    // Both empty: len_tag = 24 (header only, no entries)
    expect(pcob1.readUInt32BE(8)).toBe(24);
    expect(pcob2.readUInt32BE(8)).toBe(24);
  });

  it('PCOB1 type field = 1 (hot_cues slot)', () => {
    const [pcob1] = buildPcobSections([hotCue]);
    expect(pcob1.readUInt32BE(12)).toBe(1);
  });

  it('PCOB2 is always empty stub (memory cues go to PCO2 until PCOB2 format is confirmed)', () => {
    // Non-empty PCOB2 causes Rekordbox to reject the file — see issue #208
    const [, pcob2] = buildPcobSections([memoryCue]);
    expect(pcob2.readUInt32BE(8)).toBe(24); // len_tag = 24 = header only
    expect(pcob2.readUInt16BE(18)).toBe(0); // num_cues = 0
  });

  it('PCOB2 stays empty even when there are memory cues', () => {
    const [, pcob2] = buildPcobSections([hotCue, memoryCue]);
    expect(pcob2.readUInt32BE(8)).toBe(24);
  });

  it('PCPT entry for hot cue has status = 0 (native Rekordbox value)', () => {
    // Verified by hex-diff of native Rekordbox USB export — KSY "disabled" label is misleading
    const [pcob1] = buildPcobSections([hotCue]);
    const pcptStart = 24; // first PCPT entry after 24-byte PCOB header
    expect(pcob1.readUInt32BE(pcptStart + 16)).toBe(0);
  });

  it('PCPT entry for hot cue A has hot_cue = 1', () => {
    const [pcob1] = buildPcobSections([hotCue]);
    const pcptStart = 24;
    expect(pcob1.readUInt32BE(pcptStart + 12)).toBe(1);
  });

  it('PCPT time_ms matches position_ms', () => {
    const [pcob1] = buildPcobSections([hotCue]);
    const pcptStart = 24;
    expect(pcob1.readUInt32BE(pcptStart + 32)).toBe(1000);
  });

  it('PCOB1 len_tag = 24 + N×56 for N hot cues', () => {
    const [pcob1] = buildPcobSections([hotCue, hotCue]);
    expect(pcob1.readUInt32BE(8)).toBe(24 + 2 * 56);
  });

  it('memory cues are NOT placed in PCOB1', () => {
    const [pcob1] = buildPcobSections([memoryCue]);
    // No entries in PCOB1 since no hot cues
    expect(pcob1.readUInt32BE(8)).toBe(24); // empty
  });
});

// ── Pioneer color palette (hexToPioneerCode via PCPT / PCP2) ──────────────────

describe('Pioneer color palette — PCPT color_code byte', () => {
  const pcptStart = 24; // first PCPT entry after 24-byte PCOB header
  const colorByteOffset = pcptStart + 40; // byte [40] of the PCPT entry

  it('orange (#ff9900) → code 3 (confirmed by native Rekordbox hex-diff)', () => {
    const [pcob1] = buildPcobSections([{ position_ms: 1000, color: '#ff9900', hot_cue_index: 0 }]);
    expect(pcob1[colorByteOffset]).toBe(3);
  });

  it('cyan (#00b4d8) → code 6 (confirmed by native Rekordbox hex-diff)', () => {
    const [pcob1] = buildPcobSections([{ position_ms: 1000, color: '#00b4d8', hot_cue_index: 0 }]);
    expect(pcob1[colorByteOffset]).toBe(6);
  });

  it('unknown color hex → code 0 (no color / CDJ default)', () => {
    const [pcob1] = buildPcobSections([{ position_ms: 1000, color: '#123456', hot_cue_index: 0 }]);
    expect(pcob1[colorByteOffset]).toBe(0);
  });

  it('null/missing color → code 0', () => {
    const [pcob1] = buildPcobSections([{ position_ms: 1000, color: null, hot_cue_index: 0 }]);
    expect(pcob1[colorByteOffset]).toBe(0);
  });
});

// ── buildExtPcobSections ──────────────────────────────────────────────────────

describe('buildExtPcobSections', () => {
  it('returns empty stubs when cuePoints is empty', () => {
    const [ext1, ext2] = buildExtPcobSections([]);
    expect(ext1.slice(0, 4).toString('ascii')).toBe('PCOB');
    expect(ext1.readUInt32BE(8)).toBe(24);
    expect(ext2.readUInt32BE(8)).toBe(24);
  });

  it('places hot_cue_index 3-7 (D-H) in EXT PCOB1', () => {
    const cues = [
      { position_ms: 1000, color: '#ff9900', hot_cue_index: 3 }, // D
      { position_ms: 2000, color: '#00b4d8', hot_cue_index: 4 }, // E
    ];
    const [ext1] = buildExtPcobSections(cues);
    expect(ext1.readUInt32BE(8)).toBe(24 + 2 * 56);
    expect(ext1.readUInt16BE(18)).toBe(2); // num_cues
  });

  it('ignores cues with hot_cue_index 0-2 (A-C belong in DAT)', () => {
    const datCues = [{ position_ms: 1000, color: '#ff9900', hot_cue_index: 0 }];
    const [ext1] = buildExtPcobSections(datCues);
    expect(ext1.readUInt32BE(8)).toBe(24); // empty — no D-H cues
  });

  it('EXT PCOB2 is always empty stub', () => {
    const cues = [{ position_ms: 1000, color: '#ff9900', hot_cue_index: 3 }];
    const [, ext2] = buildExtPcobSections(cues);
    expect(ext2.readUInt32BE(8)).toBe(24);
  });
});

// ── buildPco2Sections ─────────────────────────────────────────────────────────

describe('buildPco2Sections', () => {
  const hotCue = { position_ms: 1000, color: '#ff9900', label: 'Drop', hot_cue_index: 0 };
  const memoryCue = { position_ms: 5000, color: '#00b4d8', label: '', hot_cue_index: -1 };

  it('returns empty stubs when cuePoints is empty', () => {
    const [pco2hot, pco2mem] = buildPco2Sections([]);
    expect(pco2hot.slice(0, 4).toString('ascii')).toBe('PCO2');
    expect(pco2mem.slice(0, 4).toString('ascii')).toBe('PCO2');
  });

  it('slot 1 type field = 1 (hot cues)', () => {
    const [pco2hot] = buildPco2Sections([hotCue]);
    expect(pco2hot.readUInt32BE(12)).toBe(1);
  });

  it('slot 2 type field = 0 (memory cues)', () => {
    const [, pco2mem] = buildPco2Sections([memoryCue]);
    expect(pco2mem.readUInt32BE(12)).toBe(0);
  });

  it('memory cues go to slot 2, not slot 1', () => {
    const [pco2hot, pco2mem] = buildPco2Sections([memoryCue]);
    expect(pco2hot.readUInt16BE(16)).toBe(0); // slot 1: 0 cues
    expect(pco2mem.readUInt16BE(16)).toBe(1); // slot 2: 1 cue
  });

  it('PCP2 color_code for orange (#ff9900) = 3 at no-label color offset', () => {
    const cue = { position_ms: 1000, color: '#ff9900', label: '', hot_cue_index: 0 };
    const [pco2hot] = buildPco2Sections([cue]);
    // PCO2 header=20; PCP2 entry starts at 20.
    // Inside PCP2 buf: colorOff = 44 + labelByteLen(0) = 44.
    // Absolute offset in PCO2 buf: 20 + 44 = 64.
    const colorOff = 20 + 44;
    expect(pco2hot[colorOff]).toBe(3);
  });

  it('PCP2 RGB bytes match hex color for known palette entry', () => {
    const cue = { position_ms: 1000, color: '#ff9900', label: '', hot_cue_index: 0 };
    const [pco2hot] = buildPco2Sections([cue]);
    const colorOff = 20 + 44;
    expect(pco2hot[colorOff + 1]).toBe(0xff); // R
    expect(pco2hot[colorOff + 2]).toBe(0x99); // G
    expect(pco2hot[colorOff + 3]).toBe(0x00); // B
  });
});
