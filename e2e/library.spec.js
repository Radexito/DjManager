import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures.js';

test.describe('Music library', () => {
  let app, window;

  test.beforeEach(async () => {
    ({ app, window } = await launchApp());
    await expect(window.locator('.music-library')).toBeVisible();
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test('column headers are visible', async () => {
    await expect(window.locator('.header-cell', { hasText: '#' })).toBeVisible();
    await expect(window.locator('.header-cell', { hasText: 'Title' })).toBeVisible();
    await expect(window.locator('.header-cell', { hasText: 'Artist' })).toBeVisible();
    await expect(window.locator('.header-cell', { hasText: 'BPM' })).toBeVisible();
    await expect(window.locator('.header-cell', { hasText: 'Key' })).toBeVisible();
    await expect(window.locator('.header-cell', { hasText: 'Loudness (LUFS)' })).toBeVisible();
  });

  test('search input is visible', async () => {
    await expect(window.locator('.search-input')).toBeVisible();
  });

  test('empty library shows no track rows', async () => {
    await expect(window.locator('.track-list')).toBeVisible();
    await expect(window.locator('.row')).toHaveCount(0);
  });

  test('clicking a column header sets sort indicator', async () => {
    const bpmHeader = window.locator('.header-cell', { hasText: 'BPM' });
    await bpmHeader.click();
    await expect(bpmHeader).toContainText('▲');
  });

  test('clicking same column header again reverses sort direction', async () => {
    const bpmHeader = window.locator('.header-cell', { hasText: 'BPM' });
    await bpmHeader.click();
    await expect(bpmHeader).toContainText('▲');
    await bpmHeader.click();
    await expect(bpmHeader).toContainText('▼');
  });
});
