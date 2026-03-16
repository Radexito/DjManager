import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExportModal from '../ExportModal.jsx';

describe('ExportModal', () => {
  const defaultProps = {
    onClose: vi.fn(),
    playlistId: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mocks to their default resolved values
    window.api.openDirDialog.mockResolvedValue(null);
    window.api.checkUsbFormat.mockResolvedValue({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'fat32',
      device: '/dev/sdb1',
    });
    window.api.exportRekordbox.mockResolvedValue({ ok: true, trackCount: 5, usbRoot: '/tmp/usb' });
    window.api.exportAll.mockResolvedValue({
      ok: true,
      trackCount: 5,
      playlistCount: 2,
      usbRoot: '/tmp/usb',
    });
    window.api.formatUsb.mockResolvedValue({ ok: true });
  });

  // ── Idle state ───────────────────────────────────────────────────────────────

  it('shows all three export options in idle state', () => {
    render(<ExportModal {...defaultProps} />);

    expect(screen.getByText('Export Rekordbox USB')).toBeInTheDocument();
    expect(screen.getByText('Export All')).toBeInTheDocument();
    expect(screen.getByText('Export M3U')).toBeInTheDocument();
  });

  it('"Export M3U" button calls onClose', () => {
    const onClose = vi.fn();
    render(<ExportModal {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByText('Export M3U'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  // ── Folder dialog cancelled ───────────────────────────────────────────────────

  it('stays in idle state when folder dialog is cancelled (returns null)', async () => {
    window.api.openDirDialog.mockResolvedValueOnce(null);

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      // Still shows idle export options — no crash
      expect(screen.getByText('Export Rekordbox USB')).toBeInTheDocument();
    });
    expect(window.api.checkUsbFormat).not.toHaveBeenCalled();
  });

  // ── No format needed → straight to export ─────────────────────────────────

  it('goes straight to exporting when checkUsbFormat returns needsFormat: false', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(window.api.exportRekordbox).toHaveBeenCalled();
    });
  });

  it('shows "Export complete!" after successful rekordbox export', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });
    window.api.exportRekordbox.mockResolvedValueOnce({
      ok: true,
      trackCount: 5,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(screen.getByText('Export complete!')).toBeInTheDocument();
    });
  });

  it('shows track count after successful export', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });
    window.api.exportRekordbox.mockResolvedValueOnce({
      ok: true,
      trackCount: 7,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(screen.getByText(/7 tracks/)).toBeInTheDocument();
    });
  });

  // ── Format warning ────────────────────────────────────────────────────────────

  it('shows format warning with Export Anyway and Format buttons when needsFormat: true', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(screen.getByText('Export Anyway')).toBeInTheDocument();
      expect(screen.getByText(/Format to FAT32/)).toBeInTheDocument();
    });
  });

  it('shows the detected filesystem label in format warning', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(screen.getByText(/btrfs/)).toBeInTheDocument();
    });
  });

  // ── "Export Anyway" ───────────────────────────────────────────────────────────

  it('"Export Anyway" triggers exportRekordbox without calling formatUsb', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });
    window.api.exportRekordbox.mockResolvedValueOnce({
      ok: true,
      trackCount: 3,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => screen.getByText('Export Anyway'));
    fireEvent.click(screen.getByText('Export Anyway'));

    await waitFor(() => {
      expect(window.api.exportRekordbox).toHaveBeenCalled();
    });
    expect(window.api.formatUsb).not.toHaveBeenCalled();
  });

  it('"Export Anyway" shows Export complete! after success', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });
    window.api.exportRekordbox.mockResolvedValueOnce({
      ok: true,
      trackCount: 3,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => screen.getByText('Export Anyway'));
    fireEvent.click(screen.getByText('Export Anyway'));

    await waitFor(() => {
      expect(screen.getByText('Export complete!')).toBeInTheDocument();
    });
  });

  // ── initialMode (skip idle) ───────────────────────────────────────────────────

  it('calls openDirDialog immediately when initialMode is provided', async () => {
    window.api.openDirDialog.mockResolvedValueOnce(null);

    render(<ExportModal {...defaultProps} initialMode="rekordbox" />);

    await waitFor(() => {
      expect(window.api.openDirDialog).toHaveBeenCalledOnce();
    });
  });

  it('does not call openDirDialog more than once in StrictMode (ref guard)', async () => {
    window.api.openDirDialog.mockResolvedValue(null);

    render(<ExportModal {...defaultProps} initialMode="rekordbox" />);

    await waitFor(() => {
      expect(window.api.openDirDialog).toHaveBeenCalledTimes(1);
    });
  });

  // ── "Export All" mode ─────────────────────────────────────────────────────────

  it('"Export All" button triggers exportAll', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(window.api.exportAll).toHaveBeenCalled();
    });
  });

  it('shows Export complete! with playlist count after exportAll', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });
    window.api.exportAll.mockResolvedValueOnce({
      ok: true,
      trackCount: 4,
      playlistCount: 2,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(screen.getByText('Export complete!')).toBeInTheDocument();
      expect(screen.getByText(/2 playlists/)).toBeInTheDocument();
    });
  });
});
