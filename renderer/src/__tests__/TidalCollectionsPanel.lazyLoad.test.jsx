import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import TidalCollectionsPanel from '../TidalCollectionsPanel.jsx';

const COLLECTIONS = [
  {
    id: 'pl-1',
    type: 'playlist',
    title: 'Uptempo',
    group: 'playlists',
    parentId: null,
    subtitle: '',
    count: 12,
  },
  {
    id: 'tracks',
    type: 'favorites',
    title: 'Favorite tracks',
    group: 'favorites',
    parentId: null,
    subtitle: '',
    count: 3,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  window.api.tidalListCollections.mockResolvedValue({
    ok: true,
    collections: COLLECTIONS,
    warnings: [],
  });
});

describe('TidalCollectionsPanel - lazy collection loading', () => {
  it('does not fetch while the TIDAL tab is not visible', async () => {
    render(<TidalCollectionsPanel active={false} />);

    await act(async () => {});

    expect(window.api.tidalListCollections).not.toHaveBeenCalled();
    // No fetch means no honest loading state either.
    expect(screen.queryByText('Loading collections…')).not.toBeInTheDocument();
    expect(screen.queryByText('Uptempo')).not.toBeInTheDocument();
  });

  it('fetches once when the TIDAL tab becomes visible', async () => {
    const { rerender } = render(<TidalCollectionsPanel active={false} />);
    expect(window.api.tidalListCollections).not.toHaveBeenCalled();

    rerender(<TidalCollectionsPanel active={true} />);

    expect(await screen.findByText('Uptempo')).toBeInTheDocument();
    expect(window.api.tidalListCollections).toHaveBeenCalledTimes(1);
  });

  it('shows the loading state only while a fetch is really in flight', async () => {
    let resolveFetch;
    window.api.tidalListCollections.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve))
    );

    const { rerender } = render(<TidalCollectionsPanel active={false} />);
    expect(screen.queryByText('Loading collections…')).not.toBeInTheDocument();

    rerender(<TidalCollectionsPanel active={true} />);
    expect(await screen.findByText('Loading collections…')).toBeInTheDocument();

    await act(async () => {
      resolveFetch({ ok: true, collections: COLLECTIONS, warnings: [] });
    });

    expect(await screen.findByText('Uptempo')).toBeInTheDocument();
    expect(screen.queryByText('Loading collections…')).not.toBeInTheDocument();
  });

  it('does not refetch the collections when the tab is entered again', async () => {
    const { rerender } = render(<TidalCollectionsPanel active={true} />);
    expect(await screen.findByText('Uptempo')).toBeInTheDocument();

    rerender(<TidalCollectionsPanel active={false} />);
    rerender(<TidalCollectionsPanel active={true} />);

    // Already loaded in this mount, so the panel keeps the tree it has.
    expect(await screen.findByText('Uptempo')).toBeInTheDocument();
    expect(window.api.tidalListCollections).toHaveBeenCalledTimes(1);
  });

  it('asks the main process for a forced refresh on Reload', async () => {
    render(<TidalCollectionsPanel active={true} />);
    await screen.findByText('Uptempo');

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(window.api.tidalListCollections).toHaveBeenCalledTimes(2));
    expect(window.api.tidalListCollections).toHaveBeenLastCalledWith({ force: true });
  });

  it('keeps the error state and the warnings handling', async () => {
    window.api.tidalListCollections.mockResolvedValue({
      ok: false,
      error: 'Not logged in to TIDAL. Please connect your account first.',
      collections: [],
      warnings: [],
    });

    render(<TidalCollectionsPanel active={true} />);

    expect(
      await screen.findByText(/Not logged in to TIDAL. Please connect your account first./)
    ).toBeInTheDocument();

    vi.clearAllMocks();
    window.api.tidalListCollections.mockResolvedValue({
      ok: true,
      collections: COLLECTIONS,
      warnings: ['mixes: unavailable'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(
      await screen.findByText(/Some collections could not be loaded \(1\)/)
    ).toBeInTheDocument();
    expect(screen.getByText('Uptempo')).toBeInTheDocument();
  });

  it('still opens and downloads collections from the panel', async () => {
    const onDownload = vi.fn();
    const onOpen = vi.fn();

    render(<TidalCollectionsPanel active={true} onDownload={onDownload} onOpen={onOpen} />);
    await screen.findByText('Uptempo');

    fireEvent.click(screen.getByRole('button', { name: 'Download Uptempo' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'pl-1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Uptempo' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'pl-1' }));
  });
});
