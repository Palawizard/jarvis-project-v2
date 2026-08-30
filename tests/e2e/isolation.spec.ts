import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { bootRuntime, credential, expect, headers, mutation, test } from './fixtures';

/**
 * Regressions for the E2E harness itself.
 *
 * These are the properties the flow specs rely on: a known starting state, an
 * API that is really there, and a runtime that cannot reach a real Jarvis home.
 * Run this file with `--repeat-each` and the first test fails the moment
 * fixture state survives a test.
 */

const FIXTURE_TITLE = 'Isolation fixture — exactly one of me must exist.';

test('every test starts from an empty Jarvis and its fixtures never accumulate', async ({
  page,
  app,
  request,
}) => {
  await app.open();
  const control = await credential(page);

  // Explicit known state, asserted rather than assumed: a runtime nobody has
  // used yet holds no Jobs, and none of this test's fixtures exist.
  const listJobs = async () =>
    (await request
      .get('/api/jobs?archived=all', { headers: headers(control) })
      .then((response) => response.json())) as Array<{ id: string; request: string }>;
  const listConversations = async () =>
    (await request
      .get('/api/conversations', { headers: headers(control) })
      .then((response) => response.json())) as Array<{ id: string; title: string | null }>;
  expect(await listJobs()).toEqual([]);
  expect((await listConversations()).filter((one) => one.title === FIXTURE_TITLE)).toEqual([]);

  const projects = (await request
    .get('/api/projects', { headers: headers(control) })
    .then((response) => response.json())) as Array<{ id: string; isSelf: boolean }>;
  const self = projects.find((project) => project.isSelf);
  expect(self, 'the Jarvis self project must be registered at boot').toBeTruthy();

  // Deterministic fixtures of the kind the flow specs create. Under
  // --repeat-each, a second copy of either means state leaked between
  // repetitions, whatever order the tests ran in.
  const conversation = await request.post('/api/conversations', {
    headers: mutation(app),
    data: { title: FIXTURE_TITLE },
  });
  expect(conversation.ok()).toBeTruthy();
  const job = await request.post('/api/jobs', {
    headers: mutation(app),
    data: {
      projectId: (self as { id: string }).id,
      request: FIXTURE_TITLE,
      acceptance: [],
      autostart: false,
    },
  });
  expect(job.ok()).toBeTruthy();

  expect((await listJobs()).filter((one) => one.request === FIXTURE_TITLE)).toHaveLength(1);
  expect((await listConversations()).filter((one) => one.title === FIXTURE_TITLE)).toHaveLength(1);

  // And the UI agrees: strict-mode violations are exactly how leaked state
  // showed up before every test got its own runtime.
  await page.reload();
  await expect(page.getByTestId('conversation-sidebar').getByText(FIXTURE_TITLE)).toHaveCount(1);
  await page.getByTestId('nav-jobs').click();
  await expect(page.getByTestId('jobs-view').getByText(FIXTURE_TITLE)).toHaveCount(1);
});

test('the E2E runtime cannot escape into a real Jarvis home', async ({ app, request }) => {
  await app.open();
  const health = (await request
    .get('/api/health', { headers: headers(app.control) })
    .then((response) => response.json())) as { artifactsDir: string };
  // Every byte this runtime writes lives in its own throwaway directory.
  const runtimes = path.resolve(process.cwd(), '.jarvis', 'e2e', 'runtimes');
  expect(path.resolve(health.artifactsDir).startsWith(runtimes + path.sep)).toBe(true);

  // And the runtime launcher refuses any home outside .jarvis/e2e, so no
  // isolation mechanism here can ever be pointed at a real Jarvis.
  const refused = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ['tests/e2e/start-server.mjs'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Deliberately not a real Jarvis home: if the guard ever regressed, this
      // launcher would wipe whatever it was pointed at.
      env: { ...process.env, JARVIS_HOME: path.join(os.tmpdir(), 'jarvis-e2e-guard-probe') },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('exit', (code) => resolve({ code, output }));
  });
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain('E2E runtime home must live under');
});

test('an orchestrator that disappears is reported as an API lifecycle failure', async () => {
  // A throwaway runtime, so the harness can be caught failing on purpose
  // without the per-test runtime being the victim.
  const runtime = await bootRuntime(`lifecycle-probe-${randomUUID()}`);
  await runtime.assertAlive();

  await runtime.stop();

  expect(runtime.death()).toContain('exited');
  await expect(runtime.assertAlive()).rejects.toThrow(/the Jarvis orchestrator must be reachable/i);
  expect(await fetch(`${runtime.origin}/health`).catch(() => null)).toBeNull();
});
