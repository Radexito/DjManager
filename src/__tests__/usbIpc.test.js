import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registerUsbIpc } from '../main/ipc/usbIpc.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-usbipc-'));
const linkedFile = path.join(root, 'linked.mp3');
fs.writeFileSync(linkedFile, 'x');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * Wires the USB handlers against stub repositories, manifest and export helpers.
 *
 * @param {object} overrides Replacements for individual dependencies.
 * @returns {object} Registered handlers, sent messages, captured audit lines, deps and `call`.
 */
function setup(overrides = {}) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };
  const sent = [];
  const tracks = new Map([
    [1, { id: 1, file_path: linkedFile, is_linked: 1 }],
    [2, { id: 2, file_path: path.join(root, 'gone.mp3'), is_linked: 1 }],
    [3, { id: 3, file_path: path.join(root, 'missing.mp3'), is_linked: 0 }],
  ]);
  const audit = [];
  const deps = {
    ipcMain,
    send: (channel, data) => sent.push([channel, data]),
    logAudit: (message) => audit.push(message),
    getTrackById: vi.fn((id) => tracks.get(id)),
    getLinkedTracksBasic: vi.fn(() => [{ id: 1, title: 'Linked' }]),
    detectFilesystem: vi.fn(async () => ({ fs: 'exfat', label: 'STICK' })),
    describeFilesystem: vi.fn((fsName) => (fsName === 'exfat' ? 'exFAT' : fsName)),
    formatDrive: vi.fn(async () => {}),
    getSetting: vi.fn(() => '-9'),
    copyTrackToUsb: vi.fn(),
    loadManifest: vi.fn(() => ({ tracks: new Map(), playlists: new Map() })),
    saveManifest: vi.fn(),
    reuseExistingUsbTrack: vi.fn(() => null),
    resolveExportSampleInfo: vi.fn(() => ({})),
    writeAnlz: vi.fn(),
    writePdb: vi.fn(),
    sampleInfoFromProbe: vi.fn(() => ({ sampleRate: 44100, bitDepth: 16 })),
    writeSettingFiles: vi.fn(),
    scanUsbCues: vi.fn(() => ({ ok: true, scanned: 7 })),
    applyUsbCues: vi.fn(() => ({ ok: true, added: 3 })),
    getCuePoints: vi.fn(() => []),
    getPlaylist: vi.fn(() => ({ id: 'p1', name: 'Set' })),
    getPlaylistTracks: vi.fn(() => []),
    getPlaylists: vi.fn(() => [{ id: 'p1', name: 'Set' }]),
    getFfmpegRuntimePath: vi.fn(() => '/usr/bin/ffmpeg'),
    backfillPdbSampleInfo: vi.fn(),
    runPdbExporter: vi.fn(async () => {}),
    resolveExportFormat: vi.fn(() => null),
    resolveExportTrim: vi.fn(() => null),
    exportDurationSec: vi.fn(() => 200),
    writeExportTags: vi.fn(),
    trackToFilename: vi.fn((t) => `${t.id}.mp3`),
    exportRunner: {
      plan: vi.fn(() => ({ tracks: [], playlists: [], cues: new Map(), options: {} })),
      fingerprint: vi.fn(() => 'test-fingerprint'),
      run: vi.fn(async ({ plan }) => ({
        fingerprint: 'test-fingerprint',
        summary: {
          trackCount: plan.tracks.length,
          newTrackCount: plan.tracks.length,
          playlistCount: plan.playlists.length,
        },
      })),
    },
    syncService: {
      runJob: vi.fn(async ({ execute }) => execute({ usbRoot: root })),
    },
    ...overrides,
  };
  registerUsbIpc(deps);
  return { handlers, sent, audit, deps, call: (ch, ...args) => handlers.get(ch)({}, ...args) };
}

