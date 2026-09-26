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

const TITLES = new Map(COLLECTIONS.map((c) => [`${c.type}:${c.id}`, c.title]));

// What a collection resolves to: two audio tracks (pre-ticked) plus one video
// item, which the select step lists but never ticks.
const ENTRIES = [
  {
    index: 0,
    id: 't1',
    title: 'Track One',
    artist: 'Artist One',
    duration: 180,
    url: 'https://tidal.com/browse/track/t1',
    mediaType: 'track',
  },
  {
    index: 1,
    id: 't2',
    title: 'Track Two',
    artist: 'Artist Two',
    duration: 200,
    url: 'https://tidal.com/browse/track/t2',
    mediaType: 'track',
  },
  {
    index: 2,
    id: 'v1',
    title: 'Video One',
    artist: 'Artist Three',
    duration: 210,
    url: 'https://tidal.com/browse/video/v1',
    mediaType: 'video',
  },
];

function renderView() {
  return render(
    <TidalDownloadProvider>
      <TidalDownloadView />
    </TidalDownloadProvider>
  );
}

// The ↓ arrow asks which tracks to download, exactly like the collection name:
// resolve the collection, land on the select step, download from there.
async function openCollectionFromArrow(title) {
  fireEvent.click(await screen.findByRole('button', { name: `Download ${title}` }));
  return screen.findByText('2. Select tracks');
}

async function startDownload(label = /Download 2 tracks/) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(window.api.tidalDownloadCollection).toHaveBeenCalledTimes(1));
  return window.api.tidalDownloadCollection.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api.tidalCheck.mockResolvedValue({ installed: true, loggedIn: true });
  window.api.getPlaylists.mockResolvedValue([]);
  window.api.getPlaylistSourceUrls.mockResolvedValue([]);
  window.api.checkDuplicateUrls.mockResolvedValue([]);
  window.api.tidalListCollections.mockResolvedValue({
    ok: true,
    collections: COLLECTIONS,
    warnings: [],
  });
  window.api.tidalCollectionTracks.mockImplementation(async ({ type, id }) => ({
    ok: true,
    type,
    title: TITLES.get(`${type}:${id}`) ?? '',
    entries: ENTRIES,
  }));
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

  it('opens the track selection step from the arrow instead of downloading at once', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download Uptempo' }));

    // Same select step as the URL flow, titled after the collection.
    expect(await screen.findByRole('heading', { level: 2, name: 'Uptempo' })).toBeInTheDocument();
    expect(window.api.tidalCollectionTracks).toHaveBeenCalledWith({
      type: 'playlist',
      id: 'pl-1',
    });
    expect(screen.getByText('2. Select tracks')).toBeInTheDocument();
    expect(screen.getByText('2 / 3 selected')).toBeInTheDocument();
    // Nothing is downloaded before the user starts it.
    expect(window.api.tidalDownloadCollection).not.toHaveBeenCalled();
    expect(window.api.tidalDownloadUrl).not.toHaveBeenCalled();
  });

  it('sends the name and the arrow through the same selection step', async () => {
    renderView();

    // The name opens the picker...
    fireEvent.click(await screen.findByRole('button', { name: 'Uptempo' }));
    expect(await screen.findByText('2. Select tracks')).toBeInTheDocument();
    expect(window.api.tidalDownloadCollection).not.toHaveBeenCalled();

    // ...and the arrow reaches the identical step, pre-ticked the same way.
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    await openCollectionFromArrow('Uptempo');

    expect(screen.getByText('2 / 3 selected')).toBeInTheDocument();
    expect(window.api.tidalDownloadCollection).not.toHaveBeenCalled();
  });

  it('downloads the pre-ticked tracks when the arrow flow is started', async () => {
    renderView();
    await openCollectionFromArrow('Uptempo');

    const arg = await startDownload();

    expect(arg).toMatchObject({ type: 'playlist', id: 'pl-1', title: 'Uptempo' });
    // Everything downloadable arrives ticked; the video item does not.
    expect(arg.selectedEntries.map((e) => e.id)).toEqual(['t1', 't2']);
    expect(screen.queryByText('2. Select tracks')).not.toBeInTheDocument();
  });

  it('downloads a favorites collection with its kind as id', async () => {
    renderView();
    await openCollectionFromArrow('Favorite videos');

    const arg = await startDownload();

    expect(arg).toMatchObject({ type: 'favorites', id: 'videos', title: 'Favorite videos' });
    expect(arg.selectedEntries.map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('downloads a nested favorite artist by its artist id', async () => {
    renderView();
    await openCollectionFromArrow('Doja Cat');

    const arg = await startDownload();

    expect(arg).toMatchObject({ type: 'artist', id: '521', title: 'Doja Cat' });
  });

  it('surfaces the download error on the download step', async () => {
    window.api.tidalDownloadCollection.mockResolvedValue({
      ok: false,
      error: 'This collection has no downloadable tracks.',
    });
    renderView();
    await openCollectionFromArrow('My Daily Discovery');

    fireEvent.click(screen.getByRole('button', { name: /Download 2 tracks/ }));

    expect(
      await screen.findByText('✗ This collection has no downloadable tracks.')
    ).toBeInTheDocument();
    // The failure belongs to the download step, so the picker is gone.
    expect(screen.queryByText('2. Select tracks')).not.toBeInTheDocument();
  });

  it('downloads nothing when the collection cannot be resolved from the arrow', async () => {
    window.api.tidalCollectionTracks.mockResolvedValue({
      ok: false,
      error: 'This collection could not be listed.',
    });
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Download Uptempo' }));

    expect(await screen.findByText('✗ This collection could not be listed.')).toBeInTheDocument();
    expect(window.api.tidalDownloadCollection).not.toHaveBeenCalled();
    // The row is not left spinning: the arrow is idle again.
    const arrow = screen.getByRole('button', { name: 'Download Uptempo' });
    expect(arrow).toBeEnabled();
    expect(arrow).toHaveTextContent('↓');
  });

  it('notes how many video items were skipped by the audio importer', async () => {
    window.api.tidalDownloadCollection.mockResolvedValue({
      ok: true,
      trackIds: ['t1'],
      playlistId: 'pl-uuid',
      videoCount: 2,
    });
    renderView();
    await openCollectionFromArrow('My Video Mix 1');

    await startDownload();

    expect(await screen.findByText(/Skipped 2 video items/)).toBeInTheDocument();
    expect(screen.getByText(/DjManager imports audio tracks only/)).toBeInTheDocument();
  });

  it('does not show the skip note for audio-only collections', async () => {
    renderView();
    await openCollectionFromArrow('Uptempo');

    await startDownload();

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
