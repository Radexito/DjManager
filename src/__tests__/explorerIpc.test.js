import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registerExplorerIpc } from '../main/ipc/explorerIpc.js';
import { createRuntime } from '../main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-explorer-'));
fs.writeFileSync(path.join(root, 'b-song.mp3'), 'x');
fs.writeFileSync(path.join(root, 'a-song.flac'), 'x');
fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
fs.mkdirSync(path.join(root, 'nested'));
fs.writeFileSync(path.join(root, 'nested', 'deep.m4a'), 'x');
fs.mkdirSync(path.join(root, '.hidden'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * Wires the explorer handlers against a real runtime and a fake directory dialog.
 *
 * @param {object} deps Replacements for individual dependencies.
 * @returns {object} Registered handlers, sent messages, the runtime and a `call` helper.
 */
function setup(deps = {}) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };
  const sent = [];
  const runtime = createRuntime();

  registerExplorerIpc({
    ipcMain,
    runtime,
    send: (channel, data) => sent.push([channel, data]),
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [root] })),
    getMainWindow: () => ({ id: 'window' }),
    runFfprobe: vi.fn(async () => ({
      format: { duration: '215.5', bit_rate: '320000', tags: { title: 'T', artist: 'A' } },
      streams: [{ codec_type: 'audio', bit_rate: '320000' }],
    })),
    ...deps,
  });

  return { handlers, sent, runtime, call: (ch, payload) => handlers.get(ch)({}, payload) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('registerExplorerIpc', () => {
  it('registers the five explorer channels', async () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'browse-directory',
      'explorer-cancel-recursive',
      'explorer-start-recursive',
      'get-explorer-track-metadata',
      'select-explorer-folder',
    ]);
  });

  it('returns the picked folder and lets the media server serve it', async () => {
    const { call, runtime } = setup();
    expect(await call('select-explorer-folder')).toBe(root);
    expect(runtime.explorerAllowedBases).toContain(root);
  });

  it('returns null when the user cancels the dialog', async () => {
    const { call, runtime } = setup({
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    expect(await call('select-explorer-folder')).toBeNull();
    expect(runtime.explorerAllowedBases).toEqual([]);
  });

  it('lists sorted directories and audio files, skipping dot dirs and other files', async () => {
    const { call } = setup();
    const res = await call('browse-directory', root);

    expect(res.dirs.map((d) => d.name)).toEqual(['nested']);
    expect(res.files.map((f) => f.name)).toEqual(['a-song.flac', 'b-song.mp3']);
    expect(res.files[0].size).toBeGreaterThan(0);
  });

  it('degrades to empty lists with the message when the directory cannot be read', async () => {
    const { call } = setup();
    const res = await call('browse-directory', path.join(root, 'does-not-exist'));
    expect(res.dirs).toEqual([]);
    expect(res.files).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it('maps ffprobe tags into the metadata the details pane needs', async () => {
    const { call } = setup({
      runFfprobe: vi.fn(async () => ({
        format: {
          duration: '215.5',
          bit_rate: '320000',
          tags: { title: 'Title', artist: 'Artist', genre: 'House, Techno', date: '2019-05-01' },
        },
        streams: [{ codec_type: 'audio', bit_rate: '320000' }],
      })),
    });

    const res = await call('get-explorer-track-metadata', path.join(root, 'b-song.mp3'));

    expect(res).toMatchObject({
      title: 'Title',
      artist: 'Artist',
      year: 2019,
      genre: ['House', 'Techno'],
      duration: 215.5,
      bitrate: 320000,
    });
  });

  it('falls back to the file name when ffprobe cannot read the file', async () => {
    const { call } = setup({
      runFfprobe: vi.fn(async () => {
        throw new Error('unreadable file');
      }),
    });

    const res = await call('get-explorer-track-metadata', path.join(root, 'b-song.mp3'));

    expect(res).toMatchObject({ title: 'b-song', artist: '', error: 'unreadable file' });
  });

  it('walks into subdirectories and reports batches, then done', async () => {
    const { call, sent, runtime } = setup();

    expect(await call('explorer-start-recursive', root)).toEqual({ ok: true });
    await flush();

    const names = sent
      .filter(([channel]) => channel === 'explorer-recursive-batch')
      .flatMap(([, batch]) => batch.map((f) => f.name));

    expect(names.sort()).toEqual(['a-song.flac', 'b-song.mp3', 'deep.m4a']);
    expect(sent.at(-1)).toEqual(['explorer-recursive-done', null]);
    expect(runtime.activeRecursiveWalker).toBeTruthy();
    expect(runtime.explorerAllowedBases).toContain(root);
  });

  it('stops a walk that was cancelled', async () => {
    const { call, sent } = setup();

    await call('explorer-start-recursive', root);
    await call('explorer-cancel-recursive');
    await flush();

    expect(sent.some(([channel]) => channel === 'explorer-recursive-done')).toBe(false);
  });
});
