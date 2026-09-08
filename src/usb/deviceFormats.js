/**
 * Per-device audio format compatibility for USB export (#257).
 *
 * `supported` lists are best-effort, based on Pioneer's published format
 * compatibility spec sheets per model — not individually verified against
 * real hardware. If a device rejects a format this table marks as supported,
 * file a bug with the model and format so the table can be corrected.
 *
 * Keep the `key`/`label` pairs here in sync with the dropdown options in
 * renderer/src/ExportModal.jsx.
 */
export const DEVICE_PROFILES = {
  'cdj-3000': { label: 'CDJ-3000', supported: ['mp3', 'wav', 'aiff', 'flac', 'aac'] },
  'cdj-2000nxs2': { label: 'CDJ-2000NXS2', supported: ['mp3', 'wav', 'aiff', 'aac'] },
  'xdj-rx3': { label: 'XDJ-RX3', supported: ['mp3', 'wav', 'aiff', 'flac', 'aac'] },
  'xdj-rx2': { label: 'XDJ-RX2', supported: ['mp3', 'wav', 'aiff', 'aac'] },
  'xdj-1000mk2': { label: 'XDJ-1000MK2', supported: ['mp3', 'wav', 'aiff', 'aac'] },
  'xdj-700': { label: 'XDJ-700', supported: ['mp3', 'wav', 'aiff', 'aac'] },
};

/** Preference order when a device supports more than one compatible format. */
const FORMAT_QUALITY_ORDER = ['flac', 'wav', 'aiff', 'aac', 'mp3'];

/**
 * Decide the export format for a track given the export options.
 *
 * @param {{ srcExt: string, deviceKey?: string|null, forceMp3?: boolean }} opts
 *   `srcExt` may include a leading dot; case-insensitive.
 * @returns {string|null} lowercase extension (no dot) to convert to, or null
 *   to keep the source format as-is.
 */
export function resolveExportFormat({ srcExt, deviceKey, forceMp3 }) {
  const src = (srcExt || '').replace(/^\./, '').toLowerCase();

  if (forceMp3) return src === 'mp3' ? null : 'mp3';

  const device = deviceKey ? DEVICE_PROFILES[deviceKey] : null;
  if (!device) return null;
  if (device.supported.includes(src)) return null;

  return FORMAT_QUALITY_ORDER.find((f) => device.supported.includes(f)) || 'mp3';
}
