import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  GRAPHICS_MODES,
  LINUX_COMPOSITING_SWITCHES,
  LINUX_GPU_SAFE_SWITCHES,
  normalizeGraphicsMode,
  resolveLaunchProfile,
  shouldAllowAutomaticFallback,
} from '../main/graphics/launchProfile.js';
import { applyLaunchProfile } from '../main/graphics/applyLaunchProfile.js';
import { graphicsConfigPath, readGraphicsConfig } from '../main/graphics/graphicsConfig.js';

const GPU_OFF_SWITCHES = ['disable-gpu', 'disable-gpu-sandbox', 'no-sandbox'];

/** Reduces a resolved launch profile to the Chromium switch names it enables. */
function switchNames(profile) {
  return profile.switches.map((entry) => entry.name);
}

describe('resolveLaunchProfile', () => {
  describe('Linux, mode auto (the new default)', () => {
    it('enables hardware acceleration and applies none of the GPU-off switches', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-0' },
        config: { mode: 'auto' },
      });

      expect(profile.hardwareAcceleration).toBe(true);
      expect(profile.mode).toBe('auto');
      for (const name of GPU_OFF_SWITCHES) {
        expect(switchNames(profile)).not.toContain(name);
      }
    });

    it('does not pretend to choose the Ozone transport', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-0', DJMAN_OZONE: 'wayland' },
      });

      expect(profile.switches).toEqual([{ name: 'disable-gpu-compositing' }]);
    });

    it('keeps X11 as the default transport even on a Wayland session', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-0' },
      });

      expect(switchNames(profile)).toEqual(['disable-gpu-compositing']);
    });

    it('composites in software on every Linux session so the window paints', () => {
      const wayland = resolveLaunchProfile({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-1' },
      });
      const x11 = resolveLaunchProfile({ platform: 'linux', env: { DISPLAY: ':0' } });

      for (const profile of [wayland, x11]) {
        expect(switchNames(profile)).toContain('disable-gpu-compositing');
        expect(profile.hardwareAcceleration).toBe(true);
      }
    });

    it('still asks for software compositing when acceleration is off', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-1' },
        config: { mode: 'disabled' },
      });

      expect(switchNames(profile)).toEqual([
        ...LINUX_GPU_SAFE_SWITCHES,
        ...LINUX_COMPOSITING_SWITCHES,
      ]);
    });

    it('adds only the compositing switch on an X11 session', () => {
      const profile = resolveLaunchProfile({ platform: 'linux', env: { DISPLAY: ':0' } });

      expect(profile.switches).toEqual([{ name: 'disable-gpu-compositing' }]);
      expect(profile.hardwareAcceleration).toBe(true);
    });
  });

  describe('modes', () => {
    it('auto and enabled keep acceleration on', () => {
      for (const mode of ['auto', 'enabled']) {
        const profile = resolveLaunchProfile({ platform: 'linux', config: { mode } });
        expect(profile.hardwareAcceleration, mode).toBe(true);
        expect(switchNames(profile), mode).toEqual(['disable-gpu-compositing']);
      }
    });

    it('disabled turns acceleration off and brings back all four Linux switches', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-0' },
        config: { mode: 'disabled' },
      });

      expect(profile.hardwareAcceleration).toBe(false);
      expect(switchNames(profile)).toEqual([
        ...LINUX_GPU_SAFE_SWITCHES,
        ...LINUX_COMPOSITING_SWITCHES,
      ]);
      expect(switchNames(profile)).not.toContain('ozone-platform');
    });

    it('falls back to auto for an unknown or missing mode', () => {
      expect(resolveLaunchProfile({ platform: 'linux', config: { mode: 'fallback' } }).mode).toBe(
        'auto'
      );
      expect(resolveLaunchProfile({ platform: 'linux', config: {} }).mode).toBe('auto');
      expect(resolveLaunchProfile({ platform: 'linux' }).mode).toBe('auto');
    });

    it('exposes exactly the three user-facing modes', () => {
      expect(GRAPHICS_MODES).toEqual(['auto', 'enabled', 'disabled']);
      expect(normalizeGraphicsMode('enabled')).toBe('enabled');
      expect(normalizeGraphicsMode(undefined)).toBe('auto');
    });
  });

  describe('other platforms', () => {
    for (const platform of ['win32', 'darwin']) {
      it(`${platform}: auto keeps acceleration on and adds no switches`, () => {
        const profile = resolveLaunchProfile({ platform, env: { WAYLAND_DISPLAY: 'x' } });

        expect(profile.hardwareAcceleration).toBe(true);
        expect(profile.switches).toEqual([]);
      });

      it(`${platform}: disabled turns acceleration off without Linux-only switches`, () => {
        const profile = resolveLaunchProfile({ platform, config: { mode: 'disabled' } });

        expect(profile.hardwareAcceleration).toBe(false);
        expect(profile.switches).toEqual([]);
      });
    }
  });

  describe('manual escape hatch', () => {
    it('honours DJMAN_GPU_SAFE=1 without changing the stored mode', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { DJMAN_GPU_SAFE: '1' },
        config: { mode: 'auto' },
      });

      expect(profile.hardwareAcceleration).toBe(false);
      expect(profile.gpuSafe).toBe(true);
      expect(profile.mode).toBe('auto');
      expect(switchNames(profile)).toEqual([
        ...LINUX_GPU_SAFE_SWITCHES,
        ...LINUX_COMPOSITING_SWITCHES,
      ]);
    });

    it('honours --gpu-safe on the command line', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        cliArgs: ['--gpu-safe'],
        config: { mode: 'enabled' },
      });

      expect(profile.hardwareAcceleration).toBe(false);
      expect(switchNames(profile)).toEqual([
        ...LINUX_GPU_SAFE_SWITCHES,
        ...LINUX_COMPOSITING_SWITCHES,
      ]);
    });

    it('ignores the escape hatch values other than 1', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { DJMAN_GPU_SAFE: '0' },
      });

      expect(profile.hardwareAcceleration).toBe(true);
      expect(profile.gpuSafe).toBe(false);
    });
  });

  describe('automatic fallback permission', () => {
    it('is allowed by default', () => {
      expect(shouldAllowAutomaticFallback({})).toBe(true);
      expect(resolveLaunchProfile({ platform: 'linux' }).allowAutomaticFallback).toBe(true);
    });

    it('is refused when --no-fallback-relaunch is passed', () => {
      expect(shouldAllowAutomaticFallback({ cliArgs: ['--no-fallback-relaunch'] })).toBe(false);
      expect(
        resolveLaunchProfile({ platform: 'linux', cliArgs: ['--no-fallback-relaunch'] })
          .allowAutomaticFallback
      ).toBe(false);
    });

    it('does not affect the acceleration decision itself', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        cliArgs: ['--no-fallback-relaunch'],
      });

      expect(profile.hardwareAcceleration).toBe(true);
    });
  });
});

