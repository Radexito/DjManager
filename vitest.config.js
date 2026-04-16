import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/db/**/*.js'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 65,
        branches: 44,
        functions: 70,
        lines: 65,
      },
    },
    projects: [
      {
        // DB-backed tests — need the real SQLite setup
        test: {
          name: 'db',
          environment: 'node',
          env: { DB_PATH: ':memory:' },
          include: [
            'src/__tests__/trackRepository.test.js',
            'src/__tests__/playlistRepository.test.js',
            'src/__tests__/cuePointRepository.test.js',
          ],
          setupFiles: ['./src/__tests__/setup.js'],
        },
      },
      {
        // Unit tests — no SQLite, no setup file
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'src/__tests__/importManager.test.js',
            'src/__tests__/ytDlpManager.test.js',
            'src/__tests__/mediaServer.test.js',
            'src/__tests__/anlzWriter.test.js',
            'src/__tests__/waveformGenerator.test.js',
            'src/__tests__/resetCleanup.test.js',
            'src/__tests__/usbUtils.test.js',
            'src/__tests__/settingWriter.test.js',
            'src/__tests__/pdbWriter.test.js',
          ],
        },
      },
    ],
  },
});
