import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import GraphicsSettings from '../GraphicsSettings.jsx';

const autoState = {
  mode: 'auto',
  activeProfile: 'auto',
  notice: null,
  crashCount: 0,
  lastCrashAt: null,
};

const fallbackState = {
  mode: 'auto',
  activeProfile: 'fallback',
  notice: 'gpu-crash',
  crashCount: 2,
  lastCrashAt: 1730000000000,
};

describe('GraphicsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api.getGraphicsState.mockResolvedValue(autoState);
    window.api.setGraphicsMode.mockResolvedValue({ ok: true });
  });

  it('offers exactly the three documented modes', async () => {
    render(<GraphicsSettings />);
    const select = await screen.findByLabelText('Graphics mode');

    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Automatic',
      'Force enabled',
      'Force disabled',
    ]);
    expect(select.value).toBe('auto');
  });

  it('applies a forced-off choice and restarts the app', async () => {
    render(<GraphicsSettings />);
    fireEvent.change(await screen.findByLabelText('Graphics mode'), {
      target: { value: 'disabled' },
    });

    await waitFor(() =>
      expect(window.api.setGraphicsMode).toHaveBeenCalledWith({
        mode: 'disabled',
        confirmRisk: false,
      })
    );
    expect(window.api.relaunchApp).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit confirmation before re-enabling acceleration after a fallback', async () => {
    window.api.getGraphicsState.mockResolvedValue(fallbackState);
    window.api.setGraphicsMode
      .mockResolvedValueOnce({ ok: false, requiresConfirmation: true, error: 'risky' })
      .mockResolvedValueOnce({ ok: true });

    render(<GraphicsSettings />);
    fireEvent.change(await screen.findByLabelText('Graphics mode'), {
      target: { value: 'enabled' },
    });

    const confirm = await screen.findByTestId('graphics-confirm');
    expect(confirm).toHaveTextContent('may crash the app again');
    expect(window.api.relaunchApp).not.toHaveBeenCalled();

    const enableAnyway = screen.getByRole('button', { name: 'Enable anyway' });
    expect(enableAnyway).toBeDisabled();

    fireEvent.click(screen.getByLabelText('I understand the risk'));
    expect(enableAnyway).not.toBeDisabled();
    fireEvent.click(enableAnyway);

    await waitFor(() =>
      expect(window.api.setGraphicsMode).toHaveBeenLastCalledWith({
        mode: 'enabled',
        confirmRisk: true,
      })
    );
    expect(window.api.relaunchApp).toHaveBeenCalledTimes(1);
  });

  it('tells the user when the fallback is active', async () => {
    window.api.getGraphicsState.mockResolvedValue(fallbackState);

    render(<GraphicsSettings />);

    expect(await screen.findByTestId('graphics-fallback-note')).toHaveTextContent(
      'Acceleration is currently off because the GPU process crashed 2 time(s).'
    );
  });

  it('surfaces a save failure instead of pretending it worked', async () => {
    window.api.setGraphicsMode.mockResolvedValue({ ok: false, error: 'Could not save' });

    render(<GraphicsSettings />);
    fireEvent.change(await screen.findByLabelText('Graphics mode'), {
      target: { value: 'disabled' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(window.api.relaunchApp).not.toHaveBeenCalled();
  });
});
