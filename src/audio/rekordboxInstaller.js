import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { findPhraseTableIn } from './phraseMask.js';

/** Page that publishes the current rekordbox downloads. */
export const INSTALLER_PAGE_URL = 'https://rekordbox.com/en/download/';

/** Installer used when the download page cannot be read. */
export const PINNED_INSTALLER_URL =
  'https://cdn.rekordbox.com/files/20260914104659/Install_rekordbox_x64_7_2_19.zip';

/**
 * Official 7-Zip builds fetched when the system has none.
 *
 * Every entry is pinned to a digest and to the version it comes from, so a
 * changed upstream file is rejected instead of executed. Linux and macOS ship a
 * standalone `7zz`; Windows only publishes an installer, which runs silently
 * into the app's own bin directory and needs no administrator rights.
 */
export const SEVEN_ZIP = Object.freeze({
  linux: Object.freeze({
    url: 'https://www.7-zip.org/a/7z2301-linux-x64.tar.xz',
    sha256: '23babcab045b78016e443f862363e4ab63c77d75bc715c0b3463f6134cbcf318',
    kind: 'tar.xz',
    member: '7zz',
  }),
  darwin: Object.freeze({
    url: 'https://www.7-zip.org/a/7z2301-mac.tar.xz',
    sha256: '343eae9ccbbd8f68320adaaa3c87e0244cf39fad0fbec6b9d2cd3e5b0f8a5fbf',
    kind: 'tar.xz',
    member: '7zz',
  }),
  win32: Object.freeze({
    url: 'https://www.7-zip.org/a/7z2301-x64.exe',
    sha256: '26cb6e9f56333682122fafe79dbcdfd51e9f47cc7217dccd29ac6fc33b5598cd',
    kind: 'nsis-installer',
    member: '7z.exe',
  }),
});

/** Where a provisioned extractor ends up, given the app's bin directory. */
export function provisionedPath(binDir, platform = process.platform) {
  if (!binDir) return null;
  return platform === 'win32'
    ? path.join(binDir, '7zip', '7z.exe')
    : path.join(binDir, SEVEN_ZIP[platform]?.member ?? '7zz');
}

/** Environment variable that points at a copy the user already has. */
export const EXE_ENV = 'DJMANAGER_REKORDBOX_FILE';

/** Environment variable that overrides the installer URL. */
export const URL_ENV = 'DJMANAGER_REKORDBOX_URL';

/** Refuse anything implausibly large for an installer. */
const MAX_INSTALLER_BYTES = 3 * 1024 * 1024 * 1024;

/** Name of the file inside the installer that carries the phrase table. */
const TARGET_MEMBER = 'rekordbox.exe';

/**
 * Which setup engine produced an installer, judged by the strings it carries.
 * @param {Buffer} head first megabytes of the installer
 * @returns {'nsis'|'inno'|'unknown'}
 */
export function sniffInstaller(head) {
  const text = head.toString('latin1');
  if (text.includes('NullsoftInst')) return 'nsis';
  if (text.includes('Inno Setup')) return 'inno';
  return 'unknown';
}

/**
 * Read the current installer link off the download page.
 * @param {object} [options]
 * @param {object} [options.env] environment, checked for an override first
 * @param {Function} [options.fetchText] injectable page fetcher
 * @returns {Promise<{url: string, source: string}>}
 */
export async function resolveInstallerUrl({ env = process.env, fetchText = fetchPage } = {}) {
  const override = env[URL_ENV];
  if (override) return { url: override, source: 'environment' };
  try {
    const page = await fetchText(INSTALLER_PAGE_URL);
    const match = page.match(/data-url="(https:\/\/cdn\.rekordbox\.com\/[^"]+x64[^"]*\.zip)"/i);
    if (match) return { url: match[1], source: 'download page' };
  } catch {
    /* fall through to the pinned link */
  }
  return { url: PINNED_INSTALLER_URL, source: 'pinned' };
}

/**
 * Fetch a page as text.
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      https
        .get(target, { headers: { 'User-Agent': 'Mozilla/5.0 djman' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return follow(new URL(res.headers.location, target).toString(), hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(body));
          res.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

/**
 * Download a file to disk, following redirects and reporting progress.
 * @param {string} url
 * @param {string} dest
 * @param {{onProgress?: Function, maxBytes?: number}} [options]
 * @returns {Promise<{bytes: number}>}
 */
