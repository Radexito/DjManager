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
 * Build the HTTP request handler that serves audio files from `audioBase`
 * and optionally artwork files from `artworkBase`.
 * Exported separately so it can be unit-tested without spinning up a server.
 */
export function createMediaRequestHandler(audioBase, artworkBase = null) {
  return (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

      // Security: only serve files inside the managed audio or artwork directories.
      const inAudio = urlPath.startsWith(audioBase);
      const inArtwork = artworkBase && urlPath.startsWith(artworkBase);
      if (!inAudio && !inArtwork) {
        res.writeHead(403);
        res.end();
        return;
      }

      const stat = fs.statSync(urlPath);
      const total = stat.size;
      const ext = path.extname(urlPath).toLowerCase();
      const mime = IMAGE_MIME[ext] || AUDIO_MIME[ext] || (inArtwork ? 'image/jpeg' : 'audio/mpeg');
      const rangeHeader = req.headers['range'];

      if (rangeHeader) {
        const [, s, e] = rangeHeader.match(/bytes=(\d+)-(\d*)/) || [];
        const start = parseInt(s, 10);
        const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
        });
        fs.createReadStream(urlPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
        });
        fs.createReadStream(urlPath).pipe(res);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[media-server] error:', err.message);
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end();
    }
  };
}

/**
 * Start the local HTTP media server.
 * @param {string} audioBase    Absolute path to the audio directory.
 * @param {string|null} artworkBase  Optional absolute path to the artwork directory.
 * @returns {Promise<{server: http.Server, port: number}>}
 */
export function startMediaServer(audioBase, artworkBase = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createMediaRequestHandler(audioBase, artworkBase));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`[media-server] listening on http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}
