import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HelpView from '../HelpView.jsx';

describe('HelpView', () => {
  it('renders the Help title', () => {
    render(<HelpView />);
    expect(screen.getByText('Help')).toBeInTheDocument();
  });

  it('renders each core section title', () => {
    render(<HelpView />);
    expect(screen.getByText('Library management')).toBeInTheDocument();
    expect(screen.getByText('Cue points & beat grid')).toBeInTheDocument();
    expect(screen.getByText('Cloud search & downloads')).toBeInTheDocument();
    expect(screen.getByText('Playlists')).toBeInTheDocument();
    expect(screen.getByText('USB export (Rekordbox)')).toBeInTheDocument();
  });

  it('renders the keyboard shortcuts section', () => {
    render(<HelpView />);
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
    expect(screen.getByText('Play / pause (not while typing in a field)')).toBeInTheDocument();
  });

  it('applies the style prop to the root element', () => {
    const { container } = render(<HelpView style={{ display: 'none' }} />);
    expect(container.querySelector('.help-view')).toHaveStyle({ display: 'none' });
  });

  it('filters sections by the search query', () => {
    render(<HelpView />);
    fireEvent.change(screen.getByLabelText('Search the manual'), {
      target: { value: 'rekordbox' },
    });
    // USB export section remains, unrelated sections disappear.
    expect(screen.getByText('USB export (Rekordbox)')).toBeInTheDocument();
    expect(screen.queryByText('Library management')).not.toBeInTheDocument();
  });

  it('searching "Short" surfaces the keyboard shortcuts section', () => {
    render(<HelpView />);
    fireEvent.change(screen.getByLabelText('Search the manual'), {
      target: { value: 'short' },
    });
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
  });

  it('matches a section by its title', () => {
    render(<HelpView />);
    fireEvent.change(screen.getByLabelText('Search the manual'), {
      target: { value: 'player' },
    });
    expect(screen.getByText('Player')).toBeInTheDocument();
  });

  it('shows a no-results message when nothing matches', () => {
    render(<HelpView />);
    fireEvent.change(screen.getByLabelText('Search the manual'), {
      target: { value: 'zzz-no-such-topic' },
    });
    expect(screen.getByText(/No help entries match/)).toBeInTheDocument();
  });

  it('calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(<HelpView active onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close help'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
