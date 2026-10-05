import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PlayerBar from '../PlayerBar.jsx';

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

describe('PlayerBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigator.mediaDevices = { enumerateDevices: vi.fn().mockResolvedValue([]) };
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() },
      configurable: true,
    });
  });

  it('opens track details when the artwork is clicked', async () => {
    const onOpenTrackDetails = vi.fn();
    render(
      <PlayerBar
        onNavigateToPlaylist={vi.fn()}
        onArtistSearch={vi.fn()}
        onOpenTrackDetails={onOpenTrackDetails}
      />
    );

    fireEvent.click(await screen.findByTitle('Open track details'));
    expect(onOpenTrackDetails).toHaveBeenCalledWith(7, 42);
  });

  it('renders the bottom-left playback controls and wires them up', async () => {
    render(
      <PlayerBar
        onNavigateToPlaylist={vi.fn()}
        onArtistSearch={vi.fn()}
        onOpenTrackDetails={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByLabelText('Playback controls')).toBeInTheDocument());
    fireEvent.click(screen.getByTitle('Play / Pause'));
    fireEvent.click(screen.getByTitle('Previous'));
    fireEvent.click(screen.getByTitle('Next'));
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
    expect(player.prev).toHaveBeenCalledTimes(1);
    expect(player.next).toHaveBeenCalledTimes(1);
  });

  it('clicking the title while playing from a playlist navigates to that playlist', async () => {
    player.currentPlaylistId = 42;
    player.currentPlaylistName = 'My Playlist';
    const onNavigateToPlaylist = vi.fn();
    const onLocateTrack = vi.fn();
    render(
      <PlayerBar
        onNavigateToPlaylist={onNavigateToPlaylist}
        onArtistSearch={vi.fn()}
        onOpenTrackDetails={vi.fn()}
        onLocateTrack={onLocateTrack}
      />
    );

    // The playlist chip below also carries the same tooltip — the title is the
    // first match in DOM order.
    fireEvent.click((await screen.findAllByTitle('Go to playlist: My Playlist'))[0]);
    expect(onNavigateToPlaylist).toHaveBeenCalledWith('42');
    expect(onLocateTrack).not.toHaveBeenCalled();
  });

  it('clicking the title while playing from Music asks to show the track in the Music list', async () => {
    player.currentPlaylistId = null;
    player.currentPlaylistName = null;
    const onLocateTrack = vi.fn();
    render(
      <PlayerBar
        onNavigateToPlaylist={vi.fn()}
        onArtistSearch={vi.fn()}
        onOpenTrackDetails={vi.fn()}
        onLocateTrack={onLocateTrack}
      />
    );

    fireEvent.click(await screen.findByTitle('Show track in Music list'));
    expect(onLocateTrack).toHaveBeenCalledWith(7);
  });
});

/* ── ScrollText marquee ──────────────────────────────────────────────────────
 * jsdom has no layout engine, so the geometry a browser would report is stubbed
 * on HTMLElement.prototype (the text spans are re-created whenever the marquee
 * toggles, so per-element stubs would not survive a flip).
 *
 * The stub models the real markup and stylesheet one-to-one:
 *   - the container (.player-scroll) offers `avail` px (clientWidth), and its
 *     scrollWidth grows to roughly TWO copies while `--on` is set, because the
 *     track holds the visible copy plus an aria-hidden one,
 *   - one copy of the text is `title`/`artist` px wide and gains the marquee gap
 *     (padding-right: 28px from `.player-scroll--on .player-scroll-text`) in the
 *     `--on` state only,
 *   - getComputedStyle is wrapped for that one property, since jsdom does not
 *     load the stylesheet.
 */
const MARQUEE_GAP = 28; // px: .player-scroll--on .player-scroll-text { padding-right }
const layout = { avail: 400, title: 300, artist: 300 };
const observers = [];
const savedProtoProps = {};
const realGetComputedStyle = globalThis.getComputedStyle.bind(globalThis);

function scrollRootOf(el) {
  if (!el || !el.classList) return null;
  return el.classList.contains('player-scroll') ? el : el.closest('.player-scroll');
}

function widthKeyOf(root) {
  return root.classList.contains('player-title') ? 'title' : 'artist';
}

// Width of ONE rendered copy of the text, gap included (like the browser reports)
function copyWidthOf(el) {
  const root = scrollRootOf(el);
  if (!root) return 0;
  const on = root.classList.contains('player-scroll--on');
  return layout[widthKeyOf(root)] + (on ? MARQUEE_GAP : 0);
}

function installLayoutStubs() {
  const proto = globalThis.HTMLElement.prototype;
  const own = (name, get) => {
    savedProtoProps[name] = Object.getOwnPropertyDescriptor(proto, name) || null;
    Object.defineProperty(proto, name, { configurable: true, get });
  };

  savedProtoProps.getBoundingClientRect =
    Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect') || null;
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: function () {
      const w = this.classList.contains('player-scroll-text') ? copyWidthOf(this) : 0;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: w,
        bottom: 0,
        width: w,
        height: 0,
        toJSON: () => ({}),
      };
    },
  });

  own('clientWidth', function () {
    return this.classList.contains('player-scroll') ? layout.avail : 0;
  });
  own('offsetWidth', function () {
    return this.classList.contains('player-scroll-text') ? copyWidthOf(this) : 0;
  });
  own('scrollWidth', function () {
    if (!this.classList.contains('player-scroll')) return copyWidthOf(this);
    const on = this.classList.contains('player-scroll--on');
    const copy = layout[widthKeyOf(this)] + (on ? MARQUEE_GAP : 0);
    return Math.max(layout.avail, on ? copy * 2 : copy); // two copies while marqueeing
  });
}

