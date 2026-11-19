import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import GraphicsNotice from '../GraphicsNotice.jsx';

/** LocalStorage key the notice uses to remember that the user dismissed it. */
const DISMISS_KEY = 'djman.graphicsNotice.dismissed';

const crashState = {
  mode: 'auto',
  activeProfile: 'fallback',
  notice: 'gpu-crash',
  crashCount: 2,
  lastCrashAt: 1730000000000,
};

describe('GraphicsNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.api.getGraphicsState.mockResolvedValue({
      mode: 'auto',
      activeProfile: 'auto',
      notice: null,
      crashCount: 0,
      lastCrashAt: null,
    });
  });

  it('stays out of the way when nothing crashed', async () => {
    render(<GraphicsNotice />);
    await waitFor(() => expect(window.api.getGraphicsState).toHaveBeenCalled());
    expect(screen.queryByTestId('graphics-notice')).toBeNull();
  });

  it('explains the fallback in plain words when acceleration was disabled', async () => {
    window.api.getGraphicsState.mockResolvedValue(crashState);

    render(<GraphicsNotice />);

    const bar = await screen.findByTestId('graphics-notice');
    expect(bar).toHaveTextContent(
      'Hardware acceleration was disabled because the GPU process crashed.'
    );
  });

  it('shows the recorded crash count in the details panel', async () => {
    window.api.getGraphicsState.mockResolvedValue(crashState);
    window.api.getGraphicsReport.mockResolvedValue({
      mode: 'auto',
      appVersion: '1.0.25',
      electron: '44.5.1',
      platform: 'linux',
      summary: { count: 2 },
    });

    render(<GraphicsNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));

    await waitFor(() =>
      expect(screen.getByTestId('graphics-notice-report')).toHaveTextContent('Crashes recorded: 2')
    );
    expect(window.api.getGraphicsReport).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed for the session without hiding the cause', async () => {
    window.api.getGraphicsState.mockResolvedValue(crashState);

    render(<GraphicsNotice />);
    fireEvent.click(await screen.findByLabelText('Dismiss graphics notice'));

    expect(screen.queryByTestId('graphics-notice')).toBeNull();
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe('1');
  });
});
