/**
 * An error the sync layer can hand to the IPC boundary as a stable code.
 *
 * The sync modules run both inside Electron and inside a plain Node process
 * (the crash tests spawn one), so they carry their own error type rather than
 * importing the IPC response module. The handler maps `code` to the failure
 * body, which keeps the machine value the renderer branches on unchanged.
 */
export class SyncError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'SyncError';
    this.code = code;
    this.extra = extra;
  }
}

/** True when a thrown value is a sync failure with a machine code. */
export function isSyncError(err) {
  return err instanceof SyncError;
}
