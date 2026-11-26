import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import MusicLibrary from '../MusicLibrary.jsx';

const { play } = vi.hoisted(() => ({ play: vi.fn() }));

vi.mock('../PlayerContext.jsx', () => ({
  usePlayer: () => ({
    play,
    stop: vi.fn(),
    currentTrack: null,
    currentPlaylistId: null,
    mediaPort: 4242,
    patchCurrentTrack: vi.fn(),
    reloadCurrentTrack: vi.fn(),
    updateQueue: vi.fn(),
    unavailableLinkedIds: new Set(),
  }),
}));

const contents = {
  root: '/media/STICK',
  ours: true,
  trackCount: 2,
  playlistCount: 1,
  tagCount: 1,
  tracks: [
    {
      id: 1,
      title: 'Opening',
      artist: 'Drake',
      album: 'Album',
      bpm: 128,
      duration: 245,
      rating: 3,
      file_path: '/media/STICK/Contents/1 - Opening.mp3',
    },
    {
      id: 2,
      title: 'Closer',
      artist: 'Rezz',
      album: 'Album',
      bpm: 126,
      duration: 199,
      rating: 0,
      file_path: '/media/STICK/Contents/2 - Closer.mp3',
    },
  ],
  playlists: [
    {
      id: 7,
      name: 'Set',
      trackCount: 1,
      tracks: [
        {
          id: 2,
          title: 'Closer',
          artist: 'Rezz',
          album: 'Album',
          bpm: 126,
          duration: 199,
          rating: 0,
          file_path: '/media/STICK/Contents/2 - Closer.mp3',
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
              artist: 'Drake',
              album: 'Album',
              bpm: 128,
              duration: 245,
              rating: 3,
              file_path: '/media/STICK/Contents/1 - Opening.mp3',
            },
          ],
        },
      ],
    },
  ],
};

/** The real component is controlled: the search box writes to the parent. */
function Harness({ source }) {
  const [search, setSearch] = useState('');
  return (
    <MusicLibrary
      selectedPlaylist="music"
      search={search}
      onSearchChange={setSearch}
      usbSource={source}
      openDetailsRequest={null}
      locateTrack={null}
      onImportUsbCues={() => {}}
      onArtistSearch={() => {}}
    />
  );
}

describe('MusicLibrary showing a medium', () => {
  beforeEach(() => {
    play.mockClear();
    window.api.getUsbContents.mockResolvedValue(contents);
    window.api.getTracks.mockClear();
  });

  it('draws the medium rows with the table, and asks no database for them', async () => {
    render(<Harness source={{ mount: '/media/STICK' }} />);

    await waitFor(() => expect(screen.getByText('Opening')).toBeInTheDocument());
    expect(screen.getByText('Closer')).toBeInTheDocument();
    expect(window.api.getUsbContents).toHaveBeenCalledWith('/media/STICK');
    expect(window.api.getTracks).not.toHaveBeenCalled();
  });

  it('filters with the same search box the other tabs use', async () => {
    render(<Harness source={{ mount: '/media/STICK' }} />);

    await waitFor(() => expect(screen.getByText('Opening')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'closer' } });

    await waitFor(() => expect(screen.queryByText('Opening')).not.toBeInTheDocument());
    expect(screen.getByText('Closer')).toBeInTheDocument();
  });

  it('plays a row from the file on the medium', async () => {
    render(<Harness source={{ mount: '/media/STICK' }} />);

    const row = (await screen.findByText('Opening')).closest('.row');
    fireEvent.doubleClick(row);

    await waitFor(() =>
      expect(play).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, file_path: '/media/STICK/Contents/1 - Opening.mp3' }),
        expect.any(Array),
        0,
        null,
        null
      )
    );
  });

  it('shows one playlist of the medium', async () => {
    render(<Harness source={{ mount: '/media/STICK', playlistId: 7 }} />);

    await waitFor(() => expect(screen.getByText('Closer')).toBeInTheDocument());
    expect(screen.queryByText('Opening')).not.toBeInTheDocument();
  });

  it('shows the tracks carrying a tag of the medium', async () => {
    render(<Harness source={{ mount: '/media/STICK', tagId: 3 }} />);

    await waitFor(() => expect(screen.getByText('Opening')).toBeInTheDocument());
    expect(screen.queryByText('Closer')).not.toBeInTheDocument();
  });

  it('offers only what a medium can do in the row menu', async () => {
    render(<Harness source={{ mount: '/media/STICK' }} />);

    const row = (await screen.findByText('Opening')).closest('.row');
    fireEvent.contextMenu(row);

    expect(screen.getByText('Play')).toBeInTheDocument();
    expect(screen.getByText('Copy file path')).toBeInTheDocument();
    expect(screen.queryByText(/Re-analyze|Reanalyze/)).not.toBeInTheDocument();
  });
});
