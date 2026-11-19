import { describe, expect, it, vi } from 'vitest';
import {
  bindRuntime,
  getRendererWindow,
  hasRenderer,
  sendToRenderer,
} from '../main/rendererBridge.js';

/** Stands in for a BrowserWindow: a send spy plus the destroy check the bridge performs. */
function fakeWindow() {
  return { webContents: { send: vi.fn() }, isDestroyed: () => false };
}

describe('rendererBridge', () => {
  it('rejects a binding that is not an object', () => {
    expect(() => bindRuntime(null)).toThrow('a runtime object is required');
    expect(() => bindRuntime('runtime')).toThrow('a runtime object is required');
  });

  it('sends through the window the runtime holds', () => {
    const win = fakeWindow();
    bindRuntime({ mainWindow: win });

    expect(hasRenderer()).toBe(true);
    expect(getRendererWindow()).toBe(win);
    expect(sendToRenderer('progress', { pct: 10 })).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith('progress', { pct: 10 });
  });

  it('drops the event when there is no window yet', () => {
    bindRuntime({ mainWindow: null });

    expect(hasRenderer()).toBe(false);
    expect(getRendererWindow()).toBeNull();
    expect(sendToRenderer('progress', { pct: 10 })).toBe(false);
  });

  it('treats a destroyed window as gone', () => {
    const win = fakeWindow();
    win.isDestroyed = () => true;
    bindRuntime({ mainWindow: win });

    expect(hasRenderer()).toBe(false);
    expect(sendToRenderer('progress', { pct: 10 })).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
