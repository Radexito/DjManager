import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMediaWatcher, mediaSignature, scanMedia, watchRoots } from '../usb/generic/watch.js';
import {
  DEFAULT_USB_WATCH_INTERVAL_MS,
  USB_DEVICES_EVENT,
  createUsbWatchService,
  parseWatchRoots,
} from '../main/usbWatchService.js';
import { candidateRoots } from '../usb/generic/roots.js';

describe('watch roots', () => {
  it('uses the configured list and trims it', () => {
    expect(watchRoots({ configured: [' /media/sticks ', '', '   ', '/mnt/pioneer'] })).toEqual([
      '/media/sticks',
      '/mnt/pioneer',
    ]);
  });

  it('falls back to the platform mount points when nothing is configured', () => {
    const readdir = vi.fn((dir) => {
      if (dir === '/run/media/demo') return ['STICK', 'OTHER'];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const exists = vi.fn((dir) => dir === '/run/media/demo');

    expect(
      watchRoots({
        configured: [],
        platform: 'linux',
        env: { USER: 'demo' },
        readdir,
        exists,
      })
    ).toEqual([path.join('/run/media/demo', 'STICK'), path.join('/run/media/demo', 'OTHER')]);
  });

  it('accepts the separator form of the setting as well as JSON', () => {
    expect(parseWatchRoots('/media/a, /mnt/b;\n/opt/c')).toEqual(['/media/a', '/mnt/b', '/opt/c']);
    expect(parseWatchRoots('["/media/a","/mnt/b"]')).toEqual(['/media/a', '/mnt/b']);
    expect(parseWatchRoots('')).toEqual([]);
    expect(parseWatchRoots(null)).toEqual([]);
  });
});

describe('scanning for media', () => {
  const dirent = (name, isDirectory = true) => ({ name, isDirectory: () => isDirectory });

  it('keeps only directories the recogniser accepts', () => {
    const roots = ['/media'];
    const readdir = vi.fn(() => [dirent('STICK'), dirent('BACKUP'), dirent('notes.txt', false)]);
    const recognise = vi.fn((mount) => mount === path.join('/media', 'STICK'));

    const found = scanMedia({ roots, readdir, recognise });

    expect(found).toEqual([{ mount: path.join('/media', 'STICK'), name: 'STICK' }]);
    // The root is tested as a medium itself, then both directories under it.
    expect(recognise).toHaveBeenCalledTimes(3);
  });

  it('skips a watch root that is gone and still reports the others', () => {
    const readdir = vi.fn((dir) => {
      if (dir === '/gone') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [dirent('STICK')];
    });

    const found = scanMedia({
      roots: ['/gone', '/media'],
      readdir,
      recognise: (mount) => path.basename(mount) === 'STICK',
    });

    expect(found).toEqual([{ mount: path.join('/media', 'STICK'), name: 'STICK' }]);
  });

  it('treats a Windows drive root as the medium itself', () => {
    const readdir = vi.fn(() => [{ name: 'PIONEER', isDirectory: () => true }]);
    const recognise = vi.fn((mount) => mount === 'D:\\');

    const found = scanMedia({ roots: ['D:\\', 'E:\\'], readdir, recognise });

    expect(found).toEqual([{ mount: 'D:\\', name: 'D:' }]);
  });

  it('reports each mount point once and in a stable order', () => {
    const readdir = vi.fn(() => [dirent('B'), dirent('A')]);
    // The roots themselves are not media here: this case is about the children.
    const found = scanMedia({
      roots: ['/media', '/mnt'],
      readdir,
      recognise: (mount) => mount !== '/media' && mount !== '/mnt',
    });

    expect(found.map((device) => device.mount)).toEqual([
      path.join('/media', 'A'),
      path.join('/media', 'B'),
      path.join('/mnt', 'A'),
      path.join('/mnt', 'B'),
    ]);
    expect(mediaSignature(found)).toBe(
      [
        path.join('/media', 'A'),
        path.join('/media', 'B'),
        path.join('/mnt', 'A'),
        path.join('/mnt', 'B'),
      ].join('\n')
    );
  });
});

describe('media watcher', () => {
  it('reports the first scan, then only when the set of devices changes', () => {
    let devices = [];
    const onChange = vi.fn();
    let tick = null;
    const watcher = createMediaWatcher({
      scan: () => devices,
      onChange,
      setIntervalImpl: (fn) => {
        tick = fn;
        return 1;
      },
      clearIntervalImpl: () => {},
    });

    watcher.start();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([]);

    tick();
    expect(onChange).toHaveBeenCalledTimes(1);

    devices = [{ mount: '/media/STICK', name: 'STICK' }];
    tick();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(watcher.devices()).toEqual([{ mount: '/media/STICK', name: 'STICK' }]);

    tick();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('stops polling when told to, and can start again', () => {
    const cleared = [];
    const onChange = vi.fn();
    const watcher = createMediaWatcher({
      scan: () => [],
      onChange,
      setIntervalImpl: () => 7,
      clearIntervalImpl: (handle) => cleared.push(handle),
    });

    watcher.start();
    expect(watcher.isRunning()).toBe(true);
    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
    expect(cleared).toEqual([7]);
    watcher.start();
    expect(watcher.isRunning()).toBe(true);
  });
});

describe('usb watch service', () => {
  const settings = (values) => (key, fallback) => (key in values ? values[key] : fallback);

  it('publishes a scan to the renderer and reads the roots from settings', () => {
    const send = vi.fn();
    const scanMediaImpl = vi.fn(() => [{ mount: '/media/STICK', name: 'STICK' }]);
    const service = createUsbWatchService({
      getSetting: settings({ usb_watch_roots: '/media' }),
      send,
      scanMediaImpl,
      createWatcher: ({ scan, onChange }) => ({
        start: () => onChange(scan()),
        stop: () => {},
        check: () => onChange(scan()),
      }),
    });

    service.start();

    expect(scanMediaImpl).toHaveBeenCalledWith({ roots: ['/media'] });
    expect(send).toHaveBeenCalledWith(USB_DEVICES_EVENT, [
      { mount: '/media/STICK', name: 'STICK' },
    ]);
    expect(service.devices()).toHaveLength(1);
  });

  it('polls nothing and reports an empty list when the feature is off', () => {
    const send = vi.fn();
    const scanMediaImpl = vi.fn(() => []);
    const createWatcher = vi.fn();
    const service = createUsbWatchService({
      getSetting: settings({ usb_watch_enabled: '0' }),
      send,
      scanMediaImpl,
      createWatcher,
    });

    service.start();

    expect(createWatcher).not.toHaveBeenCalled();
    expect(scanMediaImpl).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(USB_DEVICES_EVENT, []);
    expect(service.devices()).toEqual([]);
  });

  it('picks up a new watch root without a restart', () => {
    const values = { usb_watch_roots: '/media' };
    const scanMediaImpl = vi.fn(({ roots }) => [{ mount: roots[0], name: 'STICK' }]);
    const service = createUsbWatchService({
      getSetting: settings(values),
      scanMediaImpl,
      createWatcher: ({ scan }) => ({ start: () => scan(), stop: () => {}, check: () => scan() }),
    });

    service.start();
    expect(scanMediaImpl).toHaveBeenLastCalledWith({ roots: ['/media'] });

    values.usb_watch_roots = '/mnt';
    service.refresh();
    expect(scanMediaImpl).toHaveBeenLastCalledWith({ roots: ['/mnt'] });
  });

  it('falls back to the platform roots when the setting is empty', () => {
    const service = createUsbWatchService({
      getSetting: settings({}),
      createWatcher: () => ({ start: () => {}, stop: () => {}, check: () => [] }),
    });

    // Whatever this machine mounts removable media under, and nothing else: a
    // runner with no /media and no /mnt legitimately answers with an empty list.
    expect(service.roots()).toEqual(candidateRoots());
  });

  it('exports the interval it polls at', () => {
    expect(DEFAULT_USB_WATCH_INTERVAL_MS).toBe(4000);
  });
});
