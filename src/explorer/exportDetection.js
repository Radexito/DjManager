import fs from 'node:fs';
import { toCamelot } from '../audio/keyUtils.js';
import path from 'node:path';

/**
 * Read-only detection of DJ-software exports on a drive (#504).
 *
 * Every function here inspects the filesystem with stat/readdir/readFile only.
 * Nothing in this module writes, renames or deletes anything - the drive is
 * never modified, so a plugged-in stick can be browsed safely.
 *
 * Detection signatures (per software):
 *   Rekordbox  - {root}/PIONEER/rekordbox/export.pdb, plus DEVSETTING.DAT /
 *                MYSETTING.DAT at the stick root. Counts come from DjManager's
 *                own {root}/PIONEER/rekordbox/export-manifest.json when present.
 *   Serato     - {root}/_Serato_ folder. Playlist count comes from the .crate
 *                files in _Serato_/Subcrates (cheap, filename level only).
 *   Engine DJ  - {root}/Engine Library folder.
 *   Traktor    - {root}/Traktor folder.
 *
 * Track counts for Serato / Engine DJ / Traktor need real database/collection
 * parsers that do not exist yet, so they are reported as null (not parsed yet)
 * rather than guessed. Only the Rekordbox manifest is parsed here.
 */

const REKORDBOX = 'rekordbox';
const SERATO = 'serato';
const ENGINE_DJ = 'engine-dj';
const TRAKTOR = 'traktor';

