import { sha256 } from './publication.js';
import { collectActions } from './changeTracker.js';

/**
 * The plan a device needs, as data.
 *
 * Built from revisions, never from a rebuild: the same function serves the
 * preview and the apply, which is what makes "the applied plan is identical to
 * the preview" something that can be asserted instead of promised. The hash is
 * the guard between the two calls: if the library moved in between, the apply
 * refuses instead of executing a plan nobody saw.
 */

/** Stable identity of an action list. */
export function planHash(actions = []) {
  return sha256(Buffer.from(JSON.stringify(actions), 'utf8'));
}

/**
 * @param {object} options
 * @param {object[]} options.playlists `{ id, name, rev, trackIds, tracks }`
 * @param {Map<number, object>} [options.trackStates] what the device carries
 * @param {Map<number, object>} [options.playlistStates]
 * @param {boolean} [options.mirror] remove tracks outside the selection
 * @param {Set<string>} [options.ownedFiles] files this application wrote
 * @param {function(number, object): (string|null)} [options.protect]
 *   returns a reason to keep a track that would otherwise be removed
 * @returns {{actions: object[], summary: object, hash: string}}
 */
export function buildPreview({
  playlists = [],
  trackStates = new Map(),
  playlistStates = new Map(),
  mirror = false,
  ownedFiles = null,
  protect,
} = {}) {
  const trackMap = new Map();
  for (const playlist of playlists) {
    for (const track of playlist.tracks ?? []) {
      if (!trackMap.has(track.id)) trackMap.set(track.id, track);
    }
  }

  const actions = collectActions({
    tracks: [...trackMap.values()],
    trackStates,
    playlists,
    playlistStates,
  });

  if (mirror) {
    const selected = new Set(trackMap.keys());
    for (const [trackId, state] of trackStates) {
      if (selected.has(trackId)) continue;
      const filePath = state?.file_path;
      if (!filePath) continue;
      // Only files this application wrote may ever be removed.
      if (ownedFiles && !ownedFiles.has(filePath)) continue;
      const reason = typeof protect === 'function' ? protect(trackId, state) : null;
      if (reason) {
        actions.push({ type: 'keep', trackId, filePath, reason });
      } else {
        actions.push({ type: 'remove', trackId, filePath });
      }
    }
  }

  const summary = actions.reduce((acc, action) => {
    acc[action.type] = (acc[action.type] ?? 0) + 1;
    return acc;
  }, {});
  return { actions, summary, hash: planHash(actions) };
}
