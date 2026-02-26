import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DB_PATH: ':memory:',
    },
    include: ['src/**/*.test.js'],
    setupFiles: ['./src/__tests__/setup.js'],
  },
});
