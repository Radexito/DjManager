import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import FileExplorerView from '../FileExplorerView.jsx';
import { buildExplorerContextMenu, SINGLE_SELECTION_REASON } from '../explorerContextMenu.js';

// Render every virtualized row inline so rows are clickable in jsdom.
vi.mock('react-window', () => ({
  List: ({ rowComponent, rowProps, rowCount }) => {
    const Item = rowComponent;
    return (
      <div data-testid="virtual-list">
        {Array.from({ length: rowCount }, (_, i) => (
          <Item key={i} index={i} style={{}} {...rowProps} />
        ))}
      </div>
    );
  },
}));

vi.mock('../PlayerContext.jsx', () => ({
  usePlayer: () => ({
    play: vi.fn(),
    currentTrack: null,
    mediaPort: 19876,
    patchCurrentTrack: vi.fn(),
  }),
}));

globalThis.ResizeObserver =
  globalThis.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// ── Model helpers ─────────────────────────────────────────────────────────────

const dir = (name, base = '/home/user') => ({ path: `${base}/${name}`, name, type: 'dir' });
const file = (name, base = '/home/user/music') => ({
  path: `${base}/${name}`,
  name,
  type: 'file',
});

const labelsOf = (model) => model.entries.filter((e) => e.type === 'item').map((e) => e.label);

