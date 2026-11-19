import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MusicLibrary from '../MusicLibrary.jsx';

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

vi.mock('../PlayerContext.jsx', () => ({
  usePlayer: () => ({
    play: vi.fn(),
    currentTrack: null,
    currentPlaylistId: null,
    updateQueue: vi.fn(),
    unavailableLinkedIds: new Set(),
  }),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => children,
  closestCenter: vi.fn(),
  PointerSensor: class {},
  useSensor: vi.fn(() => null),
  useSensors: vi.fn((...args) => args),
  DragOverlay: () => null,
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }) => children,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: vi.fn(),
  arrayMove: (arr, from, to) => {
    const res = [...arr];
    res.splice(to, 0, res.splice(from, 1)[0]);
    return res;
  },
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}));

const TRACKS = [
  {
    id: 1,
    title: 'Track One',
    artist: 'Artist A',
    bpm: 128,
    key_camelot: '8a',
    genres: '[]',
    duration: 180,
  },
  {
    id: 2,
    title: 'Track Two',
    artist: 'Artist B',
    bpm: 140,
    key_camelot: '9a',
    genres: '[]',
    duration: 200,
  },
];

/** Renders the library view with the music (all tracks) tab selected. */
function renderLibrary() {
  return render(<MusicLibrary selectedPlaylist="music" />);
}

/** Find a .context-menu-item--has-submenu whose first text node contains labelText */
function getSubmenuParent(labelText) {
  const items = document.querySelectorAll('.context-menu-item--has-submenu');
  for (const item of items) {
    const firstText = [...item.childNodes]
      .find((n) => n.nodeType === Node.TEXT_NODE)
      ?.textContent?.trim();
    if (firstText?.includes(labelText)) return item;
  }
  return null;
}

/** Open context menu on the row for trackTitle and wait for it to appear */
async function openContextMenu(trackTitle) {
  const cell = await screen.findByText(trackTitle);
  fireEvent.contextMenu(cell.closest('.row'), { clientX: 100, clientY: 100 });
  await waitFor(() => expect(document.querySelector('.context-menu')).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });
  window.api.getTracks.mockResolvedValue(TRACKS);
  window.api.getTrackIds.mockResolvedValue(TRACKS.map((t) => t.id));
  window.api.getPlaylistsForTrack.mockResolvedValue([]);
});

describe('row click — details panel should NOT open', () => {
  it('single click selects a track without opening details panel', async () => {
    renderLibrary();
    const row = (await screen.findByText('Track One')).closest('.row');
    fireEvent.click(row);
    expect(screen.queryByText('Track Details')).not.toBeInTheDocument();
  });

  it('clicking an already-selected track (re-click) does NOT open details panel', async () => {
    renderLibrary();
    const row = (await screen.findByText('Track One')).closest('.row');
    fireEvent.click(row);
    fireEvent.click(row);
    expect(screen.queryByText('Track Details')).not.toBeInTheDocument();
  });

  it('clicking a different track after selecting one does not open details', async () => {
    renderLibrary();
    await screen.findByText('Track One');
    fireEvent.click(screen.getByText('Track One').closest('.row'));
    fireEvent.click(screen.getByText('Track Two').closest('.row'));
    expect(screen.queryByText('Track Details')).not.toBeInTheDocument();
  });

  it('details panel only opens via right-click → Edit Details', async () => {
    renderLibrary();
    await openContextMenu('Track One');

    const editItem = screen.getByText(/✏️ Edit Details/);
    fireEvent.click(editItem);

    await waitFor(() => expect(screen.getByText('Track Details')).toBeInTheDocument());
  });
});

