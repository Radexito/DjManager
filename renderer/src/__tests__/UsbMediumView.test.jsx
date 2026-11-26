import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import UsbMediumView from '../UsbMediumView.jsx';

const contents = {
  root: '/media/STICK',
  ours: true,
  trackCount: 2,
  playlistCount: 1,
  tagCount: 0,
  tracks: [
    { id: 1, title: 'Opening', artist: 'Artist', album: 'Album' },
    { id: 2, title: 'Closer', artist: 'Artist', album: 'Album' },
  ],
  playlists: [
    {
      id: 1,
      name: 'Set',
      trackCount: 1,
      tracks: [{ id: 2, title: 'Closer', artist: 'Artist', album: 'Album' }],
    },
  ],
  tags: [],
};

describe('UsbMediumView', () => {
  beforeEach(() => {
    window.api.getUsbContents.mockResolvedValue(contents);
  });

  it('shows the medium library when no playlist is chosen', async () => {
    render(
      <UsbMediumView selection={{ mount: '/media/STICK', playlistId: null }} onClose={() => {}} />
    );

    await waitFor(() => expect(screen.getByText('Opening')).toBeInTheDocument());
    expect(screen.getByText('Closer')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText(/read only, from the medium/)).toBeInTheDocument();
    expect(window.api.getUsbContents).toHaveBeenCalledWith('/media/STICK');
  });

  it('shows only the chosen playlist', async () => {
    render(
      <UsbMediumView
        selection={{ mount: '/media/STICK', playlistId: 1, name: 'Set' }}
        onClose={() => {}}
      />
    );

    await waitFor(() => expect(screen.getByText('Set')).toBeInTheDocument());
    expect(screen.getByText('Closer')).toBeInTheDocument();
    expect(screen.queryByText('Opening')).not.toBeInTheDocument();
  });

  it('says so when the medium carries no database', async () => {
    window.api.getUsbContents.mockResolvedValueOnce(null);
    render(
      <UsbMediumView selection={{ mount: '/media/EMPTY', playlistId: null }} onClose={() => {}} />
    );

    await waitFor(() =>
      expect(screen.getByText(/carries no playlist database/)).toBeInTheDocument()
    );
  });

  it('closes when asked', async () => {
    const onClose = vi.fn();
    render(
      <UsbMediumView selection={{ mount: '/media/STICK', playlistId: null }} onClose={onClose} />
    );

    await waitFor(() => expect(screen.getByText('Library')).toBeInTheDocument());
    screen.getByText('Close').click();
    expect(onClose).toHaveBeenCalled();
  });
});
