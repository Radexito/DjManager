/**
 * Main-process cache for the TIDAL account collection tree.
 *
 * `fetchTidalCollections()` spawns the tdn Python CLI, which costs ~20 s on a
 * cold interpreter, so the result is kept here instead of being fetched on
 * every renderer mount (and on every TIDAL tab switch).
 *
 * Design notes:
 * - A single in-flight promise is shared, so concurrent callers (for example
 *   React's development double-mount) cannot stack two Python processes.
 * - Only successful listings are cached: a failure (not logged in, CLI error)
 *   is retried on the next request instead of sticking for the whole TTL.
 * - `force` (the panel's Reload action) drops the cached entry and refetches.
 */
import { fetchTidalCollections } from './tidalDlManager.js';

/** How long a successful listing is served from memory. */
export const TIDAL_COLLECTIONS_TTL_MS = 5 * 60 * 1000;

/** @type {{ at: number, value: object } | null} */
let cached = null;
/** @type {Promise<object> | null} */
let inFlight = null;

/**
 * List the logged-in TIDAL account's collections, served from the cache when a
 * recent successful listing is available.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] Bypass the cache and refetch.
 * @param {() => number} [opts.now] Clock injection (tests only).
 * @param {() => Promise<object>} [opts.fetcher] Fetcher injection (tests only).
 * @returns {Promise<{ ok: boolean, collections: Array, warnings: string[], cached?: boolean, error?: string }>}
 */
export async function listTidalCollections(opts = {}) {
  const { force = false, now = Date.now, fetcher = fetchTidalCollections } = opts;

  if (force) cached = null;
  else if (cached && now() - cached.at < TIDAL_COLLECTIONS_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetcher();
      if (res?.ok) cached = { at: now(), value: res };
      return { ...res, cached: false };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drop the cached listing and any in-flight fetch (tests). */
export function resetTidalCollectionsCache() {
  cached = null;
  inFlight = null;
}
