import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: '.jarvis/e2e-results',
  reporter: [['list'], ['html', { outputFolder: '.jarvis/e2e-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4329',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node apps/orchestrator/dist/index.js',
    url: 'http://127.0.0.1:4329/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      JARVIS_HOME: path.resolve('.jarvis/e2e', String(process.pid)),
      JARVIS_PORT: '4329',
      JARVIS_EMBEDDINGS: 'off',
    },
  },
});
