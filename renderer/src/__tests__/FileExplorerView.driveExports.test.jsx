import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

const REKORDBOX = {
  software: 'rekordbox',
  label: 'Rekordbox',
  path: 'E:\\PIONEER\\rekordbox\\export.pdb',
  parsed: true,
  trackCount: 2,
  playlists: 1,
  entries: [
    {
      id: 'pl-1',
      name: 'Warmup',
      trackCount: 2,
      tracks: [
        { id: 1, title: 'Warehouse', artist: 'A', file_path: '/music/Warehouse.mp3' },
        { id: 2, title: 'Second', artist: 'B', file_path: '/music/Second.mp3' },
      ],
    },
  ],
  note: null,
};

const SERATO = {
  software: 'serato',
  label: 'Serato',
  path: 'E:\\_Serato_',
  parsed: false,
  trackCount: null,
  playlists: 2,
  entries: [],
  note: 'Track listing needs a Serato database parser (not implemented yet).',
};

function renderExplorer() {
  return render(
    <PlayerProvider>
      <FileExplorerView />
    </PlayerProvider>
  );
}

describe('FileExplorerView - detected DJ exports per drive (#504)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(key === 'explorer_favourites' ? [] : def)
    );
    window.api.getComputerRoot.mockResolvedValue({
      root: 'E:\\',
      home: 'E:\\',
      drives: ['C:\\', 'E:\\'],
    });
  });

  it('scans the selected drive and lists its detected exports', async () => {
    window.api.detectDriveExports.mockResolvedValue({ ok: true, exports: [REKORDBOX, SERATO] });

    renderExplorer();

    await waitFor(() => expect(window.api.detectDriveExports).toHaveBeenCalledWith('E:\\'));
    expect(await screen.findByText('Rekordbox export - 1 playlist / 2 tracks')).toBeTruthy();
    expect(screen.getByText('Serato export - 2 playlists')).toBeTruthy();
  });

  it('expands a parsed export into its playlists and tracks', async () => {
    window.api.detectDriveExports.mockResolvedValue({ ok: true, exports: [REKORDBOX] });

    renderExplorer();

    const head = await screen.findByText('Rekordbox export - 1 playlist / 2 tracks');
    fireEvent.click(head);

    expect(await screen.findByText('Warmup (2)')).toBeTruthy();
    expect(screen.getByText('Warehouse')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('shows the not-parsed note for exports with no reader yet', async () => {
    window.api.detectDriveExports.mockResolvedValue({ ok: true, exports: [SERATO] });

    renderExplorer();

    const head = await screen.findByText('Serato export - 2 playlists');
    fireEvent.click(head);

    expect(
      await screen.findByText('Track listing needs a Serato database parser (not implemented yet).')
    ).toBeTruthy();
  });

  it('reports when a drive has no DJ exports', async () => {
    window.api.detectDriveExports.mockResolvedValue({ ok: true, exports: [] });

    renderExplorer();

    expect(await screen.findByText('No DJ exports found')).toBeTruthy();
  });
});
