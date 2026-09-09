import { useEffect, useMemo, useState } from 'react';
import './HelpView.css';

/**
 * In-app manual. Content lives in SECTIONS (title + item list) plus a
 * SHORTCUTS table. The search box filters sections/items/shortcuts live, so
 * "find stuff quickly" works by typing any keyword (e.g. "camelot", "gain",
 * "cookies", "rekordbox").
 */

const SECTIONS = [
  {
    title: 'Library management',
    keywords: 'import link move library files folders storage',
    items: [
      'The Music view lists every track of your library. The picker above the list switches between libraries when you have more than one.',
      'Import adds files into the library by copying them into the managed storage folder. Link references files in place instead of copying (handy for network or shared folders).',
      'Right-click a track or a multi-selection for actions: Edit Details, Set BPM, Reset gain, add to playlist, Move to library (with multiple libraries) and more.',
      'Click column headers to sort. Columns can be shown/hidden and reordered from the columns menu.',
      'BPM can be overridden manually per track (Set BPM); overridden values and beat-grid shifts are marked with a dot in the BPM column.',
      'Use the eye icon to hide unavailable tracks (e.g. linked files on a disconnected drive are grayed out instead).',
    ],
  },
  {
    title: 'Search',
    keywords: 'find filter query bpm key genre artist album year loudness syntax',
    items: [
      'The search box accepts plain text plus field-qualified filters, e.g.: GENRE is Techno AND BPM in range 130-140 AND KEY adjacent 8A.',
      'Supported concepts: GENRE is ..., BPM in range a-b / BPM > n, KEY (Camelot, e.g. 8A) with same/adjacent matching, YEAR, ARTIST, ALBUM, TITLE and loudness ranges.',
      'Combine conditions with AND; the parsed query is shown as colored chips under the search box, so you can see exactly what matched.',
      'Search applies to the current view: the whole library on Music, only that playlist inside a playlist, only cloud results in Cloud Search.',
    ],
  },
  {
    title: 'Track details & auto-tag',
    keywords: 'edit details save cover art deezer tag autotag pin bulk',
    items: [
      'Open the Details panel for one track with Enter/E, double-click, or right-click → Edit Details. Select several tracks to edit them in bulk ("Edit N Tracks").',
      'The panel follows your selection: pick another single track and it switches to it; select multiple and it switches to bulk editing. A pin button keeps the panel on one track; unsaved edits ask before switching.',
      'Save writes title, artist, album, label, year, genres, rating and BPM to the database. Edit Details on multiple tracks saves only the fields you fill.',
      'Auto-tag (🔍) looks the track up on Deezer: pick a result and Apply writes the fields AND downloads the cover art immediately - there is no extra Save step.',
      'The right side of the row shows rating, BPM/key and loudness (LUFS). Reset gain re-analyzes the track for automatic gain on export.',
    ],
  },
  {
    title: 'Cue points & beat grid',
    keywords: 'prepare track waveform grid hot cue memory nudge tap bpm zoom',
    items: [
      'Click a track cue column or use "Prepare Track" to open the Beat Grid Editor.',
      'Nudge the grid with the arrow keys (Shift = bigger step) or drag the waveform; set BPM with the field or tap T to tap the tempo.',
      'Add, rename and delete hot cues and memory cues directly on the detail waveform.',
      'Space plays/pauses while editing, +/= and - zoom the waveform, Enter applies and closes.',
      'Cues, grid and BPM are written to USB exports so Rekordbox sees them on CDJs.',
    ],
  },
  {
    title: 'Player',
    keywords: 'play pause next previous volume mute shuffle repeat queue history seek',
    items: [
      'The transport lives in the bottom bar: play/pause (Space also works), previous/next, shuffle and repeat (green = on).',
      'The volume icon opens a vertical slider on hover; clicking the icon mutes/unmutes. Output devices can be switched next to it.',
      'Click anywhere on the waveform to seek. The bar can be made taller by dragging its top edge; drag the thin separators to re-balance the zones.',
      'The clock icon opens playback history. Clicking the track title jumps to the playlist the track belongs to; clicking the artist searches for that artist.',
      'Media keys of your OS (play/pause/next/previous) control the player as well.',
    ],
  },
  {
    title: 'Playlists',
    keywords: 'create rename color delete m3u export order drag',
    items: [
      'Create a playlist with the + button above the playlist list; type the name and press Enter.',
      'Right-click a playlist to rename, color-code, export (M3U/playlist file or Rekordbox USB) or delete it.',
      'Drag library rows onto a playlist to add tracks; drag playlist rows to reorder them manually (auto order until you do).',
      'Playing from a playlist marks the current track there; the player bar title then jumps back to that playlist.',
    ],
  },
  {
    title: 'Cloud search & downloads',
    keywords: 'youtube yt-dlp tidal tdn download cloud search cookies quality',
    items: [
      'Cloud Search looks up tracks on YouTube and TIDAL. Pick the source and type, search, select results and download them into the library with per-track progress.',
      'TIDAL downloads need one login: the TIDAL tab shows a device-link code to open in your browser (OAuth session is stored locally).',
      'You can also paste a direct YouTube or TIDAL URL (track, album, playlist or mix) to download that whole item.',
      'If YouTube downloads fail with 403/private errors, set the browser/profile for yt-dlp cookies in Settings and make sure the browser profile is logged in.',
      'Downloads appear in the downloads view with status per track; already-downloaded items are skipped to avoid duplicates.',
    ],
  },
  {
    title: 'Explorer & linked files',
    keywords: 'filesystem drives usb folder link reference unavailable',
    items: [
      'Explorer browses the filesystem: pick a folder with audio to link it, or select files/folders to add to the library (Ctrl+A selects all files in the folder).',
      'Removable drives are listed separately, which makes USB workflow quick. Linked tracks on a disconnected drive show as unavailable rather than disappearing.',
      'Tracks remember their source URL (YouTube/TIDAL) so a linked file can be re-downloaded or traced back to its origin.',
    ],
  },
  {
    title: 'USB export (Rekordbox)',
    keywords: 'usb stick drive rekordbox cdj export playlist format pdb',
    items: [
      'Export a single playlist or the whole library to a Rekordbox-compatible USB drive from the playlist context menu or the Export dialog.',
      'Only removable drives are offered as targets, so internal disks can never be overwritten by accident. Drives must be FAT32/exFAT (Rekordbox format).',
      'The export writes cue points, beat grid, BPM and automatic gain so CDJs (e.g. CDJ-3000) load the track ready to mix.',
      'Exporting again to a drive that already has the playlist reuses the existing path/name instead of creating duplicates.',
      'A supported format action is available for USB sticks that need a fresh Rekordbox layout.',
    ],
  },
  {
    title: 'Settings',
    keywords:
      'deps ffmpeg analyzer yt-dlp cookies browser normalize lufs gain libraries storage format zoom',
    items: [
      'First launch downloads the needed tools (FFmpeg, analyzer, yt-dlp, tidal-dl-ng) - the overlay shows the steps and a readable log, then waits for you to close it.',
      'Settings shows the real installed versions and can update all dependencies; "Clear all data" wipes the managed download area.',
      'Normalization target (LUFS) sets the loudness used for gain analysis and export.',
      'Cookies for YouTube downloads: choose browser + profile (must be logged in) so private/age-restricted videos download.',
      'Manage libraries here: add, rename, convert storage format (hashed paths vs plain) between libraries.',
      'Ctrl + scroll or Ctrl + +/- zooms the whole interface; Ctrl+0 resets to 100%.',
    ],
  },
];

