import { defineConfig } from '@playwright/test';

/**
 * There is no `webServer` here on purpose: each test boots its own isolated
 * orchestrator (see tests/e2e/fixtures.ts), which is what makes `--repeat-each`,
 * retries, test order and parallel workers safe, and what lets a dying API be
 * reported as a dying API instead of a missing element.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: '.jarvis/e2e-results',
  reporter: [['list'], ['html', { outputFolder: '.jarvis/e2e-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
