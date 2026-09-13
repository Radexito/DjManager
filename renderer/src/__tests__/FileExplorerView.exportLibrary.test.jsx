import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import FileExplorerView from '../FileExplorerView.jsx';
import { PlayerProvider } from '../PlayerContext.jsx';

// Render every virtualized row inline so rows are clickable in jsdom.
vi.mock('react-window', () => ({
  List: ({ rowComponent, rowProps, rowCount }) => {
    const Item = rowComponent;
    return (
      <div data-testid="virtual-list">
        {Array.from({ length: rowCount }, (_, i) => (
          <Item key={i} index={i} style={{}} {...rowProps} />
        ))}
      </div>
    );
  },
}));

// jsdom has no ResizeObserver; FileExplorerView uses one to size its virtualized list.
globalThis.ResizeObserver =
  globalThis.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const EXPORT_ROOT = '/home/radexito/output_folder';
const NESTED_ROOT = `${EXPORT_ROOT}/id3`;

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

/** The library view is a deliberate step, never the default. */
async function openLibraryView() {
  fireEvent.click(await screen.findByText('Open as library'));
  await screen.findByText('📚 Rekordbox export');
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

  it('stays on the folder listing and offers the library as a choice', async () => {
    renderExplorer();

    await waitFor(() => expect(window.api.findExportAt).toHaveBeenCalledWith(EXPORT_ROOT));

    expect(await screen.findByText('📚 Rekordbox export here')).toBeTruthy();
    expect(screen.getByText('Open as library')).toBeTruthy();
    // the export contents are not shown until they are asked for
    expect(screen.queryByText('The Third Invasion')).toBeNull();
  });

  it('shows what the export contains once it is opened as a library', async () => {
    renderExplorer();
    await openLibraryView();

    expect(screen.getByText(/2 playlists/)).toBeTruthy();
    expect(screen.getByText(/3 tracks/)).toBeTruthy();
    expect(screen.getByText('hhc')).toBeTruthy();
    expect(screen.getByText('Peak')).toBeTruthy();
    expect(screen.getByText('The Third Invasion')).toBeTruthy();
    expect(screen.getByText('AniMe feat. Dave Revan')).toBeTruthy();
    expect(screen.getByText('5:02')).toBeTruthy();
    expect(screen.getByText('174')).toBeTruthy();
  });

  it('swaps the track list when another playlist is picked', async () => {
    renderExplorer();
    await openLibraryView();

    fireEvent.click(screen.getByText('Peak'));

    expect(await screen.findByText('Only One')).toBeTruthy();
    expect(screen.queryByText('The Third Invasion')).toBeNull();
  });

  it('keeps the folder listing one toggle away', async () => {
    renderExplorer();
    await openLibraryView();

    fireEvent.click(screen.getByText('Files'));

    expect(await screen.findByText('📚 Rekordbox export here')).toBeTruthy();
    expect(screen.queryByText('The Third Invasion')).toBeNull();
  });

  it('hands the playlist to the library dialog with usable file paths', async () => {
    renderExplorer();
    await openLibraryView();

    fireEvent.click(screen.getByText('+ Library (2)'));

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
    expect(screen.queryByText('Open as library')).toBeNull();
  });

  it('marks an export folder one level up and opens it as a library', async () => {
    window.api.browseDirectory.mockResolvedValue({
      dirs: [
        { name: 'id3', path: NESTED_ROOT },
        { name: 'notes', path: `${EXPORT_ROOT}/notes` },
      ],
      files: [],
    });
    window.api.exportRoots.mockResolvedValue({
      ok: true,
      roots: { [NESTED_ROOT]: { software: 'rekordbox', label: 'Rekordbox' } },
    });

    renderExplorer();

    // the export folder is marked, the ordinary one is not
    const chip = await screen.findByText('Library');
    expect(chip.getAttribute('title')).toMatch(/Rekordbox export/);
    await waitFor(() => expect(window.api.exportRoots).toHaveBeenCalled());
    expect(screen.getByText('id3')).toBeTruthy();
    expect(screen.getByText('notes')).toBeTruthy();

    fireEvent.click(chip);

    await waitFor(() => expect(window.api.findExportAt).toHaveBeenCalledWith(NESTED_ROOT));
    expect(await screen.findByText('📚 Rekordbox export')).toBeTruthy();
  });
});