describe('registerUsbIpc', () => {
  it('registers the eight USB channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'check-linked-track-status',
      'check-usb-format',
      'export-all',
      'export-explorer-to-usb',
      'format-usb',
      'get-linked-tracks-basic',
      'import-usb-cues',
      'scan-usb-cues',
    ]);
  });

  it('reports linked tracks as missing when their file is gone', async () => {
    const { call } = setup();
    await expect(call('check-linked-track-status', [1, 2, 3, 99])).resolves.toEqual([
      { id: 1, exists: true },
      { id: 2, exists: false },
      { id: 3, exists: true },
      { id: 99, exists: false },
    ]);
  });

  it('passes the basic linked-track list straight through', async () => {
    const { call, deps } = setup();
    await expect(call('get-linked-tracks-basic')).resolves.toEqual([{ id: 1, title: 'Linked' }]);
    expect(deps.getLinkedTracksBasic).toHaveBeenCalledTimes(1);
  });

  it('probes the filesystem and adds a human label', async () => {
    const { call, deps } = setup();
    await expect(call('check-usb-format', '/media/stick')).resolves.toEqual({
      fs: 'exfat',
      label: 'STICK',
      fsLabel: 'exFAT',
    });
    expect(deps.detectFilesystem).toHaveBeenCalledWith('/media/stick');
  });

  it('formats the drive and always clears the progress bar', async () => {
    const { call, sent } = setup();
    await expect(
      call('format-usb', { device: '/dev/sdb', mountPoint: '/media/stick', confirm: true })
    ).resolves.toEqual({ ok: true });
    expect(sent.at(-1)).toEqual(['format-usb-progress', null]);
  });

  it('refuses to format without an explicit confirmation in the payload', async () => {
    const refused = [undefined, {}, { confirm: false }, { confirm: 'yes' }, { confirm: 1 }];

    for (const payload of refused) {
      const { call, deps, audit } = setup();
      const res = await call('format-usb', payload);

      expect(res, JSON.stringify(payload)).toMatchObject({ ok: false });
      expect(deps.formatDrive).not.toHaveBeenCalled();
      expect(audit.join('\n')).toContain('REFUSED');
    }
  });

  it('writes the audit trail for a formatting that was carried out', async () => {
    const { call, audit } = setup();
    await call('format-usb', { device: '/dev/sdb', mountPoint: '/media/stick', confirm: true });

    expect(audit.join('\n')).toContain('device=/dev/sdb');
    expect(audit.join('\n')).toContain('finished');
  });

  it('returns a failure object when formatting throws', async () => {
    const { call, sent, audit } = setup({
      formatDrive: vi.fn(async () => {
        throw new Error('device busy');
      }),
    });
    await expect(
      call('format-usb', { device: '/dev/sdb', mountPoint: '/m', confirm: true })
    ).resolves.toMatchObject({
      ok: false,
      code: 'failed',
      error: 'device busy',
      message: 'device busy',
    });
    expect(sent.at(-1)).toEqual(['format-usb-progress', null]);
    expect(audit.join('\n')).toContain('failed: device busy');
  });

  it('forwards USB cue scanning and importing to the injected helpers', async () => {
    const { call, deps } = setup();
    await expect(call('scan-usb-cues', { usbRoot: root, mode: 'extend' })).resolves.toEqual({
      ok: true,
      scanned: 7,
    });
    await expect(call('import-usb-cues', { usbRoot: root, mode: 'extend' })).resolves.toEqual({
      ok: true,
      added: 3,
    });
    expect(deps.scanUsbCues).toHaveBeenCalledWith(root, 'extend');
    expect(deps.applyUsbCues).toHaveBeenCalledWith(root, 'extend');
  });

  it('turns a throwing cue scan into a failure object', async () => {
    const { call } = setup({
      scanUsbCues: vi.fn(() => {
        throw new Error('unreadable');
      }),
    });
    await expect(call('scan-usb-cues', { usbRoot: root })).resolves.toMatchObject({
      ok: false,
      code: 'failed',
      error: 'unreadable',
    });
  });

  it('exports nothing for an empty library but still answers', async () => {
    const { call } = setup({
      getPlaylist: vi.fn(() => ({ id: 'p1', name: 'Set' })),
      getPlaylistTracks: vi.fn(() => []),
    });
    const res = await call('export-all', { usbRoot: root, playlistId: 'p1' });
    expect(res).toMatchObject({ ok: true, trackCount: 0, newTrackCount: 0 });
  });

  it('exports loose explorer files to a stick with a PDB and progress', async () => {
    const usbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-explorer-usb-'));
    const src = path.join(root, 'loose track.mp3');
    fs.writeFileSync(src, 'audio-bytes');

    const { call, sent, deps } = setup();
    const res = await call('export-explorer-to-usb', {
      filePaths: [src],
      usbRoot,
      playlistName: 'My Set',
    });

    expect(res).toMatchObject({ ok: true, trackCount: 1, usbRoot });
    const copied = fs.readdirSync(path.join(usbRoot, 'Contents'));
    expect(copied).toHaveLength(1);
    expect(fs.readFileSync(path.join(usbRoot, 'Contents', copied[0]), 'utf8')).toBe('audio-bytes');

    expect(deps.writePdb).toHaveBeenCalledTimes(1);
    const [payload, outputPath] = deps.writePdb.mock.calls[0];
    expect(outputPath).toBe(path.join(usbRoot, 'PIONEER', 'rekordbox', 'export.pdb'));
    expect(payload.playlists[0].name).toBe('My Set');
    expect(payload.tracks[0].file_path).toContain('/Contents/');

    const progress = sent.filter(([ch]) => ch === 'export-explorer-progress').map(([, d]) => d);
    expect(progress.at(-1)).toBeNull();

    fs.rmSync(usbRoot, { recursive: true, force: true });
  });

  it('keeps two files that differ only by case apart on a FAT32 stick', async () => {
    const usbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-explorer-usb2-'));
    const a = path.join(root, 'Track.mp3');
    const b = path.join(root, 'track.mp3');
    fs.writeFileSync(a, 'first');
    fs.writeFileSync(b, 'second');

    const { call } = setup();
    await call('export-explorer-to-usb', { filePaths: [a, b], usbRoot });

    const copied = fs.readdirSync(path.join(usbRoot, 'Contents'));
    expect(copied).toHaveLength(2);

    fs.rmSync(usbRoot, { recursive: true, force: true });
  });
});
