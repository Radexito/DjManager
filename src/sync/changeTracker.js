import { fileFingerprint } from '../db/fileFingerprint.js';

/**
 * What a device needs, decided from revisions instead of from a full rebuild.
 *
 * The input is the current rows for the selection and what the device recorded
 * last time. An unchanged library produces an empty list, which is the result
 * the sync uses to do nothing at all: no audio read, no database write, no job.
 */

/** The ordered membership of a playlist, as stored. Order is part of it. */
export function playlistSignature(trackIds = []) {
  return (trackIds ?? []).join(',');
}

/**
 * @param {object} options
 * @param {object[]} [options.tracks] library rows for the selection
 * @param {Map<number, object>} [options.trackStates] what the device recorded
 * @param {object[]} [options.playlists] `{ id, name, rev, trackIds }`
 * @param {Map<number, object>} [options.playlistStates]
 * @returns {Array<object>} actions in the order they should be shown
 */
export function collectActions({
  tracks = [],
  trackStates = new Map(),
  playlists = [],
  playlistStates = new Map(),
} = {}) {
  const actions = [];

  for (const track of tracks) {
    const state = trackStates.get(track.id);
    if (!state) {
      actions.push({ type: 'copy', trackId: track.id, title: track.title ?? null });
      continue;
    }
    const reasons = [];
    if (Number(state.rev ?? 0) !== Number(track.rev ?? 1)) reasons.push('rev');
    if ((state.file_path ?? null) !== (track.file_path ?? null)) reasons.push('path');
    if ((state.file_fingerprint ?? null) !== (track.file_fingerprint ?? null)) reasons.push('file');
    if (reasons.length > 0) {
      actions.push({
        type: 'update',
        trackId: track.id,
        title: track.title ?? null,
        reasons,
      });
    }
  }

  for (const playlist of playlists) {
    const state = playlistStates.get(playlist.id);
    const signature = playlistSignature(playlist.trackIds ?? []);
    if (!state) {
      actions.push({
        type: 'playlist',
        playlistId: playlist.id,
        name: playlist.name ?? null,
        reason: 'new',
      });
      continue;
    }
    if (
      Number(state.rev ?? 0) !== Number(playlist.rev ?? 1) ||
      (state.signature ?? '') !== signature
    ) {
      actions.push({
        type: 'playlist',
        playlistId: playlist.id,
        name: playlist.name ?? null,
        reason: 'changed',
      });
    }
  }

  return actions;
}

/**
 * Bring stored fingerprints in line with the files, writing only when one moved.
 *
 * This is the one place that touches the filesystem before a sync, and it reads
 * metadata only: size and mtime. A full hash is somebody else's decision, taken
 * only when this value changes. An unchanged library produces zero writes.
 *
 * @param {object} options
 * @param {object[]} options.tracks rows, updated in place
 * @param {function(string): string|null} [options.readFingerprint]
 * @param {function(number, string|null): void} [options.save]
 * @returns {{updated: number, changed: number[]}} ids whose fingerprint moved
 */
export function refreshFileFingerprints({
  tracks = [],
  readFingerprint = fileFingerprint,
  save,
} = {}) {
  let updated = 0;
  const changed = [];
  for (const track of tracks) {
    const actual = readFingerprint(track.file_path ?? null);
    if (actual === (track.file_fingerprint ?? null)) continue;
    save?.(track.id, actual);
    track.file_fingerprint = actual;
    updated += 1;
    changed.push(track.id);
  }
  return { updated, changed };
}
