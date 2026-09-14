import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import FileExplorerView from '../FileExplorerView.jsx';
import { PlayerProvider } from '../PlayerContext.jsx';

// jsdom has no ResizeObserver; FileExplorerView uses one to size its virtualized list.
globalThis.ResizeObserver =
  globalThis.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const SYSTEM = {
  id: 'linux:system',
  root: '/',
  label: '/',
  fileSystemType: 'ext4',
  removable: false,
  system: true,
  device: '/dev/nvme0n1p2',
  totalBytes: 500000,
};

// A second system subvolume: mounted, but nothing a user acts on in this pane.
const HOME_SUBVOL = {
  id: 'linux:ext4:home:100',
  root: '/home',
  label: 'home',
  fileSystemType: 'ext4',
  removable: false,
  system: false,
  device: '/dev/nvme0n1p2',
  totalBytes: 100,
};

const STICK = {
  id: 'linux:exfat:Ventoy:31372345344',
  root: '/run/media/radexito/Ventoy',
  label: 'Ventoy',
  fileSystemType: 'exfat',
  removable: true,
  system: false,
  device: '/dev/sda1',
  totalBytes: 31372345344,
};

function stubRoot(volumes, drives = []) {
  window.api.getComputerRoot.mockResolvedValue({
    root: '/',
    home: '/home/radexito',
    drives,
    volumes,
  });
}

function renderExplorer() {
  return render(
    <PlayerProvider>
      <FileExplorerView />
    </PlayerProvider>
  );
}

describe('FileExplorerView - mounted volumes in the drive pane (#504)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api.getSetting.mockImplementation((key, def) =>
      Promise.resolve(key === 'explorer_favourites' ? [] : def)
    );
    window.api.detectDriveExports.mockResolvedValue({ ok: true, exports: [] });
  });

  it('lists the system root and removable media, and hides the other mounts', async () => {
    stubRoot([SYSTEM, HOME_SUBVOL, STICK]);

    renderExplorer();

    expect(await screen.findByTitle('/run/media/radexito/Ventoy')).toBeTruthy();
    expect(screen.getByTitle('/')).toBeTruthy();
    expect(screen.getByText('Ventoy')).toBeTruthy();
    expect(screen.getByTitle('Removable drive')).toBeTruthy();
    expect(screen.queryByTitle('/home')).toBeNull();
  });

  it('scans the mount the current path lives on, and rescans when another is clicked', async () => {
    stubRoot([SYSTEM, STICK]);

    renderExplorer();

    // home lives on the filesystem root, so that is the mount that gets scanned
    await waitFor(() => expect(window.api.detectDriveExports).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('No DJ exports found')).toBeTruthy();

    fireEvent.click(screen.getByTitle('/run/media/radexito/Ventoy'));

    await waitFor(() =>
      expect(window.api.detectDriveExports).toHaveBeenCalledWith('/run/media/radexito/Ventoy')
    );
  });

  it('shows a stick that was plugged in while the app was running', async () => {
    stubRoot([SYSTEM]);
    let pushDrives = null;
    window.api.onDrivesUpdated.mockImplementation((callback) => {
      pushDrives = callback;
      return () => {};
    });

    renderExplorer();

    await waitFor(() => expect(window.api.onDrivesUpdated).toHaveBeenCalled());
    expect(screen.queryByTitle('/run/media/radexito/Ventoy')).toBeNull();

    act(() => {
      pushDrives({ drives: [], volumes: [SYSTEM, STICK] });
    });

    expect(await screen.findByTitle('/run/media/radexito/Ventoy')).toBeTruthy();
    expect(screen.getByText('Ventoy')).toBeTruthy();
  });

  it('drops a stick that was unplugged while the app was running', async () => {
    stubRoot([SYSTEM, STICK]);
    let pushDrives = null;
    window.api.onDrivesUpdated.mockImplementation((callback) => {
      pushDrives = callback;
      return () => {};
    });

    renderExplorer();

    expect(await screen.findByTitle('/run/media/radexito/Ventoy')).toBeTruthy();

    act(() => {
      pushDrives({ drives: [], volumes: [SYSTEM] });
    });

    await waitFor(() => expect(screen.queryByTitle('/run/media/radexito/Ventoy')).toBeNull());
  });

  it('still lists Windows drive letters when no volumes come back', async () => {
    window.api.getComputerRoot.mockResolvedValue({
      root: 'E:\\',
      home: 'E:\\',
      drives: ['C:\\', 'E:\\'],
    });

    renderExplorer();

    expect(await screen.findByText('C:\\')).toBeTruthy();
    expect(screen.getByText('E:\\')).toBeTruthy();
    expect(screen.queryByTitle('Removable drive')).toBeNull();
  });
});
