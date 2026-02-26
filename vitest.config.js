import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DB_PATH: ':memory:',
    },
    include: ['src/**/*.test.js'],
    setupFiles: ['./src/__tests__/setup.js'],
    coverage: {
      provider: 'v8',
      include: ['src/db/**/*.js'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 75,
        lines: 75,
      },
    },
  },
});
