import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createYtPreviewRegistry,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TTL_MS,
} from '../main/ytPreview.js';

let dir;

/** A stand-in for the yt-dlp child process: only the parts the registry uses. */
function fakeStream({ fail = false } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout.pipe = vi.fn(() => {});
  proc.kill = vi.fn();
  proc.finish = (code = fail ? 1 : 0) => proc.emit('close', code);
  return proc;
}

/** Records the status, headers and body written by the preview handler. */
function fakeResponse() {
  return {
    status: null,
    headers: null,
    written: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.written = body ?? '';
    },
  };
}

/**
 * Creates a preview registry on the temp directory with a fake stream factory.
 *
 * @param {object} [overrides] Stream failure flag, clock, TTL, concurrency and entry limits.
 * @returns {object} The registry plus the stream processes it created.
 */
function build(overrides = {}) {
  const procs = [];
  const registry = createYtPreviewRegistry({
    createStream: vi.fn(() => {
      const proc = fakeStream(overrides.failStream);
      procs.push(proc);
      return proc;
    }),
    previewDir: dir,
    getMediaServerPort: () => 4321,
    now: () => overrides.nowValue ?? Date.now(),
    ttlMs: overrides.ttlMs ?? DEFAULT_TTL_MS,
    maxConcurrent: overrides.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    maxEntries: overrides.maxEntries ?? 20,
    ...overrides.extra,
  });
  return { registry, procs };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytpreview-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createYtPreviewRegistry', () => {
  it('issues an opaque token per registration', () => {
    const { registry } = build();
    const a = registry.register('https://youtu.be/a');
    const b = registry.register('https://youtu.be/b');

    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('expires a token after the ttl and takes its file with it', () => {
    let clock = 1000;
    const registry = createYtPreviewRegistry({
      createStream: () => fakeStream(),
      previewDir: dir,
      getMediaServerPort: () => 4321,
      now: () => clock,
      ttlMs: 1000,
    });

    const token = registry.register('https://youtu.be/a');
    const filePath = path.join(dir, `${token}.m4a`);
    fs.writeFileSync(filePath, 'buffered');

    expect(registry.streams.get(token)).toBeTypeOf('function');
    expect(fs.existsSync(filePath)).toBe(true);

    clock += 1001;

    expect(registry.streams.get(token)).toBeUndefined();
    expect(registry.size()).toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('drops the oldest token once the entry cap is reached', () => {
    const { registry } = build({ maxEntries: 2 });
    const first = registry.register('https://youtu.be/1');
    registry.register('https://youtu.be/2');
    registry.register('https://youtu.be/3');

    expect(registry.size()).toBe(2);
    expect(registry.streams.get(first)).toBeUndefined();
  });

  it('refuses a new stream once the concurrency cap is reached', () => {
    const { registry, procs } = build({ maxConcurrent: 1 });
    const one = registry.register('https://youtu.be/1');
    const two = registry.register('https://youtu.be/2');

    const firstRes = fakeResponse();
    registry.streams.get(one)({}, firstRes, {});
    expect(firstRes.status).toBe(200);
    expect(registry.activeStreams()).toBe(1);

    const secondRes = fakeResponse();
    registry.streams.get(two)({}, secondRes, {});
    expect(secondRes.status).toBe(503);
    expect(secondRes.written).toBe('too many previews');
    expect(procs).toHaveLength(1);

    procs[0].finish(0);
    expect(registry.activeStreams()).toBe(0);
    const retryRes = fakeResponse();
    registry.streams.get(two)({}, retryRes, {});
    expect(retryRes.status).toBe(200);
  });

  it('rejects a second concurrent play on the same token', () => {
    const { registry } = build({ maxConcurrent: 3 });
    const token = registry.register('https://youtu.be/a');
    const entry = registry.streams.get(token);

    entry({}, fakeResponse(), {});
    const second = fakeResponse();
    entry({}, second, {});

    expect(second.status).toBe(503);
    expect(second.written).toBe('still buffering');
  });

  it('serves an expired token as missing rather than resolving a file', () => {
    let clock = 0;
    const registry = createYtPreviewRegistry({
      createStream: () => fakeStream(),
      previewDir: dir,
      getMediaServerPort: () => 4321,
      now: () => clock,
      ttlMs: 10,
    });
    const token = registry.register('https://youtu.be/a');
    clock = 11;

    expect(registry.streams.get(token)).toBeUndefined();
  });

  it('swallows a buffer write error instead of taking the process down', () => {
    const fileStream = new EventEmitter();
    fileStream.pipe = vi.fn();
    const logs = [];
    const registry = createYtPreviewRegistry({
      createStream: () => fakeStream(),
      previewDir: dir,
      getMediaServerPort: () => 4321,
      log: (line) => logs.push(line),
      fsImpl: {
        ...fs,
        createWriteStream: () => fileStream,
      },
    });

    const token = registry.register('https://youtu.be/a');
    expect(() => {
      registry.streams.get(token)({}, fakeResponse(), {});
      fileStream.emit('error', new Error('ENOENT: buffer gone'));
    }).not.toThrow();
    expect(fileStream.listenerCount('error')).toBe(1);
    expect(logs.join('\n')).toMatch(/buffer write failed/);
  });
});
