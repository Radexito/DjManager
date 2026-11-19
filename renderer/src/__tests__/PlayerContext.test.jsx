import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { PlayerProvider, usePlayer } from '../PlayerContext.jsx';

/** Render a PlayerProvider and expose the context value via renderHook. */
function renderProvider() {
  return renderHook(() => usePlayer(), { wrapper: PlayerProvider });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api.getMediaPort.mockResolvedValue(19876);
});

describe('PlayerProvider — media server port', () => {
  it('calls getMediaPort() on mount', async () => {
    renderProvider();
    await waitFor(() => expect(window.api.getMediaPort).toHaveBeenCalledTimes(1));
  });

  it('does not call getMediaPort more than once on mount', async () => {
    renderProvider();
    await waitFor(() => expect(window.api.getMediaPort).toHaveBeenCalled());
    expect(window.api.getMediaPort).toHaveBeenCalledTimes(1);
  });
});

describe('PlayerProvider — context API', () => {
  it('exposes expected API surface', () => {
    const { result } = renderProvider();
    const ctx = result.current;
    expect(typeof ctx.seek).toBe('function');
    expect(typeof ctx.play).toBe('function');
    expect(typeof ctx.stop).toBe('function');
    expect(typeof ctx.toggleShuffle).toBe('function');
    expect(typeof ctx.cycleRepeat).toBe('function');
    expect(typeof ctx.reloadCurrentTrack).toBe('function');
    expect(ctx.isPlaying).toBe(false);
    expect(ctx.currentTime).toBe(0);
    expect(ctx.duration).toBe(0);
  });
});

describe('PlayerProvider — AudioContext crash guard', () => {
  let originalAudioContext;

  beforeEach(() => {
    originalAudioContext = window.AudioContext;
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
  });

  it('renders without crashing when AudioContext constructor throws', () => {
    window.AudioContext = class {
      constructor() {
        throw new Error('NotSupportedError: AudioContext is not supported');
      }
    };

    expect(() => renderProvider()).not.toThrow();
  });

  it('still exposes full API surface when AudioContext constructor throws', () => {
    window.AudioContext = class {
      constructor() {
        throw new Error('NotSupportedError: AudioContext is not supported');
      }
    };

    const { result } = renderProvider();
    const ctx = result.current;
    expect(typeof ctx.play).toBe('function');
    expect(typeof ctx.stop).toBe('function');
    expect(typeof ctx.seek).toBe('function');
    expect(typeof ctx.toggleShuffle).toBe('function');
    expect(typeof ctx.cycleRepeat).toBe('function');
    expect(ctx.isPlaying).toBe(false);
  });

  it('renders without crashing when createMediaElementSource throws', () => {
    window.AudioContext = class {
      constructor() {
        this.destination = {};
        this.resume = vi.fn().mockResolvedValue(undefined);
        this.close = vi.fn().mockResolvedValue(undefined);
        this.createMediaElementSource = vi.fn(() => {
          throw new Error('InvalidStateError: media element already connected');
        });
        this.createGain = vi.fn().mockReturnValue({ gain: { value: 1 }, connect: vi.fn() });
        this.createDynamicsCompressor = vi.fn().mockReturnValue({
          threshold: { value: 0 },
          knee: { value: 0 },
          ratio: { value: 1 },
          attack: { value: 0 },
          release: { value: 0 },
          connect: vi.fn(),
        });
      }
    };

    expect(() => renderProvider()).not.toThrow();
  });

  it('still exposes full API surface when createMediaElementSource throws', () => {
    window.AudioContext = class {
      constructor() {
        this.destination = {};
        this.resume = vi.fn().mockResolvedValue(undefined);
        this.close = vi.fn().mockResolvedValue(undefined);
        this.createMediaElementSource = vi.fn(() => {
          throw new Error('InvalidStateError: media element already connected');
        });
        this.createGain = vi.fn().mockReturnValue({ gain: { value: 1 }, connect: vi.fn() });
        this.createDynamicsCompressor = vi.fn().mockReturnValue({
          threshold: { value: 0 },
          knee: { value: 0 },
          ratio: { value: 1 },
          attack: { value: 0 },
          release: { value: 0 },
          connect: vi.fn(),
        });
      }
    };

    const { result } = renderProvider();
    const ctx = result.current;
    expect(typeof ctx.play).toBe('function');
    expect(typeof ctx.stop).toBe('function');
    expect(typeof ctx.seek).toBe('function');
    expect(ctx.isPlaying).toBe(false);
  });

  it('calls getMediaPort even when AudioContext is unavailable', async () => {
    window.AudioContext = class {
      constructor() {
        throw new Error('NotSupportedError');
      }
    };

    renderProvider();
    await waitFor(() => expect(window.api.getMediaPort).toHaveBeenCalledTimes(1));
  });
});

describe('PlayerProvider — bounded auto-skip on unavailable tracks', () => {
  it('does not recurse infinitely (and eventually stops) when every track in the queue is unavailable', async () => {
    const badIds = Array.from({ length: 40 }, (_, i) => i + 1);
    window.api.getUnavailableLinkedTracks.mockResolvedValue(badIds);

    const { result } = renderProvider();
    await waitFor(() => expect(result.current.unavailableLinkedIds.size).toBe(40));

    const queue = badIds.map((id) => ({
      id,
      title: `Track ${id}`,
      is_linked: true,
      file_path: `/music/${id}.mp3`,
    }));

    await act(async () => {
      result.current.play(queue[0], queue, 0);
    });

    for (let i = 0; i < 60 && !/too many/i.test(result.current.playbackError ?? ''); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(result.current.playbackError).toMatch(/too many/i);
    expect(result.current.isPlaying).toBe(false);
  });
});
