import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import FileExplorerView from '../FileExplorerView.jsx';

// The player is not what this suite is about, but playing from a row is.
const { playSpy } = vi.hoisted(() => ({ playSpy: vi.fn() }));
vi.mock('../PlayerContext.jsx', () => ({
  usePlayer: () => ({
    play: playSpy,
    currentTrack: null,
    mediaPort: 19876,
    patchCurrentTrack: vi.fn(),
  }),
}));

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

globalThis.ResizeObserver =
  globalThis.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const EXPORT_ROOT = '/home/radexito/output_folder';
const NESTED_ROOT = `${EXPORT_ROOT}/id3`;

const track = (id, title, artist, key, camelot, bpm, duration) => ({
  id,
  title,
  artist,
  album: '',
  duration,
  bpm,
  key,
  key_camelot: camelot,
  file_path: `/music/${id}.mp3`,
  absolute_path: `${EXPORT_ROOT}/music/${id}.mp3`,
});

const T_INVASION = track(
  199,
  'The Third Invasion',
  'AniMe feat. Dave Revan',
  'F# minor',
  '11A',
  174,
  302.7
);
const T_SECOND = track(200, 'Second Wind', 'B', 'A minor', '8A', 150, 120);
const T_ONLY = track(201, 'Only One', 'C', 'C major', '8B', 160, 60);