export function downloadToFile(url, dest, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_INSTALLER_BYTES;
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const follow = (target, hops = 0) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      https
        .get(target, { headers: { 'User-Agent': 'djman-installer-fetch' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return follow(new URL(res.headers.location, target).toString(), hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}: ${target}`));
          }
          const total = Number(res.headers['content-length'] ?? 0);
          if (total > maxBytes) {
            res.resume();
            return reject(new Error(`installer is larger than expected (${total} bytes)`));
          }
          let received = 0;
          const out = fs.createWriteStream(dest);
          res.on('data', (chunk) => {
            received += chunk.length;
            if (received > maxBytes) {
              res.destroy();
              out.destroy();
              return reject(new Error('installer is larger than expected'));
            }
            options.onProgress?.(received, total);
          });
          res.pipe(out);
          out.on('finish', () => resolve({ bytes: received }));
          out.on('error', reject);
          res.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

/**
 * A usable 7-Zip executable: the system one, else one provisioned earlier.
 * @param {object} [options]
 * @param {string} options.binDir directory holding a provisioned copy
 * @param {Function} [options.which] injectable lookup
 * @param {Function} [options.exists] injectable existence check
 * @param {string} [options.platform] process.platform
 * @returns {{command: string, source: string}|null}
 */
export function findExtractor({
  binDir,
  which = defaultWhich,
  exists = fs.existsSync,
  platform = process.platform,
} = {}) {
  const provisioned = provisionedPath(binDir, platform);
  if (provisioned && exists(provisioned)) return { command: provisioned, source: 'provisioned' };

  const names = platform === 'win32' ? ['7z.exe', '7za.exe'] : ['7z', '7za', '7zz'];
  for (const name of names) {
    const found = which(name);
    if (found) return { command: found, source: 'system' };
  }

  if (platform === 'win32') {
    const standard = 'C:\\Program Files\\7-Zip\\7z.exe';
    if (exists(standard)) return { command: standard, source: 'system' };
  }
  return null;
}

/**
 * Look a command up on PATH.
 * @param {string} name
 * @returns {string|null}
 */
function defaultWhich(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) return null;
  const first = String(probe.stdout)
    .split(/\r?\n/)
    .find((line) => line.trim());
  return first ? first.trim() : null;
}

/**
 * Run an external tool and return its output, throwing on a non-zero exit.
 * @param {string} command
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw new Error(`${path.basename(command)}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ');
    throw new Error(`${path.basename(command)} failed (${result.status}): ${detail}`);
  }
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/**
 * Digest of a file, read in one go because the archives are a few megabytes.
 * @param {string} file
 * @returns {string} hex digest
 */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Provision 7-Zip when the system has none, verified against the pinned digest.
 *
 * Linux and macOS unpack a standalone binary from the official tarball. Windows
 * runs the official installer with /S and /D into the app's bin directory, which
 * keeps it out of Program Files and needs no elevation.
 * @param {object} options
 * @param {string} options.binDir directory to install into
 * @param {string} [options.platform] process.platform
 * @param {Function} [options.onProgress]
 * @param {object} [options.deps] injectable download, run and exists, used by the tests
 * @returns {Promise<{command: string, source: string}>}
 */
export async function provisionExtractor({
  binDir,
  platform = process.platform,
  onProgress,
  deps = {},
} = {}) {
  const build = SEVEN_ZIP[platform];
  if (!build) throw new Error(`no 7-Zip build is pinned for ${platform}`);
  if (!binDir) throw new Error('a directory is required to provision 7-Zip into');

  const download = deps.download ?? downloadToFile;
  const run = deps.run ?? runTool;
  const exists = deps.exists ?? fs.existsSync;
  const hash = deps.hash ?? sha256File;

  fs.mkdirSync(binDir, { recursive: true });
  const archive = path.join(binDir, platform === 'win32' ? '7z-setup.exe' : '7z-tool.tar.xz');
  await download(build.url, archive, {
    maxBytes: 64 * 1024 * 1024,
    onProgress,
  });

  const digest = hash(archive);
  if (digest !== build.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(`7-Zip download failed verification (sha256 ${digest})`);
  }

  const command = provisionedPath(binDir, platform);

  if (platform === 'win32') {
    run(archive, ['/S', `/D=${path.dirname(command)}`]);
    fs.rmSync(archive, { force: true });
    if (!exists(command)) throw new Error('7-Zip ran but its console binary is missing');
    return { command, source: 'provisioned' };
  }

  run('tar', ['-xJf', archive, '-C', binDir, build.member]);
  fs.rmSync(archive, { force: true });
  if (!exists(command)) throw new Error('the 7-Zip archive did not contain the expected binary');
  fs.chmodSync(command, 0o755);
  return { command, source: 'provisioned' };
}

/**
 * Unpack one member out of an archive.
 * @param {{command: string}} extractor
 * @param {string} archive
 * @param {string} outDir
 * @param {{type?: string, member?: string}} [options]
 * @returns {string[]} paths written
 */
export function unpack(extractor, archive, outDir, options = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['x', archive, `-o${outDir}`, '-y', '-bso0', '-bsp0'];
  if (options.type) args.splice(1, 0, `-t${options.type}`);
  if (options.member) args.push(options.member);
  runTool(extractor.command, args);
  return fs.readdirSync(outDir).map((name) => path.join(outDir, name));
}

/**
 * Find rekordbox.exe anywhere below a directory.
 * @param {string} dir
 * @param {Function} [readdir]
 * @returns {string|null}
 */
export function findRekordboxExe(dir, readdir = fs.readdirSync) {
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name.toLowerCase() === TARGET_MEMBER) return full;
    }
  }
  return null;
}

