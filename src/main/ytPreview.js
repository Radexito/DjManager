/**
 * Live YouTube preview registry (faza 6 hardening, tor B).
 *
 * A preview is a yt-dlp process whose stdout is streamed to the response while
 * the same bytes are tee-ed into a temp file, so a replay after the stream ends
 * is instant and seekable. Each preview is addressed by an opaque token:
 * `http://127.0.0.1:<port>/djman-yt-preview/<token>`.
 *
 * The registry exists because the naive shape had three holes:
 *   - tokens never expired, so the map and the temp files grew for the whole
 *     lifetime of the process;
 *   - nothing limited concurrent yt-dlp processes, so a burst of clicks meant a
 *     burst of transcodes;
 *   - entries were never removed, so a long session accumulated closures and
 *     files nobody could reach again.
 *
 * The map handed to the media server only ever exposes `get`, and `get` decides
 * on expiry itself, so a stale token cannot resolve to a file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
/**
 * How many preview streams may run at once. Three is enough to compare a few
 * candidates back to back while keeping a burst of clicks from starting a burst
 * of yt-dlp transcodes.
 */
export const DEFAULT_MAX_CONCURRENT = 3;
/**
 * How many previews the registry keeps before evicting the oldest. Each entry
 * owns a temp file and a closure, so the map cannot grow for a whole session.
 */
export const DEFAULT_MAX_ENTRIES = 20;

/**
 * Create the live preview registry: start a stream under an opaque token, serve
 * it from the media server, and drop it when it expires or is evicted.
 * @param {object} deps
 * @param {function(string, object): object} deps.createStream stream factory
 * @param {string} deps.previewDir directory for the tee-ed temp files
 * @param {function(): number} deps.getMediaServerPort
 * @param {function(): number} [deps.now] clock, injectable for tests
 * @param {number} [deps.ttlMs] entry lifetime
 * @param {number} [deps.maxConcurrent] concurrent stream limit
 * @param {number} [deps.maxEntries] entries kept before eviction
 * @returns {object} the registry, whose map only exposes `get`
 */
export function createYtPreviewRegistry({
  createStream,
  previewDir,
  getMediaServerPort,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxEntries = DEFAULT_MAX_ENTRIES,
  fsImpl = fs,
  log = () => {},
}) {
  if (typeof createStream !== 'function') throw new Error('createYtPreviewRegistry: createStream');
  if (!previewDir) throw new Error('createYtPreviewRegistry: previewDir is required');

  const entries = new Map();
  let activeStreams = 0;

  const removeEntry = (token) => {
    const entry = entries.get(token);
    if (!entry) return;
    entries.delete(token);
    try {
      fsImpl.unlinkSync(entry.filePath);
    } catch {}
    log(`[yt-preview] expired ${token}`);
  };

  /** Drop entries older than the TTL. Called on write and on read. */
  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [token, entry] of entries) {
      if (entry.createdAt <= cutoff) removeEntry(token);
    }
  };

  /**
   * Reserve a token for `url`. Oldest entries are dropped before the limit is
   * exceeded, so a caller hammering previews cannot grow the map without bound.
   */
  function register(url, cookiesBrowser = null) {
    sweep();
    while (entries.size >= maxEntries) {
      const oldest = [...entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      removeEntry(oldest[0]);
    }

    const token = crypto.randomUUID();
    const filePath = path.join(previewDir, `${token}.m4a`);
    let streaming = false;
    let fileDone = false;

    const entry = (req, res, corsHeaders) => {
      if (fileDone && fsImpl.existsSync(filePath)) {
        res.writeHead(302, {
          ...corsHeaders,
          Location: `http://127.0.0.1:${getMediaServerPort()}${encodeURI(filePath)}`,
        });
        res.end();
        return;
      }
      if (streaming) {
        res.writeHead(503, corsHeaders);
        res.end('still buffering');
        return;
      }
      if (activeStreams >= maxConcurrent) {
        res.writeHead(503, corsHeaders);
        res.end('too many previews');
        return;
      }

      streaming = true;
      activeStreams += 1;
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'audio/mp4',
        'Cache-Control': 'no-store',
      });

      const proc = createStream(url, { cookiesBrowser });
      let gotData = false;
      const stallTimer = setTimeout(() => {
        if (!gotData) proc.kill();
      }, 45000);
      if (typeof stallTimer.unref === 'function') stallTimer.unref();

      proc.stdout.on('data', () => {
        gotData = true;
      });
      proc.stderr.on('data', () => {});
      const fileStream = fsImpl.createWriteStream(filePath);
      if (typeof fileStream.on === 'function') {
        fileStream.on('error', (err) => {
          log(`[yt-preview] buffer write failed: ${err.message}`);
        });
      }
      proc.stdout.pipe(fileStream);
      proc.stdout.pipe(res);

      const finish = (code) => {
        clearTimeout(stallTimer);
        streaming = false;
        activeStreams -= 1;
        if (code === 0 && fsImpl.existsSync(filePath) && fsImpl.statSync(filePath).size > 0) {
          fileDone = true;
        } else {
          try {
            fsImpl.unlinkSync(filePath);
          } catch {}
        }
      };
      proc.on('close', finish);
      proc.on('error', () => finish(-1));
    };

    entries.set(token, { entry, createdAt: now(), filePath });

    const expiry = setTimeout(() => removeEntry(token), ttlMs);
    if (typeof expiry.unref === 'function') expiry.unref();

    return token;
  }

  return {
    register,
    streams: {
      get: (token) => {
        sweep();
        return entries.get(token)?.entry;
      },
    },
    size: () => entries.size,
    activeStreams: () => activeStreams,
    sweep,
  };
}
