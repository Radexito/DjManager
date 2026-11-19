import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FileExplorerView from '../FileExplorerView.jsx';
import { PlayerProvider } from '../PlayerContext.jsx';

globalThis.ResizeObserver =
  globalThis.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

/** Renders the explorer inside the player provider the component expects. */
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
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(key === 'explorer_favourites' ? '' : def)
    );

    renderExplorer();

    await waitFor(() => {
      expect(window.api.getSetting).toHaveBeenCalledWith('explorer_favourites', []);
    });
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