/**
 * Download, unpack and scan the rekordbox installer for the phrase table.
 *
 * Every path this function creates lives under one temporary directory that is
 * removed in a finally block, so a run never leaves hundreds of megabytes
 * behind. The user's own files are never touched.
 * @param {object} options
 * @param {object} [options.env]
 * @param {string} [options.binDir] where a provisioned 7-Zip may live
 * @param {boolean} [options.keepDownload] keep the temporary directory
 * @param {Function} [options.onProgress] called with {phase, received, total}
 * @param {Function} [options.log] called with human readable progress lines
 * @param {object} [options.deps] injectable collaborators, used by the tests
 * @returns {Promise<{table: string, source: string, workDir?: string}>}
 */
export async function fetchPhraseTable(options = {}) {
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? (() => {});
  const log = options.log ?? (() => {});
  const deps = options.deps ?? {};
  const download = deps.download ?? downloadToFile;
  const resolveUrl = deps.resolveUrl ?? resolveInstallerUrl;
  const findTool = deps.findExtractor ?? findExtractor;
  const provision = deps.provision ?? provisionExtractor;
  const unpackArchive = deps.unpack ?? unpack;
  const scan = deps.scan ?? ((buffer) => findPhraseTableIn(buffer));

  const local = env[EXE_ENV];
  if (local) {
    if (!fs.existsSync(local)) throw new Error(`${EXE_ENV} points at a missing file: ${local}`);
    const buffer = fs.readFileSync(local);
    const hit = scan(buffer);
    if (!hit) throw new Error(`no phrase table in ${local}`);
    return { table: hit.table, source: local };
  }

  let extractor = findTool({ binDir: options.binDir });
  if (!extractor) {
    if (!options.binDir) throw new Error('a bin directory is required to provision 7-Zip');
    log('no 7-Zip found, downloading a standalone copy');
    extractor = await provision({ binDir: options.binDir, onProgress });
  }
  log(`using 7-Zip: ${extractor.command} (${extractor.source})`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-rb-installer-'));
  try {
    const { url, source } = await resolveUrl({ env });
    log(`installer: ${url} (${source})`);
    const zip = path.join(workDir, 'installer.zip');
    await download(url, zip, {
      onProgress: (received, total) => onProgress({ phase: 'download', received, total }),
    });
    if (fs.readFileSync(zip).subarray(0, 2).toString('latin1') !== 'PK') {
      throw new Error('downloaded file is not a zip archive');
    }

    log('unpacking the zip');
    const stage1 = path.join(workDir, 'setup');
    const extracted = unpackArchive(extractor, zip, stage1);
    fs.rmSync(zip, { force: true });
    const installer = extracted.find((file) => /\.exe$/i.test(file));
    if (!installer) throw new Error('the zip does not contain an installer executable');

    const kind = sniffInstaller(fs.readFileSync(installer).subarray(0, 2 * 1024 * 1024));
    log(`installer engine: ${kind}`);
    const stage2 = path.join(workDir, 'app');
    unpackArchive(extractor, installer, stage2, {
      type: kind === 'nsis' ? 'nsis' : undefined,
      member: TARGET_MEMBER,
    });
    fs.rmSync(installer, { force: true });

    const exe = findRekordboxExe(stage2);
    if (!exe) throw new Error(`the installer does not contain ${TARGET_MEMBER}`);

    log(`scanning ${path.basename(exe)} (${fs.statSync(exe).size} bytes)`);
    const hit = scan(fs.readFileSync(exe));
    if (!hit) throw new Error('the phrase table was not found in the unpacked binary');
    return { table: hit.table, source: url, workDir: options.keepDownload ? workDir : undefined };
  } finally {
    if (!options.keepDownload) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
