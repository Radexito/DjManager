import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Sidebar from '../Sidebar.jsx';
import { DownloadProvider } from '../DownloadContext.jsx';
import { TidalDownloadProvider } from '../TidalDownloadContext.jsx';

function renderSidebar(props = {}) {
  return render(
    <DownloadProvider>
      <TidalDownloadProvider>
        <Sidebar {...props} />
      </TidalDownloadProvider>
    </DownloadProvider>
  );
}

describe('Sidebar', () => {
  const defaultProps = {
    selectedMenuItemId: 'music',
    onMenuSelect: vi.fn(),
    onExportPlaylistRekordboxUsb: vi.fn(),
    onExportPlaylistAll: vi.fn(),
  };

  it('renders the Music menu item', () => {
    renderSidebar({ ...defaultProps });
    expect(screen.getByText('Music')).toBeInTheDocument();
  });

  it('renders the PLAYLISTS heading', () => {
    renderSidebar({ ...defaultProps });
    expect(screen.getByText('PLAYLISTS')).toBeInTheDocument();
  });

  it('shows empty state when no playlists exist', async () => {
    renderSidebar({ ...defaultProps });
    await waitFor(() => {
      expect(screen.getByText('No playlists yet')).toBeInTheDocument();
    });
  });

  it('renders loaded playlists', async () => {
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 1, name: 'Techno Set', color: '#e63946', track_count: 12, total_duration: 3600 },
      { id: 2, name: 'House Vibes', color: null, track_count: 8, total_duration: 2400 },
    ]);

    renderSidebar({ ...defaultProps });
    await waitFor(() => {
      expect(screen.getByText('Techno Set')).toBeInTheDocument();
      expect(screen.getByText('House Vibes')).toBeInTheDocument();
    });
  });

  it('calls onMenuSelect when Music is clicked', () => {
    const onMenuSelect = vi.fn();
    renderSidebar({ ...defaultProps, onMenuSelect });
    fireEvent.click(screen.getByText('Music'));
    expect(onMenuSelect).toHaveBeenCalledWith('music');
  });

  it('calls onMenuSelect with playlist id when playlist is clicked', async () => {
    const onMenuSelect = vi.fn();
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 42, name: 'My Set', color: null, track_count: 5, total_duration: 1500 },
    ]);

    renderSidebar({ ...defaultProps, onMenuSelect });
    await waitFor(() => screen.getByText('My Set'));
    fireEvent.click(screen.getByText('My Set'));
    expect(onMenuSelect).toHaveBeenCalledWith('42');
  });

  it('shows new playlist input when + button is clicked', () => {
    renderSidebar({ ...defaultProps });
    fireEvent.click(screen.getByTitle('New playlist'));
    expect(screen.getByPlaceholderText('Playlist name')).toBeInTheDocument();
  });

  it('shows context menu on right-click of a playlist', async () => {
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 1, name: 'Techno Set', color: null, track_count: 0, total_duration: 0 },
    ]);

    renderSidebar({ ...defaultProps });
    await waitFor(() => screen.getByText('Techno Set'));
    fireEvent.contextMenu(screen.getByText('Techno Set'));

    expect(screen.getByText(/Rename/)).toBeInTheDocument();
    expect(screen.getByText(/Export as M3U/)).toBeInTheDocument();
    expect(screen.getByText(/Delete playlist/)).toBeInTheDocument();
  });

  it('context menu includes "Export Rekordbox USB…" and "Export All to USB…"', async () => {
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 1, name: 'Techno Set', color: null, track_count: 0, total_duration: 0 },
    ]);

    renderSidebar({ ...defaultProps });
    await waitFor(() => screen.getByText('Techno Set'));
    fireEvent.contextMenu(screen.getByText('Techno Set'));

    expect(screen.getByText(/Export Rekordbox USB/)).toBeInTheDocument();
    expect(screen.getByText(/Export All to USB/)).toBeInTheDocument();
  });

  it('calls onExportPlaylistRekordboxUsb with playlist id when "Export Rekordbox USB…" is clicked', async () => {
    const onExportPlaylistRekordboxUsb = vi.fn();
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 42, name: 'My Set', color: null, track_count: 0, total_duration: 0 },
    ]);

    renderSidebar({
      ...defaultProps,
      onExportPlaylistRekordboxUsb,
    });
    await waitFor(() => screen.getByText('My Set'));
    fireEvent.contextMenu(screen.getByText('My Set'));
    fireEvent.click(screen.getByText(/Export Rekordbox USB/));

    expect(onExportPlaylistRekordboxUsb).toHaveBeenCalledWith(42);
  });

  it('calls onExportPlaylistAll with playlist id when "Export All to USB…" is clicked', async () => {
    const onExportPlaylistAll = vi.fn();
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 42, name: 'My Set', color: null, track_count: 0, total_duration: 0 },
    ]);

    renderSidebar({ ...defaultProps, onExportPlaylistAll });
    await waitFor(() => screen.getByText('My Set'));
    fireEvent.contextMenu(screen.getByText('My Set'));
    fireEvent.click(screen.getByText(/Export All to USB/));

    expect(onExportPlaylistAll).toHaveBeenCalledWith(42);
  });

  it('does not render an "Export USB…" bottom button', () => {
    renderSidebar({ ...defaultProps });
    expect(screen.queryByText(/Export USB/)).toBeNull();
  });
});

