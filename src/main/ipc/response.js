/**
 * IPC response contract (faza 5, point 5 of the main.js refactor plan).
 *
 * Two problems this module fixes, both visible in the pre-contract code:
 *
 *   - the same field carried two meanings. `{ ok: false, error: 'folder-missing' }`
 *     puts a machine code in `error`, while `{ ok: false, error: err.message }`
 *     puts prose there, so a renderer could not branch on it without matching
 *     strings;
 *   - a handler that threw rejected the `invoke()` promise instead of answering.
 *     The renderer then saw an unhandled rejection and no error at all.
 *
 * The contract is:
 *
 *     success : { ok: true,  ...payload }
 *     failure : { ok: false, code, error, message?, ...extra }
 *
 * `code` is the machine-readable decision (stable, kebab-case), `message` is for
 * humans, and `error` stays an alias of `code` so every existing caller that
 * reads `.error` keeps working unchanged. Extra fields (folder, playlistId)
 * ride along untouched.
 *
 * Adoption is deliberately per domain, not a single sweep over 122 channels:
 * the renderer reads different shapes in different places, and a domain at a
 * time is the only size that can be reviewed and reverted.
 */

/** An error the IPC layer can map to a stable code instead of guessing. */
export class AppError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.extra = extra;
  }
}

/** Success body. `ok` is always first so a diff reads top-down. */
export function ok(payload = {}) {
  return { ok: true, ...payload };
}

/** Failure body: one code, one human message, any extra context. */
export function fail(code, message, extra = {}) {
  if (!code) throw new Error('fail(code): a code is required');
  const body = { ok: false, code, error: code };
  if (message) body.message = message;
  return { ...body, ...extra };
}

/**
 * Map a thrown value to a failure body. Anything that is not an AppError is
 * `internal`: the caller gets a code it can branch on, the details stay in the
 * log rather than in the renderer.
 */
export function toFailure(err) {
  if (err instanceof AppError) return fail(err.code, err.message, err.extra);
  return fail('internal', err?.message ?? 'unknown error');
}

/**
 * Failure for a caught error on a channel whose callers already display
 * `.error`. `code` is the machine value (new code branches on it and on
 * `.message`), while `.error` keeps the human text so an existing modal does not
 * start showing "failed" instead of the reason.
 */
export function failFromError(err, code = 'failed') {
  const message = err?.message ?? 'unknown error';
  return { ok: false, code, error: message, message };
}

/**
 * Register a handler that cannot reject.
 *
 * Everything reaches the renderer as a value: success passes through (or
 * becomes `ok()` when the handler returned nothing), and a throw becomes a
 * failure body plus one log line. Use it for channels whose handler does real
 * work; leave plain readers on `ipcMain.handle`.
 */
export function handle(ipcMain, channel, fn, { log = () => {}, mapError } = {}) {
  if (!ipcMain) throw new Error('handle: ipcMain is required');
  if (typeof fn !== 'function') throw new Error('handle: fn must be a function');

  const onError = (err) => {
    log(`[ipc] ${channel} failed: ${err?.message ?? err}`);
    return mapError ? mapError(err) : toFailure(err);
  };
  const settle = (result) => (result === undefined ? ok() : result);

  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return settle(await fn(event, ...args));
    } catch (err) {
      return onError(err);
    }
  });
}
