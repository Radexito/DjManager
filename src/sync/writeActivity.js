/**
 * Which library writers are running right now.
 *
 * Automatic sync must not start while an import or an analysis run is writing
 * the library, and a manual export must not be joined by a background job that
 * changes the same rows. The registry counts writers by kind, so a caller asks
 * "is anything writing" without knowing which feature is responsible.
 */
export function createWriteActivity() {
  const counts = new Map();

  return {
    /** Register a writer; the returned function releases it and is idempotent. */
    begin(kind) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (counts.get(kind) ?? 1) - 1;
        if (next <= 0) counts.delete(kind);
        else counts.set(kind, next);
      };
    },
    /** Kinds with at least one active writer. */
    kinds() {
      return [...counts.keys()];
    },
    /** True when any tracked writer is active. */
    isBusy() {
      return [...counts.values()].some((count) => count > 0);
    },
  };
}
