import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TidalDownloadView from '../TidalDownloadView.jsx';
import { TidalDownloadProvider } from '../TidalDownloadContext.jsx';

// Mirrors the account tree the tdn GUI shows: playlists, mixes & radio
// (incl. My Daily Discovery and video mixes) and the favorites collections.
const COLLECTIONS = [
  {
    id: 'pl-1',
    type: 'playlist',
    title: 'Uptempo',
    group: 'playlists',
    parentId: null,
    subtitle: '',
    count: 12,
  },
  {
    id: 'mix-1',
    type: 'mix',
    title: 'My Daily Discovery',
    group: 'mixes',
    parentId: null,
    subtitle: 'Daily',
    count: 0,
  },
  {
    id: 'mix-2',
    type: 'mix',
    title: 'My Video Mix 1',
    group: 'mixes',
    parentId: null,
    subtitle: '',
    count: 0,
  },
  {
    id: 'tracks',
    type: 'favorites',
    title: 'Favorite tracks',
    group: 'favorites',
    parentId: null,
    subtitle: '',
    count: 3,
  },
  {
    id: 'albums',
    type: 'favorites',
    title: 'Favorite albums',
    group: 'favorites',
    parentId: null,
    subtitle: '',
    count: 1,
  },
  {
    id: 'artists',
    type: 'favorites',
    title: 'Favorite artists',
    group: 'favorites',
    parentId: null,
    subtitle: '',
    count: 1,
  },
  {
    id: 'videos',
    type: 'favorites',
    title: 'Favorite videos',
    group: 'favorites',
    parentId: null,
    subtitle: '',
    count: 0,
  },
  {
    id: '521',
    type: 'artist',
    title: 'Doja Cat',
    group: 'favorites',
    parentId: 'artists',
    subtitle: '',
    count: 0,
  },
];

function renderView() {
  return render(
    <TidalDownloadProvider>
      <TidalDownloadView />
    </TidalDownloadProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api.tidalCheck.mockResolvedValue({ installed: true, loggedIn: true });
  window.api.getPlaylists.mockResolvedValue([]);
  window.api.tidalListCollections.mockResolvedValue({
    ok: true,
    collections: COLLECTIONS,
    warnings: [],
  });
  window.api.tidalDownloadCollection.mockResolvedValue({
    ok: true,
    trackIds: ['t1'],
    playlistId: null,
  });
});

describe('TidalDownloadView - account collections browser', () => {
  it('lists playlists, mixes & radio and the favorites collections', async () => {
    renderView();

    expect(await screen.findByText('Uptempo')).toBeInTheDocument();
    expect(screen.getByText('My Daily Discovery')).toBeInTheDocument();
    expect(screen.getByText('My Video Mix 1')).toBeInTheDocument();
    expect(screen.getByText('Favorite tracks')).toBeInTheDocument();
    expect(screen.getByText('Favorite albums')).toBeInTheDocument();
    expect(screen.getByText('Favorite artists')).toBeInTheDocument();
    expect(screen.getByText('Favorite videos')).toBeInTheDocument();
    // Group headers
    expect(screen.getByText('Playlists')).toBeInTheDocument();
    expect(screen.getByText('Mixes & Radio')).toBeInTheDocument();
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    // Favorite artists are nested under their collection
    expect(screen.getByText('Doja Cat')).toBeInTheDocument();
    expect(window.api.tidalListCollections).toHaveBeenCalledTimes(1);
  });

  it('shows an error state when collections cannot be listed', async () => {
    window.api.tidalListCollections.mockResolvedValue({
      ok: false,
      error: 'Not logged in to TIDAL. Please connect your account first.',
      collections: [],
    });
    renderView();

    expect(
      await screen.findByText(/Not logged in to TIDAL. Please connect your account first./)
    ).toBeInTheDocument();
    expect(screen.queryByText('Uptempo')).not.toBeInTheDocument();
  });

  it('downloads a single collection by type and id and shows the download step', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download Uptempo' }));

    await waitFor(() =>
      expect(window.api.tidalDownloadCollection).toHaveBeenCalledWith({
        type: 'playlist',
        id: 'pl-1',
        title: 'Uptempo',
      })
    );
    // The view switches to the download step, titled after the collection.
    expect(await screen.findByRole('heading', { level: 2, name: 'Uptempo' })).toBeInTheDocument();
  });

  it('downloads a favorites collection with its kind as id', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download Favorite videos' }));

    await waitFor(() =>
      expect(window.api.tidalDownloadCollection).toHaveBeenCalledWith({
        type: 'favorites',
        id: 'videos',
        title: 'Favorite videos',
      })
    );
  });

  it('downloads a nested favorite artist by its artist id', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download Doja Cat' }));

    await waitFor(() =>
      expect(window.api.tidalDownloadCollection).toHaveBeenCalledWith({
        type: 'artist',
        id: '521',
        title: 'Doja Cat',
      })
    );
  });

  it('surfaces the download error without leaving the download step', async () => {
    window.api.tidalDownloadCollection.mockResolvedValue({
      ok: false,
      error: 'This collection has no downloadable tracks.',
    });
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download My Daily Discovery' }));

    expect(
      await screen.findByText('✗ This collection has no downloadable tracks.')
    ).toBeInTheDocument();
  });

  it('notes how many video items were skipped by the audio importer', async () => {
    window.api.tidalDownloadCollection.mockResolvedValue({
      ok: true,
      trackIds: ['t1'],
      playlistId: 'pl-uuid',
      videoCount: 2,
    });
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download My Video Mix 1' }));

    expect(await screen.findByText(/Skipped 2 video items/)).toBeInTheDocument();
    expect(screen.getByText(/DjManager imports audio tracks only/)).toBeInTheDocument();
  });

  it('does not show the skip note for audio-only collections', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download Uptempo' }));

    await waitFor(() => expect(window.api.tidalDownloadCollection).toHaveBeenCalled());
    expect(screen.queryByText(/video item/)).not.toBeInTheDocument();
  });

  it('collapses and expands a collection group', async () => {
    renderView();

    expect(await screen.findByText('Uptempo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Playlists/ }));
    expect(screen.queryByText('Uptempo')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Playlists/ }));
    expect(await screen.findByText('Uptempo')).toBeInTheDocument();
  });

  it('collapses the nested favorite artists branch', async () => {
    renderView();

    expect(await screen.findByText('Doja Cat')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Favorite artists' }));
    expect(screen.queryByText('Doja Cat')).not.toBeInTheDocument();
  });

  it('reloads the collection list on demand', async () => {
    renderView();

    await screen.findByText('Uptempo');
    expect(window.api.tidalListCollections).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(window.api.tidalListCollections).toHaveBeenCalledTimes(2));
  });

  it('shows an empty state when the account has no collections', async () => {
    window.api.tidalListCollections.mockResolvedValue({
      ok: true,
      collections: [],
      warnings: [],
    });
    renderView();

    expect(await screen.findByText('No collections found on this account.')).toBeInTheDocument();
  });

  it('flags collections that could not be loaded', async () => {
    window.api.tidalListCollections.mockResolvedValue({
      ok: true,
      collections: COLLECTIONS,
      warnings: ['mixes: unavailable'],
    });
    renderView();

    expect(
      await screen.findByText(/Some collections could not be loaded \(1\)/)
    ).toBeInTheDocument();
  });
});
