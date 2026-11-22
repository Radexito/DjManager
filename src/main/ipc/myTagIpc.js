import { fail, handle, ok } from './response.js';

/**
 * My Tags channels (#10).
 *
 * Reads return the rows the renderer renders; mutations answer with the row they
 * touched. The repository owns the revision side effects, so a tag change is
 * visible to the sync through the track revision rather than through an event.
 */
export function registerMyTagIpc({
  ipcMain,
  send = () => {},
  listMyTags,
  getMyTagTree,
  createMyTag,
  renameMyTag,
  deleteMyTag,
  assignMyTag,
  getTagsForTrack,
  log = () => {},
} = {}) {
  if (!ipcMain) throw new Error('registerMyTagIpc: ipcMain is required');
  const register = (channel, fn) => handle(ipcMain, channel, fn, { log });
  const changed = () => send('my-tags-updated');

  register('my-tags-list', () => listMyTags());
  register('my-tags-tree', () => getMyTagTree());
  register('track-my-tags', (_, trackId) => getTagsForTrack(Number(trackId)));

  register('my-tag-create', (_, payload = {}) => {
    try {
      const tag = createMyTag({ name: payload.name, parentId: payload.parentId ?? null });
      changed();
      return ok({ tag });
    } catch (err) {
      return fail('my-tag-invalid', err.message);
    }
  });

  register('my-tag-rename', (_, payload = {}) => {
    try {
      const tag = renameMyTag(Number(payload.id), payload.name);
      changed();
      return ok({ tag });
    } catch (err) {
      return fail('my-tag-invalid', err.message);
    }
  });

  register('my-tag-delete', (_, payload = {}) => {
    try {
      const removed = deleteMyTag(Number(payload.id));
      changed();
      return ok({ removed });
    } catch (err) {
      return fail('my-tag-invalid', err.message);
    }
  });

  register('my-tag-assign', (_, payload = {}) => {
    try {
      const tags = assignMyTag(
        Number(payload.trackId),
        Number(payload.tagId),
        payload.assigned !== false
      );
      changed();
      return ok({ tags });
    } catch (err) {
      return fail('my-tag-invalid', err.message);
    }
  });
}