describe('applyLaunchProfile', () => {
  function fakeApp() {
    return {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };
  }

  it('disables acceleration and forwards every switch', () => {
    const app = fakeApp();
    const profile = resolveLaunchProfile({ platform: 'linux', config: { mode: 'disabled' } });

    applyLaunchProfile(app, profile);

    expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce();
    expect(app.commandLine.appendSwitch.mock.calls).toEqual([
      ['disable-gpu'],
      ['disable-gpu-sandbox'],
      ['no-sandbox'],
      ['disable-gpu-compositing'],
    ]);
  });

  it('applies the resolved switches and nothing else', () => {
    const app = fakeApp();
    const profile = resolveLaunchProfile({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    });

    applyLaunchProfile(app, profile);

    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(app.commandLine.appendSwitch.mock.calls).toEqual([['disable-gpu-compositing']]);
  });

  it('leaves an enabled profile untouched', () => {
    const app = fakeApp();

    applyLaunchProfile(app, resolveLaunchProfile({ platform: 'win32' }));

    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('refuses to run without an app or a profile', () => {
    expect(() => applyLaunchProfile(null, {})).toThrow(/Electron app instance/);
    expect(() => applyLaunchProfile(fakeApp(), null)).toThrow(/resolved launch profile/);
  });
});

describe('readGraphicsConfig', () => {
  const dirs = [];
  function tmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-graphics-'));
    dirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(dir, payload) {
    fs.writeFileSync(
      graphicsConfigPath(dir),
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    );
  }

  it('defaults to auto when there is no file', () => {
    expect(readGraphicsConfig(tmp())).toMatchObject({ mode: 'auto' });
  });

  it('carries the recorded fallback, because the launch decision needs it', () => {
    const dir = tmp();
    write(dir, {
      mode: 'auto',
      fallback: { active: true, since: 5, reason: 'gpu-crash-loop', relaunchedAt: 5 },
    });

    const config = readGraphicsConfig(dir);
    expect(config.mode).toBe('auto');
    expect(config.fallback).toMatchObject({ active: true, reason: 'gpu-crash-loop' });
  });

  it('reads a stored mode', () => {
    const dir = tmp();
    write(dir, { mode: 'disabled' });

    expect(readGraphicsConfig(dir)).toMatchObject({ mode: 'disabled' });
  });

  it('treats corrupt JSON, unknown modes and junk as auto', () => {
    const corrupt = tmp();
    write(corrupt, '{not json');
    expect(readGraphicsConfig(corrupt)).toMatchObject({ mode: 'auto' });

    const unknown = tmp();
    write(unknown, { mode: 'turbo' });
    expect(readGraphicsConfig(unknown)).toMatchObject({ mode: 'auto' });

    const junk = tmp();
    write(junk, null);
    expect(readGraphicsConfig(junk)).toMatchObject({ mode: 'auto' });
  });

  it('ignores keys it does not own yet', () => {
    const dir = tmp();
    write(dir, { mode: 'enabled', fallback: { active: true } });

    expect(readGraphicsConfig(dir)).toMatchObject({ mode: 'enabled' });
  });

  describe('recorded fallback', () => {
    const activeFallback = { active: true, since: 1, reason: 'gpu-crash-loop', relaunchedAt: 1 };

    it('turns acceleration off when auto carries an active fallback', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-1' },
        config: { mode: 'auto', fallback: activeFallback },
      });

      expect(profile.hardwareAcceleration).toBe(false);
      expect(switchNames(profile)).toEqual([
        ...LINUX_GPU_SAFE_SWITCHES,
        ...LINUX_COMPOSITING_SWITCHES,
      ]);
    });

    it('lets a user who forced acceleration on override the fallback', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        config: { mode: 'enabled', fallback: activeFallback },
      });

      expect(profile.hardwareAcceleration).toBe(true);
    });

    it('applies on other platforms without the Linux switches', () => {
      const profile = resolveLaunchProfile({
        platform: 'win32',
        config: { mode: 'auto', fallback: activeFallback },
      });

      expect(profile.hardwareAcceleration).toBe(false);
      expect(profile.switches).toEqual([]);
    });

    it('does nothing when the fallback is not active', () => {
      const profile = resolveLaunchProfile({
        platform: 'linux',
        config: { mode: 'auto', fallback: { active: false } },
      });

      expect(profile.hardwareAcceleration).toBe(true);
    });
  });

  it('defaults to auto without a usable userData directory', () => {
    expect(readGraphicsConfig('')).toMatchObject({ mode: 'auto' });
    expect(readGraphicsConfig('relative/path')).toMatchObject({ mode: 'auto' });
    expect(readGraphicsConfig(undefined)).toMatchObject({ mode: 'auto' });
  });
});
