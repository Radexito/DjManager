import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CloudSearchView from '../CloudSearchView.jsx';

function youtubeResult(overrides = {}) {
  return {
    source: 'youtube',
    type: 'track',
    id: 'yt1',
    title: 'Some Video',
    artist: '',
    album: '',
    durationSec: 125,
    quality: '',
    url: 'https://youtube.com/watch?v=yt1',
    ...overrides,
  };
}

function tidalTrackResult(overrides = {}) {
  return {
    source: 'tidal',
    type: 'track',
    id: '111',
    title: 'Solo Track',
    artist: 'Artist A',
    album: 'Album A',
    durationSec: 200,
    url: 'https://tidal.com/browse/track/111',
    ...overrides,
  };
}

function tidalAlbumResult(overrides = {}) {
  return {
    source: 'tidal',
    type: 'album',
    id: '999',
    title: 'Some Album',
    artist: 'Artist B',
    album: 'Some Album',
    durationSec: 1800,
    numTracks: 12,
    url: 'https://tidal.com/browse/album/999',
    ...overrides,
  };
}

function tidalPlaylistResult(overrides = {}) {
  return {
    source: 'tidal',
    type: 'playlist',
    id: '555',
    title: 'Some Playlist',
    artist: '',
    album: '',
    durationSec: 3600,
    numTracks: 30,
    url: 'https://tidal.com/browse/playlist/555',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api.cloudSearch.mockResolvedValue({ ok: true, results: [] });
  window.api.tidalCheck.mockResolvedValue({ installed: true, loggedIn: true });
});

async function search(results) {
  window.api.cloudSearch.mockResolvedValueOnce({ ok: true, results });
  render(<CloudSearchView />);
  fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: 'query' } });
  fireEvent.click(screen.getByRole('button', { name: /^Search$/i }));
  await waitFor(() => expect(window.api.cloudSearch).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/Select all/i)).toBeInTheDocument());
}

describe('CloudSearchView — dynamic result columns', () => {
  it('shows Title/Duration only for YouTube results, no Artist/Album/Source column', async () => {
    await search([youtubeResult()]);

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.queryByText('Artist')).not.toBeInTheDocument();
    expect(screen.queryByText('Album')).not.toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });

  it('shows Title/Artist/Album/Duration for a TIDAL track result', async () => {
    await search([tidalTrackResult()]);

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Artist')).toBeInTheDocument();
    expect(screen.getByText('Album')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.queryByText('Tracks')).not.toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });

  it('shows Title/Artist/Tracks/Length for a TIDAL album result — not Album', async () => {
    await search([tidalAlbumResult()]);

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Artist')).toBeInTheDocument();
    expect(screen.getByText('Tracks')).toBeInTheDocument();
    expect(screen.getByText('Length')).toBeInTheDocument();
    expect(screen.queryByText('Album')).not.toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('30:00')).toBeInTheDocument();
  });

  it('shows Title/Tracks/Length for a TIDAL playlist result — not Artist or Album', async () => {
    await search([tidalPlaylistResult()]);

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Tracks')).toBeInTheDocument();
    expect(screen.getByText('Length')).toBeInTheDocument();
    expect(screen.queryByText('Artist')).not.toBeInTheDocument();
    expect(screen.queryByText('Album')).not.toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('60:00')).toBeInTheDocument();
  });
});
