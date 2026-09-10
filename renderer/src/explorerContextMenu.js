/**
 * Pure menu-model builder for the File Explorer context menu.
 *
 * The Explorer keeps its multi-selection when an already-selected row is
 * right-clicked, so every label and every action target must be derived from
 * the whole selection instead of the clicked row alone.
 *
 * Rules implemented here:
 * - actions that can be applied per item (import, create playlist, add to
 *   favourites, remap, add to library/playlist, remove file) target EVERY
 *   selected item of the matching kind, with count-aware wording;
 * - actions that only make sense on one item (play, edit details, prepare
 *   track, analysis, remap-this-file) are rendered disabled with a
 *   "<N> folders selected" / "<N> files selected" header for N > 1, so they
 *   never silently act on the clicked row only.
 *
 * Entries are plain data so the component renders straight from the model:
 *   { type: 'separator' }
 *   { type: 'header', label }
 *   { type: 'item', id, label, paths, disabled, disabledReason, danger,
 *     title, color, playlistId, submenu }
 * An item is clickable only when it has an `id` and is not disabled.
 */

/** Reason attached to entries that only support a single-item selection. */
export const SINGLE_SELECTION_REASON = 'Available for a single selection only';

function countPhrase(n, singular, plural) {
  return n === 1 ? singular : plural;
}

/**
 * Build the context menu model.
 *
 * @param {object} args
 * @param {Array<{path: string, name: string, type: 'dir'|'file'}>} args.selection
 *   every currently selected item (the clicked one included)
 * @param {{path: string, name: string, type: 'dir'|'file'}} args.clickedItem
 *   the right-clicked row
 * @param {Array<{path: string}>} [args.favourites] saved favourite folders
 * @param {string[]} [args.linkedPaths] selected file paths that are linked tracks
 * @param {string[]} [args.brokenDirPaths] selected dirs holding broken links
 * @param {{title: string}|null} [args.brokenFileMatch] broken track matching the clicked file name
 * @param {boolean} [args.clickedTrackMissing] clicked file is a linked track with a missing file
 * @param {Array<{id: number|string, name: string, color?: string}>} [args.playlists]
 * @returns {{kind: 'folders'|'files', count: number, headers: string[], entries: Array<object>}}
 */
