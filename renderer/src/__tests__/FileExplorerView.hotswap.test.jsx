import { describe, it, expect, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import FileExplorerView from '../FileExplorerView.jsx';
import { PlayerProvider } from '../PlayerContext.jsx';

// jsdom has no ResizeObserver; FileExplorerView uses one to size its virtualized list.
globalThis.ResizeObserver =
  globalThis.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// Both FileExplorerView and PlayerContext subscribe to the drive event, so the
// fake collects every subscriber and fires them all.
function subscribeToDriveEvents() {
  const callbacks = [];
  window.api.onDrivesUpdated.mockImplementation((cb) => {
    callbacks.push(cb);
    return () => {
      const index = callbacks.indexOf(cb);
      if (index >= 0) callbacks.splice(index, 1);
    };
  });
  return (payload) => act(() => callbacks.forEach((cb) => cb(payload)));
}

function renderExplorer() {
  return render(
    <PlayerProvider>
      <FileExplorerView />
    </PlayerProvider>
  );
}

// #514: a USB stick that comes back under a different letter must not leave the
// Explorer pointing at the old, now stale, path.
describe('FileExplorerView - drive hot-swap (#514)', () => {
  it('follows the browsed volume when it returns under a new drive letter', async () => {
    window.api.getComputerRoot.mockResolvedValue({
      root: 'C:\\',
      home: 'E:\\Music',
      drives: ['C:\\', 'E:\\'],
      volumes: [],
    });
    const emitDrivesUpdated = subscribeToDriveEvents();

    renderExplorer();

    await waitFor(() => {
      expect(window.api.browseDirectory).toHaveBeenCalledWith('E:\\Music');
    });

    emitDrivesUpdated({
      drives: ['C:\\', 'D:\\'],
      volumes: [],
      added: [],
      removed: [],
      letterChanged: [{ id: 'win32:vol:1', from: 'E:\\', to: 'D:\\', volume: { root: 'D:\\' } }],
    });

    await waitFor(() => {
      expect(window.api.browseDirectory).toHaveBeenCalledWith('D:\\Music');
    });
  });

  it('keeps the current folder when a different drive appears', async () => {
    window.api.getComputerRoot.mockResolvedValue({
      root: 'C:\\',
      home: 'E:\\Music',
      drives: ['C:\\', 'E:\\'],
      volumes: [],
    });
    const emitDrivesUpdated = subscribeToDriveEvents();

    renderExplorer();

    await waitFor(() => {
      expect(window.api.browseDirectory).toHaveBeenCalledWith('E:\\Music');
    });
    window.api.browseDirectory.mockClear();

    emitDrivesUpdated({
      drives: ['C:\\', 'E:\\', 'F:\\'],
      volumes: [],
      added: [{ root: 'F:\\' }],
      removed: [],
      letterChanged: [],
    });

    await waitFor(() => {
      expect(window.api.browseDirectory).toHaveBeenCalledWith('E:\\Music');
    });
    expect(window.api.browseDirectory).not.toHaveBeenCalledWith('F:\\');
  });

  it('unsubscribes from the drive event on unmount', async () => {
    const unsubscribe = vi.fn();
    window.api.onDrivesUpdated.mockImplementation(() => unsubscribe);

    const { unmount } = renderExplorer();
    await waitFor(() => {
      expect(window.api.onDrivesUpdated).toHaveBeenCalled();
    });

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('re-points favourites that lived on the renamed drive', async () => {
    window.api.getComputerRoot.mockResolvedValue({
      root: 'C:\\',
      home: 'E:\\Music',
      drives: ['C:\\', 'E:\\'],
      volumes: [],
    });
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(
        key === 'explorer_favourites'
          ? JSON.stringify([{ path: 'E:\\Music', name: 'Music' }])
          : (def ?? null)
      )
    );
    const emitDrivesUpdated = subscribeToDriveEvents();

    renderExplorer();

    await waitFor(() => {
      expect(window.api.getSetting).toHaveBeenCalledWith('explorer_favourites', []);
    });

    emitDrivesUpdated({
      drives: ['C:\\', 'D:\\'],
      volumes: [],
      added: [],
      removed: [],
      letterChanged: [{ id: 'win32:vol:1', from: 'E:\\', to: 'D:\\', volume: { root: 'D:\\' } }],
    });

    await waitFor(() => {
      expect(window.api.setSetting).toHaveBeenCalledWith(
        'explorer_favourites',
        JSON.stringify([{ path: 'D:\\Music', name: 'Music' }])
      );
    });
  });
});
