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

const EXPORT_ROOT = '/home/radexito/output_folder/id3';
const REKORDBOX = {
  software: 'rekordbox',
  label: 'Rekordbox',
  path: `${EXPORT_ROOT}/PIONEER/rekordbox/export.pdb`,
  parsed: true,
  trackCount: 3,
  playlists: 2,
  entries: [
    {
      id: 'pl-1',
      name: 'hhc',
      trackCount: 2,
      tracks: [
        {
          id: 199,
          title: 'The Third Invasion',
          artist: 'AniMe feat. Dave Revan',
          album: '',
          duration: 302.7,
          bpm: 174,
          key: 'F# minor',
          file_path: '/music/a.mp3',
          absolute_path: `${EXPORT_ROOT}/music/a.mp3`,
        },
        {
          id: 200,
          title: 'Second Wind',
          artist: 'B',
          album: '',
          duration: 120,
          bpm: 150,
          key: 'A minor',
          file_path: '/music/b.mp3',
          absolute_path: `${EXPORT_ROOT}/music/b.mp3`,
        },
      ],
    },
    {
      id: 'pl-2',
      name: 'Peak',
      trackCount: 1,
      tracks: [
        {
          id: 201,
          title: 'Only One',
          artist: 'C',
          album: '',
          duration: 60,
          bpm: 160,
          key: 'C major',
          file_path: '/music/c.mp3',
          absolute_path: `${EXPORT_ROOT}/music/c.mp3`,
        },
      ],
    },
  ],
  note: null,
};

function renderExplorer() {
  return render(
    <PlayerProvider>
      <FileExplorerView />
    </PlayerProvider>
  );
}

describe('FileExplorerView - library view of a detected export (#504)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(key === 'explorer_favourites' ? [] : def)
    );
    window.api.getComputerRoot.mockResolvedValue({
      root: '/',
      home: EXPORT_ROOT,
      drives: [],
      volumes: [{ id: 'linux:system', root: '/', label: '/', removable: false, system: true }],
    });
    window.api.findExportAt.mockResolvedValue({
      ok: true,
      root: EXPORT_ROOT,
      exports: [REKORDBOX],
    });
  });

  it('shows what the export contains instead of the folders it is made of', async () => {
    renderExplorer();

    await waitFor(() => expect(window.api.findExportAt).toHaveBeenCalledWith(EXPORT_ROOT));

    expect(await screen.findByText('📚 Rekordbox export')).toBeTruthy();
    expect(screen.getByText(/2 playlists/)).toBeTruthy();
    expect(screen.getByText(/3 tracks/)).toBeTruthy();

    // the playlists and the tracks of the open one
    expect(screen.getByText('hhc')).toBeTruthy();
    expect(screen.getByText('Peak')).toBeTruthy();
    expect(screen.getByText('The Third Invasion')).toBeTruthy();
    expect(screen.getByText('AniMe feat. Dave Revan')).toBeTruthy();
    expect(screen.getByText('5:02')).toBeTruthy();
    expect(screen.getByText('174')).toBeTruthy();

    // and not the raw export folders (the breadcrumb still shows where we are)
    expect(screen.queryByText('PIONEER')).toBeNull();
    expect(screen.queryByText('No audio files here')).toBeNull();
  });

  it('swaps the track list when another playlist is picked', async () => {
    renderExplorer();

    fireEvent.click(await screen.findByText('Peak'));

    expect(await screen.findByText('Only One')).toBeTruthy();
    expect(screen.queryByText('The Third Invasion')).toBeNull();
  });

  it('keeps the folder listing one toggle away', async () => {
    renderExplorer();

    fireEvent.click(await screen.findByText('Files'));

    expect(screen.getByText('📚 Rekordbox export detected here')).toBeTruthy();
    expect(screen.queryByText('The Third Invasion')).toBeNull();

    fireEvent.click(screen.getByText('Library view'));

    expect(await screen.findByText('The Third Invasion')).toBeTruthy();
  });

  it('hands the playlist to the library dialog with usable file paths', async () => {
    renderExplorer();

    fireEvent.click(await screen.findByText('+ Library (2)'));

    expect(await screen.findByText('2 file(s) in "hhc" (Rekordbox export)')).toBeTruthy();
  });

  it('leaves a plain folder alone', async () => {
    window.api.findExportAt.mockResolvedValue({ ok: true, root: null, exports: [] });
    window.api.getComputerRoot.mockResolvedValue({
      root: '/',
      home: '/home/radexito/music',
      drives: [],
      volumes: [{ id: 'linux:system', root: '/', label: '/', removable: false, system: true }],
    });

    renderExplorer();

    await waitFor(() =>
      expect(window.api.findExportAt).toHaveBeenCalledWith('/home/radexito/music')
    );
    expect(screen.queryByText('📚 Rekordbox export')).toBeNull();
    expect(screen.queryByText('Library view')).toBeNull();
  });
});
