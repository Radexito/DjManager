import { fail, handle, ok } from './response.js';

/**
 * Sync state, stopping and the eject guard.
 *
 * Two channels, both about the same question: is the medium being written right
 * now. `sync-status` answers it and says whether stopping or ejecting is safe;
 * `sync-cancel` refuses while files are being published, because a rename set
 * that stops half way is the state the journal cannot make safe.
 */
export function registerSyncIpc({ ipcMain, syncService, log = () => {} }) {
  if (!ipcMain) throw new Error('registerSyncIpc: ipcMain is required');
  if (!syncService) throw new Error('registerSyncIpc: syncService is required');

  const register = (channel, fn) => handle(ipcMain, channel, fn, { log });

  register('sync-status', () => syncService.status());

  register('sync-cancel', (_, payload = {}) => {
    const result = syncService.cancel(payload ?? {});
    if (result.ok) return ok(result);
    return fail(result.code, result.message, result.jobId ? { jobId: result.jobId } : {});
  });
}
