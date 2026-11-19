import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { PlayerProvider, usePlayer } from '../PlayerContext.jsx';
import MusicLibrary from '../MusicLibrary.jsx';

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

/** Limit the view sends when it wants the whole library; the `getTracks` mock keys off it. */
const FULL_RESULT_LIMIT = 999999;

const makeTrack = (id, title) => ({
  id,
  title,
  artist: 'Artist',
  bpm: 128,
  key_camelot: '8a',
  genres: '[]',
  duration: 180,
  file_path: `/music/${id}.mp3`,
  is_linked: 0,
});

const EXISTING = [makeTrack(1, 'Track One'), makeTrack(2, 'Track Two')];
const IMPORTED = makeTrack(99, 'Imported Track');
const AFTER_IMPORT = [IMPORTED, ...EXISTING];

/** Callback registered through `onLibraryUpdated`, replaced on every mount. */
let libraryUpdated = null;
/** Flipped once the fake import completes so `getTracks` starts returning the new row. */
let importFinished = false;
let errorCalls = [];

/** Prints the player queue ids so a test can assert the queue followed the import. */
function QueueProbe() {
  const { queue } = usePlayer();
  return <div data-testid="queue-ids">{queue.map((t) => t.id).join(',')}</div>;
}

/** Renders the library and the queue probe inside the player provider. */
function renderLibraryWithPlayer(props = {}) {
  return render(
    <PlayerProvider>
      <MusicLibrary selectedPlaylist="music" {...props} />
      <QueueProbe />
    </PlayerProvider>
  );
}

const renderPhaseError = () => errorCalls.find((m) => /while rendering/i.test(m));

beforeEach(() => {
  vi.clearAllMocks();
  importFinished = false;
  libraryUpdated = null;
  errorCalls = [];

  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errorCalls.push(args.map((a) => String(a)).join(' '));
  });

  Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });

  window.api.onLibraryUpdated.mockImplementation((cb) => {
    libraryUpdated = cb;
    return () => {};
  });
  window.api.getTracks.mockImplementation((opts = {}) => {
    if (opts.limit === FULL_RESULT_LIMIT) return Promise.resolve(AFTER_IMPORT);
    return Promise.resolve(importFinished ? AFTER_IMPORT : EXISTING);
  });
  window.api.getTrackIds.mockResolvedValue(EXISTING.map((t) => t.id));
  window.api.countTracks.mockResolvedValue(EXISTING.length);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('import into the all-tracks view', () => {
  it('syncs the player queue from the full result set without a render-phase update', async () => {
    renderLibraryWithPlayer();

    await waitFor(() => expect(window.api.getTracks).toHaveBeenCalled());
    await waitFor(() => expect(libraryUpdated).toBeTypeOf('function'));
    expect(screen.getByTestId('queue-ids').textContent).toBe('');

    importFinished = true;
    await act(async () => {
      await libraryUpdated();
    });

    expect(renderPhaseError()).toBeUndefined();

    await waitFor(() => expect(screen.getByTestId('queue-ids').textContent).toBe('99,1,2'));

    expect(window.api.getTracks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: FULL_RESULT_LIMIT })
    );
  });

  it('leaves the player queue alone when a search filter is active', async () => {
    renderLibraryWithPlayer({ search: 'ARTIST is Nobody' });

    await waitFor(() => expect(window.api.getTracks).toHaveBeenCalled());
    await waitFor(() => expect(libraryUpdated).toBeTypeOf('function'));

    importFinished = true;
    await act(async () => {
      await libraryUpdated();
    });

    expect(screen.getByTestId('queue-ids').textContent).toBe('');
    expect(window.api.getTracks).not.toHaveBeenCalledWith(
      expect.objectContaining({ limit: FULL_RESULT_LIMIT })
    );
    expect(renderPhaseError()).toBeUndefined();
  });
});
