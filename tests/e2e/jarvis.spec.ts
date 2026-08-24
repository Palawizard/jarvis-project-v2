import http from 'node:http';
import { expect, test } from '@playwright/test';

test('command, projects, jobs and controllable memory work in the real UI', async ({
  page,
  request,
  context,
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
  const credential = await page.evaluate(() => localStorage.getItem('jarvis-human-control'));
  expect(credential).toBeTruthy();
  if (!credential) throw new Error('paired browser credential missing');
  const readHeaders = { 'x-jarvis-control': credential };
  const mutationHeaders = { ...readHeaders, origin: 'http://127.0.0.1:4329' };

  const candidateServer = http.createServer((_request, response) => {
    response.end('<!doctype html><title>candidate</title>');
  });
  await new Promise<void>((resolve) => candidateServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = candidateServer.address();
    if (!address || typeof address === 'string')
      throw new Error('candidate server address missing');
    const candidatePage = await context.newPage();
    await candidatePage.goto(`http://127.0.0.1:${address.port}`);
    expect(
      await candidatePage.evaluate(() => localStorage.getItem('jarvis-human-control')),
    ).toBeNull();
    expect(await candidatePage.context().cookies()).toEqual([]);
    await candidatePage.close();
  } finally {
    await new Promise<void>((resolve, reject) =>
      candidateServer.close((error) => (error ? reject(error) : resolve())),
    );
  }

  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByText('jarvis', { exact: true }).first()).toBeVisible();

  const projectsResponse = await request.get('/api/projects', { headers: readHeaders });
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = (await projectsResponse.json()) as Array<{ id: string; isSelf: boolean }>;
  const self = projects.find((project) => project.isSelf);
  expect(self).toBeTruthy();
  if (!self) throw new Error('self project missing');

  const invalidMemory = await request.post('/api/memory', {
    headers: mutationHeaders,
    data: { scope: 'project', kind: 'fact', content: 'missing project scope id' },
  });
  expect(invalidMemory.status()).toBe(400);

  const queued = await request.post('/api/jobs', {
    headers: mutationHeaders,
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
  await page.getByTestId('nav-tools').click();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();
  const purgeRow = page
    .getByRole('row')
    .filter({ has: page.getByText('memory.purge', { exact: true }) });
  await expect(purgeRow.getByText('memory.purge', { exact: true })).toBeVisible();
  await expect(purgeRow.getByText('asks you first')).toBeVisible();
  await expect(
    page.getByRole('row', { name: /memory\.search/ }).getByText('runs immediately'),
  ).toBeVisible();

  // A request may not name its own privileges: the risk ceiling can only tighten.
  const escalation = await request.post('/api/tools/memory.purge', {
    headers: mutationHeaders,
    data: { input: { id: 'mem_missing' }, maxRisk: 'destructive' },
  });
  expect(escalation.ok()).toBeTruthy();
  const outcome = (await escalation.json()) as { status: string };
  expect(outcome.status).toBe('pending_approval');
  await expect(page.getByText('1 permission request')).toBeVisible();
  await page.getByRole('button', { name: 'Refuse' }).click();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();

  await expect(page.getByTestId('tools-view')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-tools.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  // The mobile nav is a horizontal scroller by design, so its content may be
  // wider than the bar. What must hold is that the bar is sized by its own
  // content: when it is left to absorb the grid row's spare height, the pills
  // stretch to fill it, and the active one grows until its rounded top edge is
  // flush against the viewport.
  const measureNav = () =>
    page.locator('.sidebar .nav-item.active').evaluate((node) => {
      const bar = node.closest('.sidebar') as HTMLElement;
      const item = node.getBoundingClientRect();
      const rail = bar.getBoundingClientRect();
      return {
        label: node.textContent ?? '',
        itemHeight: item.height,
        top: item.top,
        bottom: item.bottom,
        railTop: rail.top,
        railHeight: rail.height,
        radius: parseFloat(getComputedStyle(node).borderTopLeftRadius),
        viewport: window.innerHeight,
      };
    });

  // Reload rather than navigate: on a fresh load the header carries only the
  // title, the project selector and the theme toggle, which is the state the
  // responsive layout has to read well in.
  await page.reload();
  await expect(page.getByLabel('Command input')).toBeVisible();
  const shortPage = await measureNav();
  expect(shortPage.label).toContain('Command');
  expect(shortPage.radius).toBeGreaterThan(0);
  // Fully inside the viewport, and strictly inset from the bar's top edge so
  // the corner curve has room to render.
  expect(shortPage.top).toBeGreaterThan(shortPage.railTop);
  expect(shortPage.top).toBeGreaterThanOrEqual(0);
  expect(shortPage.bottom).toBeLessThanOrEqual(shortPage.viewport);

  // The header is a deliberate two-row layout at phone width: the title owns
  // the first row, and the project selector and theme toggle share the second.
  // An orphaned toggle on a row of its own is the regression this catches.
  const header = await page.locator('.topbar').evaluate((bar) => {
    // Spread the rect: a DOMRect's properties live on its prototype and would
    // cross the page boundary as an empty object.
    const box = (selector: string) => {
      const { top, bottom, left, right } = (
        bar.querySelector(selector) as HTMLElement
      ).getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      title: box('h1'),
      project: box('.topbar-project'),
      toggle: box('.theme-toggle'),
      viewport: window.innerWidth,
    };
  });
  expect(header.title.bottom).toBeLessThanOrEqual(header.project.top);
  // Same row: their vertical spans overlap rather than stacking.
  expect(header.toggle.top).toBeLessThan(header.project.bottom);
  expect(header.toggle.bottom).toBeGreaterThan(header.project.top);
  expect(header.toggle.left).toBeGreaterThan(header.project.right);
  expect(header.toggle.right).toBeLessThanOrEqual(header.viewport);

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  // Reaching Tools must not depend on the whole nav fitting at once.
  await page.getByRole('button', { name: 'Memory' }).click();
  const mobileTools = page.getByTestId('nav-tools');
  await mobileTools.scrollIntoViewIfNeeded();
  await mobileTools.click();
  await expect(page.getByTestId('tools-view')).toBeVisible();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();
  await expect(page.getByRole('row', { name: /memory\.purge/ }).first()).toBeVisible();

  // Tools is a long page and Command is a short one. If the nav bar is content
  // sized, both look identical; if it absorbs the leftover height it balloons
  // on whichever page is shorter.
  const longPage = await measureNav();
  expect(longPage.railHeight).toBeCloseTo(shortPage.railHeight, 0);
  expect(longPage.itemHeight).toBeCloseTo(shortPage.itemHeight, 0);

  // Wide tables scroll inside their own box; the page itself does not.
  await expect
    .poll(() => page.locator('main').evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const localScroll = await page
    .locator('.table-scroll')
    .first()
    .evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(localScroll).toBe(true);

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
