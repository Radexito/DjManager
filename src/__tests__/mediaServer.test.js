import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { startMediaServer, AUDIO_MIME } from '../audio/mediaServer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert an OS file path to the URL path the media server expects.
 *  On Windows: C:\foo\bar → /C:/foo/bar (server strips the leading slash). */
function toUrlPath(filePath) {
  return '/' + filePath.replace(/\\/g, '/').replace(/^\//, '');
}

/** Make an HTTP GET request and return { status, headers, body (Buffer) }. */
function httpGet(url, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers: reqHeaders }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      })
      .on('error', reject);
  });
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpDir;
let audioBase;
let testFile;
let server;
let port;
const FILE_CONTENT = Buffer.from('FAKEMP3DATA_0123456789ABCDEF'); // 28 bytes

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj_media_test_'));
  audioBase = path.join(tmpDir, 'audio');
  fs.mkdirSync(audioBase, { recursive: true });

  testFile = path.join(audioBase, 'test.mp3');
  fs.writeFileSync(testFile, FILE_CONTENT);

  ({ server, port } = await startMediaServer(audioBase));
});

afterAll(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── AUDIO_MIME table ─────────────────────────────────────────────────────────

describe('AUDIO_MIME', () => {
  it('maps known extensions', () => {
    expect(AUDIO_MIME['.mp3']).toBe('audio/mpeg');
    expect(AUDIO_MIME['.flac']).toBe('audio/flac');
    expect(AUDIO_MIME['.wav']).toBe('audio/wav');
    expect(AUDIO_MIME['.ogg']).toBe('audio/ogg');
    expect(AUDIO_MIME['.m4a']).toBe('audio/mp4');
    expect(AUDIO_MIME['.aac']).toBe('audio/aac');
  });
});

// ── startMediaServer ──────────────────────────────────────────────────────────

describe('startMediaServer', () => {
  it('resolves with a numeric port > 0', () => {
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
  });
});

// ── Full file (no Range header) ───────────────────────────────────────────────

describe('GET — full file', () => {
  it('returns 200 with correct Content-Type for .mp3', async () => {
    const url = `http://127.0.0.1:${port}${toUrlPath(testFile)}`;
    const res = await httpGet(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(parseInt(res.headers['content-length'], 10)).toBe(FILE_CONTENT.length);
    expect(res.body).toEqual(FILE_CONTENT);
  });

  it('serves .flac with audio/flac content-type', async () => {
    const flacFile = path.join(audioBase, 'track.flac');
    fs.writeFileSync(flacFile, Buffer.from('FAKEFLAC'));
    const res = await httpGet(`http://127.0.0.1:${port}${toUrlPath(flacFile)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
  });

  it('falls back to audio/mpeg for unknown extension', async () => {
    const unknownFile = path.join(audioBase, 'track.xyz');
    fs.writeFileSync(unknownFile, Buffer.from('DATA'));
    const res = await httpGet(`http://127.0.0.1:${port}${toUrlPath(unknownFile)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
  });
});

// ── Range requests ────────────────────────────────────────────────────────────

describe('GET with Range header', () => {
  it('returns 206 for a valid byte range', async () => {
    const url = `http://127.0.0.1:${port}${toUrlPath(testFile)}`;
    const res = await httpGet(url, { Range: 'bytes=0-9' });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-9/${FILE_CONTENT.length}`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(parseInt(res.headers['content-length'], 10)).toBe(10);
    expect(res.body).toEqual(FILE_CONTENT.subarray(0, 10));
  });

  it('returns the correct tail slice (open-ended range)', async () => {
    const url = `http://127.0.0.1:${port}${toUrlPath(testFile)}`;
    const start = 10;
    const res = await httpGet(url, { Range: `bytes=${start}-` });
    expect(res.status).toBe(206);
    const expectedEnd = FILE_CONTENT.length - 1;
    expect(res.headers['content-range']).toBe(
      `bytes ${start}-${expectedEnd}/${FILE_CONTENT.length}`
    );
    expect(res.body).toEqual(FILE_CONTENT.subarray(start));
  });

  it('clamps end to file size - 1 when range exceeds file size', async () => {
    const url = `http://127.0.0.1:${port}${toUrlPath(testFile)}`;
    const res = await httpGet(url, { Range: `bytes=0-99999` });
    expect(res.status).toBe(206);
    const expectedEnd = FILE_CONTENT.length - 1;
    expect(res.headers['content-range']).toBe(`bytes 0-${expectedEnd}/${FILE_CONTENT.length}`);
    expect(res.body).toEqual(FILE_CONTENT);
  });
});

// ── Security ──────────────────────────────────────────────────────────────────

describe('Security — path restriction', () => {
  it('returns 403 for a path outside audioBase', async () => {
    const outsidePath = path.join(tmpDir, '..', 'etc', 'passwd');
    const res = await httpGet(`http://127.0.0.1:${port}${toUrlPath(outsidePath)}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a path traversal attempt', async () => {
    // Build traversal using forward-slash form (works cross-platform)
    const traversal = toUrlPath(audioBase) + '/../../../etc/passwd';
    const encoded = encodeURIComponent(traversal);
    const res = await httpGet(`http://127.0.0.1:${port}/${encoded}`);
    expect(res.status).toBe(403);
  });
});

// ── Not found ─────────────────────────────────────────────────────────────────

describe('GET — missing file', () => {
  it('returns 404 for a non-existent file inside audioBase', async () => {
    const missing = path.join(audioBase, 'nope.mp3');
    const res = await httpGet(`http://127.0.0.1:${port}${toUrlPath(missing)}`);
    expect(res.status).toBe(404);
  });
});
