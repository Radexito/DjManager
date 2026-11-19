/**
 * Start the media server on the default library's audio and artwork roots,
 * putting every other library on the explorer allowlist first, and remember the
 * port on the runtime so the renderer can build URLs.
 * @param {object} deps injected collaborators
 * @param {object} deps.runtime shared runtime state
 * @param {object} deps.ytPreview preview stream registry
 * @param {Function} deps.listLibraries every configured library
 * @param {Function} deps.getDefaultLibraryId id of the library in use
 * @param {Function} deps.getLibraryBase audio root of a library
 * @param {Function} deps.getArtworkBase artwork root of a library
 * @param {Function} deps.allowExplorerBase adds a base to the allowlist
 * @param {Function} deps.startServer starts the server for the given roots
 * @returns {{start: Function}} media server control
 */
export function createMediaServerService({
  runtime,
  ytPreview,
  listLibraries,
  getDefaultLibraryId,
  getLibraryBase,
  getArtworkBase,
  allowExplorerBase,
  startServer,
}) {
  /**
   * Resolve the roots, widen the allowlist and store the port.
   * @returns {Promise<number>} the port the server listens on
   */
  function start() {
    const defaultId = getDefaultLibraryId();
    const audioBase = getLibraryBase(defaultId);
    const artworkBase = getArtworkBase(defaultId);

    for (const lib of listLibraries()) {
      if (lib.id === defaultId) continue;
      for (const base of [getLibraryBase(lib.id), getArtworkBase(lib.id)]) {
        allowExplorerBase(runtime, base);
      }
    }

    return startServer(
      audioBase,
      artworkBase,
      runtime.explorerAllowedBases,
      ytPreview.streams
    ).then(({ port }) => {
      runtime.mediaServerPort = port;
      return port;
    });
  }

  return { start };
}
