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
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Paths ─────────────────────────────────────────────────────────────────────

function getBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

const EXT = process.platform === 'win32' ? '.exe' : '';

export function getFfmpegRuntimePath() {
  return path.join(getBinDir(), `ffmpeg${EXT}`);
}
export function getFfprobeRuntimePath() {
  return path.join(getBinDir(), `ffprobe${EXT}`);
}
export function getAnalyzerRuntimePath() {
  return path.join(getBinDir(), `analysis${EXT}`);
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
  };
}

// ── Readiness ─────────────────────────────────────────────────────────────────

export function areDepsReady() {
  return (
    fs.existsSync(getFfmpegRuntimePath()) &&
    fs.existsSync(getFfprobeRuntimePath()) &&
    fs.existsSync(getAnalyzerRuntimePath())
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

// ── Archive helpers ───────────────────────────────────────────────────────────

async function extractTarGz(archive, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  await execAsync(`tar -xzf "${archive}" -C "${destDir}"`);
}

async function extractTarXz(archive, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  await execAsync(`tar -xJf "${archive}" -C "${destDir}"`);
}

async function extractZip(archive, destDir) {
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
        onProgress?.(`Downloading FFmpeg… ${Math.round((r / t) * 100)}%`, Math.round((r / t) * 100))
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
        onProgress?.(`Downloading FFmpeg… ${Math.round((r / t) * 100)}%`, Math.round((r / t) * 100))
    );
    onProgress?.('Extracting FFmpeg…', 99);
    const dir = path.join(tmp, 'ffmpeg-win-extracted');
    await extractZip(archive, dir);
    fs.copyFileSync(await findFile(dir, 'ffmpeg.exe'), getFfmpegRuntimePath());
    fs.copyFileSync(await findFile(dir, 'ffprobe.exe'), getFfprobeRuntimePath());
  } else if (platform === 'darwin') {
    const ffmpegZip = path.join(tmp, 'ffmpeg-mac.zip');
    const ffprobeZip = path.join(tmp, 'ffprobe-mac.zip');
    onProgress?.(`Downloading FFmpeg…`, 0);
    await downloadFile(
      'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
      ffmpegZip,
      (r, t) =>
        t > 0 &&
        onProgress?.(`Downloading FFmpeg… ${Math.round((r / t) * 50)}%`, Math.round((r / t) * 50))
    );
    await downloadFile(
      'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
      ffprobeZip,
      (r, t) =>
        t > 0 &&
        onProgress?.(
          `Downloading FFprobe… ${50 + Math.round((r / t) * 49)}%`,
          50 + Math.round((r / t) * 49)
        )
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
      onProgress?.(
        `Downloading mixxx-analyzer… ${Math.round((r / t) * 100)}%`,
        Math.round((r / t) * 100)
      )
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

  // Copy all files from the bundle directory (binary + any .so or .dylib siblings)
  for (const entry of await fs.promises.readdir(bundleDir)) {
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

// ── Public API ────────────────────────────────────────────────────────────────

export async function ensureDeps(onProgress) {
  const ffmpegReady =
    fs.existsSync(getFfmpegRuntimePath()) && fs.existsSync(getFfprobeRuntimePath());
  const analyzerReady = fs.existsSync(getAnalyzerRuntimePath());
  if (ffmpegReady && analyzerReady) return;

  const binDir = getBinDir();
  await fs.promises.mkdir(binDir, { recursive: true });
  const tmp = path.join(app.getPath('temp'), 'djman-deps');
  await fs.promises.mkdir(tmp, { recursive: true });

  const totalSteps = (!ffmpegReady ? 1 : 0) + (!analyzerReady ? 1 : 0);
  let step = 0;
  const stepCb = (msg, pct) => onProgress?.(`[${step}/${totalSteps}] ${msg}`, pct);

  try {
    if (!ffmpegReady) {
      step++;
      await downloadFFmpeg(tmp, stepCb);
    }
    if (!analyzerReady) {
      step++;
      await downloadAnalyzer(tmp, stepCb);
    }
    onProgress?.('Setup complete.', 100);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function checkForUpdates() {
  const installed = getInstalledVersions();
  const result = { analyzer: null };

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

export async function updateAll(onProgress) {
  const binDir = getBinDir();
  await fs.promises.mkdir(binDir, { recursive: true });
  const tmp = path.join(app.getPath('temp'), 'djman-deps');
  await fs.promises.mkdir(tmp, { recursive: true });
  try {
    await downloadFFmpeg(tmp, (msg, pct) => onProgress?.(`[1/2] ${msg}`, pct));
    await downloadAnalyzer(tmp, (msg, pct) => onProgress?.(`[2/2] ${msg}`, pct));
    onProgress?.('All dependencies updated.', 100);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