describe('context menu — submenu CSS classes', () => {
  it('Analysis submenu does NOT have context-submenu--scrollable', async () => {
    renderLibrary();
    await openContextMenu('Track One');

    const analysisParent = getSubmenuParent('🔬 Analysis');
    expect(analysisParent).toBeTruthy();

    const submenu = analysisParent.querySelector(':scope > .context-submenu');
    expect(submenu).toBeTruthy();
    expect(submenu.classList.contains('context-submenu--scrollable')).toBe(false);
  });

  it('BPM submenu does NOT have context-submenu--scrollable', async () => {
    renderLibrary();
    await openContextMenu('Track One');

    const bpmParent = getSubmenuParent('🥁 Beat Grid');
    expect(bpmParent).toBeTruthy();

    const submenu = bpmParent.querySelector(':scope > .context-submenu');
    expect(submenu).toBeTruthy();
    expect(submenu.classList.contains('context-submenu--scrollable')).toBe(false);
  });

  it('BPM SubItem is nested inside the Analysis submenu (not at root level)', async () => {
    renderLibrary();
    await openContextMenu('Track One');

    const analysisParent = getSubmenuParent('🔬 Analysis');
    const analysisSubmenu = analysisParent.querySelector(':scope > .context-submenu');
    const bpmParent = getSubmenuParent('🥁 Beat Grid');

    expect(analysisSubmenu.contains(bpmParent)).toBe(true);
  });

  it('BPM submenu is a direct child of its own has-submenu element', async () => {
    renderLibrary();
    await openContextMenu('Track One');

    const bpmParent = getSubmenuParent('🥁 Beat Grid');
    const directSubmenus = [...bpmParent.children].filter((el) =>
      el.classList.contains('context-submenu')
    );
    expect(directSubmenus).toHaveLength(1);
  });

  it('"Add to playlist" submenu HAS context-submenu--scrollable when playlists exist', async () => {
    window.api.getPlaylistsForTrack.mockResolvedValue([
      { id: 1, name: 'My Set', color: null, is_member: false },
    ]);
    renderLibrary();
    await openContextMenu('Track One');
    await waitFor(() => expect(getSubmenuParent('➕ Add to playlist')).toBeTruthy());

    const playlistParent = getSubmenuParent('➕ Add to playlist');
    const submenu = playlistParent.querySelector(':scope > .context-submenu');
    expect(submenu).toBeTruthy();
    expect(submenu.classList.contains('context-submenu--scrollable')).toBe(true);
  });

  it('shows "Add to new playlist" option directly when there are no playlists', async () => {
    window.api.getPlaylistsForTrack.mockResolvedValue([]);
    renderLibrary();
    await openContextMenu('Track One');

    await waitFor(() => expect(screen.getByText(/➕ Add to new playlist…/)).toBeInTheDocument());
    expect(getSubmenuParent('➕ Add to playlist')).toBeNull();
  });
});

describe('context menu — move to library', () => {
  it('does not show "Move to library" when only one library exists', async () => {
    renderLibrary();
    await openContextMenu('Track One');
    await waitFor(() => expect(window.api.listLibrariesWithFreeSpace).toHaveBeenCalled());
    expect(getSubmenuParent('📚 Move to library')).toBeNull();
  });

  it('shows each library with its free disk space when multiple libraries exist', async () => {
    window.api.listLibrariesWithFreeSpace.mockResolvedValue([
      { id: 1, name: 'Default', free_bytes: 5 * 1024 ** 3 },
      { id: 2, name: 'Backup', free_bytes: 2 * 1024 ** 2 },
    ]);
    renderLibrary();
    await openContextMenu('Track One');
    await waitFor(() => expect(getSubmenuParent('📚 Move to library')).toBeTruthy());

    fireEvent.mouseEnter(getSubmenuParent('📚 Move to library'));
    expect(await screen.findByText('Backup')).toBeInTheDocument();
    expect(screen.getByText('5.0 GB free')).toBeInTheDocument();
    expect(screen.getByText('2.0 MB free')).toBeInTheDocument();
  });

  it('clicking a library calls moveTracksToLibrary with the track id and target library', async () => {
    window.api.listLibrariesWithFreeSpace.mockResolvedValue([
      { id: 1, name: 'Default', free_bytes: 5 * 1024 ** 3 },
      { id: 2, name: 'Backup', free_bytes: 2 * 1024 ** 3 },
    ]);
    renderLibrary();
    await openContextMenu('Track One');
    await waitFor(() => expect(getSubmenuParent('📚 Move to library')).toBeTruthy());
    fireEvent.mouseEnter(getSubmenuParent('📚 Move to library'));

    fireEvent.click(await screen.findByText('Backup'));
    await waitFor(() => expect(window.api.moveTracksToLibrary).toHaveBeenCalledWith([1], 2));
  });

  it('updates an already-open Edit Details panel in place after moving that same track', async () => {
    window.api.moveTracksToLibrary.mockResolvedValue({
      moved: [{ trackId: 1, newPath: '/tmp/userData/audio/2/newpath.mp3' }],
      failed: [],
    });
    window.api.listLibraries.mockResolvedValue([
      { id: 1, name: 'Default', storage_format: 'hashed', root_path: null },
      { id: 2, name: 'Backup', storage_format: 'hashed', root_path: null },
    ]);
    window.api.listLibrariesWithFreeSpace.mockResolvedValue([
      { id: 1, name: 'Default', free_bytes: 5 * 1024 ** 3 },
      { id: 2, name: 'Backup', free_bytes: 2 * 1024 ** 3 },
    ]);
    renderLibrary();

    await openContextMenu('Track One');
    fireEvent.click(screen.getByText(/✏️ Edit Details/));
    await waitFor(() => expect(screen.getByText('Track Details')).toBeInTheDocument());
    expect(screen.getByText('Library').nextSibling).toHaveTextContent('—');

    await openContextMenu('Track One');
    await waitFor(() => expect(getSubmenuParent('📚 Move to library')).toBeTruthy());
    fireEvent.mouseEnter(getSubmenuParent('📚 Move to library'));
    await waitFor(() => expect(document.querySelector('.context-menu-item--library')).toBeTruthy());
    const backupItem = [...document.querySelectorAll('.context-menu-item--library')].find((el) =>
      el.textContent.includes('Backup')
    );
    fireEvent.click(backupItem);
    await waitFor(() => expect(window.api.moveTracksToLibrary).toHaveBeenCalledWith([1], 2));

    await waitFor(() =>
      expect(screen.getByText('Library').nextSibling).toHaveTextContent('Backup')
    );
  });
});

