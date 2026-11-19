import { describe, expect, it, vi } from 'vitest';
import { AppError, fail, handle, ok, toFailure } from '../main/ipc/response.js';

/** Minimal `ipcMain` that records handlers by channel so a test can invoke them directly. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, fn) => handlers.set(channel, fn)),
  };
}

describe('response contract', () => {
  it('builds a success body with the payload spread after ok', () => {
    expect(ok()).toEqual({ ok: true });
    expect(ok({ playlistId: 3, added: 2 })).toEqual({ ok: true, playlistId: 3, added: 2 });
  });

  it('builds a failure body with a machine code and keeps error as its alias', () => {
    const body = fail('folder-missing', 'Folder not found: /nope', { folder: '/nope' });
    expect(body).toMatchObject({
      ok: false,
      code: 'folder-missing',
      error: 'folder-missing',
      message: 'Folder not found: /nope',
      folder: '/nope',
    });
  });

  it('refuses a failure without a code', () => {
    expect(() => fail()).toThrow(/a code is required/);
  });

  it('maps an AppError to its own code and everything else to internal', () => {
    expect(toFailure(new AppError('duplicate-name', 'Name taken'))).toMatchObject({
      ok: false,
      code: 'duplicate-name',
      message: 'Name taken',
    });
    expect(toFailure(new Error('disk on fire'))).toMatchObject({
      ok: false,
      code: 'internal',
      message: 'disk on fire',
    });
  });

  it('turns a throw into a failure body instead of a rejected invoke', async () => {
    const ipcMain = fakeIpcMain();
    const log = vi.fn();
    handle(
      ipcMain,
      'boom',
      () => {
        throw new AppError('nope', 'nope happened');
      },
      { log }
    );

    const res = await ipcMain.handlers.get('boom')({}, {});
    expect(res).toMatchObject({ ok: false, code: 'nope', message: 'nope happened' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[ipc] boom failed'));
  });

  it('answers ok() when a handler returns nothing', async () => {
    const ipcMain = fakeIpcMain();
    handle(ipcMain, 'silent', () => {});
    await expect(ipcMain.handlers.get('silent')({}, {})).resolves.toEqual({ ok: true });
  });

  it('passes the handler payload through unchanged', async () => {
    const ipcMain = fakeIpcMain();
    handle(ipcMain, 'echo', (_event, payload) => payload);
    await expect(ipcMain.handlers.get('echo')({}, { a: 1 })).resolves.toEqual({ a: 1 });
  });

  it('lets the caller override the error mapping', async () => {
    const ipcMain = fakeIpcMain();
    handle(
      ipcMain,
      'mapped',
      () => {
        throw new Error('x');
      },
      { mapError: () => fail('custom', 'mapped by the domain') }
    );
    await expect(ipcMain.handlers.get('mapped')({}, {})).resolves.toMatchObject({ code: 'custom' });
  });

  it('waits for an asynchronous handler and wraps its rejection', async () => {
    const ipcMain = fakeIpcMain();
    handle(ipcMain, 'later', async () => {
      throw new AppError('slow-fail', 'took too long');
    });

    await expect(ipcMain.handlers.get('later')({}, {})).resolves.toMatchObject({
      ok: false,
      code: 'slow-fail',
    });
  });
});
