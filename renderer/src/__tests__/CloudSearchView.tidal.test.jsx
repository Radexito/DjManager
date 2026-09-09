import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CloudSearchView from '../CloudSearchView.jsx';

function trackResult(overrides = {}) {
  return {
    source: 'tidal',
    type: 'track',
    id: '111',
    title: 'Solo Track',
    artist: 'Artist A',
    album: 'Album A',
    durationSec: 200,
    url: 'https://tidal.com/browse/track/111',
    ...overrides,
  };
}

function albumResult(overrides = {}) {
  return {
    source: 'tidal',
    type: 'album',
    id: '999', // album id — NOT a track id
    title: 'Some Album',
    artist: 'Artist B',
    album: '',
    durationSec: null,
    url: 'https://tidal.com/browse/album/999',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api.cloudSearch.mockResolvedValue({ ok: true, results: [] });
  window.api.tidalCheck.mockResolvedValue({ installed: true, loggedIn: true });
});

async function searchAndSelectAll(results) {
  window.api.cloudSearch.mockResolvedValueOnce({ ok: true, results });
  render(<CloudSearchView />);
  fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: 'query' } });
  fireEvent.click(screen.getByRole('button', { name: /^Search$/i }));
  await waitFor(() => expect(window.api.cloudSearch).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/Select all/i)).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText(/Select all/i));
}

describe('CloudSearchView — TIDAL album/playlist download expansion', () => {
  it('passes a track result straight through without calling tidalFetchInfo', async () => {
    await searchAndSelectAll([trackResult()]);

    fireEvent.click(screen.getByRole('button', { name: /Download Selected/i }));

    await waitFor(() => expect(window.api.tidalDownloadUrl).toHaveBeenCalled());
    expect(window.api.tidalFetchInfo).not.toHaveBeenCalled();
    expect(window.api.tidalDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedEntries: [{ id: '111', title: 'Solo Track', artist: 'Artist A' }],
      })
    );
  });

  it('expands an album result into its individual track entries before downloading', async () => {
    window.api.tidalFetchInfo.mockResolvedValueOnce({
      ok: true,
      type: 'album',
      title: 'Some Album',
      entries: [
        { index: 0, id: '201', title: 'Track One', artist: 'Artist B' },
        { index: 1, id: '202', title: 'Track Two', artist: 'Artist B' },
      ],
    });

    await searchAndSelectAll([albumResult()]);

    fireEvent.click(screen.getByRole('button', { name: /Download Selected/i }));

    await waitFor(() => expect(window.api.tidalDownloadUrl).toHaveBeenCalled());
    expect(window.api.tidalFetchInfo).toHaveBeenCalledWith('https://tidal.com/browse/album/999');
    expect(window.api.tidalDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedEntries: [
          { id: '201', title: 'Track One', artist: 'Artist B' },
          { id: '202', title: 'Track Two', artist: 'Artist B' },
        ],
      })
    );
    // The album id (999) must never be used as a track id.
    const call = window.api.tidalDownloadUrl.mock.calls[0][0];
    expect(call.selectedEntries.some((e) => e.id === '999')).toBe(false);
  });

  it('surfaces an error and skips the download call when expansion fails', async () => {
    window.api.tidalFetchInfo.mockResolvedValueOnce({ ok: false, error: 'Album not found' });

    await searchAndSelectAll([albumResult()]);

    fireEvent.click(screen.getByRole('button', { name: /Download Selected/i }));

    await waitFor(() => expect(screen.getByText('Album not found')).toBeInTheDocument());
    expect(window.api.tidalDownloadUrl).not.toHaveBeenCalled();
  });
});
