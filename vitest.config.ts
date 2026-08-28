import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    maxWorkers: 1,
    // Unit tests are fast and isolated; integration tests touch the filesystem,
    // git and (optionally) real agent CLIs, so they run serially and separately.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Must stay above the supervisor suite's own deadline, or vitest
          // kills the test before that deadline can report what went wrong.
          testTimeout: 420_000,
          hookTimeout: 420_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
