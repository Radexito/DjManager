import fs from 'fs';
import http from 'http';
import path from 'path';

export const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.opus': 'audio/ogg',
};

const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Pipe a file stream to the HTTP response, destroying the response instead of
 * crashing the process if the file disappears mid-read (e.g. a USB drive is
 * unplugged while a track is streaming). Headers are already sent by this
 * point, so the only option on error is to end the connection cleanly.
 */
export function streamFile(stream, res) {
  stream.on('error', (err) => {
    if (err.code !== 'ENOENT') console.error('[media-server] stream error:', err.message);
    res.destroy();
  });
  stream.pipe(res);
}

/**
 * Whether `filePath` sits inside `base`, judged on a path boundary.
 *
 * A plain `startsWith` answers `/…/music2/secret.mp3` with "yes" when the
 * allowed base is `/…/music`, which serves a sibling directory's files. Both
 * sides are resolved first so `..` cannot be smuggled through either. The same
 * rule guards the explorer allowlist; the two must agree.
 */
export function isInsideBase(filePath, base) {
  if (!base || !filePath) return false;
  const target = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (target === resolvedBase) return true;
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return target.startsWith(prefix);
}

/**
 * Build the HTTP request handler that serves audio files from `audioBase`
 * and optionally artwork files from `artworkBase`.
 * `allowedBases` is a mutable array; entries added at runtime are respected immediately.
 * `previewStreams` (optional): Map of token -> (req, res, corsHeaders) => void,
 * dispatched from /djman-yt-preview/<token>. Lets the cloud-search preview
 * stream yt-dlp output live (play as data arrives) while tee-ing it to a file.
 * Exported separately so it can be called without spinning up a server.
 */
export function createMediaRequestHandler(
  audioBase,
  artworkBase = null,
  allowedBases = [],
  previewStreams = null
) {
  return (req, res) => {
    const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    try {
      let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (previewStreams && urlPath.startsWith('/djman-yt-preview/')) {
        const token = urlPath.slice('/djman-yt-preview/'.length);
        const entry = previewStreams.get(token);
        if (!entry) {
          res.writeHead(404, corsHeaders);
          res.end();
          return;
        }
        entry(req, res, corsHeaders);
        return;
      }
      if (process.platform === 'win32') {
        urlPath = urlPath.slice(1).replace(/\//g, '\\');
      }

      const inAudio = isInsideBase(urlPath, audioBase);
      const inArtwork = isInsideBase(urlPath, artworkBase);
      const inAllowed = allowedBases.some((base) => isInsideBase(urlPath, base));
      if (!inAudio && !inArtwork && !inAllowed) {
        res.writeHead(403, corsHeaders);
        res.end();
        return;
      }

      const stat = fs.statSync(urlPath);
      const total = stat.size;
      const ext = path.extname(urlPath).toLowerCase();
      const mime = IMAGE_MIME[ext] || AUDIO_MIME[ext] || (inArtwork ? 'image/jpeg' : 'audio/mpeg');
      const rangeHeader = req.headers['range'];

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      if (rangeHeader) {
        const [, s, e] = rangeHeader.match(/bytes=(\d+)-(\d*)/) || [];
        const start = parseInt(s, 10);
        const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        res.writeHead(206, {
          ...corsHeaders,
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
        });
        streamFile(fs.createReadStream(urlPath, { start, end }), res);
      } else {
        res.writeHead(200, {
          ...corsHeaders,
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
        });
        streamFile(fs.createReadStream(urlPath), res);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[media-server] error:', err.message);
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, corsHeaders);
      res.end();
    }
  };
}

/**
 * Start the local HTTP media server.
 * @param {string} audioBase    Absolute path to the audio directory.
 * @param {string|null} artworkBase  Optional absolute path to the artwork directory.
 * @param {string[]} allowedBases  Mutable array of extra allowed base paths (explorer-linked dirs).
 * @returns {Promise<{server: http.Server, port: number}>}
 */
export function startMediaServer(
  audioBase,
  artworkBase = null,
  allowedBases = [],
  previewStreams = null
) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(
      createMediaRequestHandler(audioBase, artworkBase, allowedBases, previewStreams)
    );
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`[media-server] listening on http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}