// Searches top-level entries and submenu children.
const itemOf = (model, id) => {
  const walk = (entries) => {
    for (const entry of entries) {
      if (entry.type === 'item' && entry.id === id) return entry;
      if (entry.submenu) {
        const found = walk(entry.submenu);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(model.entries);
};

// ── Pure menu-model tests (#502) ──────────────────────────────────────────────

describe('buildExplorerContextMenu - folders', () => {
  it('keeps the singular labels and no header for a single folder', () => {
    const clicked = dir('Alpha');
    const model = buildExplorerContextMenu({
      selection: [clicked],
      clickedItem: clicked,
    });

    expect(model.kind).toBe('folders');
    expect(model.count).toBe(1);
    expect(model.headers).toEqual([]);
    expect(labelsOf(model)).toEqual([
      '⭐ Add to Favourites',
      '📁 Import folder (flat)',
      '📁 Import folder (recursive)',
      '➕ Create playlist (flat)',
      '➕ Create playlist (recursive)',
    ]);
    expect(itemOf(model, 'import-flat').paths).toEqual([clicked.path]);
  });

  it('counts the whole selection and targets every selected folder', () => {
    const dirs = [dir('Alpha'), dir('Beta'), dir('Gamma')];
    const model = buildExplorerContextMenu({
      selection: dirs,
      clickedItem: dirs[1],
    });

    expect(model.count).toBe(3);
    expect(model.headers).toEqual(['3 folders selected']);
    expect(labelsOf(model)).toEqual([
      '⭐ Add 3 to Favourites',
      '📁 Import 3 folders (flat)',
      '📁 Import 3 folders (recursive)',
      '➕ Create 3 playlists (flat)',
      '➕ Create 3 playlists (recursive)',
    ]);
    expect(itemOf(model, 'import-flat').paths).toEqual(dirs.map((d) => d.path));
    expect(itemOf(model, 'import-recursive').paths).toEqual(dirs.map((d) => d.path));
    expect(itemOf(model, 'create-playlist-flat').paths).toEqual(dirs.map((d) => d.path));
    expect(itemOf(model, 'create-playlist-recursive').paths).toEqual(dirs.map((d) => d.path));
  });

  it('splits Add/Remove Favourites into count-aware entries per state', () => {
    const dirs = [dir('Alpha'), dir('Beta'), dir('Gamma')];
    const model = buildExplorerContextMenu({
      selection: dirs,
      clickedItem: dirs[0],
      favourites: [{ path: dirs[2].path, name: 'Gamma' }],
    });

    const add = itemOf(model, 'favourite-add');
    const remove = itemOf(model, 'favourite-remove');
    expect(add.label).toBe('⭐ Add 2 to Favourites');
    expect(add.paths).toEqual([dirs[0].path, dirs[1].path]);
    expect(remove.label).toBe('★ Remove from Favourites');
    expect(remove.paths).toEqual([dirs[2].path]);
  });

  it('offers remap for every selected folder holding broken links', () => {
    const dirs = [dir('Alpha'), dir('Beta'), dir('Gamma')];
    const model = buildExplorerContextMenu({
      selection: dirs,
      clickedItem: dirs[0],
      brokenDirPaths: [dirs[0].path, dirs[2].path],
    });

    const remap = itemOf(model, 'remap-folders');
    expect(remap.label).toBe('🔗 Remap 2 broken folders…');
    expect(remap.paths).toEqual([dirs[0].path, dirs[2].path]);
    expect(remap.disabled).toBeFalsy();
  });

  it('hides the remap entry when no selected folder has broken links', () => {
    const dirs = [dir('Alpha'), dir('Beta')];
    const model = buildExplorerContextMenu({ selection: dirs, clickedItem: dirs[0] });
    expect(itemOf(model, 'remap-folders')).toBeUndefined();
  });

  it('ignores selected files when the clicked row is a folder', () => {
    const dirs = [dir('Alpha'), dir('Beta')];
    const model = buildExplorerContextMenu({
      selection: [...dirs, file('one.mp3'), file('two.mp3')],
      clickedItem: dirs[1],
    });

    expect(model.kind).toBe('folders');
    expect(model.count).toBe(2);
    expect(model.headers).toEqual(['2 folders selected']);
    expect(itemOf(model, 'import-flat').paths).toEqual(dirs.map((d) => d.path));
  });
});

describe('buildExplorerContextMenu - files', () => {
  it('keeps the singular labels and enables single-item actions for one file', () => {
    const clicked = file('one.mp3');
    const model = buildExplorerContextMenu({
      selection: [clicked],
      clickedItem: clicked,
      linkedPaths: [clicked.path],
      playlists: [{ id: 7, name: 'Warmup' }],
    });

    expect(model.kind).toBe('files');
    expect(model.headers).toEqual([]);
    expect(itemOf(model, 'play').disabled).toBeFalsy();
    expect(itemOf(model, 'edit-details').disabled).toBeFalsy();
    expect(itemOf(model, 'prepare-track').disabled).toBeFalsy();
    expect(itemOf(model, 'analysis').disabled).toBeFalsy();
    expect(itemOf(model, 'remove-files').label).toBe('🗑️ Remove file');
    expect(itemOf(model, 'remove-files').paths).toEqual([clicked.path]);
    expect(itemOf(model, 'remove-files').danger).toBe(true);
    expect(itemOf(model, 'playlist-existing').playlistId).toBe(7);
  });

  it('acts on all selected files and disables single-item-only actions', () => {
    const files = [file('one.mp3'), file('two.mp3'), file('three.mp3')];
    const model = buildExplorerContextMenu({
      selection: files,
      clickedItem: files[1],
      playlists: [{ id: 7, name: 'Warmup' }],
    });

    expect(model.headers).toEqual(['3 files selected']);
    const addLibrary = itemOf(model, 'add-to-library');
    expect(addLibrary.label).toBe('➕ Add 3 files to library');
    expect(addLibrary.paths).toEqual(files.map((f) => f.path));

    const playlist = itemOf(model, 'add-to-playlist');
    expect(playlist.label).toBe('➕ Add 3 files to playlist');
    expect(itemOf(model, 'playlist-new').paths).toEqual(files.map((f) => f.path));
    expect(itemOf(model, 'playlist-existing').paths).toEqual(files.map((f) => f.path));

    for (const id of ['play']) {
      expect(itemOf(model, id).disabled).toBe(true);
      expect(itemOf(model, id).disabledReason).toBe(SINGLE_SELECTION_REASON);
    }
    // Edit/analysis surfaces are single-track only: hidden while files differ.
    expect(itemOf(model, 'edit-details')).toBeUndefined();
  });

  it('disables detail/analysis entries for a multi-selection of linked files', () => {
    const files = [file('one.mp3'), file('two.mp3')];
    const model = buildExplorerContextMenu({
      selection: files,
      clickedItem: files[0],
      linkedPaths: files.map((f) => f.path),
    });

    for (const id of ['play', 'edit-details', 'prepare-track', 'analysis']) {
      expect(itemOf(model, id).disabled).toBe(true);
      expect(itemOf(model, id).disabledReason).toBe(SINGLE_SELECTION_REASON);
    }
    expect(itemOf(model, 'remove-files').label).toBe('🗑️ Remove 2 files');
    expect(itemOf(model, 'remove-files').paths).toEqual(files.map((f) => f.path));
    // Disabled parents never expose their submenu.
    expect(itemOf(model, 'analysis').submenu && itemOf(model, 'analysis').disabled).toBe(true);
  });

  it('only offers Add to library for the unlinked part of the selection', () => {
    const files = [file('one.mp3'), file('two.mp3'), file('three.mp3')];
    const model = buildExplorerContextMenu({
      selection: files,
      clickedItem: files[0],
      linkedPaths: [files[0].path],
    });

    const addLibrary = itemOf(model, 'add-to-library');
    expect(addLibrary.label).toBe('➕ Add 2 files to library');
    expect(addLibrary.paths).toEqual([files[1].path, files[2].path]);
    expect(itemOf(model, 'remove-files').paths).toEqual([files[0].path]);
  });

  it('never renders a leading, duplicate or trailing separator', () => {
    const dirs = [dir('Alpha'), dir('Beta')];
    const variants = [
      buildExplorerContextMenu({ selection: dirs, clickedItem: dirs[0] }),
      buildExplorerContextMenu({
        selection: [file('one.mp3')],
        clickedItem: file('one.mp3'),
        linkedPaths: [file('one.mp3').path],
      }),
      buildExplorerContextMenu({
        selection: [file('one.mp3'), file('two.mp3')],
        clickedItem: file('one.mp3'),
      }),
    ];

    for (const model of variants) {
      const types = model.entries.map((e) => e.type);
      expect(types[0]).not.toBe('separator');
      expect(types[types.length - 1]).not.toBe('separator');
      for (let i = 1; i < types.length; i += 1) {
        expect(`${types[i - 1]}|${types[i]}`).not.toBe('separator|separator');
      }
    }
  });

  it('keeps the broken-file remap single-item only', () => {
    const files = [file('one.mp3'), file('two.mp3')];
    const single = buildExplorerContextMenu({
      selection: [files[0]],
      clickedItem: files[0],
      brokenFileMatch: { title: 'Lost Track' },
    });
    expect(itemOf(single, 'remap-track').label).toBe('🔗 Remap “Lost Track” to this file');
    expect(itemOf(single, 'remap-track').disabled).toBeFalsy();

    const multi = buildExplorerContextMenu({
      selection: files,
      clickedItem: files[0],
      brokenFileMatch: { title: 'Lost Track' },
    });
    expect(itemOf(multi, 'remap-track').disabled).toBe(true);
    expect(itemOf(multi, 'remap-track').disabledReason).toBe(SINGLE_SELECTION_REASON);
  });

  it('marks a missing linked file as a disabled informational entry', () => {
    const clicked = file('one.mp3');
    const model = buildExplorerContextMenu({
      selection: [clicked],
      clickedItem: clicked,
      linkedPaths: [clicked.path],
      clickedTrackMissing: true,
    });

    const broken = model.entries.find((e) => e.label === '⚠️ Broken link - file missing');
    expect(broken.disabled).toBe(true);
    expect(broken.id).toBeNull();
    expect(broken.disabledReason).toBe("This track's file is missing from disk");
  });
});

// ── Mounted integration tests ─────────────────────────────────────────────────

const DIRS = ['Alpha', 'Beta', 'Gamma'].map((n) => ({ name: n, path: `/home/user/${n}` }));
const FILES = ['one.mp3', 'two.mp3', 'three.mp3'].map((n) => ({
  name: n,
  path: `/home/user/music/${n}`,
}));

function renderExplorer({ dirs = DIRS, files = [], linkedTracks = [] } = {}) {
  window.api.browseDirectory.mockResolvedValue({ dirs, files });
  window.api.getTracksByPaths.mockResolvedValue(linkedTracks);
  return render(<FileExplorerView />);
}

async function waitForRows(selector, count) {
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(count));
  return [...document.querySelectorAll(selector)];
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('FileExplorerView context menu with a multi-selection (#502)', () => {
  it('shows count-aware folder labels and imports every selected folder', async () => {
    renderExplorer();
    const rows = await waitForRows('.explorer-dir-row', 3);

    // Plain click selects one row, Shift+click extends the range to all three.
    fireEvent.click(rows[0]);
    fireEvent.click(rows[2], { shiftKey: true });
    fireEvent.contextMenu(rows[1]);

    expect(screen.getByText('3 folders selected')).toBeInTheDocument();
    const importFlat = screen.getByText('📁 Import 3 folders (flat)');
    expect(screen.getByText('➕ Create 3 playlists (flat)')).toBeInTheDocument();

    fireEvent.click(importFlat);

    await waitFor(() => expect(window.api.linkDirectory).toHaveBeenCalledTimes(3));
    const called = window.api.linkDirectory.mock.calls.map((c) => c[0]);
    expect(new Set(called)).toEqual(new Set(DIRS.map((d) => d.path)));
    // The menu closes after an action.
    expect(screen.queryByText('3 folders selected')).not.toBeInTheDocument();
  });

  it('creates one playlist per selected folder', async () => {
    renderExplorer();
    const rows = await waitForRows('.explorer-dir-row', 3);

    fireEvent.click(rows[0]);
    fireEvent.click(rows[2], { shiftKey: true });
    fireEvent.contextMenu(rows[2]);
    fireEvent.click(screen.getByText('➕ Create 3 playlists (flat)'));

    await waitFor(() => expect(window.api.createPlaylist).toHaveBeenCalledTimes(3));
    expect(window.api.createPlaylist.mock.calls.map((c) => c[0])).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    await waitFor(() => expect(window.api.linkDirectory).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByText('Created 3 playlists, linked 0/0 tracks')).toBeInTheDocument()
    );
  });

  it('labels a single right-clicked folder in the singular', async () => {
    renderExplorer();
    const rows = await waitForRows('.explorer-dir-row', 3);

    fireEvent.contextMenu(rows[1]);

    expect(screen.queryByText(/folders selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('📁 Import folder (flat)'));
    await waitFor(() => expect(window.api.linkDirectory).toHaveBeenCalledTimes(1));
    expect(window.api.linkDirectory.mock.calls[0][0]).toBe(DIRS[1].path);
  });

  it('keeps file menu actions on all selected files and disables Play', async () => {
    renderExplorer({ dirs: [], files: FILES });
    const rows = await waitForRows('.row:not(.explorer-dir-row)', 3);

    fireEvent.click(rows[0]);
    fireEvent.click(rows[2], { shiftKey: true });
    fireEvent.contextMenu(rows[1]);

    expect(screen.getByText('3 files selected')).toBeInTheDocument();
    const play = screen.getByText('▶ Play').closest('.context-menu-item');
    expect(play.className).toContain('context-menu-item--disabled');
    expect(play.title).toBe(SINGLE_SELECTION_REASON);

    fireEvent.click(screen.getByText('➕ Add 3 files to library'));
    await waitFor(() => expect(window.api.linkAudioFiles).toHaveBeenCalledTimes(1));
    expect(window.api.linkAudioFiles.mock.calls[0][0]).toEqual(FILES.map((f) => f.path));
  });

  it('removes every selected linked file behind one confirmation', async () => {
    const linkedTracks = FILES.map((f, i) => ({
      id: i + 1,
      file_path: f.path,
      is_linked: 1,
      title: f.name,
    }));
    renderExplorer({ dirs: [], files: FILES, linkedTracks });
    const rows = await waitForRows('.row:not(.explorer-dir-row)', 3);
    // Wait for the linked state to land in tracksMap (drives the menu labels).
    await waitFor(() => expect(screen.getAllByTitle('In library')).toHaveLength(3));

    fireEvent.click(rows[0]);
    fireEvent.click(rows[2], { shiftKey: true });
    fireEvent.contextMenu(rows[1]);

    fireEvent.click(screen.getByText('🗑️ Remove 3 files'));
    fireEvent.click(await screen.findByText('Delete 3 files'));
    await waitFor(() => expect(window.api.removeLinkedFile).toHaveBeenCalledTimes(3));
    expect(window.api.removeLinkedFile.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2, 3]);
  });
});
