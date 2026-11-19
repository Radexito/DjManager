import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures.js';

/**
 * The fallback must be visible. These tests seed the graphics state the app
 * would have written after a GPU crash loop and check that a real Electron
 * window says so, instead of trusting the component tests alone.
 */
test.describe('graphics fallback notice', () => {
  let app, window, graphicsDir;

  test.beforeEach(async () => {
    graphicsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-e2e-graphics-'));
    fs.writeFileSync(
      path.join(graphicsDir, 'graphics.json'),
      JSON.stringify({
        mode: 'auto',
        fallback: {
          active: true,
          since: 1730000000000,
          reason: 'gpu-crash-loop',
          relaunchedAt: 1730000005000,
        },
        crashes: [
          { at: 1729999990000, type: 'GPU', reason: 'crashed', exitCode: 139 },
          { at: 1730000000000, type: 'GPU', reason: 'crashed', exitCode: 139 },
        ],
      }),
      'utf8'
    );

    ({ app, window } = await launchApp({ args: [`--user-data-dir=${graphicsDir}`] }));
    await expect(window.locator('.sidebar')).toBeVisible();
  });

  test.afterEach(async () => {
    await app?.close();
    fs.rmSync(graphicsDir, { recursive: true, force: true });
  });

  test('tells the user acceleration was disabled', async () => {
    const bar = window.locator('[data-testid="graphics-notice"]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(
      'Hardware acceleration was disabled because the GPU process crashed.'
    );
  });

  test('the details panel shows the recorded crashes', async () => {
    await window.locator('[data-testid="graphics-notice"]').getByRole('button').first().click();
    await expect(window.locator('[data-testid="graphics-notice-report"]')).toContainText(
      'Crashes recorded: 2'
    );
  });

  test('the settings section agrees that acceleration is off', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('open-settings');
    });
    await expect(window.locator('.settings-modal')).toBeVisible();
    await window.locator('.settings-nav-item', { hasText: 'Graphics' }).click();
    await expect(window.locator('[data-testid="graphics-fallback-note"]')).toContainText(
      'Acceleration is currently off'
    );
  });

  test('the bar can be dismissed for the session', async () => {
    await window.getByLabel('Dismiss graphics notice').click();
    await expect(window.locator('[data-testid="graphics-notice"]')).toHaveCount(0);
  });
});

/**
 * The launch profile is decided at module load, before Electron's `ready`, and
 * Electron ignores both the acceleration flag and the switches after that. These
 * tests read Chromium's own verdict, so moving the decision anywhere later turns
 * them red instead of silently leaving the GPU on.
 */
test.describe('launch profile reaches Chromium', () => {
  let app, window, dir;

  const seed = (config) => {
    if (!config) return;
    fs.writeFileSync(path.join(dir, 'graphics.json'), JSON.stringify(config), 'utf8');
  };

  const launch = async (config) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-e2e-profile-'));
    seed(config);
    ({ app, window } = await launchApp({ args: [`--user-data-dir=${dir}`] }));
    await expect(window.locator('.sidebar')).toBeVisible();
  };

  const gpuStatus = () => app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus());

  const webgl = () =>
    window.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      return gl ? 'context' : 'none';
    });

  test.afterEach(async () => {
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the disabled profile switches the GPU off before the window exists', async () => {
    await launch({ mode: 'disabled' });

    const status = await gpuStatus();
    expect(status.gpu_compositing).toBe('disabled_software');
    expect(status.webgl).toBe('disabled_off');
    expect(await webgl()).toBe('none');
  });

  test('the default profile keeps the GPU available', async () => {
    await launch(null);

    const status = await gpuStatus();
    // GitHub's runners have no GPU, so even the default profile cannot enable
    // WebGL there. Skipping is honest: the check cannot distinguish profiles on
    // a machine without a GPU, and pretending otherwise would just be green noise.
    test.skip(status.webgl === 'disabled_off', 'this runner has no GPU');
    expect(await webgl()).toBe('context');
  });
});
