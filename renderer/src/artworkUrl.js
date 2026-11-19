/**
 * Converts an OS filesystem path (artwork_path from the DB) to a media server URL.
 * Matches the same encoding pattern used by PlayerContext for audio files.
 */
export function artworkUrl(path, mediaPort) {
  if (!path || !mediaPort) return null;
  const posixPath = path.replace(/\\/g, '/');
  const encoded = posixPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `http://127.0.0.1:${mediaPort}/${encoded.replace(/^\//, '')}`;
}
