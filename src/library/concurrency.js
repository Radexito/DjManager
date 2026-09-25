// src/library/concurrency.js
// #516 — a tiny bounded-concurrency runner, no new dependency.
//
// Linking a folder's files is dominated by one ffprobe child process per file
// (100-300 ms each, more on a slow disk) while the SQLite write itself is
// synchronous; running the link phase at a fixed width overlaps the IO without
// letting a 100+ file folder open a hundred subprocesses at once.

/** Default width for the folder-sync link phase — matches MAX_ANALYSIS_WORKERS. */
export const DEFAULT_MAP_CONCURRENCY = 4;

/**
 * Run `worker(item, index)` over `items`, at most `limit` at a time.
 *
 * Every item is visited exactly once; `results` is indexed like the input, so
 * the caller never sees completion order. A rejection is captured in `errors`
 * (with the item and index that caused it) and the run continues — one
 * unreadable file must not abandon the rest of the folder.
 *
 * @template T, R
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {{ limit?: number, onSettled?: (item: T, result: R|undefined, index: number) => void }} [opts]
 * @returns {Promise<{ results: (R|undefined)[], errors: { item: T, index: number, error: unknown }[], ok: number }>}
 */
export async function mapWithConcurrency(
  items = [],
  worker,
  { limit = DEFAULT_MAP_CONCURRENCY, onSettled } = {}
) {
  const list = Array.from(items ?? []);
  const results = new Array(list.length);
  const errors = [];
  if (list.length === 0 || typeof worker !== 'function') {
    return { results, errors, ok: 0 };
  }

  const requested = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_MAP_CONCURRENCY;
  const width = Math.max(1, Math.min(requested, list.length));
  let next = 0;

  const pump = async () => {
    for (;;) {
      const index = next++;
      if (index >= list.length) return;
      const item = list[index];
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        errors.push({ item, index, error });
      }
      onSettled?.(item, results[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, pump));
  return { results, errors, ok: list.length - errors.length };
}
