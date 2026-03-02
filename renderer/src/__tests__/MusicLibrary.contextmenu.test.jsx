import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MusicLibrary from '../MusicLibrary.jsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Render all rows inline — no virtualization in tests
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
  usePlayer: () => ({ play: vi.fn(), currentTrack: null, currentPlaylistId: null }),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Desktop viewport → disables overlay/bottom-sheet mode (triggered when < 500px wide)
  Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });
  window.api.getTracks.mockResolvedValue(TRACKS);
  window.api.getTrackIds.mockResolvedValue(TRACKS.map((t) => t.id));
  window.api.getPlaylistsForTrack.mockResolvedValue([]);
});

// ── Row click tests ───────────────────────────────────────────────────────────

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
    fireEvent.click(row); // first click — select
    fireEvent.click(row); // re-click — must NOT open details
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

    // Click "Edit Details" in context menu
    const editItem = screen.getByText(/✏️ Edit Details/);
    fireEvent.click(editItem);

    await waitFor(() => expect(screen.getByText('Track Details')).toBeInTheDocument());
  });
});

// ── Context menu submenu CSS class tests ─────────────────────────────────────

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

    const bpmParent = getSubmenuParent('🎵 BPM');
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
    const bpmParent = getSubmenuParent('🎵 BPM');

    // BPM item must be a descendant of the Analysis submenu
    expect(analysisSubmenu.contains(bpmParent)).toBe(true);
  });

  it('BPM submenu is a direct child of its own has-submenu element', async () => {
    renderLibrary();
    await openContextMenu('Track One');

    const bpmParent = getSubmenuParent('🎵 BPM');
    const directSubmenus = [...bpmParent.children].filter((el) =>
      el.classList.contains('context-submenu')
    );
    // Exactly one direct .context-submenu child
    expect(directSubmenus).toHaveLength(1);
  });

  it('"Add to playlist" submenu HAS context-submenu--scrollable when playlists exist', async () => {
    window.api.getPlaylistsForTrack.mockResolvedValue([
      { id: 1, name: 'My Set', color: null, is_member: false },
    ]);
    renderLibrary();
    await openContextMenu('Track One');
    // Wait for playlist submenu to appear (after async getPlaylistsForTrack)
    await waitFor(() => expect(getSubmenuParent('➕ Add to playlist')).toBeTruthy());

    const playlistParent = getSubmenuParent('➕ Add to playlist');
    const submenu = playlistParent.querySelector(':scope > .context-submenu');
    expect(submenu).toBeTruthy();
    expect(submenu.classList.contains('context-submenu--scrollable')).toBe(true);
  });

  it('"Add to playlist" is NOT shown when there are no playlists', async () => {
    window.api.getPlaylistsForTrack.mockResolvedValue([]);
    renderLibrary();
    await openContextMenu('Track One');

    // Should show a disabled "No playlists" item, not the submenu
    await waitFor(() => expect(screen.getByText(/➕ No playlists/)).toBeInTheDocument());
    expect(getSubmenuParent('➕ Add to playlist')).toBeNull();
  });
});
