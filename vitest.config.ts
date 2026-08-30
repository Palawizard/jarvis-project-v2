import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // Serial on purpose, and this is the stricter form of the concurrency
    // bound: the candidate/browser integration test builds and runs a whole
    // isolated Jarvis, and loses the machine to the process-heavy unit
    // project when they overlap. A self-upgrade gate has to be deterministic.
    maxWorkers: 1,
    fileParallelism: false,
    // Unit tests are fast and isolated; integration tests touch the filesystem,
    // git and (optionally) real agent CLIs, so they run serially and separately.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          sequence: { groupOrder: 0 },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Candidate/browser integration must not compete with the process-heavy unit project.
          sequence: { groupOrder: 1 },
          // Generous on purpose: these run real installs, builds, supervisors
          // and process trees, and they share the machine with the parallel
          // unit project. The budget is a guard against a genuine hang, not a
          // performance assertion about a loaded developer machine.
          testTimeout: 420_000,
          hookTimeout: 420_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
