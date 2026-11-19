/**
 * What the window loads. Split from createWindow so the decision is a pure
 * function that can be tested without Electron or the filesystem.
 *
 * The dev server is only used when `npm run dev` has written `.dev-url`. That
 * file is generated and gitignored, so a clean checkout (CI, a fresh clone) has
 * none, and the built renderer is the correct fallback rather than a crash.
 * @param {object} input
 * @param {boolean} input.isPackaged whether the app runs from a packaged build
 * @param {boolean} [input.loadBuiltRenderer] the --load-built-renderer flag
 * @param {boolean} [input.devUrlExists] whether .dev-url is on disk
 * @returns {'dev-server'|'built'} which renderer to load
 */
export function resolveRendererSource({
  isPackaged,
  loadBuiltRenderer = false,
  devUrlExists = false,
}) {
  if (isPackaged || loadBuiltRenderer) return 'built';
  return devUrlExists ? 'dev-server' : 'built';
}
