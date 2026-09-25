// #516 — the folder sync's own counter in the sidebar.
// The analysis counter showed 1/1, 2/2, 3/3 … for a folder-tracked playlist
// because it counts analysis batches; this one counts the folder's files.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within, waitFor } from '@testing-library/react';
import Sidebar from '../Sidebar.jsx';
import { DownloadProvider } from '../DownloadContext.jsx';
import { TidalDownloadProvider } from '../TidalDownloadContext.jsx';

function renderSidebar() {
  return render(
    <DownloadProvider>
      <TidalDownloadProvider>
        <Sidebar
          selectedMenuItemId="music"
          onMenuSelect={vi.fn()}
          onExportPlaylistRekordboxUsb={vi.fn()}
          onExportPlaylistAll={vi.fn()}
        />
      </TidalDownloadProvider>
    </DownloadProvider>
  );
}

describe('Sidebar — folder sync progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api.getPlaylists.mockResolvedValue([]);
  });

  function captureProgress() {
    let callback;
    window.api.onFolderSyncProgress.mockImplementation((cb) => {
      callback = cb;
      return vi.fn();
    });
    return (data) => act(() => callback(data));
  }

  it('shows the live counter with a real total', async () => {
    const emit = captureProgress();
    renderSidebar();

    emit({ playlistId: 3, phase: 'linking', done: 42, total: 118, file: '/m/a.mp3' });

    expect(await screen.findByText('Linking 42/118…')).toBeInTheDocument();
    expect(screen.queryByText('Linking files…')).toBeNull();
  });

  it('follows the counter as it climbs and labels the final pass', async () => {
    const emit = captureProgress();
    renderSidebar();

    emit({ playlistId: 3, phase: 'linking', done: 10, total: 118 });
    expect(await screen.findByText('Linking 10/118…')).toBeInTheDocument();

    emit({ playlistId: 3, phase: 'linking', done: 118, total: 118 });
    expect(await screen.findByText('Linking 118/118…')).toBeInTheDocument();

    emit({ playlistId: 3, phase: 'adding', done: 118, total: 118 });
    expect(await screen.findByText('Adding 118/118…')).toBeInTheDocument();
  });

  it('clears the counter when the terminal done event arrives', async () => {
    const emit = captureProgress();
    renderSidebar();

    emit({ playlistId: 3, phase: 'linking', done: 7, total: 20 });
    expect(await screen.findByText('Linking 7/20…')).toBeInTheDocument();

    emit({ playlistId: 3, phase: 'done', done: 20, total: 20 });
    await waitFor(() => expect(screen.queryByText(/Linking 7\/20/)).toBeNull());
  });

  it('clears the counter when the run is cleared or fails', async () => {
    const emit = captureProgress();
    renderSidebar();

    emit({ playlistId: 3, phase: 'linking', done: 1, total: 5 });
    expect(await screen.findByText('Linking 1/5…')).toBeInTheDocument();

    emit(null); // the clearing event every progress stream ends with
    await waitFor(() => expect(screen.queryByText(/Linking 1\/5/)).toBeNull());
  });

  it('still shows the plain linking line for a manual link run', async () => {
    window.api.selectAudioFiles.mockResolvedValue(['/tmp/track.mp3']);
    window.api.linkAudioFiles.mockImplementation(() => new Promise(() => {})); // never resolves

    renderSidebar();
    (await screen.findByText('Link')).click();
    const dialog = (await screen.findByText('Link to Playlist')).closest('.ipd-modal');
    act(() => {
      within(dialog).getByRole('button', { name: 'Link' }).click();
    });

    expect(await screen.findByText('Linking files…')).toBeInTheDocument();
  });
});
