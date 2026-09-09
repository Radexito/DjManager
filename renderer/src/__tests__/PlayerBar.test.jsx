import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});
