import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TopBar from '../TopBar.jsx';

describe('TopBar logo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onLogoClick when the logo is clicked', () => {
    const onLogoClick = vi.fn();
    render(<TopBar onOpenSettings={() => {}} onLogoClick={onLogoClick} />);

    fireEvent.click(screen.getByAltText('DJ Manager'));

    expect(onLogoClick).toHaveBeenCalledTimes(1);
  });

  it('calls onLogoClick on Enter/Space when the logo is focused', () => {
    const onLogoClick = vi.fn();
    render(<TopBar onOpenSettings={() => {}} onLogoClick={onLogoClick} />);

    const logo = screen.getByRole('button', { name: 'DJ Manager' });
    fireEvent.keyDown(logo, { key: 'Enter' });
    fireEvent.keyDown(logo, { key: ' ' });

    expect(onLogoClick).toHaveBeenCalledTimes(2);
  });
});

describe('TopBar actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onOpenSettings when the settings button is clicked', () => {
    const onOpenSettings = vi.fn();
    render(<TopBar onOpenSettings={onOpenSettings} onLogoClick={() => {}} />);
    fireEvent.click(screen.getByTitle('Settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('does not render search or transport controls', () => {
    render(<TopBar onOpenSettings={() => {}} onLogoClick={() => {}} />);
    expect(screen.queryByPlaceholderText(/Search…/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Play / Pause')).not.toBeInTheDocument();
  });
});
