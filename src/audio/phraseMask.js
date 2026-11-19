import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Name of the cache file that holds the extracted table. */
export const PHRASE_MASK_FILE = 'phrase-mask.json';

/** Length of the phrase table, in characters. */
export const PHRASE_TABLE_LENGTH = 19;

/** Index the encoder starts reading the table from when it builds the key. */
export const PHRASE_TABLE_OFFSET = 14;

/**
 * Fingerprint of the phrase table.
 *
 * The repository carries this digest and never the bytes. Extraction walks the
 * printable strings of the installed rekordbox binary and compares digests, so
 * the table is reproduced on the user's machine from their own licensed copy.
 * The digest is salted with a fixed string so that a public hash lookup of the
 * bare table tells nothing.
 */
export const PHRASE_TABLE_FINGERPRINT =
  '6d0424622ef9e16cd95910f36b98285c20098fb678dc70515b63baa8afac7214';

/** Longest a single printable run may be before the scan gives up on it. */
const MAX_RUN_LENGTH = 4096;

let cachedMask = null;
let cachedTable = null;
let attempted = false;

/**
 * Digest of a candidate table, matched against {@link PHRASE_TABLE_FINGERPRINT}.
 * @param {string} table candidate of {@link PHRASE_TABLE_LENGTH} characters
 * @returns {string} hex digest
 */
export function fingerprintOf(table) {
  return crypto.createHash('sha256').update(`djman-phrase-table:${table}`).digest('hex');
}

/**
 * Whether a string is the phrase table, judged by its digest alone.
 * @param {string} table candidate string
 * @returns {boolean}
 */
export function isPhraseTable(table, fingerprint = PHRASE_TABLE_FINGERPRINT) {
  return (
    typeof table === 'string' &&
    table.length === PHRASE_TABLE_LENGTH &&
    fingerprintOf(table) === fingerprint
  );
}

/**
 * Derive the 19-byte XOR base from the table: the encoder reads the table
 * starting at {@link PHRASE_TABLE_OFFSET} and subtracts 0x80 from every byte.
 * @param {string} table phrase table
 * @returns {Buffer} 19 bytes
 */
export function deriveMask(table) {
  if (typeof table !== 'string' || table.length !== PHRASE_TABLE_LENGTH) {
    throw new Error(`phrase table must be ${PHRASE_TABLE_LENGTH} characters`);
  }
  const mask = Buffer.alloc(PHRASE_TABLE_LENGTH);
  for (let i = 0; i < PHRASE_TABLE_LENGTH; i += 1) {
    mask[i] = (table.charCodeAt((PHRASE_TABLE_OFFSET + i) % PHRASE_TABLE_LENGTH) - 0x80) & 0xff;
  }
  return mask;
}

/**
 * Walk the printable runs of a binary looking for the table.
 *
 * Both narrow and UTF-16LE encodings are covered, because the same constant can
 * be stored either way depending on how the compiler emitted it.
 * @param {Buffer} buffer binary contents
 * @param {{maxCandidates?: number}} [options] cap on digests computed
 * @returns {{table: string, candidates: number}|null}
 */
export function findPhraseTableIn(buffer, options = {}) {
  const maxCandidates = options.maxCandidates ?? 4_000_000;
  const fingerprint = options.fingerprint ?? PHRASE_TABLE_FINGERPRINT;
  let candidates = 0;

  const tryRun = (chars) => {
    for (let off = 0; off + PHRASE_TABLE_LENGTH <= chars.length; off += 1) {
      candidates += 1;
      if (candidates > maxCandidates) return null;
      const slice = chars.slice(off, off + PHRASE_TABLE_LENGTH).join('');
      if (fingerprintOf(slice) === fingerprint) return slice;
    }
    return null;
  };

  const scan = (readChar, step) => {
    let run = [];
    for (let i = 0; i + step <= buffer.length; i += step) {
      const code = readChar(i);
      const printable = code >= 0x20 && code <= 0x7e;
      if (printable && run.length < MAX_RUN_LENGTH) {
        run.push(String.fromCharCode(code));
        continue;
      }
      if (printable) continue;
      if (run.length >= PHRASE_TABLE_LENGTH) {
        const hit = tryRun(run);
        if (hit) return hit;
      }
      run = [];
      if (candidates > maxCandidates) return null;
    }
    if (run.length >= PHRASE_TABLE_LENGTH) return tryRun(run);
    return null;
  };

  const narrow = scan((i) => buffer[i], 1);
  if (narrow) return { table: narrow, candidates };
  const wide = scan((i) => buffer.readUInt16LE(i), 2);
  if (wide) return { table: wide, candidates };
  return null;
}

/**
 * Executables worth scanning on this platform.
 * @param {object} [options]
 * @param {string} [options.platform] process.platform
 * @param {object} [options.env] environment holding the program directories
 * @param {Function} [options.readdir] injectable directory reader
 * @param {Function} [options.exists] injectable existence check
 * @returns {string[]} candidate paths, existing ones only
 */
