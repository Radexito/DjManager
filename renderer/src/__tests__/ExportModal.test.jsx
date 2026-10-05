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
      removable: true,
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
      removable: true,
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
      removable: true,
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
      removable: true,
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

  // ── initialMode (shows confirm step first) ───────────────────────────────────

  it('shows confirm step (not folder dialog) when initialMode is provided', async () => {
    render(<ExportModal {...defaultProps} initialMode="rekordbox" />);

    await waitFor(() => {
      expect(screen.getByText('Choose folder & Export')).toBeInTheDocument();
    });
    expect(window.api.openDirDialog).not.toHaveBeenCalled();
  });

  it('calls openDirDialog after clicking proceed in confirm step', async () => {
    window.api.openDirDialog.mockResolvedValueOnce(null);

    render(<ExportModal {...defaultProps} initialMode="rekordbox" />);
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
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(window.api.exportRekordbox).toHaveBeenCalledWith(
        expect.objectContaining({ targetDevice: null, forceMp3: false })
      );
    });
  });

  it('passes the selected target device and forceMp3 flag to exportRekordbox', async () => {
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
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(window.api.exportRekordbox).toHaveBeenCalledWith(
        expect.objectContaining({ targetDevice: 'xdj-rx2', forceMp3: true })
      );
    });
  });

  it('passes target device and forceMp3 to exportAll as well', async () => {
    window.api.openDirDialog.mockResolvedValueOnce('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValueOnce({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });

    render(<ExportModal {...defaultProps} />);
    fireEvent.change(screen.getByLabelText('Target device'), { target: { value: 'cdj-3000' } });
    fireEvent.click(screen.getByText('Export All'));

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
    fireEvent.click(screen.getByText('Export Rekordbox USB'));

    await waitFor(() => {
      expect(window.api.exportRekordbox).toHaveBeenCalledWith(
        expect.objectContaining({ applyTrim: false })
      );
    });
  });

  it('sends applyTrim: true when the option is left alone (export all)', async () => {
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

  // ── Cancel a running export + keep/remove cleanup choice ──────────────────────

  /** Starts an Export All run whose IPC call stays pending until the test ends it. */
  async function startPendingExportAll() {
    let finish;
    window.api.openDirDialog.mockResolvedValue('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValue({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });
    window.api.exportAll.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export All'));
    await waitFor(() => expect(window.api.exportAll).toHaveBeenCalled());
    return finish;
  }

  it('offers no Cancel for an export while the modal is idle', () => {
    render(<ExportModal {...defaultProps} />);

    expect(screen.queryByText('Cancel export')).not.toBeInTheDocument();
  });

  it('shows a Cancel button while the export is running', async () => {
    await startPendingExportAll();

    expect(screen.getByRole('button', { name: 'Cancel export' })).toBeInTheDocument();
    // The export options are gone for the duration of the run.
    expect(screen.queryByText('Export All')).not.toBeInTheDocument();
  });

  it('calls the cancel IPC when Cancel is clicked', async () => {
    await startPendingExportAll();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));

    await waitFor(() => expect(window.api.cancelExport).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  });

  it('asks how to clean up after the export stopped, with the number of files written', async () => {
    const finish = await startPendingExportAll();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));
    await waitFor(() => expect(window.api.cancelExport).toHaveBeenCalled());

    finish({ ok: true, cancelled: true, addedFileCount: 3, usbRoot: '/tmp/usb' });

    await waitFor(() => {
      expect(screen.getByText('Export cancelled')).toBeInTheDocument();
    });
    expect(screen.getByText(/3 files had already been written to the USB/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep what was copied' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove what this export added' })
    ).toBeInTheDocument();
  });

  it('sends the keep choice and reports what was kept', async () => {
    window.api.resolveExportCleanup.mockResolvedValueOnce({
      ok: true,
      choice: 'keep',
      keptFiles: 3,
      usbRoot: '/tmp/usb',
    });
    const finish = await startPendingExportAll();
    finish({ ok: true, cancelled: true, addedFileCount: 3, usbRoot: '/tmp/usb' });
    await waitFor(() => screen.getByRole('button', { name: 'Keep what was copied' }));

    fireEvent.click(screen.getByRole('button', { name: 'Keep what was copied' }));

    await waitFor(() => {
      expect(window.api.resolveExportCleanup).toHaveBeenCalledWith({ choice: 'keep' });
      expect(screen.getByText(/Kept 3 files on the USB/)).toBeInTheDocument();
    });
  });

  it('sends the remove choice and reports what was removed', async () => {
    window.api.resolveExportCleanup.mockResolvedValueOnce({
      ok: true,
      choice: 'remove',
      removedFiles: 3,
      removedFolders: 1,
      keptFiles: 0,
      keptTracks: 2,
      usbRoot: '/tmp/usb',
    });
    const finish = await startPendingExportAll();
    finish({ ok: true, cancelled: true, addedFileCount: 3, usbRoot: '/tmp/usb' });
    await waitFor(() => screen.getByRole('button', { name: 'Remove what this export added' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove what this export added' }));

    await waitFor(() => {
      expect(window.api.resolveExportCleanup).toHaveBeenCalledWith({ choice: 'remove' });
      expect(screen.getByText(/Removed 3 files from the USB/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/2 tracks from earlier exports were left untouched/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('shows no files written when the export was cancelled before anything landed', async () => {
    const finish = await startPendingExportAll();
    finish({ ok: true, cancelled: true, addedFileCount: 0, usbRoot: '/tmp/usb' });

    await waitFor(() => {
      expect(screen.getByText(/No files had been written to the USB yet/)).toBeInTheDocument();
    });
  });

  it('still reports a completed export when Cancel arrives too late', async () => {
    const finish = await startPendingExportAll();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));

    finish({ ok: true, cancelled: false, trackCount: 5, playlistCount: 2, usbRoot: '/tmp/usb' });

    await waitFor(() => {
      expect(screen.getByText('Export complete!')).toBeInTheDocument();
    });
    expect(window.api.resolveExportCleanup).not.toHaveBeenCalled();
  });

  it('offers Cancel for a Rekordbox export too', async () => {
    let finish;
    window.api.openDirDialog.mockResolvedValue('/tmp/usb');
    window.api.checkUsbFormat.mockResolvedValue({
      needsFormat: false,
      fs: 'fat32',
      fsLabel: 'FAT32',
      device: '/dev/sdb1',
    });
    window.api.exportRekordbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );

    render(<ExportModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Export Rekordbox USB'));
    await waitFor(() => expect(window.api.exportRekordbox).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: 'Cancel export' })).toBeInTheDocument();
    finish({ ok: true, cancelled: false, trackCount: 3, usbRoot: '/tmp/usb' });
  });
});
