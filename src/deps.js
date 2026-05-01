/**
 * Runtime dependency manager.
 * Downloads FFmpeg and mixxx-analyzer into userData/bin/ on first launch.
 * Tracks versions and supports update checks / forced re-downloads.
 */
import path from 'path';
import fs from 'fs';
import https from 'https';
import { createWriteStream } from 'fs';
import { app } from 'electron';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { findTidalDlPath } from './audio/tidalDlManager.js';
const execAsync = promisify(exec);

// ── Paths ─────────────────────────────────────────────────────────────────────

function getBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

// On Windows, ffmpeg/ffprobe live in their own subdirectory so they don't
// accidentally load conflicting system DLLs that the analyzer bundle places
// alongside it in the shared bin/ directory.
function getFfmpegBinDir() {
  return process.platform === 'win32' ? path.join(getBinDir(), 'ffmpeg') : getBinDir();
}

const EXT = process.platform === 'win32' ? '.exe' : '';

export function getFfmpegRuntimePath() {
  return path.join(getFfmpegBinDir(), `ffmpeg${EXT}`);
}
export function getFfprobeRuntimePath() {
  return path.join(getFfmpegBinDir(), `ffprobe${EXT}`);
}
export function getAnalyzerRuntimePath() {
  return path.join(getBinDir(), `analysis${EXT}`);
}

export function getYtDlpRuntimePath() {
  const platform = process.platform;
  if (platform === 'win32') return path.join(getBinDir(), 'yt-dlp.exe');
  if (platform === 'darwin') return path.join(getBinDir(), 'yt-dlp_macos');
  return path.join(getBinDir(), 'yt-dlp');
}

export function getUvRuntimePath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'uv.exe' : 'uv');
}

function versionFile(name) {
  return path.join(getBinDir(), `${name}.version`);
}

function readVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(versionFile(name), 'utf8'));
  } catch {
    return null;
  }
}

function writeVersion(name, data) {
  fs.mkdirSync(getBinDir(), { recursive: true });
  fs.writeFileSync(versionFile(name), JSON.stringify(data, null, 2));
}

export function getInstalledVersions() {
  return {
    ffmpeg: readVersion('ffmpeg'),
    analyzer: readVersion('analyzer'),
    ytDlp: readVersion('yt-dlp'),
    tidalDlNg: readVersion('tidal-dl-ng'),
  };
}

async function getTidalDlNgVersion() {
  const uvPath = getUvRuntimePath();
  if (fs.existsSync(uvPath)) {
    try {
      const { stdout } = await execAsync(`"${uvPath}" tool list`);
      const match = stdout.match(/tidal-dl-ng(?:-for-dj)?\s+v?([\d.]+)/i);
      if (match) return match[1];
    } catch {
      /* fall through */
    }
  }
  // Fallback: pip show
  const cmds =
    process.platform === 'win32'
      ? ['pip show tidal-dl-ng', 'python -m pip show tidal-dl-ng']
      : ['pip3 show tidal-dl-ng', 'pip show tidal-dl-ng', 'python3 -m pip show tidal-dl-ng'];
  for (const cmd of cmds) {
    try {
      const { stdout } = await execAsync(cmd);
      const match = stdout.match(/^Version:\s*(.+)$/m);
      if (match) return match[1].trim();
    } catch {
      /* try next */
    }
  }
  return 'installed';
}

