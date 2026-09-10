// renderer/src/__tests__/BeatGridEditor.trim.test.jsx
// Trim controls in Prepare Track (#463).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import BeatGridEditor from '../BeatGridEditor.jsx';

// Mutable player mock — every field the editor branches on is re-set per test.
const player = {
  currentTrack: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  togglePlay: vi.fn(),
  play: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
};

vi.mock('../PlayerContext.jsx', () => ({
  usePlayer: () => player,
}));

function resetPlayer(overrides = {}) {
  player.currentTrack = { id: 7 };
  player.isPlaying = false;
  player.currentTime = 0;
  player.duration = 0;
  Object.assign(player, overrides);
}

const TRACK = {
  id: 7,
  title: 'Test Track',
  artist: 'Test Artist',
  duration: 180,
  bpm: null,
  beatgrid: null,
  beatgrid_offset: 0,
  trim_start_ms: null,
  trim_end_ms: null,
};

// jsdom has no canvas 2D context and no ResizeObserver — stub both so the
// editor's draw loop can run, and capture the rAF callback so frames are drawn
// on demand (deterministic instead of racing a real animation frame).
let ctx;
let rafCallback;
const originalResizeObserver = globalThis.ResizeObserver;

function makeCtx() {
  const target = {};
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      const fn = vi.fn(() => makeCtx());
      t[key] = fn;
      return fn;
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx = makeCtx();
  rafCallback = null;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx);
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    rafCallback = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  resetPlayer();
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.unstubAllGlobals();
});

function renderEditor(trackOverrides = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <BeatGridEditor track={{ ...TRACK, ...trackOverrides }} onApply={onApply} onClose={onClose} />
  );
  return { onApply, onClose, ...utils };
}

function drawFrame() {
  act(() => {
    rafCallback?.(16);
  });
}

describe('BeatGridEditor — trim controls (#463)', () => {
  it('shows a stored trim range on open', () => {
    renderEditor({ trim_start_ms: 30_000, trim_end_ms: 90_000 });

    expect(screen.getByTitle('Trim start')).toHaveTextContent('0:30.0');
    expect(screen.getByTitle('Trim end')).toHaveTextContent('1:30.0');
    expect(screen.getByText('1:00.0 usable')).toBeInTheDocument();
  });

  it('shows the file bounds and a disabled clear button when untrimmed', () => {
    renderEditor();

    expect(screen.getByTitle('Trim start')).toHaveTextContent('file start');
    expect(screen.getByTitle('Trim end')).toHaveTextContent('file end');
    expect(screen.getByRole('button', { name: 'Clear trim' })).toBeDisabled();
  });

  it('Set IN marks the playhead as the trim start and draws the IN marker', () => {
    // Paused playback keeps the view centered on the playhead, so the marker
    // lands at the middle of the canvas (W/2) — the same place the playhead is.
    player.currentTime = 2;
    const { onApply } = renderEditor();
    expect(screen.getByRole('button', { name: 'Clear trim' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Set IN' }));

    expect(screen.getByTitle('Trim start')).toHaveTextContent('0:02.0');
    expect(screen.getByRole('button', { name: 'Clear trim' })).toBeEnabled();

    drawFrame();
    expect(ctx.fillText).toHaveBeenCalledWith('IN', expect.any(Number), expect.any(Number));
    // Everything left of the trim start is shaded out (canvas is 300x150)
    expect(ctx.fillRect.mock.calls.some(([, , w, h]) => w === 150 && h === 150)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(7, {
      beatgrid_offset: 0,
      bpm_override: null,
      trim_start_ms: 2000,
      trim_end_ms: null,
    });
  });

  it('Set OUT marks the playhead as the trim end and saves it', () => {
    player.currentTime = 30;
    const { onApply } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Set OUT' }));

    expect(screen.getByTitle('Trim end')).toHaveTextContent('0:30.0');

    drawFrame();
    expect(ctx.fillText).toHaveBeenCalledWith('OUT', expect.any(Number), expect.any(Number));

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onApply).toHaveBeenCalledWith(7, {
      beatgrid_offset: 0,
      bpm_override: null,
      trim_start_ms: null,
      trim_end_ms: 30_000,
    });
  });

  it('clamps the trim end to the file duration when saving', () => {
    player.currentTime = 10;
    const { rerender } = render(
      <BeatGridEditor track={TRACK} onApply={vi.fn()} onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set IN' }));

    // Playhead beyond the 180 s file
    player.currentTime = 200;
    const onApply = vi.fn();
    rerender(<BeatGridEditor track={TRACK} onApply={onApply} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set OUT' }));

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        trim_start_ms: 10_000,
        trim_end_ms: 180_000,
      })
    );
  });

  it('clears both trim points and saves the cleared range', () => {
    const { onApply } = renderEditor({ trim_start_ms: 30_000, trim_end_ms: 90_000 });

    fireEvent.click(screen.getByRole('button', { name: 'Clear trim' }));

    expect(screen.getByTitle('Trim start')).toHaveTextContent('file start');
    expect(screen.getByTitle('Trim end')).toHaveTextContent('file end');

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(7, {
      beatgrid_offset: 0,
      bpm_override: null,
      trim_start_ms: null,
      trim_end_ms: null,
    });
  });

  it('refuses to save an inverted range and explains why', () => {
    player.currentTime = 40;
    const { rerender } = render(
      <BeatGridEditor track={TRACK} onApply={vi.fn()} onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set OUT' }));

    player.currentTime = 60;
    const onApply = vi.fn();
    const onClose = vi.fn();
    rerender(<BeatGridEditor track={TRACK} onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set IN' }));

    expect(screen.getByText('Trim end must be after trim start')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('warns about unsaved trim changes when closing', async () => {
    const { onClose } = renderEditor();
    // The editor snapshots the cue list asynchronously; the dirty check is
    // disabled until that lands, so flush it before relying on it.
    await act(async () => {});
    player.currentTime = 5;
    fireEvent.click(screen.getByRole('button', { name: 'Set IN' }));

    fireEvent.click(screen.getByTitle('Close (Esc)'));

    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not ask on close when nothing changed', async () => {
    const { onClose } = renderEditor({ trim_start_ms: 30_000, trim_end_ms: 90_000 });
    await act(async () => {});

    fireEvent.click(screen.getByTitle('Close (Esc)'));

    expect(onClose).toHaveBeenCalled();
  });
});