export function buildExplorerContextMenu({
  selection = [],
  clickedItem = null,
  favourites = [],
  linkedPaths = [],
  brokenDirPaths = [],
  brokenFileMatch = null,
  clickedTrackMissing = false,
  playlists = [],
} = {}) {
  const isDirMenu = clickedItem?.type === 'dir';
  const ofType = selection.filter((i) => i.type === (isDirMenu ? 'dir' : 'file'));
  // The clicked row is always part of the selection (handleContextMenu keeps an
  // existing multi-selection), but fall back to it if it somehow is not.
  const targets = ofType.length ? ofType : clickedItem ? [clickedItem] : [];
  const paths = targets.map((t) => t.path);
  const n = paths.length;
  const single = n === 1;

  const entries = [];
  let sepPending = false;
  const sep = () => {
    sepPending = true;
  };
  const add = (entry) => {
    if (sepPending && entries.length && entries[entries.length - 1].type !== 'separator') {
      entries.push({ type: 'separator' });
    }
    sepPending = false;
    entries.push(entry);
  };
  const item = (id, label, targetPaths, extra = {}) =>
    add({ type: 'item', id, label, paths: targetPaths, ...extra });

  const headers = [];
  if (!single) {
    const label = isDirMenu ? `${n} folders selected` : `${n} files selected`;
    headers.push(label);
    add({ type: 'header', label });
  }

  if (isDirMenu) {
    const favPaths = new Set(favourites.map((f) => f.path));
    const notFav = paths.filter((p) => !favPaths.has(p));
    const fav = paths.filter((p) => favPaths.has(p));

    if (notFav.length) {
      item(
        'favourite-add',
        `⭐ Add ${countPhrase(notFav.length, 'to Favourites', `${notFav.length} to Favourites`)}`,
        notFav
      );
    }
    if (fav.length) {
      item(
        'favourite-remove',
        `★ Remove ${countPhrase(fav.length, 'from Favourites', `${fav.length} from Favourites`)}`,
        fav
      );
    }

    sep();
    item(
      'import-flat',
      `📁 Import ${countPhrase(n, 'folder (flat)', `${n} folders (flat)`)}`,
      paths
    );
    item(
      'import-recursive',
      `📁 Import ${countPhrase(n, 'folder (recursive)', `${n} folders (recursive)`)}`,
      paths
    );

    sep();
    item(
      'create-playlist-flat',
      `➕ Create ${countPhrase(n, 'playlist (flat)', `${n} playlists (flat)`)}`,
      paths
    );
    item(
      'create-playlist-recursive',
      `➕ Create ${countPhrase(n, 'playlist (recursive)', `${n} playlists (recursive)`)}`,
      paths
    );

    if (brokenDirPaths.length) {
      sep();
      item(
        'remap-folders',
        `🔗 Remap ${countPhrase(brokenDirPaths.length, 'broken folder…', `${brokenDirPaths.length} broken folders…`)}`,
        brokenDirPaths
      );
    }

    return { kind: 'folders', count: n, headers, entries };
  }

  // ── File menu ──────────────────────────────────────────────────────────────
  const linkedSet = new Set(linkedPaths);
  const unlinked = paths.filter((p) => !linkedSet.has(p));
  const linked = paths.filter((p) => linkedSet.has(p));

  if (unlinked.length) {
    item(
      'add-to-library',
      `➕ Add ${countPhrase(unlinked.length, 'to library', `${unlinked.length} files to library`)}`,
      unlinked
    );
    sep();
  }

  // A submenu parent is never clickable on its own; it only hosts its children.
  add({
    type: 'item',
    id: 'add-to-playlist',
    label: `➕ Add ${countPhrase(n, 'to playlist', `${n} files to playlist`)}`,
    paths,
    submenu: [
      { type: 'item', id: 'playlist-new', label: '✚ New playlist…', paths },
      ...(playlists.length ? [{ type: 'separator' }] : []),
      ...playlists.map((pl) => ({
        type: 'item',
        id: 'playlist-existing',
        label: pl.name,
        color: pl.color,
        playlistId: pl.id,
        paths,
      })),
    ],
  });

  sep();
  item('play', '▶ Play', paths, {
    disabled: !single,
    disabledReason: SINGLE_SELECTION_REASON,
  });

  // Detail editing / analysis always open a single-track surface, so for a
  // multi-selection they stay visible but disabled (never act on one row).
  if (linked.length === n && n > 0) {
    sep();
    item('edit-details', '✏️ Edit Details', paths, {
      disabled: !single,
      disabledReason: SINGLE_SELECTION_REASON,
    });
    item('prepare-track', '🎛 Prepare Track…', paths, {
      disabled: !single,
      disabledReason: SINGLE_SELECTION_REASON,
    });
    add({
      type: 'item',
      id: 'analysis',
      label: '🔬 Analysis',
      paths,
      disabled: !single,
      disabledReason: SINGLE_SELECTION_REASON,
      submenu: [
        { type: 'item', id: 'reanalyze', label: '🔄 Re-analyze', paths },
        { type: 'separator' },
        { type: 'item', id: 'normalize', label: '🔊 Normalize', paths },
      ],
    });
  }

  if (brokenFileMatch || clickedTrackMissing) {
    sep();
    if (brokenFileMatch) {
      item('remap-track', `🔗 Remap “${brokenFileMatch.title}” to this file`, paths, {
        disabled: !single,
        disabledReason: SINGLE_SELECTION_REASON,
        title: `Remap broken track: ${brokenFileMatch.title}`,
      });
    }
    if (clickedTrackMissing) {
      add({
        type: 'item',
        id: null,
        label: '⚠️ Broken link - file missing',
        paths,
        disabled: true,
        disabledReason: "This track's file is missing from disk",
      });
    }
  }

  if (linked.length) {
    sep();
    item(
      'remove-files',
      `🗑️ Remove ${countPhrase(linked.length, 'file', `${linked.length} files`)}`,
      linked,
      { danger: true }
    );
  }

  return { kind: 'files', count: n, headers, entries };
}
