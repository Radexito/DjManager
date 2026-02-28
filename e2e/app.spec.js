import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures.js';

test.describe('App launch', () => {
  let app, window;

  test.beforeEach(async () => {
    ({ app, window } = await launchApp());
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test('window is visible', async () => {
    expect(await app.windows()).toHaveLength(1);
    await expect(window.locator('body')).toBeVisible();
  });

  test('sidebar is rendered', async () => {
    await expect(window.locator('.sidebar')).toBeVisible();
  });

  test('Music menu item is present', async () => {
    await expect(window.locator('.menu-item', { hasText: 'Music' })).toBeVisible();
  });

  test('PLAYLISTS section header is present', async () => {
    await expect(window.locator('.section-title', { hasText: 'PLAYLISTS' })).toBeVisible();
  });

  test('Import Audio Files button is present', async () => {
    await expect(window.locator('.import-button')).toBeVisible();
  });

  test('empty playlists message is shown', async () => {
    await expect(window.locator('.playlists-empty')).toHaveText('No playlists yet');
  });

  test('main library view is rendered', async () => {
    await expect(window.locator('.app-main')).toBeVisible();
  });
});
