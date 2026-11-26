import { readMedium } from '../../usb/pioneer/contents.js';
import { handle } from './response.js';

/**
 * Channels for the USB section of the sidebar.
 *
 * The watcher is lazy on purpose: the first caller starts it, so an application
 * that never shows the device list never polls the mount points either.
 * @param {object} deps
 * @param {object} deps.ipcMain Electron ipcMain, required
 * @param {object} deps.usbWatch the service from createUsbWatchService
 * @throws {Error} when either dependency is missing
 */
export function registerUsbWatchIpc({ ipcMain, usbWatch }) {
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
    return readMedium(root);
  });
}
