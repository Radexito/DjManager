import { UsbFormatError } from './generic/contract.js';
import { isPioneerUsb } from './pioneer/detect.js';

/**
 * USB formats this build can open.
 *
 * Each entry is a `UsbFormat`: an id, a predicate that recognises a mounted
 * root and a factory that returns the reader/writer for it. Adding Traktor or
 * VirtualDJ means adding one entry here and one folder next to `pioneer/`, and
 * nothing in the callers changes.
 */
export const USB_FORMATS = Object.freeze({
  pioneer: Object.freeze({
    id: 'pioneer',
    matches: (root, deps) => isPioneerUsb(root, deps),
    open: async (root, deps) => {
      const { createPioneerUsb } = await import('./pioneer/index.js');
      return createPioneerUsb({ root, ...deps });
    },
  }),
});

/**
 * Which format a mounted root carries, if any.
 * @param {string} root mount point
 * @param {object} [formats] registry to consult, defaults to USB_FORMATS
 * @param {object} [deps] dependencies handed to the predicates
 * @returns {string|null} format id
 */
export function detectUsbFormat(root, formats = USB_FORMATS, deps) {
  if (!root) return null;
  for (const format of Object.values(formats)) {
    if (format.matches(root, deps)) return format.id;
  }
  return null;
}

/**
 * Open a mounted root with the format it carries.
 * @param {string} root mount point
 * @param {{formats?: object, deps?: object}} [options]
 * @returns {Promise<import('./generic/contract.js').UsbDevice>}
 * @throws {UsbFormatError} when no registered format recognises the root
 */
export async function openUsbDevice(root, { formats = USB_FORMATS, deps } = {}) {
  const id = detectUsbFormat(root, formats, deps);
  if (!id) {
    throw new UsbFormatError(`no known USB format at ${root}`, { root });
  }
  return formats[id].open(root, deps);
}

export { UsbFormatError } from './generic/contract.js';
export { CAPABILITY } from './generic/contract.js';
