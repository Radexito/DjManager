import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Sidebar from '../Sidebar.jsx';

describe('Sidebar', () => {
  const defaultProps = {
    selectedMenuItemId: 'music',
    onMenuSelect: vi.fn(),
  };

  it('renders the Music menu item', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('Music')).toBeInTheDocument();
  });

  it('renders the PLAYLISTS heading', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('PLAYLISTS')).toBeInTheDocument();
  });

  it('shows empty state when no playlists exist', async () => {
    render(<Sidebar {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('No playlists yet')).toBeInTheDocument();
    });
  });

  it('renders loaded playlists', async () => {
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 1, name: 'Techno Set', color: '#e63946', track_count: 12, total_duration: 3600 },
      { id: 2, name: 'House Vibes', color: null, track_count: 8, total_duration: 2400 },
    ]);

    render(<Sidebar {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Techno Set')).toBeInTheDocument();
      expect(screen.getByText('House Vibes')).toBeInTheDocument();
    });
  });

  it('calls onMenuSelect when Music is clicked', () => {
    const onMenuSelect = vi.fn();
    render(<Sidebar {...defaultProps} onMenuSelect={onMenuSelect} />);
    fireEvent.click(screen.getByText('Music'));
    expect(onMenuSelect).toHaveBeenCalledWith('music');
  });

  it('calls onMenuSelect with playlist id when playlist is clicked', async () => {
    const onMenuSelect = vi.fn();
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 42, name: 'My Set', color: null, track_count: 5, total_duration: 1500 },
    ]);

    render(<Sidebar {...defaultProps} onMenuSelect={onMenuSelect} />);
    await waitFor(() => screen.getByText('My Set'));
    fireEvent.click(screen.getByText('My Set'));
    expect(onMenuSelect).toHaveBeenCalledWith('42');
  });

  it('shows new playlist input when + button is clicked', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByTitle('New playlist'));
    expect(screen.getByPlaceholderText('Playlist name')).toBeInTheDocument();
  });

  it('shows context menu on right-click of a playlist', async () => {
    window.api.getPlaylists.mockResolvedValueOnce([
      { id: 1, name: 'Techno Set', color: null, track_count: 0, total_duration: 0 },
    ]);

    render(<Sidebar {...defaultProps} />);
    await waitFor(() => screen.getByText('Techno Set'));
    fireEvent.contextMenu(screen.getByText('Techno Set'));

    expect(screen.getByText(/Rename/)).toBeInTheDocument();
    expect(screen.getByText(/Export as M3U/)).toBeInTheDocument();
    expect(screen.getByText(/Delete playlist/)).toBeInTheDocument();
  });
});