describe('context menu — remove from library with confirmation', () => {
  it('right-click → "Remove from library" calls window.confirm with a message containing "Remove"', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderLibrary();
    await openContextMenu('Track One');
    const removeItem = screen.getByText(/🗑️ Remove from library/);
    fireEvent.click(removeItem);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Remove'));
  });

  it('if window.confirm returns false, removeTracks is NOT called', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderLibrary();
    await openContextMenu('Track One');
    fireEvent.click(screen.getByText(/🗑️ Remove from library/));
    expect(window.api.removeTracks).not.toHaveBeenCalled();
  });

  it('if window.confirm returns true, removeTracks IS called with the track ID', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderLibrary();
    await openContextMenu('Track One');
    fireEvent.click(screen.getByText(/🗑️ Remove from library/));
    await waitFor(() => expect(window.api.removeTracks).toHaveBeenCalledWith([1]));
  });
});

describe('context menu — playlist view shows both remove options', () => {
  function renderPlaylistLibrary() {
    window.api.getPlaylist.mockResolvedValue({
      id: 1,
      name: 'Test Playlist',
      color: null,
      track_count: 2,
      total_duration: 380,
    });
    return render(<MusicLibrary selectedPlaylist="1" />);
  }

  it('shows both "Remove from playlist" and "Remove from library" in playlist view', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPlaylistLibrary();
    await openContextMenu('Track One');
    expect(screen.getByText(/➖ Remove from playlist/)).toBeInTheDocument();
    expect(screen.getByText(/🗑️ Remove from library/)).toBeInTheDocument();
  });
});

describe('search bar', () => {
  it('renders the search input inside MusicLibrary content and forwards typed text via onSearchChange', async () => {
    const onSearchChange = vi.fn();
    render(<MusicLibrary selectedPlaylist="music" search="" onSearchChange={onSearchChange} />);
    await screen.findByText('Track One');

    const input = screen.getByPlaceholderText(/Search…/);
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Techno' } });
    expect(onSearchChange).toHaveBeenCalled();
  });

  it('reflects the current search value passed in via props', async () => {
    render(
      <MusicLibrary selectedPlaylist="music" search="ARTIST is Foo" onSearchChange={() => {}} />
    );
    await screen.findByText('Track One');
    expect(screen.getByText('ARTIST')).toBeInTheDocument();
  });
});
