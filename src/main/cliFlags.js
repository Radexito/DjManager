/**
 * Command-line flags this app understands on top of Electron's own switches.
 *
 * They exist so an operator can start the same build in a different mode:
 * serving an already built renderer, skipping the download of external
 * binaries at startup, keeping the app from relaunching itself after a run of
 * GPU crashes, or fetching the rekordbox phrase table on a machine that has no
 * rekordbox installed.
 */
export const CLI_FLAGS = Object.freeze({
  loadBuiltRenderer: '--load-built-renderer',
  noDepsBootstrap: '--no-deps-bootstrap',
  noFallbackRelaunch: '--no-fallback-relaunch',
  fetchPhraseTable: '--fetch-phrase-table',
  gpuSafe: '--gpu-safe',
});

/**
 * Whether the flag was passed to this process.
 * @param {string} flag flag name including the leading dashes
 * @param {string[]} [argv] argument list to inspect, defaults to this process's argv
 */
export function hasCliFlag(flag, argv = process.argv) {
  return argv.slice(1).includes(flag);
}