async function downloadUvBinary(onProgress) {
  const { platform, arch } = process;
  const assetMap = {
    linux:
      arch === 'arm64'
        ? 'uv-aarch64-unknown-linux-gnu.tar.gz'
        : 'uv-x86_64-unknown-linux-gnu.tar.gz',
    darwin: arch === 'arm64' ? 'uv-aarch64-apple-darwin.tar.gz' : 'uv-x86_64-apple-darwin.tar.gz',
    win32: 'uv-x86_64-pc-windows-msvc.zip',
  };
  const assetName = assetMap[platform];
  if (!assetName) throw new Error(`Unsupported platform for uv: ${platform}`);

  const release = await getLatestRelease('astral-sh', 'uv');
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`No uv asset found: ${assetName}`);

  const tmp = path.join(app.getPath('temp'), 'djman-uv-dl');
  await fs.promises.mkdir(tmp, { recursive: true });
  try {
    const archive = path.join(tmp, assetName);
    await downloadFile(
      asset.browser_download_url,
      archive,
      (r, t) => t > 0 && onProgress?.(`Downloading uv… ${Math.round((r / t) * 100)}%`, -1)
    );
    const dir = path.join(tmp, 'extracted');
    if (assetName.endsWith('.tar.gz')) await extractTarGz(archive, dir);
    else await extractZip(archive, dir);

    const uvBinName = platform === 'win32' ? 'uv.exe' : 'uv';
    const uvSrc = await findFile(dir, uvBinName);
    if (!uvSrc) throw new Error('uv binary not found in archive');

    const dest = getUvRuntimePath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(uvSrc, dest);
    if (platform !== 'win32') fs.chmodSync(dest, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function installTidalDlNgDep(onProgress) {
  let uvPath = getUvRuntimePath();
  if (!fs.existsSync(uvPath)) {
    onProgress?.('Downloading uv…', -1);
    await downloadUvBinary(onProgress);
    uvPath = getUvRuntimePath();
  }

  onProgress?.('Installing tidal-dl-ng…', -1);
  await new Promise((resolve, reject) => {
    const proc = spawn(
      uvPath,
      ['tool', 'install', '--reinstall', 'git+https://github.com/Radexito/tidal-dl-ng-For-DJ.git'],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const t = line.trim();
        if (t) onProgress?.(t, -1);
      }
    });
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const t = line.trim();
        if (t) onProgress?.(t, -1);
      }
    });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`uv tool install exited with code ${code}`))
    );
    proc.on('error', reject);
  });

  const version = await getTidalDlNgVersion();
  writeVersion('tidal-dl-ng', { version, installedAt: new Date().toISOString() });
}

export { installTidalDlNgDep as ensureTidalDlNg };

