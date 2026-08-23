import { expect, test } from '@playwright/test';

test('command, projects, jobs and controllable memory work in the real UI', async ({
  page,
  request,
}, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()}`));

  await page.goto('/');
  await expect(page.getByText('Jarvis', { exact: true })).toBeVisible();
  await expect(page.getByText('jarvis', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('claude').locator('..')).toContainText(
    /available|unavailable|cooldown/,
  );

  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByText('jarvis', { exact: true }).first()).toBeVisible();

  const projectsResponse = await request.get('/api/projects');
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = (await projectsResponse.json()) as Array<{ id: string; isSelf: boolean }>;
  const self = projects.find((project) => project.isSelf);
  expect(self).toBeTruthy();
  if (!self) throw new Error('self project missing');

  const invalidMemory = await request.post('/api/memory', {
    data: { scope: 'project', kind: 'fact', content: 'missing project scope id' },
  });
  expect(invalidMemory.status()).toBe(400);

  const queued = await request.post('/api/jobs', {
    data: {
      projectId: self.id,
      request: 'Document the deterministic E2E smoke-test fixture.',
      acceptance: ['The queued job is visible without spending agent quota.'],
      autostart: false,
    },
  });
  expect(queued.ok()).toBeTruthy();

  await page.getByRole('button', { name: 'Jobs' }).click();
  await expect(
    page.getByText('Document the deterministic E2E smoke-test fixture.').first(),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Memory' }).click();
  await page.getByRole('button', { name: 'Add a memory' }).click();
  await page.getByLabel('Memory content').fill('E2E preference: keep bootstrap evidence concise.');
  await page.getByLabel('Subject key').fill('preference.e2e_evidence');
  await page.getByRole('button', { name: 'Store', exact: true }).click();
  await expect(page.getByText(/Stored\.|Already known/)).toBeVisible();
  await expect(
    page.locator('.mem-content', {
      hasText: 'E2E preference: keep bootstrap evidence concise.',
    }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Provenance' }).last().click();
  await expect(page.getByRole('cell', { name: 'user_explicit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).last().click();

  // The permission layer must be inspectable from the UI, not just from the API.
  await page.getByRole('button', { name: 'Tools' }).click();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();
  await expect(page.getByText('memory.purge')).toBeVisible();
  await expect(
    page.getByRole('row', { name: /memory\.purge/ }).getByText('asks you first'),
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: /memory\.search/ }).getByText('runs immediately'),
  ).toBeVisible();

  // A request may not name its own privileges: the risk ceiling can only tighten.
  const escalation = await request.post('/api/tools/memory.purge', {
    data: { input: { id: 'mem_missing' }, maxRisk: 'destructive' },
  });
  expect(escalation.ok()).toBeTruthy();
  const outcome = (await escalation.json()) as { status: string };
  expect(outcome.status).toBe('pending_approval');
  await expect(page.getByText('1 permission request')).toBeVisible();
  await page.getByRole('button', { name: 'Refuse' }).click();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('desktop-tools.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // The mobile sidebar scrolls on purpose; what must not regress is reaching
  // the Tools view from it at phone width.
  await page.getByRole('button', { name: 'Memory' }).click();
  const mobileTools = page.getByRole('button', { name: 'Tools' });
  await mobileTools.scrollIntoViewIfNeeded();
  await mobileTools.click();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();
  await expect(page.getByRole('row', { name: /memory\.purge/ }).first()).toBeVisible();
  await expect
    .poll(() => page.locator('main').evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-tools.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Memory' }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop-memory.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Command' }).click();
  await expect(page.getByLabel('Command input')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-command.png'), fullPage: true });

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
