import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures.js';

test.describe('Settings modal', () => {
  let app, window;

  test.beforeEach(async () => {
    ({ app, window } = await launchApp());
    await expect(window.locator('.sidebar')).toBeVisible();
  });

  test.afterEach(async () => {
    await app?.close();
  });

  /** Trigger the settings modal via the main-process IPC event. */
  async function openSettings(appHandle, win) {
    await appHandle.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('open-settings');
    });
    await expect(win.locator('.settings-modal')).toBeVisible();
  }

  test('settings modal opens via IPC', async () => {
    await openSettings(app, window);
  });

  test('settings modal has title "Settings"', async () => {
    await openSettings(app, window);
    await expect(window.locator('.settings-title')).toHaveText('Settings');
  });

  test('settings modal closes when clicking the backdrop', async () => {
    await openSettings(app, window);
    await window.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(window.locator('.settings-modal')).not.toBeVisible();
  });

  test('settings modal closes on Escape key', async () => {
    await openSettings(app, window);
    await window.keyboard.press('Escape');
    await expect(window.locator('.settings-modal')).not.toBeVisible();
  });
});
