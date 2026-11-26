import fs from 'node:fs';
import path from 'node:path';

import { readMedium, PDB_REL } from '../../usb/pioneer/contents.js';
import { patchTrackField, slotRoom } from '../../usb/pioneer/formats/inPlace.js';
import { readLibrary } from '../../usb/pioneer/formats/pdbRead.js';
import { handle } from './response.js';

/**
 * Channels for the USB section of the sidebar.
 *
 * The watcher is lazy on purpose: the first caller starts it, so an application
 * that never shows the device list never polls the mount points either.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {object} deps.usbWatch the service from createUsbWatchService
 * @param {(dir: string) => void} [deps.allowBase] lets the media server serve files
 *   from a medium, so a track on a stick can actually be played
 * @param {object} [deps.fs] filesystem, injectable for tests
 * @throws {Error} when either dependency is missing
 */
export function registerUsbWatchIpc({ ipcMain, usbWatch, allowBase = () => {}, fs: fsImpl = fs }) {
  if (!ipcMain) throw new Error('registerUsbWatchIpc: ipcMain is required');
  if (!usbWatch) throw new Error('registerUsbWatchIpc: usbWatch is required');

  const register = (channel, fn) =>
    handle(ipcMain, channel, fn, { log: (...args) => console.error(...args) });

  register('get-usb-devices', () => {
    usbWatch.start();
    return usbWatch.devices();
  });

  register('refresh-usb-devices', () => {
    usbWatch.start();
    return usbWatch.refresh();
  });

  register('get-usb-watch-roots', () => ({
    roots: usbWatch.roots(),
    enabled: usbWatch.isEnabled(),
  }));

  // What the medium carries, read from the medium: the library database and the
  // tag tree, so a stick rekordbox prepared shows the same way as ours.
  register('get-usb-contents', (_, root) => {
    if (typeof root !== 'string' || root.trim() === '') return null;
    const contents = readMedium(root);
    // The player opens a file path and the media server only serves paths under
    // a base it knows, so opening a medium is what puts it on that list. Without
    // this every row on a stick answers NotSupportedError.
    if (contents) allowBase(root);
    return contents;
  });

  /**
   * Edit one text field of a track that lives on the medium.
   *
   * Only the field the user touched changes: the row is patched inside
   * `export.pdb` and every other byte stays where it was, which is what makes it
   * safe to run against a stick that rekordbox or a deck also knows about. A new
   * text that does not fit the slot the old one occupied is refused rather than
   * written, because moving it would mean rebuilding the page.
   */
  register('update-usb-track', (_, { mount, trackId, field = 'title', value } = {}) => {
    if (typeof mount !== 'string' || mount.trim() === '') {
      return { ok: false, reason: 'no medium' };
    }
    const file = path.join(mount, ...PDB_REL.split('/'));
    let before;
    try {
      before = fsImpl.readFileSync(file);
    } catch (err) {
      return { ok: false, reason: `cannot read ${PDB_REL}: ${err.message}` };
    }

    const patched = patchTrackField(before, { trackId, field, value });
    if (!patched.ok) {
      return { ...patched, limit: patched.limit ?? slotRoom(before, { trackId, field }) };
    }

    // Read it back before replacing anything: a buffer that does not decode to
    // the new value must never reach the medium.
    const check = readLibrary(patched.bytes);
    const row = check.tracks.find((entry) => entry.id === trackId);
    if (!row || row[field] !== String(value ?? '')) {
      return { ok: false, reason: 'verification failed' };
    }

    const tmp = `${file}.writing`;
    const backup = `${file}.bak`;
    try {
      fsImpl.writeFileSync(tmp, patched.bytes);
      if (!fsImpl.existsSync(backup)) fsImpl.copyFileSync(file, backup);
      fsImpl.renameSync(tmp, file);
    } catch (err) {
      try {
        if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      return { ok: false, reason: `write failed: ${err.message}` };
    }

    return { ok: true, field, value: String(value ?? ''), backup: path.basename(backup) };
  });
}
