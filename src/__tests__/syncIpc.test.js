import { describe, expect, it, vi } from 'vitest';

import { registerSyncIpc } from '../main/ipc/syncIpc.js';

function setup(syncService) {
  const handlers = new Map();
  const ipcMain = { handle: vi.fn((channel, fn) => handlers.set(channel, fn)) };
  registerSyncIpc({ ipcMain, syncService });
  return { handlers, call: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

describe('sync IPC', () => {
  it('registers the status and cancel channels', () => {
    const { handlers } = setup({ status: () => ({}), cancel: () => ({ ok: true }) });
    expect([...handlers.keys()].sort()).toEqual(['sync-cancel', 'sync-status']);
  });

  it('answers with the status the engine reports', async () => {
    const status = { ok: true, jobs: [], canCancel: false, canEject: true };
    const { call } = setup({ status: () => status, cancel: () => ({ ok: true }) });
    await expect(call('sync-status')).resolves.toEqual(status);
  });

  it('turns a refused stop into a failure body with the machine code', async () => {
    const { call } = setup({
      status: () => ({}),
      cancel: () => ({
        ok: false,
        code: 'publishing',
        message: 'Cannot stop while publishing',
        jobId: 'job-1',
      }),
    });
    await expect(call('sync-cancel', { usbRoot: '/media/stick' })).resolves.toMatchObject({
      ok: false,
      code: 'publishing',
      error: 'publishing',
      jobId: 'job-1',
    });
  });

  it('passes a successful stop through', async () => {
    const { call } = setup({ status: () => ({}), cancel: () => ({ ok: true, jobIds: ['job-1'] }) });
    await expect(call('sync-cancel')).resolves.toEqual({ ok: true, jobIds: ['job-1'] });
  });
});
