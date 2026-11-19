import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXE_ENV,
  PINNED_INSTALLER_URL,
  SEVEN_ZIP,
  URL_ENV,
  fetchPhraseTable,
  findExtractor,
  findRekordboxExe,
  provisionExtractor,
  provisionedPath,
  resolveInstallerUrl,
  sniffInstaller,
} from '../audio/rekordboxInstaller.js';
import { TEST_PHRASE_TABLE } from './phraseSetup.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'djman-installer-test-'));
}

/** Collaborators that fake the whole download and unpack chain on disk. */
function fakeDeps({ withExe = true } = {}) {
  return {
    resolveUrl: async () => ({ url: 'https://example.invalid/installer.zip', source: 'test' }),
    download: async (url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(32)]));
      return { bytes: 36 };
    },
    findExtractor: () => ({ command: '7z', source: 'test' }),
    unpack: (extractor, archive, outDir, options = {}) => {
      fs.mkdirSync(outDir, { recursive: true });
      if (!options.type) {
        const installer = path.join(outDir, 'Install_rekordbox_x64_7_2_19.exe');
        fs.writeFileSync(installer, Buffer.concat([Buffer.from('NullsoftInst'), Buffer.alloc(64)]));
        return [installer];
      }
      if (!withExe) return [];
      const exe = path.join(outDir, 'rekordbox.exe');
      fs.writeFileSync(exe, Buffer.from('binary with a table inside'));
      return [exe];
    },
    scan: () => ({ table: TEST_PHRASE_TABLE, candidates: 1 }),
  };
}

describe('sniffInstaller', () => {
  it('recognises the setup engines', () => {
    expect(sniffInstaller(Buffer.from('xxxxNullsoftInstyyyy'))).toBe('nsis');
    expect(sniffInstaller(Buffer.from('Inno Setup Setup Data'))).toBe('inno');
    expect(sniffInstaller(Buffer.from('nothing to see'))).toBe('unknown');
  });
});

describe('resolveInstallerUrl', () => {
  it('prefers the environment override', async () => {
    const result = await resolveInstallerUrl({
      env: { [URL_ENV]: 'https://example.invalid/custom.zip' },
      fetchText: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toEqual({ url: 'https://example.invalid/custom.zip', source: 'environment' });
  });

  it('reads the link published on the download page', async () => {
    const page =
      '<a data-url="https://cdn.rekordbox.com/files/9/Install_rekordbox_x64_7_2_20.zip">';
    const result = await resolveInstallerUrl({ env: {}, fetchText: async () => page });
    expect(result.url).toBe('https://cdn.rekordbox.com/files/9/Install_rekordbox_x64_7_2_20.zip');
    expect(result.source).toBe('download page');
  });

  it('falls back to the pinned link when the page cannot be read', async () => {
    const result = await resolveInstallerUrl({
      env: {},
      fetchText: async () => {
        throw new Error('offline');
      },
    });
    expect(result).toEqual({ url: PINNED_INSTALLER_URL, source: 'pinned' });
  });

  it('falls back when the page no longer carries the link', async () => {
    const result = await resolveInstallerUrl({ env: {}, fetchText: async () => '<html></html>' });
    expect(result.source).toBe('pinned');
  });
});

describe('findExtractor', () => {
  it('prefers a provisioned copy inside the bin directory', () => {
    const dir = tempDir();
    const file = path.join(dir, process.platform === 'win32' ? '7za.exe' : '7zz');
    fs.writeFileSync(file, '');
    const found = findExtractor({ binDir: dir, which: () => null });
    expect(found).toEqual({ command: file, source: 'provisioned' });
  });

  it('falls back to the system tool', () => {
    const found = findExtractor({ binDir: tempDir(), which: (name) => `/usr/bin/${name}` });
    expect(found?.source).toBe('system');
    expect(found?.command).toBe('/usr/bin/7z');
  });

  it('reports nothing when neither exists', () => {
    expect(findExtractor({ binDir: tempDir(), which: () => null, platform: 'linux' })).toBeNull();
  });
});

describe('provisionedPath', () => {
  it('points at the console binary each platform ships', () => {
    expect(provisionedPath('/data/bin', 'linux')).toBe('/data/bin/7zz');
    expect(provisionedPath('/data/bin', 'darwin')).toBe('/data/bin/7zz');
    expect(provisionedPath('C:\\data\\bin', 'win32')).toContain('7z.exe');
  });

  it('returns null without a bin directory', () => {
    expect(provisionedPath(undefined, 'linux')).toBeNull();
  });
});

describe('provisionExtractor', () => {
  function fakeDownload() {
    return async (url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'downloaded');
      return { bytes: 10 };
    };
  }

  it('unpacks the tarball on macOS and marks the binary executable', async () => {
    const binDir = tempDir();
    const calls = [];
    const result = await provisionExtractor({
      binDir,
      platform: 'darwin',
      deps: {
        download: fakeDownload(),
        hash: () => SEVEN_ZIP.darwin.sha256,
        run: (command, args) => {
          calls.push([command, ...args]);
          fs.writeFileSync(path.join(binDir, '7zz'), 'binary');
        },
      },
    });
    expect(result).toEqual({ command: path.join(binDir, '7zz'), source: 'provisioned' });
    expect(calls[0]).toEqual([
      'tar',
      '-xJf',
      path.join(binDir, '7z-tool.tar.xz'),
      '-C',
      binDir,
      '7zz',
    ]);
    expect(fs.existsSync(path.join(binDir, '7z-tool.tar.xz'))).toBe(false);
  });

  it('runs the Windows installer silently into its own directory', async () => {
    const binDir = tempDir();
    const calls = [];
    const result = await provisionExtractor({
      binDir,
      platform: 'win32',
      deps: {
        download: fakeDownload(),
        hash: () => SEVEN_ZIP.win32.sha256,
        run: (command, args) => {
          calls.push([command, ...args]);
          fs.mkdirSync(path.join(binDir, '7zip'), { recursive: true });
          fs.writeFileSync(path.join(binDir, '7zip', '7z.exe'), 'binary');
        },
      },
    });
    expect(result.command).toBe(path.join(binDir, '7zip', '7z.exe'));
    expect(calls[0][0]).toBe(path.join(binDir, '7z-setup.exe'));
    expect(calls[0].slice(1)).toEqual(['/S', `/D=${path.join(binDir, '7zip')}`]);
    expect(fs.existsSync(path.join(binDir, '7z-setup.exe'))).toBe(false);
  });

  it('refuses a download whose digest does not match', async () => {
    const binDir = tempDir();
    await expect(
      provisionExtractor({
        binDir,
        platform: 'linux',
        deps: { download: fakeDownload(), hash: () => 'deadbeef' },
      })
    ).rejects.toThrow(/failed verification/);
    expect(fs.readdirSync(binDir)).toEqual([]);
  });

  it('reports a platform it has no build for', async () => {
    await expect(provisionExtractor({ binDir: tempDir(), platform: 'aix' })).rejects.toThrow(
      /no 7-Zip build is pinned/
    );
  });
});

describe('findRekordboxExe', () => {
  it('walks nested directories', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    const exe = path.join(dir, 'a', 'b', 'rekordbox.exe');
    fs.writeFileSync(exe, '');
    expect(findRekordboxExe(dir)).toBe(exe);
  });

  it('returns null when the binary is absent', () => {
    expect(findRekordboxExe(tempDir())).toBeNull();
  });
});

