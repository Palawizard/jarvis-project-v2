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
          // The self Visual QA catalog smoke boots a whole candidate Jarvis and
          // photographs every declared surface. It is real work, not waste, but
          // at ~135s it is longer than the rest of the suite put together and
          // it answers a question -- "is every catalogued screenshot state
          // still reachable in the real UI?" -- that only has to be answered
          // before a self-upgrade is approved, not on every inner-loop run.
          // It runs as its own project, gated by `pnpm verify:full`.
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'tests/integration/visualqa-catalog.test.ts',
          ],
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
      {
        test: {
          name: 'visual-catalog',
          include: ['tests/integration/visualqa-catalog.test.ts'],
          environment: 'node',
          // Last, and never alongside anything else: it runs a full candidate
          // runtime and a browser.
          sequence: { groupOrder: 2 },
          testTimeout: 420_000,
          hookTimeout: 420_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