describe('Sidebar — import dialog playlist association', () => {
  beforeEach(() => vi.clearAllMocks());

  const defaultProps = {
    selectedMenuItemId: 'music',
    onMenuSelect: vi.fn(),
    onExportPlaylistRekordboxUsb: vi.fn(),
    onExportPlaylistAll: vi.fn(),
  };

  it('passes playlist id (not the whole object) to importAudioFiles when creating new playlist', async () => {
    window.api.selectAudioFiles.mockResolvedValueOnce(['/tmp/track.mp3']);
    window.api.createPlaylist.mockResolvedValueOnce({ id: 7 });

    renderSidebar({ ...defaultProps });
    fireEvent.click(screen.getByText('Import Audio Files'));

    await waitFor(() => screen.getByText('Import to Playlist'));

    fireEvent.click(screen.getByRole('radio', { name: /Create new playlist/ }));
    fireEvent.change(screen.getByPlaceholderText('New playlist name'), {
      target: { value: 'My New Set' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(window.api.createPlaylist).toHaveBeenCalledWith('My New Set');
      // Regression: must pass the integer id, not the whole { id } object
      expect(window.api.importAudioFiles).toHaveBeenCalledWith(['/tmp/track.mp3'], 7);
    });
  });

  it('passes playlist id to importAudioFiles when selecting an existing playlist', async () => {
    window.api.getPlaylists.mockResolvedValue([
      { id: 42, name: 'Techno Set', color: null, track_count: 5, total_duration: 1500 },
    ]);
    window.api.selectAudioFiles.mockResolvedValueOnce(['/tmp/track.mp3']);

    renderSidebar({ ...defaultProps });
    await waitFor(() => screen.getByText('Techno Set'));

    fireEvent.click(screen.getByText('Import Audio Files'));
    await waitFor(() => screen.getByText('Import to Playlist'));

    fireEvent.click(screen.getByRole('radio', { name: /Techno Set/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(window.api.importAudioFiles).toHaveBeenCalledWith(['/tmp/track.mp3'], 42);
    });
  });

  it('passes null to importAudioFiles when "Library only" is selected', async () => {
    window.api.selectAudioFiles.mockResolvedValueOnce(['/tmp/track.mp3']);

    renderSidebar({ ...defaultProps });
    fireEvent.click(screen.getByText('Import Audio Files'));
    await waitFor(() => screen.getByText('Import to Playlist'));

    // "Library only" is the default — just click Import
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(window.api.importAudioFiles).toHaveBeenCalledWith(['/tmp/track.mp3'], null);
    });
  });
});

describe('Sidebar — normalization progress bar', () => {
  beforeEach(() => vi.clearAllMocks());

  const defaultProps = {
    selectedMenuItemId: 'music',
    onMenuSelect: vi.fn(),
    onExportPlaylistRekordboxUsb: vi.fn(),
    onExportPlaylistAll: vi.fn(),
  };

  it('shows normalize progress when onNormalizeProgress fires with progress data', async () => {
    let progressCallback;
    window.api.onNormalizeProgress.mockImplementation((cb) => {
      progressCallback = cb;
      return vi.fn(); // unsub
    });

    renderSidebar({ ...defaultProps });

    act(() => {
      progressCallback({ completed: 3, total: 10, done: false });
    });

    await waitFor(() => {
      expect(screen.getByText('Normalizing')).toBeInTheDocument();
      expect(screen.getByText('3 / 10')).toBeInTheDocument();
    });
  });

  it('hides normalize progress bar when done event fires', async () => {
    let progressCallback;
    window.api.onNormalizeProgress.mockImplementation((cb) => {
      progressCallback = cb;
      return vi.fn();
    });

    renderSidebar({ ...defaultProps });

    act(() => progressCallback({ completed: 5, total: 5, done: false }));
    await waitFor(() => expect(screen.getByText('Normalizing')).toBeInTheDocument());

    act(() => progressCallback({ done: true }));
    await waitFor(() => expect(screen.queryByText('Normalizing')).toBeNull(), { timeout: 2000 });
  });
});
