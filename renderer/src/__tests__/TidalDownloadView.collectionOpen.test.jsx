import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TidalDownloadView from '../TidalDownloadView.jsx';
import { TidalDownloadProvider } from '../TidalDownloadContext.jsx';

// #508 follow-up: clicking a collection name opens it as a selectable track list
// in the same table the URL flow uses, instead of downloading it whole. The ↓
// arrow takes the same route.
const COLLECTIONS = [
  {
    id: 'pl-1',
    type: 'playlist',
    title: 'Uptempo',
    group: 'playlists',
    parentId: null,
    subtitle: '',
    count: 3,
  },
];

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

async function openCollection() {
  // The name button opens the list; the ↓ button (aria-label "Download ...")
  // now opens the same list, with every downloadable track pre-ticked.
  fireEvent.click(await screen.findByRole('button', { name: 'Uptempo' }));
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
  window.api.tidalCollectionTracks.mockResolvedValue({
    ok: true,
    title: 'Uptempo',
    type: 'playlist',
    entries: ENTRIES,
    videoCount: 1,
  });
  window.api.tidalDownloadCollection.mockResolvedValue({
    ok: true,
    trackIds: ['t1'],
    playlistId: null,
  });
});

describe('TidalDownloadView - opening a collection as a track list', () => {
  it('lists the collection tracks in the same table as the URL flow', async () => {
    renderView();
    await openCollection();

    expect(window.api.tidalCollectionTracks).toHaveBeenCalledWith({ type: 'playlist', id: 'pl-1' });
    expect(await screen.findByText('Track One')).toBeInTheDocument();
    expect(screen.getByText('Track Two')).toBeInTheDocument();
    expect(screen.getByText('Video One')).toBeInTheDocument();
    // Same select step as the URL flow: checkbox header, counts, download button
    expect(screen.getByText('2. Select tracks')).toBeInTheDocument();
    expect(screen.getByText('2 / 3 selected')).toBeInTheDocument();
    expect(screen.getByText(/select which to download/)).toBeInTheDocument();
  });

  it('never downloads the collection whole when opening it', async () => {
    renderView();
    await openCollection();

    await screen.findByText('Track One');
    expect(window.api.tidalDownloadCollection).not.toHaveBeenCalled();
  });

  it('lists videos but keeps them out of the selection', async () => {
    renderView();
    await openCollection();

    const videoRow = (await screen.findByText('Video One')).closest('label');
    const videoBox = videoRow.querySelector('input[type="checkbox"]');
    expect(videoBox).toBeDisabled();
    expect(screen.getByText('video, skipped')).toBeInTheDocument();
    expect(screen.getByText(/1 video skipped/)).toBeInTheDocument();
  });

  it('sends only the ticked tracks to the download', async () => {
    renderView();
    await openCollection();
    await screen.findByText('Track One');

    // boxes: [0] select-all, [1] Track One, [2] Track Two, [3] Video One
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[2]); // drop Track Two
    expect(screen.getByText('1 / 3 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Download 1 track/ }));

    await waitFor(() => expect(window.api.tidalDownloadCollection).toHaveBeenCalledTimes(1));
    const arg = window.api.tidalDownloadCollection.mock.calls[0][0];
    expect(arg).toMatchObject({ type: 'playlist', id: 'pl-1', title: 'Uptempo' });
    expect(arg.selectedEntries.map((e) => e.id)).toEqual(['t1']);
    expect(window.api.tidalDownloadUrl).not.toHaveBeenCalled();
  });

  it('sends every ticked track when nothing is deselected', async () => {
    renderView();
    await openCollection();
    await screen.findByText('Track One');

    fireEvent.click(screen.getByRole('button', { name: /Download 2 tracks/ }));

    await waitFor(() => expect(window.api.tidalDownloadCollection).toHaveBeenCalledTimes(1));
    const arg = window.api.tidalDownloadCollection.mock.calls[0][0];
    expect(arg.selectedEntries.map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('deselects everything from the header box', async () => {
    renderView();
    await openCollection();
    await screen.findByText('Track One');

    fireEvent.click(screen.getAllByRole('checkbox')[0]); // select-all off
    expect(screen.getByText('0 / 3 selected')).toBeInTheDocument();
    // Pre-existing label quirk of the shared action bar: with nothing ticked it
    // offers the link action. What matters here is that it is not actionable.
    expect(screen.getByRole('button', { name: /Link 0 tracks/ })).toBeDisabled();
  });

  it('surfaces the reason when the collection cannot be resolved', async () => {
    window.api.tidalCollectionTracks.mockResolvedValue({
      ok: false,
      error: 'Not logged in to TIDAL. Please connect your account first.',
    });
    renderView();
    await openCollection();

    expect(
      await screen.findByText(/Not logged in to TIDAL. Please connect your account first./)
    ).toBeInTheDocument();
    expect(screen.queryByText('Track One')).not.toBeInTheDocument();
  });
});