class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
    observers.push(this);
  }
  observe(el) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {}
}

// Deterministic re-measure trigger (the component also re-measures on rAF)
function fireResize(root) {
  act(() => {
    for (const ro of observers) {
      if (ro.targets.includes(root)) ro.cb();
    }
  });
}

function wrappedGetComputedStyle(el, pseudo) {
  const cs = realGetComputedStyle(el, pseudo);
  if (el && el.classList && el.classList.contains('player-scroll-text')) {
    const root = el.closest('.player-scroll');
    const on = !!(root && root.classList.contains('player-scroll--on'));
    Object.defineProperty(cs, 'paddingRight', {
      configurable: true,
      get: () => (on ? `${MARQUEE_GAP}px` : '0px'),
    });
  }
  return cs;
}

describe('PlayerBar ScrollText marquee', () => {
  beforeEach(() => {
    // The usePlayer mock returns a MODULE-LEVEL object, so every field the
    // component branches on is re-set here instead of leaking between tests.
    player.currentTrack = {
      id: 7,
      title: 'Now Playing',
      artist: 'Artist',
      has_artwork: 0,
      artwork_path: null,
    };
    player.currentPlaylistId = 42;
    player.currentPlaylistName = 'My Playlist';
    player.isPlaying = false;
    player.currentTime = 0;
    player.duration = 120;
    player.playbackError = null;
    player.history = [];

    layout.avail = 400;
    layout.title = 300;
    layout.artist = 300;
    observers.length = 0;
    installLayoutStubs();
    globalThis.ResizeObserver = FakeResizeObserver;
    globalThis.getComputedStyle = wrappedGetComputedStyle;
  });

  afterEach(() => {
    for (const [name, desc] of Object.entries(savedProtoProps)) {
      if (desc) Object.defineProperty(globalThis.HTMLElement.prototype, name, desc);
      else delete globalThis.HTMLElement.prototype[name];
    }
    delete globalThis.ResizeObserver;
    globalThis.getComputedStyle = realGetComputedStyle;
  });

  const bar = () => (
    <PlayerBar
      onNavigateToPlaylist={vi.fn()}
      onArtistSearch={vi.fn()}
      onOpenTrackDetails={vi.fn()}
      onLocateTrack={vi.fn()}
    />
  );

  const titleRoot = (container) => container.querySelector('.player-scroll.player-title');

  const setTitle = (title, width) => {
    player.currentTrack = { ...player.currentTrack, title };
    layout.title = width;
  };

  it('does not marquee a title that fits once but not twice (regression)', () => {
    layout.title = 1000; // a long title switches the marquee on
    const { container, rerender } = render(bar());
    const root = titleRoot(container);
    expect(root).toHaveClass('player-scroll--on');

    // 300px fits the 400px bar once, but not twice (600px) -> must sit still
    setTitle('Short enough', 300);
    rerender(bar());
    fireResize(root);

    expect(root).not.toHaveClass('player-scroll--on');
    expect(root.querySelectorAll('.player-scroll-text')).toHaveLength(1);
  });

  it('marquees a title that genuinely overflows, at ~55px/s', () => {
    layout.title = 1000;
    const { container } = render(bar());
    const root = titleRoot(container);
    fireResize(root);

    expect(root).toHaveClass('player-scroll--on');
    const copies = root.querySelectorAll('.player-scroll-text');
    expect(copies).toHaveLength(2);
    expect(copies[1]).toHaveAttribute('aria-hidden', 'true');

    // One copy + its gap is what the -50% keyframe moves: (1000 + 28) / 55 = 19s
    const track = root.querySelector('.player-scroll-track');
    expect(track.getAttribute('style')).toContain('animation-duration: 19s');
  });

  it('clears the marquee when a long title is replaced by a short one', () => {
    layout.title = 1000;
    const { container, rerender } = render(bar());
    const root = titleRoot(container);
    expect(root).toHaveClass('player-scroll--on');

    setTitle('Tiny', 100);
    rerender(bar());
    fireResize(root);

    expect(root).not.toHaveClass('player-scroll--on');
    expect(root.querySelector('.player-scroll-track')).toBeNull();
  });

  it('does not scroll for an overflow inside the 2px tolerance', () => {
    layout.title = 402; // exactly 400 + 2
    const { container, rerender } = render(bar());
    const root = titleRoot(container);
    expect(root).not.toHaveClass('player-scroll--on');

    setTitle('Just past tolerance', 402.5);
    rerender(bar());
    fireResize(root);
    expect(root).toHaveClass('player-scroll--on');
  });
});
