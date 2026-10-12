import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UsbCueImport from '../UsbCueImport.jsx';

// #518 review — the import dialog must let the user choose between extending
// the library and replacing it with what the stick carries.

const SCAN_EXTEND = {
  ok: true,
  usbRoot: '/run/media/radexito/STICK',
  mode: 'extend',
  tracks: [
    {
      trackId: 1,
      title: 'Track One',
      usbFilePath: '/music/one.mp3',
      cues: [{ hotCueIndex: 0, positionMs: 1000 }],
      add: [{ hotCueIndex: 0, positionMs: 1000 }],
      update: [],
      skip: [],
      remove: [],
    },
  ],
  summary: { tracks: 1, cues: 1, add: 1, update: 0, skip: 0, remove: 0 },
};

const SCAN_REPLACE = {
  ...SCAN_EXTEND,
  mode: 'replace',
  tracks: [{ ...SCAN_EXTEND.tracks[0], remove: [{ id: 5 }, { id: 6 }] }],
  summary: { tracks: 1, cues: 1, add: 1, update: 0, skip: 0, remove: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  window.api.scanUsbCues.mockResolvedValue(SCAN_EXTEND);
  window.api.importUsbCues.mockResolvedValue({
    ok: true,
    mode: 'replace',
    added: 1,
    updated: 0,
    skipped: 0,
    removed: 2,
    tracks: 1,
  });
});

describe('UsbCueImport modes (#518)', () => {
  it('scans in extend mode by default and says nothing is deleted', async () => {
    render(<UsbCueImport usbRoot="/run/media/radexito/STICK" onClose={vi.fn()} />);

    await waitFor(() =>
      expect(window.api.scanUsbCues).toHaveBeenCalledWith({
        usbRoot: '/run/media/radexito/STICK',
        mode: 'extend',
      })
    );
    expect(await screen.findByText('Extend')).toBeInTheDocument();
    expect(screen.getByText('Replace')).toBeInTheDocument();
    expect(screen.getByText(/nothing is ever deleted/i)).toBeInTheDocument();
  });

  it('re-scans in replace mode when the user picks it', async () => {
    window.api.scanUsbCues.mockImplementation(({ mode }) =>
      Promise.resolve(mode === 'replace' ? SCAN_REPLACE : SCAN_EXTEND)
    );
    render(<UsbCueImport usbRoot="/run/media/radexito/STICK" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText('Replace'));

    await waitFor(() =>
      expect(window.api.scanUsbCues).toHaveBeenLastCalledWith({
        usbRoot: '/run/media/radexito/STICK',
        mode: 'replace',
      })
    );
  });

  it('warns how many library cues replace would delete', async () => {
    window.api.scanUsbCues.mockResolvedValue(SCAN_REPLACE);
    render(<UsbCueImport usbRoot="/run/media/radexito/STICK" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText('Replace'));

    expect(
      await screen.findByText(/deletes 2 library cues that this stick does not carry/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Replace with 1 cue/)).toBeInTheDocument();
  });

  it('passes the chosen mode to the import', async () => {
    window.api.scanUsbCues.mockResolvedValue(SCAN_REPLACE);
    render(<UsbCueImport usbRoot="/run/media/radexito/STICK" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText('Replace'));
    fireEvent.click(await screen.findByText(/Replace with 1 cue/));

    await waitFor(() =>
      expect(window.api.importUsbCues).toHaveBeenCalledWith({
        usbRoot: '/run/media/radexito/STICK',
        mode: 'replace',
      })
    );
    expect(await screen.findByText(/2 removed/)).toBeInTheDocument();
  });

  it('keeps extend as the safe default for the import call', async () => {
    render(<UsbCueImport usbRoot="/run/media/radexito/STICK" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Import 1 cue/));

    await waitFor(() =>
      expect(window.api.importUsbCues).toHaveBeenCalledWith({
        usbRoot: '/run/media/radexito/STICK',
        mode: 'extend',
      })
    );
  });
});
