/**
 * The contract a USB format has to satisfy.
 *
 * Formats are plain objects rather than classes: the registry only needs an id,
 * a way to recognise a mounted root and a way to open it, and inheritance would
 * add nothing but a hierarchy to fight later. Traktor and VirtualDJ register
 * with the same three members.
 */

/**
 * @typedef {object} UsbFormat
 * @property {string} id short name, also the key in the registry
 * @property {(root: string, deps?: object) => boolean} matches whether a mounted root carries this format
 * @property {(root: string, deps?: object) => UsbDevice} open builds the reader/writer for that root
 */

/**
 * @typedef {object} UsbCapabilities
 * @property {'read'|'write'|'read-write'|'none'} library tracks and playlists stored by the format itself
 * @property {'read'|'write'|'read-write'|'none'} cues cue points or hot cues stored on the medium
 * @property {'read'|'write'|'read-write'|'none'} settings per-device settings files
 */

/**
 * @typedef {object} UsbDevice
 * @property {string} format id of the format that opened the device
 * @property {string} root mount point the device was opened at
 * @property {UsbCapabilities} capabilities what this device can actually do
 * @property {object} read readers for the parts that can be read
 * @property {object} write writers for the parts that can be written
 */

/** Raised when a root cannot be opened as any known format. */
export class UsbFormatError extends Error {
  /**
   * @param {string} message
   * @param {{root?: string, format?: string}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'UsbFormatError';
    this.root = details.root;
    this.format = details.format;
  }
}

/** Capability values, so callers do not spell the strings themselves. */
export const CAPABILITY = Object.freeze({
  none: 'none',
  read: 'read',
  write: 'write',
  readWrite: 'read-write',
});
