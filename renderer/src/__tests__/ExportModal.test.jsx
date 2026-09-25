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
    window.api.exportAll.mockResolvedValue({
      ok: true,
      trackCount: 5,
      playlistCount: 2,
      usbRoot: '/tmp/usb',
    });
    window.api.formatUsb.mockResolvedValue({ ok: true });
  });

  // ── Idle state ───────────────────────────────────────────────────────────────

  it('shows only the Export All option in idle state', () => {
    render(<ExportModal {...defaultProps} />);

    expect(screen.getByText('Export All')).toBeInTheDocument();
    // The standalone M3U and Rekordbox USB exports are gone for good
    expect(screen.queryByText('Export Rekordbox USB')).toBeNull();
    expect(screen.queryByText('Export M3U')).toBeNull();
  });

  // ── Folder dialog cancelled ───────────────────────────────────────────────────

  it('stays in idle state when folder dialog is cancelled (returns null)', async () => {
    window.api.openDirDialog.mockResolvedValueOnce(null);

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      // Still shows idle export options — no crash
      expect(screen.getByText('Export All')).toBeInTheDocument();
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
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(window.api.exportAll).toHaveBeenCalled();
    });
  });

  it('shows "Export complete!" after successful export', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });
    window.api.exportAll.mockResolvedValueOnce({
      ok: true,
      trackCount: 5,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

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
    window.api.exportAll.mockResolvedValueOnce({
      ok: true,
      trackCount: 7,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(screen.getByText(/7 tracks/)).toBeInTheDocument();
    });
  });

  // ── Format warning ────────────────────────────────────────────────────────────

  it('shows format warning with Export Anyway and Format buttons when needsFormat: true', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      removable: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(screen.getByText('Export Anyway')).toBeInTheDocument();
      expect(screen.getByText(/Format to FAT32/)).toBeInTheDocument();
    });
  });

  it('shows the detected filesystem label in format warning', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      removable: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(screen.getByText(/btrfs/)).toBeInTheDocument();
    });
  });

  // ── "Export Anyway" ───────────────────────────────────────────────────────────

  it('"Export Anyway" triggers exportAll without calling formatUsb', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      removable: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });
    window.api.exportAll.mockResolvedValueOnce({
      ok: true,
      trackCount: 3,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => screen.getByText('Export Anyway'));
    fireEvent.click(screen.getByText('Export Anyway'));

    await waitFor(() => {
      expect(window.api.exportAll).toHaveBeenCalled();
    });
    expect(window.api.formatUsb).not.toHaveBeenCalled();
  });

  it('"Export Anyway" shows Export complete! after success', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: true,
      removable: true,
      fs: 'btrfs',
      fsLabel: 'btrfs',
      device: '/dev/sdb1',
    });
    window.api.exportAll.mockResolvedValueOnce({
      ok: true,
      trackCount: 3,
      usbRoot: '/tmp/usb',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => screen.getByText('Export Anyway'));
    fireEvent.click(screen.getByText('Export Anyway'));

    await waitFor(() => {
      expect(screen.getByText('Export complete!')).toBeInTheDocument();
    });
  });

  // ── initialMode (shows confirm step first) ───────────────────────────────────

  it('shows confirm step (not folder dialog) when initialMode is provided', async () => {
    render(<ExportModal {...defaultProps} initialMode="all" />);

    await waitFor(() => {
      expect(screen.getByText('Choose folder & Export')).toBeInTheDocument();
    });
    expect(window.api.openDirDialog).not.toHaveBeenCalled();
  });

  it('calls openDirDialog after clicking proceed in confirm step', async () => {
    window.api.openDirDialog.mockResolvedValueOnce(null);

    render(<ExportModal {...defaultProps} initialMode="all" />);
    await screen.findByText('Choose folder & Export');
    fireEvent.click(screen.getByText('Choose folder & Export'));

    await waitFor(() => {
      expect(window.api.openDirDialog).toHaveBeenCalledOnce();
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

  // ── Target device + force-MP3 options (#257) ──────────────────────────────────

  it('defaults to no target device and forceMp3 unchecked, and passes them through as null/false', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    expect(screen.getByText('Re-encode all tracks to MP3')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(window.api.exportAll).toHaveBeenCalledWith(
        expect.objectContaining({ targetDevice: null, forceMp3: false })
      );
    });
  });

  it('passes the selected target device and forceMp3 flag to exportAll', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.change(screen.getByLabelText('Target device'), { target: { value: 'xdj-rx2' } });
    fireEvent.click(screen.getByText('Re-encode all tracks to MP3'));
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(window.api.exportAll).toHaveBeenCalledWith(
        expect.objectContaining({ targetDevice: 'xdj-rx2', forceMp3: true })
      );
    });
  });

  it('passes the selected target device to exportAll from the confirm step', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} initialMode="all" />);
    fireEvent.change(await screen.findByLabelText('Target device'), {
      target: { value: 'cdj-3000' },
    });
    fireEvent.click(screen.getByText('Choose folder & Export'));

    await waitFor(() => {
      expect(window.api.exportAll).toHaveBeenCalledWith(
        expect.objectContaining({ targetDevice: 'cdj-3000', forceMp3: false })
      );
    });
  });

  // ── Trim ranges option (#463) ────────────────────────────────────────────────

  it('offers the trim-ranges option checked by default', () => {
    render(<ExportModal {...defaultProps} />);

    expect(screen.getByLabelText(/Apply trim ranges/)).toBeChecked();
  });

  it('sends applyTrim: true when the option is left alone', async () => {
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
      expect(window.api.exportAll).toHaveBeenCalledWith(
        expect.objectContaining({ applyTrim: true })
      );
    });
  });

  it('sends applyTrim: false when the trim option is switched off', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByLabelText(/Apply trim ranges/));
    fireEvent.click(screen.getByText('Export All'));

    await waitFor(() => {
      expect(window.api.exportAll).toHaveBeenCalledWith(
        expect.objectContaining({ applyTrim: false })
      );
    });
  });
});
