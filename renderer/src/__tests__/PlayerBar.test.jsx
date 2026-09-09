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
