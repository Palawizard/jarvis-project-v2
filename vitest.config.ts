import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
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
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
