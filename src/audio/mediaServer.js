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
 * Build the HTTP request handler that serves audio files from `audioBase`
 * and optionally artwork files from `artworkBase`.
 * `allowedBases` is a mutable array; entries added at runtime are respected immediately.
 * Exported separately so it can be unit-tested without spinning up a server.
 */
export function createMediaRequestHandler(audioBase, artworkBase = null, allowedBases = []) {
  return (req, res) => {
    // Allow Web Audio API (createMediaElementSource) to process audio from any
    // renderer origin. In dev mode the renderer runs at localhost:517x while the
    // server is 127.0.0.1:PORT — different origins — so without this header
    // Chromium outputs zeroes and the user hears silence. Applied to every
    // response (including errors, declared outside the try so the catch block
    // can use it too) so cross-origin callers — e.g. the reachability probe in
    // PlayerContext.jsx — get a readable status instead of an opaque
    // CORS-blocked network error.
    const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    try {
      let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (process.platform === 'win32') {
        // URL pathname is '/C:/Users/...' — strip the leading slash and use OS separators
        urlPath = urlPath.slice(1).replace(/\//g, '\\');
      }

      // Security: only serve files inside the managed audio, artwork, or explorer-linked directories.
      const inAudio = urlPath.startsWith(audioBase);
      const inArtwork = artworkBase && urlPath.startsWith(artworkBase);
      const inAllowed = allowedBases.some((base) => urlPath.startsWith(base));
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
export function startMediaServer(audioBase, artworkBase = null, allowedBases = []) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(
      createMediaRequestHandler(audioBase, artworkBase, allowedBases)
    );
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`[media-server] listening on http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}
