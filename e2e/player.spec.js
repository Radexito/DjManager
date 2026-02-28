import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures.js';

test.describe('Player bar', () => {
  let app, window;

  test.beforeEach(async () => {
    ({ app, window } = await launchApp());
    await expect(window.locator('.player-bar')).toBeVisible();
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test('player bar is rendered', async () => {
    await expect(window.locator('.player-bar')).toBeVisible();
  });

  test('play button is visible', async () => {
    await expect(window.locator('.player-btn--play')).toBeVisible();
  });

  test('shows idle state when no track is playing', async () => {
    await expect(window.locator('.player-idle')).toHaveText('No track playing');
  });

  test('seek bar is rendered', async () => {
    await expect(window.locator('.player-seekbar')).toBeVisible();
  });
});