describe('fetchPhraseTable', () => {
  it('downloads, unpacks, scans and cleans up after itself', async () => {
    const deps = fakeDeps();
    let workDir;
    const originalMkdtemp = fs.mkdtempSync;
    const result = await fetchPhraseTable({
      env: {},
      deps: {
        ...deps,
        download: async (url, dest, options) => {
          workDir = path.dirname(dest);
          return deps.download(url, dest, options);
        },
      },
    });

    expect(result.table).toBe(TEST_PHRASE_TABLE);
    expect(result.workDir).toBeUndefined();
    expect(workDir && fs.existsSync(workDir)).toBe(false);
    expect(originalMkdtemp).toBe(fs.mkdtempSync);
  });

  it('keeps the temporary directory when asked', async () => {
    let workDir;
    const deps = fakeDeps();
    const result = await fetchPhraseTable({
      env: {},
      keepDownload: true,
      deps: {
        ...deps,
        download: async (url, dest, options) => {
          workDir = path.dirname(dest);
          return deps.download(url, dest, options);
        },
      },
    });
    expect(result.workDir).toBe(workDir);
    expect(fs.existsSync(workDir)).toBe(true);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('scans a file the user already has instead of downloading', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'rekordbox.exe');
    fs.writeFileSync(file, 'whatever');
    const result = await fetchPhraseTable({
      env: { [EXE_ENV]: file },
      deps: {
        ...fakeDeps(),
        download: async () => {
          throw new Error('must not download');
        },
      },
    });
    expect(result).toEqual({ table: TEST_PHRASE_TABLE, source: file });
  });

  it('fails clearly when the pointed file is missing', async () => {
    await expect(
      fetchPhraseTable({ env: { [EXE_ENV]: path.join(tempDir(), 'nope.exe') }, deps: fakeDeps() })
    ).rejects.toThrow(/missing file/);
  });

  it('rejects a download that is not a zip', async () => {
    const deps = fakeDeps();
    await expect(
      fetchPhraseTable({
        env: {},
        deps: {
          ...deps,
          download: async (url, dest) => {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, Buffer.from('<html>not a zip</html>'));
            return { bytes: 21 };
          },
        },
      })
    ).rejects.toThrow(/not a zip/);
  });

  it('fails when the installer carries no rekordbox binary', async () => {
    await expect(fetchPhraseTable({ env: {}, deps: fakeDeps({ withExe: false }) })).rejects.toThrow(
      /does not contain rekordbox.exe/
    );
  });

  it('provisions 7-Zip when the system has none', async () => {
    const calls = [];
    const binDir = tempDir();
    const result = await fetchPhraseTable({
      env: {},
      binDir,
      deps: {
        ...fakeDeps(),
        findExtractor: () => null,
        provision: async ({ binDir }) => {
          calls.push(binDir);
          return { command: path.join(binDir, '7zz'), source: 'provisioned' };
        },
      },
    });
    expect(result.table).toBe(TEST_PHRASE_TABLE);
    expect(calls).toHaveLength(1);
  });

  it('pins an official 7-Zip build for every platform it supports', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const build = SEVEN_ZIP[platform];
      expect(build, platform).toBeDefined();
      expect(build.sha256, platform).toMatch(/^[0-9a-f]{64}$/);
      expect(build.url, platform).toMatch(/^https:\/\/www\.7-zip\.org\//);
      expect(build.member, platform).toMatch(/^7z/);
    }
  });
});
