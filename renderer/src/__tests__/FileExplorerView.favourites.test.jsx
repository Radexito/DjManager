import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

function renderExplorer() {
  return render(
    <PlayerProvider>
      <FileExplorerView />
    </PlayerProvider>
  );
}

describe('FileExplorerView — favourites persistence (regression for #400)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not crash when the stored setting is a corrupt empty string', async () => {
    // String([]) coerces to '' — the exact bad value that used to be persisted
    // by setSetting() before it was JSON.stringify'd.
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(key === 'explorer_favourites' ? '' : def)
    );

    renderExplorer();

    await waitFor(() => {
      expect(window.api.getSetting).toHaveBeenCalledWith('explorer_favourites', []);
    });
    // No uncaught JSON.parse SyntaxError — component renders normally.
    expect(screen.getAllByText(/Favourites/i).length).toBeGreaterThan(0);
  });

  it('does not crash when the stored setting is malformed non-JSON text', async () => {
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(key === 'explorer_favourites' ? '[object Object]' : def)
    );

    renderExplorer();

    await waitFor(() => {
      expect(window.api.getSetting).toHaveBeenCalledWith('explorer_favourites', []);
    });
  });

  it('loads a well-formed JSON-stringified favourites array', async () => {
    const favs = [{ path: '/music/a', name: 'a' }];
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(key === 'explorer_favourites' ? JSON.stringify(favs) : def)
    );

    renderExplorer();

    await waitFor(() => {
      expect(window.api.getSetting).toHaveBeenCalledWith('explorer_favourites', []);
    });
  });
});
