import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { PlayerProvider, usePlayer } from '../PlayerContext.jsx';
import MusicLibrary from '../MusicLibrary.jsx';

// Regression cover for the import path in the all-tracks view.
//
// The reported crash was:
//   "Cannot update a component (PlayerProvider) while rendering a different
//    component (MusicLibrary)"
// It happened because `updateQueueRef.current(...)` (a PlayerProvider setter)
// was called INSIDE the `setTracks` updater in the `onLibraryUpdated` handler.
// React runs updaters during the render phase, so touching another component's
// state there is illegal and React errors out on every import.
//
// The queue sync now runs OUTSIDE the updater, after the fetch, and snapshots the
// FULL result set rather than the loaded window. Both halves are asserted below,
// so a regression that moves the call back into the updater (or that rebuilds the
// queue from the window) turns this file red. The PlayerProvider is deliberately
// REAL: with a mocked usePlayer there is no cross-component setState to trip over
// and the original bug would slip through.

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

// The values MusicLibrary reads from the bridge for this path.
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
// getTracks orders by created_at DESC, so the new track is FIRST in the full set.
const AFTER_IMPORT = [IMPORTED, ...EXISTING];

// Set by the wiring in beforeEach.
let libraryUpdated = null; // the callback MusicLibrary registers on mount
let importFinished = false; // flips the bridge mock into "the new track exists" mode
let errorCalls = []; // every console.error message seen during the test

function QueueProbe() {
  const { queue } = usePlayer();
  return <div data-testid="queue-ids">{queue.map((t) => t.id).join(',')}</div>;
}

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

  // Swallow React's chatter but keep every message inspectable.
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errorCalls.push(args.map((a) => String(a)).join(' '));
  });

  // Desktop viewport: the overlay / bottom-sheet mode kicks in below 500px.
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

    // The regression itself: no cross-component setState during render.
    expect(renderPhaseError()).toBeUndefined();

    // The queue is the FULL view snapshot in SQL order (newest first), not the
    // loaded window with the new track appended at the end.
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

    // The filtered view reloads instead of appending, and the library-wide
    // queue snapshot must not be rebuilt from it.
    expect(screen.getByTestId('queue-ids').textContent).toBe('');
    expect(window.api.getTracks).not.toHaveBeenCalledWith(
      expect.objectContaining({ limit: FULL_RESULT_LIMIT })
    );
    expect(renderPhaseError()).toBeUndefined();
  });
});