function isDirectory(fsImpl, p) {
  try {
    return fsImpl.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(fsImpl, p) {
  try {
    return fsImpl.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Directory entry names (non-recursive). Returns [] when unreadable. */
function listNames(fsImpl, p) {
  try {
    return fsImpl.readdirSync(p);
  } catch {
    return [];
  }
}

/** Parsed JSON file, or null when missing/corrupt. Never throws. */
function readJson(fsImpl, p) {
  try {
    return JSON.parse(fsImpl.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Parses DjManager's own export manifest into playlist entries with their
 * tracks resolved. Returns null when the manifest is absent or corrupt.
 */
function readRekordboxManifest(root, fsImpl) {
  const manifestPath = path.join(root, 'PIONEER', 'rekordbox', 'export-manifest.json');
  const data = readJson(fsImpl, manifestPath);
  if (!data || typeof data !== 'object') return null;

  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const playlists = Array.isArray(data.playlists) ? data.playlists : [];
  const tracksById = new Map(tracks.map((t) => [t.id, t]));

  /** One manifest track, in the shape the rest of the app reads tracks in. */
  const toTrack = (t) => ({
    id: t.id,
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    duration: Number.isFinite(Number(t.duration)) ? Number(t.duration) : null,
    bpm: Number.isFinite(Number(t.bpm)) ? Number(t.bpm) : null,
    key: t.key_raw || t.key || '',
    key_camelot: camelotFromText(t.key_raw || t.key || ''),
    file_path: t.file_path || '',
    // The manifest stores paths relative to the export root ('/music/...'), so a
    // mounted export can be imported or previewed without guessing.
    absolute_path: t.file_path ? path.join(root, t.file_path) : '',
  });

  const entries = playlists.map((pl) => {
    const trackIds = Array.isArray(pl.track_ids) ? pl.track_ids : [];
    const resolved = trackIds
      .map((id) => tracksById.get(id))
      .filter(Boolean)
      .map(toTrack);
    return {
      id: pl.id,
      name: pl.name || 'Untitled playlist',
      trackCount: resolved.length,
      tracks: resolved,
    };
  });

  return {
    trackCount: tracks.length,
    playlists: playlists.length,
    entries,
    tracks: tracks.map(toTrack),
  };
}

/**
 * Detects DJ-software exports present at `root`.
 *
 * @param {string} root drive root to inspect (e.g. 'E:\\' or '/media/stick')
 * @param {{existsSync?: Function, statSync: Function, readdirSync: Function,
 *          readFileSync: Function}} [fsImpl] injectable filesystem (default node:fs)
 * @returns {Array<{software: string, label: string, path: string, parsed: boolean,
 *   trackCount: number|null, playlists: number|null,
 *   entries: Array<{id: any, name: string, trackCount: number, tracks: Array}>,
 *   note: string|null}>} stable order: Rekordbox, Serato, Engine DJ, Traktor
 */
export function detectExports(root, fsImpl = fs) {
  if (typeof root !== 'string' || root.length === 0) return [];
  const results = [];

  // ── Rekordbox (CDJ/XDJ sticks) ────────────────────────────────────────────
  const rekordboxDir = path.join(root, 'PIONEER', 'rekordbox');
  const pdbPath = path.join(rekordboxDir, 'export.pdb');
  const hasPdb = isFile(fsImpl, pdbPath);
  const hasDeviceSetting = isFile(fsImpl, path.join(root, 'DEVSETTING.DAT'));
  const hasMySetting = isFile(fsImpl, path.join(root, 'MYSETTING.DAT'));

  if (hasPdb || hasDeviceSetting || hasMySetting) {
    // Our own export (or a stick another tool prepared) - the manifest is the
    // only thing readable without a full DeviceSQL PDB parser.
    const manifest = readRekordboxManifest(root, fsImpl);
    results.push({
      software: REKORDBOX,
      label: 'Rekordbox',
      path: hasPdb ? pdbPath : rekordboxDir,
      parsed: Boolean(manifest),
      trackCount: manifest ? manifest.trackCount : null,
      playlists: manifest ? manifest.playlists : null,
      entries: manifest ? manifest.entries : [],
      tracks: manifest ? manifest.tracks : [],
      note: manifest
        ? null
        : 'Track and playlist counts need a Rekordbox PDB parser (not implemented yet).',
    });
  }

  // ── Serato ────────────────────────────────────────────────────────────────
  const seratoDir = path.join(root, '_Serato_');
  if (isDirectory(fsImpl, seratoDir)) {
    // Each .crate file is one crate/playlist. Crate contents are binary, so the
    // track count is not derivable here.
    const subcratesDir = path.join(seratoDir, 'Subcrates');
    const hasSubcrates = isDirectory(fsImpl, subcratesDir);
    const crateCount = hasSubcrates
      ? listNames(fsImpl, subcratesDir).filter((n) => String(n).toLowerCase().endsWith('.crate'))
          .length
      : null;
    results.push({
      software: SERATO,
      label: 'Serato',
      path: seratoDir,
      parsed: false,
      trackCount: null,
      playlists: crateCount,
      entries: [],
      note: 'Track listing needs a Serato database parser (not implemented yet).',
    });
  }

  // ── Engine DJ ─────────────────────────────────────────────────────────────
  const engineDir = path.join(root, 'Engine Library');
  if (isDirectory(fsImpl, engineDir)) {
    results.push({
      software: ENGINE_DJ,
      label: 'Engine DJ',
      path: engineDir,
      parsed: false,
      trackCount: null,
      playlists: null,
      entries: [],
      note: 'Track listing needs an Engine DJ database parser (not implemented yet).',
    });
  }

  // ── Traktor ───────────────────────────────────────────────────────────────
  const traktorDir = path.join(root, 'Traktor');
  if (isDirectory(fsImpl, traktorDir)) {
    results.push({
      software: TRAKTOR,
      label: 'Traktor',
      path: traktorDir,
      parsed: false,
      trackCount: null,
      playlists: null,
      entries: [],
      note: 'Track listing needs a Traktor NML parser (not implemented yet).',
    });
  }

  return results;
}

/**
 * The manifest stores the key as text ('F# minor'), while the library and the
 * rest of the Explorer store and show Camelot ('11A'). Convert on the way in so
 * an export reads the same as everything else (#504).
 *
 * @param {string} key
 * @returns {string|null}
 */
export function camelotFromText(key) {
  const text = String(key ?? '').trim();
  if (!text) return null;
  if (/^([1-9]|1[0-2])[ab]$/i.test(text)) return text.toUpperCase();

  const match = /^([A-G][#b]?)\s*(.*)$/.exec(text);
  if (!match) return null;
  return toCamelot(match[1], /min/i.test(match[2]) ? 'minor' : 'major') ?? null;
}

/**
 * Walks up from `startDir` looking for a DJ-software export, nearest first.
 *
 * The Explorer calls this for the folder a user actually opened: opening the
 * export folder itself or any folder inside it should offer the same library
 * view, and a stick's export is often a level or two below its mount point.
 *
 * @param {string} startDir directory to inspect, then its parents
 * @param {{maxDepth?: number, fsImpl?: object}} [opts] maxDepth defaults to 6
 * @returns {{root: string, exports: object[]}|null} null when nothing is found
 */
export function findExportRoot(startDir, { maxDepth = 6, fsImpl = fs } = {}) {
  if (typeof startDir !== 'string' || startDir.length === 0) return null;
  let current = startDir;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const exports = detectExports(current, fsImpl);
    if (exports.length > 0) return { root: current, exports };
    const parent = path.dirname(current);
    if (!parent || parent === current) return null;
    current = parent;
  }
  return null;
}