async function upgradeTidalDlNgDep(onProgress) {
  const uvPath = getUvRuntimePath();
  if (fs.existsSync(uvPath)) {
    await new Promise((resolve, reject) => {
      const proc = spawn(
        uvPath,
        [
          'tool',
          'install',
          '--reinstall',
          'git+https://github.com/Radexito/tidal-dl-ng-For-DJ.git',
        ],
        {
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      proc.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          const t = line.trim();
          if (t) onProgress?.(t, -1);
        }
      });
      proc.stderr.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          const t = line.trim();
          if (t) onProgress?.(t, -1);
        }
      });
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`uv tool upgrade exited with code ${code}`))
      );
      proc.on('error', reject);
    });
  } else {
    // Fallback: pip upgrade
    const candidates =
      process.platform === 'win32'
        ? [
            ['pip', ['install', '--upgrade', 'tidal-dl-ng']],
            ['python', ['-m', 'pip', 'install', '--upgrade', 'tidal-dl-ng']],
          ]
        : [
            ['pip3', ['install', '--upgrade', 'tidal-dl-ng']],
            ['pip', ['install', '--upgrade', 'tidal-dl-ng']],
            ['python3', ['-m', 'pip', 'install', '--upgrade', 'tidal-dl-ng']],
            ['python', ['-m', 'pip', 'install', '--upgrade', 'tidal-dl-ng']],
          ];
    let lastErr;
    for (const [cmd, args] of candidates) {
      try {
        await new Promise((resolve, reject) => {
          const proc = spawn(cmd, args, {
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          proc.stdout.on('data', (chunk) => {
            for (const line of chunk.toString().split('\n')) {
              const t = line.trim();
              if (t) onProgress?.(t, -1);
            }
          });
          proc.stderr.on('data', (chunk) => {
            for (const line of chunk.toString().split('\n')) {
              const t = line.trim();
              if (t) onProgress?.(t, -1);
            }
          });
          proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
          proc.on('error', reject);
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
  }

  const version = await getTidalDlNgVersion();
  writeVersion('tidal-dl-ng', { version, installedAt: new Date().toISOString() });
}

// ── Readiness ─────────────────────────────────────────────────────────────────

export function areDepsReady() {
  return (
    fs.existsSync(getFfmpegRuntimePath()) &&
    fs.existsSync(getFfprobeRuntimePath()) &&
    fs.existsSync(getAnalyzerRuntimePath()) &&
    fs.existsSync(getYtDlpRuntimePath())
  );
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const follow = (u) => {
      https
        .get(u, { headers: { 'User-Agent': 'djman-dep-downloader' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location);
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${u}`));
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          const out = createWriteStream(dest);
          res.on('data', (chunk) => {
            received += chunk.length;
            onProgress?.(received, total);
          });
          res.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          res.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

export function getLatestRelease(owner, repo) {
  return new Promise((resolve, reject) => {
    https
      .get(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
        {
          headers: { 'User-Agent': 'djman-dep-downloader', Accept: 'application/vnd.github+json' },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

export function getReleaseByTag(owner, repo, tag) {
  return new Promise((resolve, reject) => {
    https
      .get(
        `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
        {
          headers: { 'User-Agent': 'djman-dep-downloader', Accept: 'application/vnd.github+json' },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.message) reject(new Error(`GitHub: ${data.message} (tag: ${tag})`));
              else resolve(data);
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

// ── Archive helpers ───────────────────────────────────────────────────────────

async function extractTarGz(archive, destDir) {
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  await fs.promises.mkdir(destDir, { recursive: true });
  await execAsync(`tar -xzf "${archive}" -C "${destDir}"`);
}

async function extractTarXz(archive, destDir) {
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  await fs.promises.mkdir(destDir, { recursive: true });
  await execAsync(`tar -xJf "${archive}" -C "${destDir}"`);
}

async function extractZip(archive, destDir) {
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  await fs.promises.mkdir(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await execAsync(
      `powershell -Command "Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force"`
    );
  } else {
    await execAsync(`unzip -q -o "${archive}" -d "${destDir}"`);
  }
}

async function findFile(dir, name) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = await findFile(full, name).catch(() => null);
      if (f) return f;
    } else if (e.name === name || e.name === name + '.exe') return full;
  }
  return null;
}

// ── FFmpeg download ───────────────────────────────────────────────────────────

async function downloadFFmpeg(tmp, onProgress) {
  const platform = process.platform;

  if (platform === 'linux') {
    const url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
    const archive = path.join(tmp, 'ffmpeg.tar.xz');
    onProgress?.(`Downloading FFmpeg…`, 0);
    await downloadFile(
      url,
      archive,
      (r, t) =>
        t > 0 &&
        onProgress?.(`Downloading FFmpeg…`, Math.round((r / t) * 100), {
          bytesReceived: r,
          bytesTotal: t,
        })
    );
    onProgress?.('Extracting FFmpeg…', 99);
    const dir = path.join(tmp, 'ffmpeg-extracted');
    await extractTarXz(archive, dir);
    const ffmpeg = await findFile(dir, 'ffmpeg');
    const ffprobe = await findFile(dir, 'ffprobe');
    fs.copyFileSync(ffmpeg, getFfmpegRuntimePath());
    fs.copyFileSync(ffprobe, getFfprobeRuntimePath());
    fs.chmodSync(getFfmpegRuntimePath(), 0o755);
    fs.chmodSync(getFfprobeRuntimePath(), 0o755);
  } else if (platform === 'win32') {
    const release = await getLatestRelease('BtbN', 'FFmpeg-Builds');
    const asset = release.assets.find(
      (a) => a.name.includes('win64-gpl.zip') && a.name.includes('latest')
    );
    const archive = path.join(tmp, 'ffmpeg-win.zip');
    onProgress?.(`Downloading FFmpeg…`, 0);
    await downloadFile(
      asset.browser_download_url,
      archive,
      (r, t) =>
        t > 0 &&
        onProgress?.(`Downloading FFmpeg…`, Math.round((r / t) * 100), {
          bytesReceived: r,
          bytesTotal: t,
        })
    );
    onProgress?.('Extracting FFmpeg…', 99);
    const dir = path.join(tmp, 'ffmpeg-win-extracted');
    await extractZip(archive, dir);
    const ffmpegExe = await findFile(dir, 'ffmpeg.exe');
    const ffprobeExe = await findFile(dir, 'ffprobe.exe');
    // Use isolated subdirectory so system DLLs from other bundled tools
    // (e.g. the analyzer) don't shadow the system's own DLLs and cause
    // STATUS_ENTRYPOINT_NOT_FOUND when ffprobe loads.
    const ffmpegBinDir = getFfmpegBinDir();
    fs.mkdirSync(ffmpegBinDir, { recursive: true });
    fs.copyFileSync(ffmpegExe, getFfmpegRuntimePath());
    fs.copyFileSync(ffprobeExe, getFfprobeRuntimePath());
    // Copy sibling DLLs into the same isolated folder (needed for shared builds)
    const ffmpegDir = path.dirname(ffmpegExe);
    for (const entry of fs.readdirSync(ffmpegDir)) {
      if (entry.toLowerCase().endsWith('.dll')) {
        fs.copyFileSync(path.join(ffmpegDir, entry), path.join(ffmpegBinDir, entry));
      }
    }
  } else if (platform === 'darwin') {
    const ffmpegZip = path.join(tmp, 'ffmpeg-mac.zip');
    const ffprobeZip = path.join(tmp, 'ffprobe-mac.zip');
    onProgress?.(`Downloading FFmpeg…`, 0);
    await downloadFile(
      'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
      ffmpegZip,
      (r, t) =>
        t > 0 &&
        onProgress?.(`Downloading FFmpeg…`, Math.round((r / t) * 50), {
          bytesReceived: r,
          bytesTotal: t,
        })
    );
    await downloadFile(
      'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
      ffprobeZip,
      (r, t) =>
        t > 0 &&
        onProgress?.(`Downloading FFprobe…`, 50 + Math.round((r / t) * 49), {
          bytesReceived: r,
          bytesTotal: t,
        })
    );
    onProgress?.('Extracting FFmpeg…', 99);
    await extractZip(ffmpegZip, path.join(tmp, 'ffmpeg-mac'));
    await extractZip(ffprobeZip, path.join(tmp, 'ffprobe-mac'));
    fs.copyFileSync(await findFile(path.join(tmp, 'ffmpeg-mac'), 'ffmpeg'), getFfmpegRuntimePath());
    fs.copyFileSync(
      await findFile(path.join(tmp, 'ffprobe-mac'), 'ffprobe'),
      getFfprobeRuntimePath()
    );
    fs.chmodSync(getFfmpegRuntimePath(), 0o755);
    fs.chmodSync(getFfprobeRuntimePath(), 0o755);
  }

  // Store version (run ffmpeg -version to capture build string)
  try {
    const { stdout } = await execAsync(`"${getFfmpegRuntimePath()}" -version`);
    const match = stdout.match(/ffmpeg version (\S+)/);
    writeVersion('ffmpeg', {
      version: match?.[1] ?? 'unknown',
      installedAt: new Date().toISOString(),
    });
  } catch {
    writeVersion('ffmpeg', { version: 'unknown', installedAt: new Date().toISOString() });
  }
}

// ── Analyzer download ─────────────────────────────────────────────────────────

async function analyzerAssetName() {
  const p = process.platform;
  if (p === 'linux') return { name: 'linux-x86_64', ext: 'tar.gz' };
  if (p === 'darwin') return { name: 'macos-arm64', ext: 'zip' };
  if (p === 'win32') return { name: 'windows-x86_64', ext: 'zip' };
  throw new Error(`Unsupported platform: ${p}`);
}

async function downloadAnalyzer(tmp, onProgress) {
  onProgress?.('Downloading mixxx-analyzer…', 0);
  const release = await getLatestRelease('Radexito', 'mixxx-analyzer');
  const { name, ext } = await analyzerAssetName();
  const asset = release.assets.find((a) => a.name.includes(name) && a.name.endsWith(`.${ext}`));
  if (!asset) throw new Error(`No mixxx-analyzer asset for ${name}`);

  const archive = path.join(tmp, `analyzer.${ext}`);
  await downloadFile(
    asset.browser_download_url,
    archive,
    (r, t) =>
      t > 0 &&
      onProgress?.(`Downloading mixxx-analyzer…`, Math.round((r / t) * 100), {
        bytesReceived: r,
        bytesTotal: t,
      })
  );

  onProgress?.('Extracting mixxx-analyzer…', 99);
  const dir = path.join(tmp, 'analyzer-extracted');
  if (ext === 'tar.gz') await extractTarGz(archive, dir);
  else await extractZip(archive, dir);

  // On Linux the bundle contains the binary + bundled .so files (RPATH=$ORIGIN).
  // Copy everything from the extracted dir into binDir so sibling libs are found.
  const binDir = getBinDir();
  const binName = process.platform === 'win32' ? 'mixxx-analyzer.exe' : 'mixxx-analyzer';
  const src = await findFile(dir, binName);
  if (!src) throw new Error('mixxx-analyzer binary not found in archive');
  const bundleDir = path.dirname(src);

  // Windows system DLLs that the analyzer bundle may include for portability
  // but which must NOT be copied — shadowing them causes STATUS_ENTRYPOINT_NOT_FOUND
  // when the system's own (newer) version of the DLL has entry points the local copy lacks.
  const WIN_SYSTEM_DLLS = new Set([
    'msvcp_win.dll',
    'cfgmgr32.dll',
    'dwrite.dll',
    'iphlpapi.dll',
    'usp10.dll',
    'd2d1.dll',
    'ncrypt.dll',
    'kernel32.dll',
    'user32.dll',
    'ntdll.dll',
    'advapi32.dll',
    'shell32.dll',
    'ole32.dll',
  ]);

  // Copy all files from the bundle directory (binary + any .so or .dylib siblings)
  for (const entry of await fs.promises.readdir(bundleDir)) {
    if (process.platform === 'win32' && WIN_SYSTEM_DLLS.has(entry.toLowerCase())) continue;
    const srcFile = path.join(bundleDir, entry);
    const dstFile = path.join(binDir, entry);
    fs.copyFileSync(srcFile, dstFile);
    if (process.platform !== 'win32') {
      const stat = await fs.promises.stat(srcFile);
      if (stat.mode & 0o111) fs.chmodSync(dstFile, 0o755); // preserve executable bit
    }
  }

  // Create a stable symlink/copy named 'analysis' pointing to the real binary
  const analyzerDest = getAnalyzerRuntimePath();
  const realBin = path.join(binDir, binName);
  if (fs.existsSync(analyzerDest) && analyzerDest !== realBin) fs.unlinkSync(analyzerDest);
  if (analyzerDest !== realBin) fs.copyFileSync(realBin, analyzerDest);
  if (process.platform !== 'win32') fs.chmodSync(analyzerDest, 0o755);

  writeVersion('analyzer', {
    version: release.tag_name,
    releaseUrl: release.html_url,
    installedAt: new Date().toISOString(),
  });
}

// ── yt-dlp download ───────────────────────────────────────────────────────────

async function downloadYtDlp(tmp, onProgress, tag = null) {
  onProgress?.('Downloading yt-dlp…', 0);
  const release = tag
    ? await getReleaseByTag('yt-dlp', 'yt-dlp', tag)
    : await getLatestRelease('yt-dlp', 'yt-dlp');

  const platform = process.platform;
  let assetName;
  if (platform === 'win32') assetName = 'yt-dlp.exe';
  else if (platform === 'darwin') assetName = 'yt-dlp_macos';
  else assetName = 'yt-dlp';

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`No yt-dlp asset found for platform: ${platform}`);

  const dest = getYtDlpRuntimePath();
  await downloadFile(
    asset.browser_download_url,
    dest,
    (r, t) =>
      t > 0 &&
      onProgress?.(`Downloading yt-dlp…`, Math.round((r / t) * 100), {
        bytesReceived: r,
        bytesTotal: t,
      })
  );

  if (platform !== 'win32') fs.chmodSync(dest, 0o755);

  writeVersion('yt-dlp', {
    version: release.tag_name,
    releaseUrl: release.html_url,
    installedAt: new Date().toISOString(),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function ensureDeps(onProgress) {
  const ffmpegReady =
    fs.existsSync(getFfmpegRuntimePath()) && fs.existsSync(getFfprobeRuntimePath());
  const analyzerReady = fs.existsSync(getAnalyzerRuntimePath());
  const ytDlpReady = fs.existsSync(getYtDlpRuntimePath());
  const tidalReady = Boolean(findTidalDlPath());
  if (ffmpegReady && analyzerReady && ytDlpReady && tidalReady) return;

  const binDir = getBinDir();
  await fs.promises.mkdir(binDir, { recursive: true });
  const tmp = path.join(app.getPath('temp'), 'djman-deps');
  await fs.promises.mkdir(tmp, { recursive: true });

  const STEP_DEFS = [
    !ffmpegReady && { id: 'ffmpeg', label: 'FFmpeg' },
    !analyzerReady && { id: 'analyzer', label: 'mixxx-analyzer' },
    !ytDlpReady && { id: 'ytdlp', label: 'yt-dlp' },
    !tidalReady && { id: 'tidal', label: 'tidal-dl-ng' },
  ].filter(Boolean);
  const totalSteps = STEP_DEFS.length;
  let stepIndex = 0;
  let currentStep = null;

  // Per-step speed/ETA tracker — reset when step changes
  let _lastBytes = 0,
    _lastBytesTime = Date.now(),
    _speedSamples = [];
  const resetTracker = () => {
    _lastBytes = 0;
    _lastBytesTime = Date.now();
    _speedSamples = [];
  };

  const stepCb = (msg, pct, meta = {}) => {
    let bytesPerSec = 0,
      etaSec = -1;
    const { bytesReceived, bytesTotal } = meta;
    if (bytesReceived != null && bytesTotal > 0) {
      const now = Date.now();
      const dt = (now - _lastBytesTime) / 1000;
      if (dt > 0.25) {
        const speed = (bytesReceived - _lastBytes) / dt;
        _speedSamples = [..._speedSamples.slice(-4), speed];
        _lastBytesTime = now;
        _lastBytes = bytesReceived;
      }
      const avg = _speedSamples.length
        ? _speedSamples.reduce((a, b) => a + b) / _speedSamples.length
        : 0;
      bytesPerSec = avg;
      etaSec = avg > 0 ? (bytesTotal - bytesReceived) / avg : -1;
    }
    onProgress?.({
      msg,
      pct,
      stepId: currentStep?.id ?? null,
      stepLabel: currentStep?.label ?? null,
      stepIndex,
      stepTotal: totalSteps,
      stepPct: pct,
      bytesDownloaded: bytesReceived ?? 0,
      bytesTotal: bytesTotal ?? -1,
      bytesPerSec,
      etaSec,
    });
  };

  try {
    if (!ffmpegReady) {
      currentStep = STEP_DEFS.find((s) => s.id === 'ffmpeg');
      stepIndex++;
      resetTracker();
      await downloadFFmpeg(tmp, stepCb);
    }
    if (!analyzerReady) {
      currentStep = STEP_DEFS.find((s) => s.id === 'analyzer');
      stepIndex++;
      resetTracker();
      await downloadAnalyzer(tmp, stepCb);
    }
    if (!ytDlpReady) {
      currentStep = STEP_DEFS.find((s) => s.id === 'ytdlp');
      stepIndex++;
      resetTracker();
      await downloadYtDlp(tmp, stepCb);
    }
    if (!tidalReady) {
      currentStep = STEP_DEFS.find((s) => s.id === 'tidal');
      stepIndex++;
      resetTracker();
      stepCb('Installing tidal-dl-ng…', 0);
      try {
        await installTidalDlNgDep((msg) => stepCb(msg, -1));
        stepCb('tidal-dl-ng installed.', 100);
      } catch (err) {
        console.warn('[deps] tidal-dl-ng install failed (non-fatal):', err.message);
        stepCb('tidal-dl-ng install failed — Python 3.12+ may not be available.', -1);
      }
    }
    onProgress?.({
      msg: 'Setup complete.',
      pct: 100,
      stepIndex: totalSteps,
      stepTotal: totalSteps,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function checkForUpdates() {
  const installed = getInstalledVersions();
  const result = { analyzer: null, ytDlp: null };

  try {
    const release = await getLatestRelease('Radexito', 'mixxx-analyzer');
    result.analyzer = {
      installedTag: installed.analyzer?.version ?? null,
      latestTag: release.tag_name,
      hasUpdate: installed.analyzer?.version !== release.tag_name,
      releaseUrl: release.html_url,
    };
  } catch {
    result.analyzer = { error: 'Could not check for updates' };
  }

  try {
    const release = await getLatestRelease('yt-dlp', 'yt-dlp');
    result.ytDlp = {
      installedTag: installed.ytDlp?.version ?? null,
      latestTag: release.tag_name,
      hasUpdate: installed.ytDlp?.version !== release.tag_name,
      releaseUrl: release.html_url,
    };
  } catch {
    result.ytDlp = { error: 'Could not check for updates' };
  }

  return result;
}

export async function updateAnalyzer(onProgress) {
  const binDir = getBinDir();
  await fs.promises.mkdir(binDir, { recursive: true });
  const tmp = path.join(app.getPath('temp'), 'djman-deps');
  await fs.promises.mkdir(tmp, { recursive: true });
  try {
    await downloadAnalyzer(tmp, onProgress);
    onProgress?.('mixxx-analyzer updated.', 100);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function updateYtDlp(onProgress, tag = null) {
  const binDir = getBinDir();
  await fs.promises.mkdir(binDir, { recursive: true });
  const tmp = path.join(app.getPath('temp'), 'djman-deps');
  await fs.promises.mkdir(tmp, { recursive: true });
  try {
    await downloadYtDlp(tmp, onProgress, tag);
    onProgress?.(tag ? `yt-dlp ${tag} installed.` : 'yt-dlp updated.', 100);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function updateTidalDlNg(onProgress) {
  try {
    onProgress?.('Upgrading tidal-dl-ng…', 0);
    await upgradeTidalDlNgDep(onProgress);
    onProgress?.('tidal-dl-ng updated.', 100);
  } catch (err) {
    onProgress?.(`tidal-dl-ng update failed: ${err.message}`, -1);
    throw err;
  }
}

export async function updateAll(onProgress) {
  const binDir = getBinDir();
  await fs.promises.mkdir(binDir, { recursive: true });
  const tmp = path.join(app.getPath('temp'), 'djman-deps');
  await fs.promises.mkdir(tmp, { recursive: true });
  try {
    await downloadFFmpeg(tmp, (msg, pct) => onProgress?.(`[1/4] ${msg}`, pct));
    await downloadAnalyzer(tmp, (msg, pct) => onProgress?.(`[2/4] ${msg}`, pct));
    await downloadYtDlp(tmp, (msg, pct) => onProgress?.(`[3/4] ${msg}`, pct));
    onProgress?.('[4/4] Upgrading tidal-dl-ng…', 0);
    try {
      await upgradeTidalDlNgDep((msg) => onProgress?.(`[4/4] ${msg}`, -1));
    } catch (err) {
      console.warn('[deps] tidal-dl-ng upgrade failed (non-fatal):', err.message);
    }
    onProgress?.('All dependencies updated.', 100);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
