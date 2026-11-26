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
    {
      id: 1,
      title: 'Opening',
      artist: 'Artist',
      album: 'Album',
      bpm: 128,
      duration: 245,
      rating: 3,
    },
    {
      id: 2,
      title: 'Closer',
      artist: 'Artist',
      album: 'Album',
      bpm: 126,
      duration: 199,
      rating: 0,
    },
  ],
  playlists: [
    {
      id: 1,
      name: 'Set',
      trackCount: 1,
      tracks: [
        {
          id: 2,
          title: 'Closer',
          artist: 'Artist',
          album: 'Album',
          bpm: 126,
          duration: 199,
          rating: 0,
        },
      ],
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

    // The same columns and cells the library table draws, not a second layout.
    const header = document.querySelector('.header');
    expect(header).not.toBeNull();
    for (const label of ['Title', 'Artist', 'Album', 'BPM']) {
      expect(header.textContent).toContain(label);
    }
    expect(document.querySelector('.row .cell.artist')).not.toBeNull();
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('4:05')).toBeInTheDocument();
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