export function rekordboxExecutables({
  platform = process.platform,
  env = process.env,
  readdir = fs.readdirSync,
  exists = fs.existsSync,
} = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const found = [];
  const add = (file) => {
    if (!file || found.includes(file)) return;
    try {
      if (exists(file)) found.push(file);
    } catch {
      /* an unreadable candidate is simply skipped */
    }
  };
  const list = (dir) => {
    try {
      return readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    for (const root of roots) {
      for (const entry of list(root)) {
        if (!entry?.isDirectory?.() || !/rekordbox/i.test(entry.name)) continue;
        const base = join(root, entry.name);
        add(join(base, 'rekordbox.exe'));
        for (const sub of list(base)) {
          if (sub?.isDirectory?.()) add(join(base, sub.name, 'rekordbox.exe'));
        }
      }
    }
  }

  if (platform === 'darwin') {
    for (const app of ['rekordbox 7', 'rekordbox 6', 'rekordbox']) {
      add(`/Applications/${app}/rekordbox.app/Contents/MacOS/rekordbox`);
    }
  }

  return found;
}

/**
 * Read the first table found in the given binaries.
 * @param {object} [options]
 * @param {string[]} [options.files] binaries to scan, defaults to installed rekordbox
 * @param {Function} [options.readFile] injectable file reader
 * @returns {{table: string, source: string, candidates: number}|null}
 */
export function extractPhraseTable({
  files = rekordboxExecutables(),
  readFile = fs.readFileSync,
  fingerprint = PHRASE_TABLE_FINGERPRINT,
} = {}) {
  for (const file of files) {
    let buffer;
    try {
      buffer = readFile(file);
    } catch {
      continue;
    }
    const hit = findPhraseTableIn(buffer, { fingerprint });
    if (hit) return { table: hit.table, source: file, candidates: hit.candidates };
  }
  return null;
}

/**
 * Path of the cache file inside a user data directory.
 * @param {string} userDataPath directory holding app state
 * @returns {string}
 */
export function phraseMaskPath(userDataPath) {
  return path.join(userDataPath, PHRASE_MASK_FILE);
}

/**
 * Read a cached table, if the file exists and still matches the fingerprint.
 * @param {string} userDataPath directory holding app state
 * @returns {{table: string, source: string, extractedAt?: string}|null}
 */
export function readPhraseMask(userDataPath, { fingerprint = PHRASE_TABLE_FINGERPRINT } = {}) {
  try {
    const raw = fs.readFileSync(phraseMaskPath(userDataPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPhraseTable(parsed?.table, fingerprint)) return null;
    return {
      table: parsed.table,
      source: parsed.source ?? 'cache',
      extractedAt: parsed.extractedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a table so later starts skip the scan.
 * @param {string} userDataPath directory holding app state
 * @param {string} table phrase table
 * @param {string} source where it came from
 * @returns {string} path written
 */
export function writePhraseMask(userDataPath, table, source) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const file = phraseMaskPath(userDataPath);
  const payload = {
    table,
    offset: PHRASE_TABLE_OFFSET,
    fingerprint: PHRASE_TABLE_FINGERPRINT,
    source,
    extractedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

/**
 * Install a table for this process and derive its mask.
 * @param {string} table phrase table
 * @returns {Buffer} derived mask
 */
export function setPhraseMask(table) {
  if (typeof table !== 'string' || table.length !== PHRASE_TABLE_LENGTH) {
    throw new Error(`phrase table must be ${PHRASE_TABLE_LENGTH} characters`);
  }
  cachedTable = table;
  cachedMask = deriveMask(table);
  return cachedMask;
}

/**
 * Drop the in-process table, so the next access reports it as unavailable.
 */
export function clearPhraseMask() {
  cachedMask = null;
  cachedTable = null;
  attempted = false;
}

/**
 * The mask for this process, or null when no table was installed or extracted.
 * @returns {Buffer|null}
 */
export function getPhraseMask() {
  return cachedMask;
}

/**
 * Make a mask available for this process: from the cache file, else from the
 * installed rekordbox, else nothing. Runs at most once per process.
 * @param {object} options
 * @param {string} options.userDataPath directory holding app state
 * @param {string[]} [options.files] binaries to scan instead of the installed ones
 * @returns {{table: string, mask: Buffer, source: string}|null}
 */
export function ensurePhraseMask({ userDataPath, files, fingerprint } = {}) {
  if (cachedMask) return { table: cachedTable, mask: cachedMask, source: 'memory' };
  if (attempted || !userDataPath) return null;
  attempted = true;

  const cached = readPhraseMask(userDataPath, { fingerprint });
  if (cached) {
    return { table: cached.table, mask: setPhraseMask(cached.table), source: cached.source };
  }

  const extracted = extractPhraseTable(files ? { files, fingerprint } : { fingerprint });
  if (!extracted) return null;
  setPhraseMask(extracted.table);
  try {
    writePhraseMask(userDataPath, extracted.table, extracted.source);
  } catch {
    /* a cache that cannot be written still leaves the mask usable */
  }
  return { table: extracted.table, mask: cachedMask, source: extracted.source };
}