const SHORTCUTS = [
  { keys: ['Space'], what: 'Play / pause (not while typing in a field)' },
  { keys: ['Enter', 'E'], what: 'Open Details for the selected track' },
  { keys: ['Esc'], what: 'Close Details panel, context menu or dialog' },
  { keys: ['Ctrl', 'A'], what: 'Select all tracks (library) or all files (Explorer)' },
  { keys: ['Ctrl', '+'], what: 'Zoom in (also Ctrl + scroll up)' },
  { keys: ['Ctrl', '-'], what: 'Zoom out (also Ctrl + scroll down)' },
  { keys: ['Ctrl', '0'], what: 'Reset zoom to 100%' },
  { keys: ['←', '→'], what: 'Beat Grid Editor: nudge grid (Shift = 10x step)' },
  { keys: ['T'], what: 'Beat Grid Editor: tap tempo' },
  { keys: ['Space'], what: 'Beat Grid Editor: play/pause' },
  { keys: ['+', '−'], what: 'Beat Grid Editor: zoom waveform' },
  { keys: ['Enter'], what: 'Beat Grid Editor: apply & close (also confirms dialogs)' },
];

export default function HelpView({ style, active = false, onClose }) {
  const [query, setQuery] = useState('');

  // Esc closes the manual while it is visible.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  const q = query.trim().toLowerCase();
  const { sections, shortcutCount, totalHits } = useMemo(() => {
    const visible = (items, extra) =>
      !q ||
      items.some((i) => i.toLowerCase().includes(q)) ||
      (extra || '').toLowerCase().includes(q);
    const sections = SECTIONS.map((s) => ({
      ...s,
      items: q ? s.items.filter((i) => i.toLowerCase().includes(q)) : s.items,
    })).filter((s) => !q || visible(s.items, s.keywords));
    const shortcuts = q ? SHORTCUTS.filter((s) => s.what.toLowerCase().includes(q)) : SHORTCUTS;
    return {
      sections,
      shortcutCount: shortcuts.length,
      totalHits:
        sections.reduce((n, s) => n + s.items.length, 0) +
        shortcuts.length +
        (sections.length ? 1 : 0),
    };
  }, [q]);

  const nothingVisible = q && totalHits === 0;

  return (
    <div className="help-view" style={style}>
      <div className="help-view__inner">
        <div className="help-view__head">
          <h1 className="help-view__title">Help</h1>
          {onClose && (
            <button
              type="button"
              className="help-view__close"
              onClick={onClose}
              title="Close help"
              aria-label="Close help"
            >
              ✕
            </button>
          )}
        </div>

        <div className="help-view__toolbar">
          <input
            type="search"
            className="help-view__search"
            placeholder="Search the manual (e.g. gain, camelot, cookies, usb)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the manual"
          />
          {q && (
            <button
              type="button"
              className="help-view__clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              Clear
            </button>
          )}
        </div>

        {nothingVisible && (
          <p className="help-view__none">No help entries match &quot;{query}&quot;.</p>
        )}

        {sections.map((section) => (
          <section className="help-view__section" key={section.title}>
            <h2 className="help-view__section-title">{section.title}</h2>
            <ul className="help-view__list">
              {section.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </section>
        ))}

        {(!q || shortcutCount > 0) && (
          <section className="help-view__section help-view__shortcuts">
            <h2 className="help-view__section-title">Keyboard shortcuts</h2>
            <table className="help-view__keys">
              <tbody>
                {(q ? SHORTCUTS.filter((s) => s.what.toLowerCase().includes(q)) : SHORTCUTS).map(
                  (s, i) => (
                    <tr key={i}>
                      <td className="help-view__keys-keys">
                        {s.keys.map((k) => (
                          <kbd key={k} className="help-view__kbd">
                            {k}
                          </kbd>
                        ))}
                      </td>
                      <td className="help-view__keys-what">{s.what}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
