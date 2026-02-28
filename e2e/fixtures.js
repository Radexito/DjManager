import { _electron as electron } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, '..');

/**
 * Launch the Electron app against the pre-built renderer.
 * Requires `npm run build-renderer` to have run first.
 */
export async function launchApp() {
  const app = await electron.launch({
    args: [appRoot],
    env: {
      ...process.env,
      E2E_TEST: '1',
      NODE_ENV: 'test',
      // Use an isolated in-memory DB so tests don't touch real library data
      DB_PATH: ':memory:',
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
