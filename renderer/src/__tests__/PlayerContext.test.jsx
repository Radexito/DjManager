import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PlayerProvider, usePlayer } from '../PlayerContext.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Render a PlayerProvider and expose the context value via renderHook. */
function renderProvider() {
  return renderHook(() => usePlayer(), { wrapper: PlayerProvider });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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
