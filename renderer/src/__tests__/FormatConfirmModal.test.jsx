import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FormatConfirmModal from '../FormatConfirmModal.jsx';

describe('FormatConfirmModal', () => {
  const defaultProps = {
    fsLabel: 'btrfs',
    device: '/dev/sdb1',
    mountPoint: '/mnt/usb',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders without crashing', () => {
    render(<FormatConfirmModal {...defaultProps} />);
    expect(screen.getByText(/Format as FAT32/)).toBeInTheDocument();
  });

  it('shows the filesystem label passed as prop', () => {
    render(<FormatConfirmModal {...defaultProps} fsLabel="NTFS" />);
    expect(screen.getByText(/NTFS/)).toBeInTheDocument();
  });

  it('shows the device path', () => {
    render(<FormatConfirmModal {...defaultProps} />);
    expect(screen.getByText('/dev/sdb1')).toBeInTheDocument();
  });

  it('shows the mount point', () => {
    render(<FormatConfirmModal {...defaultProps} />);
    expect(screen.getByText('/mnt/usb')).toBeInTheDocument();
  });

  it('does not show mount point when it equals device', () => {
    render(<FormatConfirmModal {...defaultProps} mountPoint="/dev/sdb1" device="/dev/sdb1" />);
    // The mount point conditional: mountPoint !== device → not rendered
    const codeEls = screen.getAllByRole('code').map((el) => el.textContent);
    expect(codeEls.filter((t) => t === '/dev/sdb1').length).toBe(1);
  });

  it('calls onConfirm when "Format as FAT32" button is clicked', () => {
    const onConfirm = vi.fn();
    render(<FormatConfirmModal {...defaultProps} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText('Format as FAT32'));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<FormatConfirmModal {...defaultProps} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows a destructive-operation warning message', () => {
    render(<FormatConfirmModal {...defaultProps} />);
    expect(screen.getByText(/erase all data/i)).toBeInTheDocument();
  });

  it('does not show device section when device is not provided', () => {
    render(<FormatConfirmModal {...defaultProps} device={null} mountPoint={null} />);
    // No code elements for device
    expect(screen.queryByRole('code')).toBeNull();
  });
});
