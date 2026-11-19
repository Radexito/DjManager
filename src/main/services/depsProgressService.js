/**
 * Forward dependency install progress to the renderer, logging only the start
 * and the end of each step so a long install does not flood the main log. The
 * last logged banner is remembered, so a repeated step is not printed twice.
 * @param {object} deps injected collaborators
 * @param {Function} deps.send renderer bridge
 * @param {object} [deps.log] logger, defaults to the console
 * @returns {{forward: Function, lastMessage: Function}} progress forwarder
 */
export function createDepsProgressService({ send, log = console }) {
  let lastMessage = '';

  /**
   * Send one progress payload, logging step boundaries at most once in a row.
   * @param {object|null} data progress payload, or null when a step ends
   */
  function forward(data) {
    if (data && (data.pct === 0 || data.pct === 100) && data.msg !== lastMessage) {
      lastMessage = data.msg;
      log.log('[deps]', data.msg);
    }
    send('deps-progress', data);
  }

  /**
   * The step banner that was logged last, exposed for diagnostics and tests.
   * @returns {string} last logged message
   */
  function lastLogged() {
    return lastMessage;
  }

  return { forward, lastMessage: lastLogged };
}
