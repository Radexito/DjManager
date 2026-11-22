import { buildCueImportPlan } from '../../usb/pioneer/formats/cues.js';
import { SyncError } from '../../sync/errors.js';
import { buildPreview } from '../../sync/preview.js';
import { moveToTrash, pruneTrash } from '../../sync/trash.js';

/**
 * Selective sync: a stored selection per device, a plan the user can see, and an
 * apply that executes exactly that plan.
 *
 * The preview and the apply share `buildPreview`, so the action list shown is the
 * action list executed. The hash of the list travels back to the apply and is
 * checked again: if the library moved between the two calls the apply refuses
 * instead of doing something nobody saw.
 */
export function createSelectiveSyncService({
  readIdentity,
  getSelection,
  saveSelection,
  saveLastPlan,
  getLastPlan,
  getTrackStates,
  getPlaylistStates,
  loadManifest,
  getPlaylist,
  getPlaylistTracks,
  getCuePoints,
  readTrackCues,
  exportRunner,
  syncService,
  recordExportState,
  getRetentionMs = () => 7 * 24 * 60 * 60 * 1000,
  now = Date.now,
  log = () => {},
} = {}) {
  /** Resolve the device and the playlists it is meant to carry. */
  async function resolve(usbRoot) {
    const identity = await readIdentity(usbRoot, { createMarker: false });
    if (!identity?.key) {
      throw new SyncError('missing-identity', 'The medium has no usable identity yet');
    }
    const stored = getSelection(identity.key);
    const playlists = [];
    for (const id of stored.playlists) {
      const playlist = getPlaylist(id);
      if (!playlist) continue;
      const tracks = getPlaylistTracks(id);
      playlists.push({
        id,
        name: playlist.name,
        rev: playlist.rev,
        trackIds: tracks.map((track) => track.id),
        tracks,
      });
    }
    return { identity, stored, playlists };
  }

  /**
   * Why a track that mirror mode would remove must be kept.
   * Cues a player wrote and the library never imported are the device's own
   * data: the file comes back only after those were imported. The comparison is
   * the cue import plan, which already knows that a hot cue belongs to a slot
   * and that a memory cue matches within a tolerance, instead of comparing raw
   * field names. History lives in the encrypted library (#10) and is not read
   * here yet, which is stated in the plan as a reason the removal is unverified.
   */
  function protectionFor(usbRoot) {
    return (trackId, state) => {
      if (!state?.file_path) return 'no-file';
      try {
        const deviceCues = readTrackCues(usbRoot, state.file_path) ?? [];
        if (deviceCues.length === 0) return null;
        const libraryCues = getCuePoints(trackId) ?? [];
        const plan = buildCueImportPlan({ usbCues: deviceCues, existingCues: libraryCues });
        return plan.add.length > 0 ? 'device-cues' : null;
      } catch (err) {
        log(`[sync] could not read cues for track ${trackId}: ${err.message}`);
        return 'cues-unreadable';
      }
    };
  }

  /** The plan for a device, without writing anything. */
  async function preview({ usbRoot, mirror = false } = {}) {
    if (!usbRoot) throw new SyncError('missing-usb-root', 'A mount point is required');
    const { identity, stored, playlists } = await resolve(usbRoot);
    const manifest = loadManifest(usbRoot);
    const plan = buildPreview({
      playlists,
      trackStates: getTrackStates(identity.key),
      playlistStates: getPlaylistStates(identity.key),
      mirror,
      ownedFiles: manifest.ownedFiles,
      protect: protectionFor(usbRoot),
    });
    return {
      ok: true,
      deviceKey: identity.key,
      selection: stored.playlists,
      mirror,
      actions: plan.actions,
      summary: plan.summary,
      hash: plan.hash,
      lastPlan: getLastPlan(identity.key),
    };
  }

  /** Execute the plan, through a sync job so it is locked and journaled. */
  async function apply({ usbRoot, mirror = false, expectedHash = null } = {}) {
    if (!usbRoot) throw new SyncError('missing-usb-root', 'A mount point is required');
    const plan = await preview({ usbRoot, mirror });
    if (plan.selection.length === 0) {
      throw new SyncError('empty-selection', 'The device has no playlists selected');
    }
    if (expectedHash && expectedHash !== plan.hash) {
      throw new SyncError(
        'plan-changed',
        'The library changed since the preview. Preview again before applying.',
        { expected: expectedHash, current: plan.hash }
      );
    }

    // An empty plan is the answer to an unchanged device: no job, no lock, no
    // write. This is the second-sync case of the acceptance criteria.
    if (plan.actions.length === 0) {
      return { ok: true, skipped: true, planHash: plan.hash, removed: 0, summary: {} };
    }

    const removals = plan.actions.filter((action) => action.type === 'remove');
    const result = await syncService.runJob({
      usbRoot,
      trigger: 'manual',
      execute: async (job) => {
        const snapshot = exportRunner.plan({
          playlistIds: plan.selection,
          mirror,
        });
        const exported = await exportRunner.run({ job, plan: snapshot, recordState: false });

        // Publication already removed these tracks from the database the players
        // read. Moving the files is the second step, so a crash in between leaves
        // orphaned files that the next mirror preview still sees and cleans.
        let removed = 0;
        for (const action of removals) {
          const moved = moveToTrash({ usbRoot, syncId: job.id, relPath: action.filePath });
          job.note('trashed', {
            relPath: action.filePath,
            trackId: action.trackId,
            trashPath: moved.trashPath ?? null,
            moved: moved.moved,
          });
          if (moved.moved) removed += 1;
        }

        pruneTrash({ usbRoot, retentionMs: getRetentionMs(), now });

        await recordExportState({
          usbRoot,
          manifest: exported.state.manifest,
          tracks: exported.state.tracks,
          playlists: exported.state.playlists,
          revision: exported.state.revision,
        });
        saveLastPlan({
          deviceKey: plan.deviceKey,
          hash: plan.hash,
          actions: plan.actions,
          summary: plan.summary,
        });

        return {
          fingerprint: exported.fingerprint,
          summary: { ...exported.summary, removed },
        };
      },
    });

    return {
      ok: true,
      planHash: plan.hash,
      removed: result.summary?.removed ?? 0,
      summary: result.summary ?? null,
    };
  }

  /** The playlists this device is meant to carry. */
  async function selection({ usbRoot } = {}) {
    const { identity, stored } = await resolve(usbRoot);
    return { ok: true, deviceKey: identity.key, playlists: stored.playlists };
  }

  /** Replace the selection. The next preview shows what it would change. */
  async function setSelection({ usbRoot, playlistIds = [] } = {}) {
    const { identity } = await resolve(usbRoot);
    const saved = saveSelection(identity.key, playlistIds);
    return { ok: true, deviceKey: identity.key, playlists: saved };
  }

  return { preview, apply, selection, setSelection };
}
