import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PlayerBar from '../PlayerBar.jsx';

// ---------------------------------------------------------------------------
// The waveform canvas fills .player-seekbar-wrap and sizes its backing store from
// that box (canvas.offsetHeight). jsdom has no layout engine, so this suite pins
// the CHAIN rather than pixels:
//
//   bar height (PB_H_*) -> waveH (clampPbWave in PlayerBar.jsx)
//     -> --pb-wave-h inline on .player-seekbar-wrap
//     -> .player-seekbar-wrap { height: var(--pb-wave-h) } in PlayerBarCues.css
//     -> canvas.offsetHeight -> canvas.height
//
// The last step is emulated by returning the variable from a stubbed offsetHeight
// getter, which is what the CSS rule resolves to in a real browser. Before the
// fix the row was pinned at `height: 40px`, so every value below was unreachable.
// ---------------------------------------------------------------------------

const BAR_VAR = '--pb-wave-h';
const PB_H_KEY = 'djmanager.playerBarHeight';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const cuesCss = fs.readFileSync(path.join(dirname, '../PlayerBarCues.css'), 'utf8');

const player = {
  mediaPort: 19876,
  currentTrack: {
    id: 7,
    title: 'Now Playing',
    artist: 'Artist',
    currentPlaylistId: 42,
    has_artwork: 0,
    artwork_path: null,
  },
  currentPlaylistId: 42,
  currentPlaylistName: 'My Playlist',
  isPlaying: false,
  shuffle: false,
  repeat: 'none',
  currentTime: 0,
  duration: 120,
  outputDeviceId: '',
  volume: 0.5,
  history: [],
  playbackError: null,
  clearPlaybackError: vi.fn(),
  togglePlay: vi.fn(),
  next: vi.fn(),
  prev: vi.fn(),
  seek: vi.fn(),
  toggleShuffle: vi.fn(),
  cycleRepeat: vi.fn(),
  setDevice: vi.fn(),
  setVolume: vi.fn(),
  play: vi.fn(),
  audioRef: { current: null },
};

vi.mock('../PlayerContext.jsx', () => ({
  usePlayer: () => player,
}));

// jsdom has no PointerEvent constructor; React dispatches by event NAME, so a
// MouseEvent carrying the pointer fields exercises the same handlers.
const pointerEvent = (type, { clientX = 0, clientY = 0, buttons = 0, button = 0 } = {}) =>
  new MouseEvent(type, { bubbles: true, clientX, clientY, buttons, button });

const ctx = { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: '' };

let store;
let rafQueue;

beforeEach(() => {
  vi.clearAllMocks();
  navigator.mediaDevices = { enumerateDevices: vi.fn().mockResolvedValue([]) };
  store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    configurable: true,
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx);
  // Deterministic rAF: paintWaveform() sizes and draws inside one callback.
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushRaf() {
  const queued = rafQueue;
  rafQueue = [];
  queued.forEach((cb) => cb(0));
}

function renderBar(storedHeight) {
  if (storedHeight != null) store.set(PB_H_KEY, String(storedHeight));
  const utils = render(
    <PlayerBar
      onNavigateToPlaylist={vi.fn()}
      onArtistSearch={vi.fn()}
      onOpenTrackDetails={vi.fn()}
    />
  );
  const bar = utils.container.querySelector('.player-bar');
  const wrap = utils.container.querySelector('.player-seekbar-wrap');
  const waveVar = () => parseFloat(wrap.style.getPropertyValue(BAR_VAR));
  // The handle latches the current bar height on pointerdown, then follows
  // window pointermove events — see startBarResize in PlayerBar.jsx.
  const drag = (fromY, toY) => {
    act(() => {
      fireEvent(
        utils.container.querySelector('.player-resize-handle'),
        pointerEvent('pointerdown', { clientY: fromY, button: 0, buttons: 1 })
      );
      fireEvent(window, pointerEvent('pointermove', { clientY: toY, buttons: 1 }));
      fireEvent(window, pointerEvent('pointerup', { buttons: 0 }));
    });
  };
  return { ...utils, bar, wrap, waveVar, drag };
}

describe('PlayerBar — wave/seek row height follows the bar height', () => {
  it('keeps the historical 40px row at the default 124px bar', () => {
    const { bar, waveVar } = renderBar();
    expect(bar.style.height).toBe('124px');
    expect(waveVar()).toBe(40); // 124 / 2 - 22
  });

  it('honours the persisted bar height', () => {
    const { waveVar } = renderBar(200);
    expect(waveVar()).toBe(78); // 200 / 2 - 22
  });

  it('grows the row when the bar is dragged taller', () => {
    const { waveVar, drag } = renderBar();
    expect(waveVar()).toBe(40);
    drag(500, 380); // +120px of bar
    expect(waveVar()).toBe(100); // (124 + 120) / 2 - 22
    expect(waveVar()).toBeGreaterThan(40);
  });

  it('shrinks the row when the bar is dragged shorter, down to the 24px floor', () => {
    const { waveVar, drag } = renderBar();
    drag(500, 540); // -40px, bar clamps at PB_H_MIN 84
    expect(waveVar()).toBe(24); // 84 / 2 - 22 = 20, floored at PB_WAVE_MIN
  });

  it('caps the row at 108px at PB_H_MAX', () => {
    const { waveVar, drag } = renderBar();
    drag(500, 100); // +400px, bar clamps at PB_H_MAX 260
    expect(waveVar()).toBe(108); // 260 / 2 - 22
  });

  it('caps the row for a persisted height above PB_H_MAX', () => {
    const { waveVar } = renderBar(1000);
    expect(waveVar()).toBe(108);
  });

  it('persists the resized height', () => {
    const { drag } = renderBar();
    drag(500, 380);
    expect(store.get(PB_H_KEY)).toBe('244');
  });

  it('repaints the canvas at the resized box after a drag', async () => {
    window.api.getTrackWaveform.mockResolvedValue(
      new Uint8Array([0, 0, 0, 0, 12, 8, 5, 3, 40, 30, 20, 10, 6, 4, 2, 1]).buffer
    );
    const { container, wrap, drag } = renderBar();
    const canvas = container.querySelector('.player-waveform-canvas');
    // Stand in for the layout the CSS performs: the canvas fills the row and the
    // row height IS the variable under test. No fallback on purpose — a missing
    // variable must fail loudly instead of quietly becoming 40px again.
    Object.defineProperty(canvas, 'offsetWidth', { configurable: true, get: () => 400 });
    Object.defineProperty(canvas, 'offsetHeight', {
      configurable: true,
      get: () => {
        const h = parseFloat(wrap.style.getPropertyValue(BAR_VAR));
        if (!Number.isFinite(h)) throw new Error(`${BAR_VAR} missing on .player-seekbar-wrap`);
        return h;
      },
    });

    await act(async () => {}); // let getTrackWaveform resolve and queue the repaint
    flushRaf();
    expect(canvas.height).toBe(40);
    expect(canvas.width).toBe(400);

    drag(500, 380); // bar 124 -> 244, row 40 -> 100
    flushRaf();
    expect(canvas.height).toBe(100);
  });
});

describe('PlayerBarCues.css — the row height is driven by the variable', () => {
  it('sizes .player-seekbar-wrap from var(--pb-wave-h)', () => {
    const rule = cuesCss.slice(cuesCss.indexOf('.player-seekbar-wrap {'));
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).toMatch(/height:\s*var\(--pb-wave-h/);
    // The old fixed `height: 40px` pin is what made the row ignore the bar height.
    expect(block).not.toMatch(/height:\s*\d+px/);
  });
});
