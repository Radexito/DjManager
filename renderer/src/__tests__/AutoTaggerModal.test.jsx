import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AutoTaggerModal from '../AutoTaggerModal.jsx';

const TRACK = {
  id: 1,
  title: 'Test Track',
  artist: 'Test Artist',
  album: 'Test Album',
  genres: '[]',
};

describe('AutoTaggerModal cover handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops broken cover URLs when image loading fails', async () => {
    window.api.autoTagSearch.mockResolvedValueOnce({
      ok: true,
      results: [
        {
          source: 'MusicBrainz',
          title: 'Test Track',
          artist: 'Test Artist',
          album: 'Test Album',
          label: '',
          year: '2022',
          genres: [],
          coverUrl: 'https://example.com/broken.jpg',
        },
        {
          source: 'Deezer',
          title: 'Test Track',
          artist: 'Test Artist',
          album: 'Test Album',
          label: '',
          year: '2022',
          genres: [],
          coverUrl: 'https://example.com/ok.jpg',
        },
      ],
    });

    render(<AutoTaggerModal track={TRACK} onApply={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Search'));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));

    fireEvent.error(screen.getByAltText('MusicBrainz'));

    await waitFor(() => {
      expect(screen.queryByAltText('MusicBrainz')).not.toBeInTheDocument();
    });
    expect(screen.getByAltText('Deezer')).toBeInTheDocument();
  });
});
