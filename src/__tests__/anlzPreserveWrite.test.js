import { describe, it, expect, vi, beforeEach } from 'vitest';

const written = new Map();
let existingBySuffix = new Map();

const fsMock = {
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn((p, buf) => {
    written.set(String(p), Buffer.from(buf));
  }),
  readFileSync: vi.fn((p) => {
    const name = String(p);
    for (const [suffix, buf] of existingBySuffix) {
      if (name.endsWith(suffix)) return buf;
    }
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
  statSync: vi.fn(() => ({ size: 1234 })),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
};

vi.mock('fs', () => ({ default: fsMock, ...fsMock }));

vi.mock('../audio/waveformGenerator.js', () => ({
  generateWaveform: vi.fn().mockResolvedValue({
    pwv3: Buffer.alloc(50, 0x01),
    pwv5: Buffer.alloc(60, 0x02),
    pwav: Buffer.alloc(400, 0x03),
    pwv2: Buffer.alloc(100, 0x04),
    pwv4: Buffer.alloc(7200, 0x05),
    pwv7: Buffer.alloc(300, 0x06),
    pwv6: Buffer.alloc(3600, 0x07),
    numCols: 100,
  }),
}));

const { writeAnlz, parseAnlzSections } = await import('../usb/pioneer/formats/anlz.js');
const { buildPssi, readPhrasesFromAnlz } = await import('../usb/pioneer/formats/pssi.js');

/** Builds one ANLZ section: a 12-byte header followed by the payload. */
function section(tag, payload, lenHeader = 12) {
  const header = Buffer.alloc(12);
  header.write(tag, 0, 4, 'ascii');
  header.writeUInt32BE(lenHeader, 4);
  header.writeUInt32BE(payload.length + 12, 8);
  return Buffer.concat([header, payload]);
}

/** Wraps the given sections in a PMAI container whose header accounts for their total length. */
function container(...sections) {
  const head = Buffer.alloc(28);
  head.write('PMAI', 0, 4, 'ascii');
  head.writeUInt32BE(28, 4);
  head.writeUInt32BE(28 + sections.reduce((s, b) => s + b.length, 0), 8);
  return Buffer.concat([head, ...sections]);
}

describe('writeAnlz keeps what it cannot generate', () => {
  beforeEach(() => {
    written.clear();
    existingBySuffix = new Map();
  });

  it('carries a PSSI section from an existing EXT into the rewritten file', async () => {
    const pssi = section('PSSI', Buffer.alloc(72, 0x5a), 32);
    const oldExt = container(
      section('PPTH', Buffer.alloc(6, 0x01)),
      section('PQT2', Buffer.alloc(8)),
      pssi
    );
    existingBySuffix.set('ANLZ0000.EXT', oldExt);

    await writeAnlz({
      usbFilePath: '/Contents/Artist/Album/track.mp3',
      sourceFilePath: '/music/track.mp3',
      beatgrid: [0.5, 1.0, 1.5, 2.0],
      bpm: 128,
      usbRoot: '/usb',
      cuePoints: [],
    });

    const extKey = [...written.keys()].find((k) => k.endsWith('ANLZ0000.EXT'));
    const produced = written.get(extKey);
    expect(produced).toBeTruthy();

    const tags = parseAnlzSections(produced).map((s) => s.tag);
    expect(tags).toContain('PSSI');

    const keptPssi = parseAnlzSections(produced).find((s) => s.tag === 'PSSI');
    expect(keptPssi.raw.equals(pssi)).toBe(true);
    expect(produced.length).toBe(produced.readUInt32BE(8));
  });

  it('says out loud that the phrases survived, and keeps the same table', async () => {
    const records = [
      [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [2, 33, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [3, 65, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ];
    const realPssi = buildPssi(records, { form: 'stick', mood: 2 });
    const oldExt = container(
      section('PPTH', Buffer.alloc(6, 0x01)),
      section('PQT2', Buffer.alloc(8)),
      realPssi
    );
    existingBySuffix.set('ANLZ0000.EXT', oldExt);

    const logged = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args) => logged.push(args.join(' ')));
    await writeAnlz({
      usbFilePath: '/Contents/Artist/Album/track.mp3',
      sourceFilePath: '/music/track.mp3',
      beatgrid: [0.5, 1.0, 1.5, 2.0],
      bpm: 128,
      usbRoot: '/usb',
      cuePoints: [],
    });
    spy.mockRestore();

    const extKey = [...written.keys()].find((k) => k.endsWith('ANLZ0000.EXT'));
    const produced = written.get(extKey);
    const kept = readPhrasesFromAnlz(produced);
    expect(kept.phrases).toHaveLength(3);
    expect(kept.phrases.map((p) => p.label)).toEqual(['INTRO', 'VERSE 1', 'CHORUS']);
    expect(logged.join('\n')).toMatch(/phrases kept: 3/);
  });

  it('does not duplicate sections the writer produces itself', async () => {
    const oldExt = container(
      section('PPTH', Buffer.alloc(6, 0x01)),
      section('PQT2', Buffer.alloc(8))
    );
    existingBySuffix.set('ANLZ0000.EXT', oldExt);

    await writeAnlz({
      usbFilePath: '/Contents/Artist/Album/track.mp3',
      sourceFilePath: '/music/track.mp3',
      beatgrid: [0.5, 1.0],
      bpm: 120,
      usbRoot: '/usb',
      cuePoints: [],
    });

    const extKey2 = [...written.keys()].find((k) => k.endsWith('ANLZ0000.EXT'));
    const tags = parseAnlzSections(written.get(extKey2)).map((s) => s.tag);
    expect(tags.filter((t) => t === 'PPTH')).toHaveLength(1);
    expect(tags.filter((t) => t === 'PQT2')).toHaveLength(1);
  });
});
