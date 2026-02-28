import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures.js';

test.describe('Playlist management', () => {
  let app, window;

  test.beforeEach(async () => {
    ({ app, window } = await launchApp());
    // Ensure sidebar is ready
    await expect(window.locator('.sidebar')).toBeVisible();
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('can create a playlist', async () => {
    await window.locator('.new-playlist-btn').click();
    await window.locator('.playlist-rename-input').fill('My Test Playlist');
    await window.locator('.playlist-rename-input').press('Enter');

    await expect(window.locator('.playlist-name', { hasText: 'My Test Playlist' })).toBeVisible();
  });

  test('can rename a playlist', async () => {
    // Create one first
    await window.locator('.new-playlist-btn').click();
    await window.locator('.playlist-rename-input').fill('Original Name');
    await window.locator('.playlist-rename-input').press('Enter');
    await expect(window.locator('.playlist-name', { hasText: 'Original Name' })).toBeVisible();

    // Right-click to open context menu
    await window.locator('.playlist-item', { hasText: 'Original Name' }).click({ button: 'right' });
    await window.locator('.context-menu-item', { hasText: 'Rename' }).click();

    // Clear and type new name
    const renameInput = window.locator('.playlist-rename-input');
    await renameInput.clear();
    await renameInput.fill('Renamed Playlist');
    await renameInput.press('Enter');

    await expect(window.locator('.playlist-name', { hasText: 'Renamed Playlist' })).toBeVisible();
    await expect(window.locator('.playlist-name', { hasText: 'Original Name' })).not.toBeVisible();
  });

  test('can delete a playlist', async () => {
    // Create one first
    await window.locator('.new-playlist-btn').click();
    await window.locator('.playlist-rename-input').fill('Delete Me');
    await window.locator('.playlist-rename-input').press('Enter');
    await expect(window.locator('.playlist-name', { hasText: 'Delete Me' })).toBeVisible();

    // Right-click → delete
    await window.locator('.playlist-item', { hasText: 'Delete Me' }).click({ button: 'right' });

    // Handle the window.confirm dialog
    window.on('dialog', (dialog) => dialog.accept());
    await window.locator('.context-menu-item--danger', { hasText: 'Delete playlist' }).click();

    await expect(window.locator('.playlist-name', { hasText: 'Delete Me' })).not.toBeVisible();
  });

  test('selecting a playlist highlights it', async () => {
    await window.locator('.new-playlist-btn').click();
    await window.locator('.playlist-rename-input').fill('Select Me');
    await window.locator('.playlist-rename-input').press('Enter');

    const item = window.locator('.playlist-item', { hasText: 'Select Me' });
    await item.click();
    await expect(item).toHaveClass(/active/);
  });
});
