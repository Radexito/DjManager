import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DownloadView from '../DownloadView.jsx';
import { DownloadProvider } from '../DownloadContext.jsx';

function renderWithProvider(ui) {
  return render(<DownloadProvider>{ui}</DownloadProvider>);
}

const PLAYLIST_INFO = {
  ok: true,
  type: 'playlist',
  title: 'Acid House',
  entries: [
    { index: 0, id: 'a', title: 'Track A', url: 'https://yt.com/a', duration: 200 },
    { index: 1, id: 'b', title: 'Track B', url: 'https://yt.com/b', duration: 180 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Re-assign mocks in case a previous test set them to undefined
  window.api.ytDlpFetchInfo = vi.fn().mockResolvedValue({ ok: false, error: 'not configured' });
  window.api.ytDlpDownloadUrl = vi.fn().mockResolvedValue({ ok: true, trackIds: [] });
  window.api.onYtDlpProgress = vi.fn().mockImplementation(() => () => {});
  window.api.onYtDlpTrackUpdate = vi.fn().mockImplementation(() => () => {});
});

describe('DownloadView', () => {
  it('step 1 renders URL input and Load button; does not show selection or progress view', () => {
    renderWithProvider(<DownloadView />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load/i })).toBeInTheDocument();
    expect(screen.queryByText(/Acid House/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Download all/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Downloading and importing/i)).not.toBeInTheDocument();
  });

  it('Load button is disabled when input is empty', () => {
    renderWithProvider(<DownloadView />);
    expect(screen.getByRole('button', { name: /Load/i })).toBeDisabled();
  });

  it('shows error when ytDlpFetchInfo returns ok:false', async () => {
    window.api.ytDlpFetchInfo.mockResolvedValue({ ok: false, error: 'Network error' });
    renderWithProvider(<DownloadView />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://www.youtube.com/watch?v=abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Load/i }));
    await waitFor(() => expect(screen.getByText(/Network error/i)).toBeInTheDocument());
  });

  it('shows restart error when ytDlpFetchInfo is not a function', async () => {
    window.api.ytDlpFetchInfo = undefined;
    renderWithProvider(<DownloadView />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://www.youtube.com/watch?v=abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Load/i }));
    await waitFor(() => expect(screen.getByText(/restart/i)).toBeInTheDocument());
  });

  it('transitions to selection view on success (playlist)', async () => {
    window.api.ytDlpFetchInfo.mockResolvedValue(PLAYLIST_INFO);
    renderWithProvider(<DownloadView />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://www.youtube.com/playlist?list=xyz' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Load/i }));
    await waitFor(() => expect(screen.getByText('Acid House')).toBeInTheDocument());
    expect(screen.getByText('Track A')).toBeInTheDocument();
    expect(screen.getByText('Track B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download all \(2\)/i })).toBeInTheDocument();
  });

  it('select/deselect single track updates Download button count', async () => {
    window.api.ytDlpFetchInfo.mockResolvedValue(PLAYLIST_INFO);
    renderWithProvider(<DownloadView />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://www.youtube.com/playlist?list=xyz' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Load/i }));
    await waitFor(() => expect(screen.getByText('Acid House')).toBeInTheDocument());

    // Uncheck the first track (Track A)
    const checkboxes = screen.getAllByRole('checkbox');
    // The first checkbox is the "select all"; track checkboxes follow
    const trackCheckboxes = checkboxes.filter((cb) => !cb.closest('.dl-select-toolbar'));
    fireEvent.click(trackCheckboxes[0]);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Download selected \(1\)/i })).toBeInTheDocument()
    );
  });

  it('fmtDuration renders track duration correctly (125s → "2:05")', async () => {
    window.api.ytDlpFetchInfo.mockResolvedValue({
      ok: true,
      type: 'playlist',
      title: 'Duration Test',
      entries: [
        { index: 0, id: 'x', title: 'Short Track', url: 'https://yt.com/x', duration: 125 },
      ],
    });
    renderWithProvider(<DownloadView />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://www.youtube.com/playlist?list=dur' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Load/i }));
    await waitFor(() => expect(screen.getByText('Duration Test')).toBeInTheDocument());
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });
});
