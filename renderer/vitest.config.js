import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    root: __dirname,
    environment: 'jsdom',
    globals: true,
    setupFiles: [resolve(__dirname, 'src/__tests__/setup.js')],
    include: ['src/**/*.test.{js,jsx}'],
  },
});
