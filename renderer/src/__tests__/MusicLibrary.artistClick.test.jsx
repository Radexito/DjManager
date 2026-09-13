import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MusicLibrary from '../MusicLibrary.jsx';

// ── Module mocks (same preamble as MusicLibrary.contextmenu.test.jsx) ─────────

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

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
    artist: 'Doja Cat',
    bpm: 140,
    key_camelot: '9a',
    genres: '[]',
    duration: 200,
  },
  {
    id: 4,
    title: 'Track Four',
    artist: 'Sigma, Doctor P',
    bpm: 175,
    key_camelot: '2a',
    genres: '[]',
    duration: 220,
  },
  {
    id: 3,
    title: 'Track Three',
    artist: '',
    bpm: 150,
    key_camelot: '1a',
    genres: '[]',
    duration: 210,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });
  window.api.getTracks.mockResolvedValue(TRACKS);
  window.api.getTrackIds.mockResolvedValue(TRACKS.map((t) => t.id));
  window.api.getPlaylistsForTrack.mockResolvedValue([]);
});

// ── #505 — clicking an artist searches by that artist ────────────────────────

describe('artist cell click (#505)', () => {
  it('searches by the clicked artist', async () => {
    const onArtistSearch = vi.fn();
    render(<MusicLibrary selectedPlaylist="music" onArtistSearch={onArtistSearch} />);

    fireEvent.click(await screen.findByText('Artist A'));

    expect(onArtistSearch).toHaveBeenCalledTimes(1);
    expect(onArtistSearch).toHaveBeenCalledWith('Artist A', false);
  });

  it('works for multi-word names', async () => {
    const onArtistSearch = vi.fn();
    render(<MusicLibrary selectedPlaylist="music" onArtistSearch={onArtistSearch} />);

    fireEvent.click(await screen.findByText('Doja Cat'));

    expect(onArtistSearch).toHaveBeenCalledWith('Doja Cat', false);
  });

  it('does not select the row (the click is stopped at the cell)', async () => {
    const onArtistSearch = vi.fn();
    const { container } = render(
      <MusicLibrary selectedPlaylist="music" onArtistSearch={onArtistSearch} />
    );

    const artist = await screen.findByText('Artist A');
    fireEvent.click(artist);

    expect(container.querySelectorAll('.row--selected')).toHaveLength(0);
    expect(screen.queryByText('Track Details')).not.toBeInTheDocument();
  });

  it('marks the artist as clickable and leaves unknown artists as plain text', async () => {
    render(<MusicLibrary selectedPlaylist="music" onArtistSearch={vi.fn()} />);

    const clickable = await screen.findByText('Artist A');
    expect(clickable.tagName).toBe('SPAN');
    expect(clickable.className).toBe('cell-artist--clickable');
    expect(clickable.getAttribute('title')).toBe('Search: ARTIST is Artist A');

    // Track with no artist shows "Unknown" and is not a click target
    const unknown = await screen.findByText('Unknown');
    expect(unknown.tagName).not.toBe('SPAN');
  });

  it('falls back to setting the search box when no view-switching handler is given', async () => {
    const onSearchChange = vi.fn();
    render(<MusicLibrary selectedPlaylist="music" onSearchChange={onSearchChange} />);

    fireEvent.click(await screen.findByText('Artist A'));

    expect(onSearchChange).toHaveBeenCalledWith('ARTIST is Artist A');
  });

  it('splits a comma-separated credit into one link per artist', async () => {
    const onArtistSearch = vi.fn();
    render(<MusicLibrary selectedPlaylist="music" onArtistSearch={onArtistSearch} />);

    const first = await screen.findByText('Sigma');
    const second = await screen.findByText('Doctor P');

    expect(first.className).toBe('cell-artist--clickable');
    expect(second.className).toBe('cell-artist--clickable');

    expect(second.getAttribute('title')).toBe('Search: ARTIST contains Doctor P');

    fireEvent.click(second);
    expect(onArtistSearch).toHaveBeenCalledWith('Doctor P', true);

    fireEvent.click(first);
    expect(onArtistSearch).toHaveBeenLastCalledWith('Sigma', true);
  });

  it('searches one name of a split credit through the search box fallback', async () => {
    const onSearchChange = vi.fn();
    render(<MusicLibrary selectedPlaylist="music" onSearchChange={onSearchChange} />);

    fireEvent.click(await screen.findByText('Doctor P'));

    expect(onSearchChange).toHaveBeenCalledWith('ARTIST contains Doctor P');
  });

  it('does not select the row when a split name is clicked', async () => {
    const onArtistSearch = vi.fn();
    const { container } = render(
      <MusicLibrary selectedPlaylist="music" onArtistSearch={onArtistSearch} />
    );

    fireEvent.click(await screen.findByText('Doctor P'));

    expect(container.querySelectorAll('.row--selected')).toHaveLength(0);
    expect(screen.queryByText('Track Details')).not.toBeInTheDocument();
  });

  it('is not clickable at all without a handler', async () => {
    render(<MusicLibrary selectedPlaylist="music" />);

    const artist = await screen.findByText('Artist A');
    expect(artist.className).not.toContain('cell-artist--clickable');
  });
});
