import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import UsbMediumView from '../UsbMediumView.jsx';

const { play } = vi.hoisted(() => ({ play: vi.fn() }));

vi.mock('../PlayerContext.jsx', () => ({ usePlayer: () => ({ play }) }));

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
      file_path: '/media/STICK/Contents/1 - Opening.mp3',
    },
    {
      id: 2,
      title: 'Closer',
      artist: 'Artist',
      album: 'Album',
      bpm: 126,
      duration: 199,
      rating: 0,
      file_path: '/media/STICK/Contents/2 - Closer.mp3',
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
  tags: [
    {
      name: 'Genre',
      tags: [
        {
          id: 3,
          name: 'Trap',
          trackCount: 1,
          unknownTrackCount: 0,
          tracks: [
            {
              id: 1,
              title: 'Opening',
              artist: 'Artist',
              album: 'Album',
              bpm: 128,
              duration: 245,
              rating: 3,
              file_path: '/media/STICK/Contents/1 - Opening.mp3',
            },
          ],
        },
        { id: 4, name: 'Boom bap', trackCount: 0, unknownTrackCount: 2, tracks: [] },
      ],
    },
  ],
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
    expect(screen.getByText(/from the medium/)).toBeInTheDocument();
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

  it('searches the rows of the medium', async () => {
    render(
      <UsbMediumView selection={{ mount: '/media/STICK', playlistId: null }} onClose={() => {}} />
    );

    await waitFor(() => expect(screen.getByText('Opening')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'closer' } });

    await waitFor(() => expect(screen.queryByText('Opening')).not.toBeInTheDocument());
    expect(screen.getByText('Closer')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 track/)).toBeInTheDocument();
  });

  it('plays a row on double click, from the file on the medium', async () => {
    render(
      <UsbMediumView selection={{ mount: '/media/STICK', playlistId: null }} onClose={() => {}} />
    );

    const row = (await screen.findByText('Opening')).closest('.row');
    fireEvent.doubleClick(row);

    expect(play).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        file_path: '/media/STICK/Contents/1 - Opening.mp3',
      }),
      expect.any(Array),
      0,
      null,
      null
    );
  });

  it('offers a row menu', async () => {
    render(
      <UsbMediumView selection={{ mount: '/media/STICK', playlistId: null }} onClose={() => {}} />
    );

    const row = (await screen.findByText('Opening')).closest('.row');
    fireEvent.contextMenu(row);

    expect(screen.getByText('Play')).toBeInTheDocument();
    expect(screen.getByText('Copy file path')).toBeInTheDocument();
  });

  it('shows the tracks carrying a tag', async () => {
    render(
      <UsbMediumView
        selection={{ mount: '/media/STICK', playlistId: null, tagId: 3, name: 'Trap' }}
        onClose={() => {}}
      />
    );

    await waitFor(() => expect(screen.getByText('Trap')).toBeInTheDocument());
    expect(screen.getByText('Opening')).toBeInTheDocument();
    expect(screen.queryByText('Closer')).not.toBeInTheDocument();
  });

  it('says a tag names no track it can find rather than showing wrong ones', async () => {
    render(
      <UsbMediumView
        selection={{ mount: '/media/STICK', playlistId: null, tagId: 4, name: 'Boom bap' }}
        onClose={() => {}}
      />
    );

    await waitFor(() =>
      expect(screen.getByText(/No track on this medium carries that tag/)).toBeInTheDocument()
    );
    expect(screen.queryByText('Opening')).not.toBeInTheDocument();
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