const REKORDBOX = {
  software: 'rekordbox',
  label: 'Rekordbox',
  path: `${EXPORT_ROOT}/PIONEER/rekordbox/export.pdb`,
  parsed: true,
  trackCount: 3,
  playlists: 2,
  tracks: [T_INVASION, T_SECOND, T_ONLY],
  entries: [
    { id: 'pl-1', name: 'hhc', trackCount: 2, tracks: [T_INVASION, T_SECOND] },
    { id: 'pl-2', name: 'Peak', trackCount: 1, tracks: [T_ONLY] },
  ],
  note: null,
};

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
    render(<FileExplorerView />);

    await waitFor(() => expect(window.api.findExportAt).toHaveBeenCalledWith(EXPORT_ROOT));

    expect(await screen.findByText('📚 Rekordbox export here')).toBeTruthy();
    expect(screen.getByText('Open as library')).toBeTruthy();
    expect(screen.queryByText('The Third Invasion')).toBeNull();
  });

  it('shows the export through the same listing a folder uses, all tracks first', async () => {
    render(<FileExplorerView />);
    await openLibraryView();

    // Rekordbox's collection first, then the playlists
    expect(screen.getByText('All tracks')).toBeTruthy();
    expect(screen.getByText('hhc')).toBeTruthy();
    expect(screen.getByText('Peak')).toBeTruthy();
    expect(screen.getByText(/2 playlists/)).toBeTruthy();

    // every track of the export, with the metadata the manifest carries
    expect(screen.getByText('The Third Invasion')).toBeTruthy();
    expect(screen.getByText('Second Wind')).toBeTruthy();
    expect(screen.getByText('Only One')).toBeTruthy();
    expect(screen.getByText('AniMe feat. Dave Revan')).toBeTruthy();
    expect(screen.getByText('5:02')).toBeTruthy();
    expect(screen.getByText('174')).toBeTruthy();
    expect(screen.getByText('11A')).toBeTruthy();

    // and the rows are the explorer's rows, play button included
    expect(document.querySelectorAll('.index-play').length).toBeGreaterThan(0);
  });

  it('swaps the track list when another playlist is picked', async () => {
    render(<FileExplorerView />);
    await openLibraryView();

    fireEvent.click(screen.getByText('Peak'));

    expect(await screen.findByText('Only One')).toBeTruthy();
    expect(screen.queryByText('The Third Invasion')).toBeNull();
  });

  it('keeps the folder listing one toggle away', async () => {
    render(<FileExplorerView />);
    await openLibraryView();

    fireEvent.click(screen.getByText('Files'));

    expect(await screen.findByText('📚 Rekordbox export here')).toBeTruthy();
    expect(screen.queryByText('The Third Invasion')).toBeNull();
  });

  it('plays a track the way the explorer does', async () => {
    render(<FileExplorerView />);
    await openLibraryView();

    fireEvent.doubleClick(screen.getByText('The Third Invasion'));

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(playSpy.mock.calls[0][0]).toMatchObject({
      title: 'The Third Invasion',
      bpm: 174,
      key_camelot: '11A',
      file_path: `${EXPORT_ROOT}/music/199.mp3`,
    });
  });

  it('offers the explorer context menu on an export track', async () => {
    render(<FileExplorerView />);
    await openLibraryView();

    fireEvent.contextMenu(screen.getByText('The Third Invasion'));

    expect(await screen.findByText('➕ Add to library')).toBeTruthy();
    expect(screen.getByText('➕ Add to playlist')).toBeTruthy();
    expect(screen.getByText('▶ Play')).toBeTruthy();

    fireEvent.click(screen.getByText('➕ Add to library'));

    await waitFor(() =>
      expect(window.api.linkAudioFiles).toHaveBeenCalledWith([`${EXPORT_ROOT}/music/199.mp3`], null)
    );
  });

  it('adds a whole playlist from the sidebar', async () => {
    render(<FileExplorerView />);
    await openLibraryView();

    fireEvent.click(screen.getByTitle('Add "All tracks" to the library'));

    expect(await screen.findByText('3 track(s) in "All tracks" (Rekordbox export)')).toBeTruthy();
  });

  it('leaves a plain folder alone', async () => {
    window.api.findExportAt.mockResolvedValue({ ok: true, root: null, exports: [] });
    window.api.getComputerRoot.mockResolvedValue({
      root: '/',
      home: '/home/radexito/music',
      drives: [],
      volumes: [{ id: 'linux:system', root: '/', label: '/', removable: false, system: true }],
    });

    render(<FileExplorerView />);

    await waitFor(() =>
      expect(window.api.findExportAt).toHaveBeenCalledWith('/home/radexito/music')
    );
    expect(screen.queryByText('📚 Rekordbox export')).toBeNull();
    expect(screen.queryByText('Open as library')).toBeNull();
  });

  it('asks how to open a folder that holds an export', async () => {
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

    render(<FileExplorerView />);

    await screen.findByText('Library');
    fireEvent.doubleClick(screen.getByText('id3'));

    expect(await screen.findByText('Open id3')).toBeTruthy();
    expect(dialogButton('Open as folder')).toBeTruthy();
    expect(dialogButton('Open as library')).toBeTruthy();

    // a folder that is not an export is still opened straight away
    fireEvent.doubleClick(screen.getByText('notes'));

    await waitFor(() =>
      expect(window.api.findExportAt).toHaveBeenCalledWith(`${EXPORT_ROOT}/notes`)
    );
    expect(screen.queryByText('Open notes')).toBeNull();
  });

  it('opens the folder, not the library, when the folder is chosen', async () => {
    window.api.browseDirectory.mockResolvedValue({
      dirs: [{ name: 'id3', path: NESTED_ROOT }],
      files: [],
    });
    window.api.exportRoots.mockResolvedValue({
      ok: true,
      roots: { [NESTED_ROOT]: { software: 'rekordbox', label: 'Rekordbox' } },
    });

    render(<FileExplorerView />);

    await screen.findByText('Library');
    fireEvent.doubleClick(screen.getByText('id3'));
    await screen.findByText('Open id3');
    fireEvent.click(dialogButton('Open as folder'));

    await waitFor(() => expect(window.api.findExportAt).toHaveBeenCalledWith(NESTED_ROOT));
    expect(screen.queryByText('The Third Invasion')).toBeNull();
    expect(screen.getByText('Open as library')).toBeTruthy();
  });

  it('opens the library when the library is chosen', async () => {
    window.api.browseDirectory.mockResolvedValue({
      dirs: [{ name: 'id3', path: NESTED_ROOT }],
      files: [],
    });
    window.api.exportRoots.mockResolvedValue({
      ok: true,
      roots: { [NESTED_ROOT]: { software: 'rekordbox', label: 'Rekordbox' } },
    });

    render(<FileExplorerView />);

    await screen.findByText('Library');
    fireEvent.doubleClick(screen.getByText('id3'));
    await screen.findByText('Open id3');
    fireEvent.click(dialogButton('Open as library'));

    expect(await screen.findByText('The Third Invasion')).toBeTruthy();
  });

  it('does not carry the library view into the next folder', async () => {
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

    render(<FileExplorerView />);

    // open a library on purpose...
    fireEvent.click(await screen.findByText('Library'));
    await screen.findByText('The Third Invasion');

    // ...then leave the library view and walk into an ordinary folder
    fireEvent.click(screen.getByText('Files'));
    fireEvent.doubleClick(await screen.findByText('notes'));

    await waitFor(() =>
      expect(window.api.findExportAt).toHaveBeenCalledWith(`${EXPORT_ROOT}/notes`)
    );
    expect(screen.queryByText('The Third Invasion')).toBeNull();
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

    render(<FileExplorerView />);

    // the export folder is marked, the ordinary one is not
    const chip = await screen.findByTitle(/Rekordbox export/);
    expect(screen.getByText('id3')).toBeTruthy();
    expect(screen.getByText('notes')).toBeTruthy();

    fireEvent.click(chip);

    await waitFor(() => expect(window.api.findExportAt).toHaveBeenCalledWith(NESTED_ROOT));
    expect(await screen.findByText('📚 Rekordbox export')).toBeTruthy();
  });
});

/** Buttons inside the open dialog: the banner behind it uses the same wording. */
function dialogButton(label) {
  const dialog = document.querySelector('.explorer-dialog');
  if (!dialog) throw new Error('no open dialog');
  return [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
}
