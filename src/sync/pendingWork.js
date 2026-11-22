import {
  getDeviceSyncState,
  getPlaylistStates,
  getTrackStates,
} from '../db/deviceStateRepository.js';
import { revisionSummary } from '../db/revision.js';
import { loadManifest } from '../usb/pioneer/manifest.js';
import { readDeviceIdentity } from '../usb/generic/identity.js';
import { collectActions } from './changeTracker.js';

/**
 * Whether a medium needs work, answered without building an export.
 *
 * The fast answer is one indexed query: the library revision key. When it
 * matches what the device recorded, nothing changed and the caller does
 * nothing. When it does not, only the playlists the manifest lists are
 * examined, by revision, so the cost is the selection and never the whole
 * library. Files are not read here at all.
 *
 * @param {object} options
 * @param {string} options.usbRoot
 * @param {function(string): Promise<object>} [options.readIdentity]
 * @param {function(): object} [options.revision]
 * @param {function(): Map} [options.loadTrackStates]
 * @returns {Promise<boolean>} true when a job should run
 */
export async function hasPendingWork({
  usbRoot,
  readIdentity = readDeviceIdentity,
  revision = revisionSummary,
  getState = getDeviceSyncState,
  getTracksState = getTrackStates,
  getPlaylistsState = getPlaylistStates,
  manifestLoader = loadManifest,
  getPlaylist,
  getPlaylistTracks,
} = {}) {
  // A poll is a read. It must not create the fallback marker on the medium.
  const identity = await readIdentity(usbRoot, { createMarker: false });
  if (!identity?.key) return true;

  const state = getState(identity.key);
  if (!state) return true;

  const current = revision();
  if (state.library_revision && state.library_revision === current.key) return false;

  const manifest = manifestLoader(usbRoot);
  const playlistIds = [...manifest.playlists.keys()].filter((id) => getPlaylist(id));
  if (playlistIds.length === 0) return false;

  const playlists = [];
  const trackMap = new Map();
  for (const id of playlistIds) {
    const playlist = getPlaylist(id);
    const tracks = getPlaylistTracks(id);
    for (const track of tracks) trackMap.set(track.id, track);
    playlists.push({
      id,
      name: playlist.name,
      rev: playlist.rev,
      trackIds: tracks.map((track) => track.id),
    });
  }

  const actions = collectActions({
    tracks: [...trackMap.values()],
    trackStates: getTracksState(identity.key),
    playlists,
    playlistStates: getPlaylistsState(identity.key),
  });
  return actions.length > 0;
}
