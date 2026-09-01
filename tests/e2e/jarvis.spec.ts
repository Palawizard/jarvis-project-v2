import http from 'node:http';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { credential, expect, headers, mutation, test, type App } from './fixtures';

/**
 * End-to-end flows for the conversational Jarvis.
 *
 * Each test runs against its own orchestrator, database and port (see
 * fixtures.ts), so nothing here depends on what another test did or on how
 * often the suite is repeated.
 *
 * The chat provider is a deterministic fake (tests/e2e/fake-claude.js) wired in
 * through JARVIS_CLAUDE_BIN, so no live agent runs and no subscription quota is
 * spent. Markers in the user's message pick the scripted reply.
 */

/** Start a fresh conversation and return its id from the URL. */
async function newChat(page: Page): Promise<string> {
  // Opening Jarvis already puts a conversation in the URL, so waiting for
  // "some /chat/<id>" would return the previous one. Wait for it to change.
  const before = new URL(page.url()).pathname;
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  await expect
    .poll(() => {
      const pathname = new URL(page.url()).pathname;
      return /^\/chat\/.+/.test(pathname) && pathname !== before;
    })
    .toBe(true);
  return new URL(page.url()).pathname.split('/')[2] as string;
}

/**
 * Wait until the turn in flight has finished.
 *
 * The composer shows Stop while Jarvis is working and Send when it is not, so
 * this is the UI's own statement that the turn is over. Every assertion that
 * something did NOT happen needs it: without it, "no Job exists" can just mean
 * "no Job exists yet", and routing now takes two provider runs before anything
 * is created.
 */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function send(page: Page, text: string): Promise<void> {
  // Wait until no response is in flight: the composer shows Stop instead of
  // Send while one is. Then send with Enter, the documented primary
  // interaction — the button itself can still be moving while the transcript
  // smooth-scrolls, and clicking it would race that animation.
  const sendButton = page.getByRole('button', { name: 'Send', exact: true });
  await expect(sendButton).toBeVisible({ timeout: 60_000 });
  const composer = page.getByLabel('Message Jarvis');
  await composer.fill(text);
  // Send stays disabled until React has the draft, so this is the signal that
  // the keypress will actually submit something.
  await expect(sendButton).toBeEnabled();
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
}

/**
 * Open a row's `•••` menu idempotently.
 *
 * The menu is a native <details>, which stays open after an item is clicked, so
 * blindly clicking the summary again would close it instead.
 */
async function openMenu(row: Locator): Promise<void> {
  const details = row.locator('details.item-menu');
  if (await details.evaluate((node: HTMLDetailsElement) => node.open)) return;
  await details.locator('summary').click();
  await expect(details.locator('[role=menu]')).toBeVisible();
}

/**
 * The sidebar row for one conversation, addressed by its id.
 *
 * Titles are human text and the product allows duplicates, so a title is an
 * assertion about a row, never the way to find it.
 */
function conversationRow(page: Page, conversationId: string): Locator {
  return page.getByTestId(`conversation-row-${conversationId}`);
}

/**
 * Actually stop a running Job.
 *
 * `job.cancel` is a sensitive tool, so the API only *requests* it: the answer is
 * a 200 carrying `pending_approval`, and the pipeline keeps going until a human
 * approves. A test that checks only `response.ok()` therefore leaves the Job
 * running. This does what the human does, then waits for the pipeline to
 * actually reach `cancelled` — a Job that is merely not running *yet* is a Job
 * that will still be creating worktrees and spawning builds after the test ends.
 */
async function stopJob(request: APIRequestContext, app: App, jobId: string): Promise<void> {
  const requested = await request.post(`/api/jobs/${jobId}/cancel`, { headers: mutation(app) });
  expect(requested.ok()).toBeTruthy();
  const outcome = (await requested.json()) as {
    status: string;
    execution: { id: string };
  };
  if (outcome.status === 'pending_approval') {
    const approved = await request.post(`/api/tool-executions/${outcome.execution.id}/approve`, {
      headers: mutation(app),
    });
    expect(approved.ok()).toBeTruthy();
    expect((await approved.json()) as { result: { cancelled: boolean } }).toMatchObject({
      result: { cancelled: true },
    });
  } else {
    expect(outcome.status).toBe('succeeded');
  }
  await expect
    .poll(
      async () => {
        const detail = (await request
          .get(`/api/jobs/${jobId}`, { headers: headers(app.control) })
          .then((response) => response.json())) as {
          job: { status: string };
          running: boolean;
        };
        return `${detail.job.status}/${detail.running ? 'in-pipeline' : 'stopped'}`;
      },
      { timeout: 60_000, message: 'the cancelled Job must reach a terminal state' },
    )
    .toBe('cancelled/stopped');
}

async function selfProject(request: APIRequestContext, control: string) {
  const response = await request.get('/api/projects', { headers: headers(control) });
  expect(response.ok()).toBeTruthy();
  const projects = (await response.json()) as Array<{ id: string; isSelf: boolean; name: string }>;
  const self = projects.find((project) => project.isSelf);
  expect(self, 'the Jarvis self project must be registered at boot').toBeTruthy();
  return self as { id: string; isSelf: boolean; name: string };
}

test('FLOW A — Jarvis opens as a chat assistant and ordinary talk creates no Job', async ({
  page,
  app,
  request,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await app.open();
  // The front door is a conversation, not a project chooser.
  await expect(page.getByTestId('chat-view')).toBeVisible();
  await expect(page.getByTestId('conversation-sidebar')).toBeVisible();
  const control = await credential(page);

  const conversationId = await newChat(page);
  await send(page, 'Explain TCP slow start. E2E-NORMAL-QUESTION');

  await expect(page.getByTestId('chat-view').getByText('congestion window')).toBeVisible();
  // No project was selected and no Job was manufactured.
  const jobs = await request
    .get(`/api/jobs?sessionId=${conversationId}&archived=all`, { headers: headers(control) })
    .then((response) => response.json());
  expect(jobs).toEqual([]);

  // The first user message names the conversation, deterministically.
  await expect(
    page.getByTestId('conversation-sidebar').locator('.conversation-title', {
      hasText: 'Explain TCP slow start.',
    }),
  ).toBeVisible();

  // Rename.
  const row = conversationRow(page, conversationId);
  await openMenu(row);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Conversation title').fill('Networking notes');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(row.locator('.conversation-title')).toHaveText('Networking notes');

  // Archive, then find it again under archived, then bring it back.
  await openMenu(row);
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(row).toHaveCount(0);

  await page.getByRole('button', { name: 'Archived conversations' }).click();
  await expect(row).toBeVisible();
  await openMenu(row);
  await page.getByRole('menuitem', { name: 'Unarchive' }).click();
  await page.getByRole('button', { name: '← Recent conversations' }).click();
  await expect(row).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test('FLOW A2 — the destructive confirmation says what goes and what stays', async ({
  page,
  app,
}) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const conversationId = await newChat(page);
  await send(page, 'A conversation to delete. E2E-NORMAL-QUESTION');
  await expect(page.getByTestId('chat-view').getByText('congestion window')).toBeVisible();

  await openMenu(conversationRow(page, conversationId));
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  // Really modal: backdrop, focus trap and native Escape, not `<dialog open>`.
  expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
  await expect(dialog).toContainText('Will remove');
  await expect(dialog).toContainText('its transcript');
  await expect(dialog).toContainText('Will preserve');
  await expect(dialog).toContainText('Jobs created from it');
  await expect(dialog).toContainText('irreversible');

  // Escape closes it and nothing is destroyed.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(conversationRow(page, conversationId)).toBeVisible();
});

/**
 * The regression this flow exists for.
 *
 * A real user typed this shape of message into a new conversation and got no
 * Job: the conversational provider explored its own empty scratch directory and
 * asked where the Jarvis repository was. Trusted code now recognises an explicit
 * imperative development request, resolves the registered project itself, and
 * creates exactly one Job — the conversational provider is never consulted.
 */
test('FLOW B — a coding request resolves the project and shows a live Job card', async ({
  page,
  app,
  request,
}) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const control = await credential(page);
  const self = await selfProject(request, control);

  const conversationId = await newChat(page);
  // No project chooser is touched, and no path is ever asked for: the sentence
  // names Jarvis, and Jarvis is a registered project.
  await send(
    page,
    'code sur le projet Jarvis une nouvelle implémentation : rends la navigation mobile ' +
      'atteignable. E2E-ROUTE-JARVIS',
  );

  const card = page.locator('.job-card').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('navigation mobile');
  // Nothing asked the human where the repository is, and no confirmation stood
  // between the instruction and the work.
  await expect(page.getByTestId('confirm-dialog')).toBeHidden();
  await expect(page.getByTestId('chat-view')).not.toContainText('chat-scratch');

  const jobs = (await request
    .get(`/api/jobs?sessionId=${conversationId}&archived=all`, { headers: headers(control) })
    .then((response) => response.json())) as Array<{
    id: string;
    projectId: string;
    sessionId: string;
    request: string;
    originMessageId: string | null;
  }>;
  expect(jobs).toHaveLength(1);
  const job = jobs[0] as (typeof jobs)[number];
  // Provenance: resolved project, source conversation, originating message.
  expect(job.projectId).toBe(self.id);
  expect(job.sessionId).toBe(conversationId);
  expect(job.originMessageId).toBeTruthy();

  // The conversation stays usable while the Job runs in the background.
  await expect(page.getByLabel('Message Jarvis')).toBeEnabled();

  // Stop the real pipeline this flow deliberately started, before doing
  // anything else: this Job builds, tests and verifies Jarvis itself in a
  // worktree, and left running it would run a whole nested `pnpm verify`
  // underneath the rest of the suite. The Job, its card and its provenance all
  // remain.
  await stopJob(request, app, job.id);

  // A follow-up resolves the linked Job without naming it.
  await send(page, 'How is that job doing? E2E-INSPECT-JOB');
  await expect(page.getByTestId('chat-view').getByText('navigation mobile').last()).toBeVisible({
    timeout: 30_000,
  });

  // Opening the card navigates to the Job.
  await page.locator('.job-card').first().click();
  await expect(page.getByTestId('job-detail-view')).toBeVisible();
});

/**
 * The other authority statement, kept beside FLOW B on purpose.
 *
 * FLOW B is the semantic route: two independent tool-free classifiers agree the
 * message names a repository to change, trusted code resolves the row, and the
 * Job starts. Here routing returns ordinary conversation, so the message reaches
 * the conversational model — and a model-emitted `create_job` is that model's
 * inference about what was wanted, which stops at a confirmation it cannot
 * answer itself.
 */
test('FLOW B2 — a Job the MODEL asks for still needs the human', async ({ page, app, request }) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const control = await credential(page);
  await selfProject(request, control);

  const conversationId = await newChat(page);
  await send(page, 'Something really should be done about the mobile nav. E2E-CREATE-SELF-JOB');

  const review = page.getByTestId(/^review-confirmation-/);
  await expect(review).toBeVisible({ timeout: 30_000 });
  // Nothing has started yet.
  const before = (await request
    .get(`/api/jobs?sessionId=${conversationId}&archived=all`, { headers: headers(control) })
    .then((response) => response.json())) as unknown[];
  expect(before).toHaveLength(0);

  await review.click();
  const confirmation = page.getByTestId('confirm-dialog');
  await expect(confirmation).toBeVisible();
  // The human must be able to see WHAT is about to run, not just which tool.
  await expect(confirmation).toContainText('Fix the mobile nav');
  await confirmation.getByRole('button', { name: 'Confirm and run' }).click();
  await expect(confirmation).toBeHidden();

  const card = page.locator('.job-card').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const jobs = (await request
    .get(`/api/jobs?sessionId=${conversationId}&archived=all`, { headers: headers(control) })
    .then((response) => response.json())) as Array<{ id: string }>;
  expect(jobs).toHaveLength(1);
  await stopJob(request, app, (jobs[0] as { id: string }).id);
});

/**
 * The three outcomes of routing, driven through the real UI.
 *
 * The semantic matrix — which sentences mean "change this repository" — lives in
 * the unit tests, where a scripted classifier makes what is being asserted
 * explicit. What only the browser can show is this: a Job card appears when both
 * classifiers agree, a question appears when they do not, and an answer appears
 * when the message was never about changing code. In none of the last two does
 * a Job exist.
 */
test('FLOW B3 — routing reaches exactly one of three outcomes', async ({ page, app, request }) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const control = await credential(page);
  const self = await selfProject(request, control);

  const jobsNow = async (conversationId: string) =>
    (await request
      .get(`/api/jobs?sessionId=${conversationId}&archived=all`, { headers: headers(control) })
      .then((response) => response.json())) as Array<{ id: string; projectId: string }>;

  // A — both classifiers agree on the repository: exactly one Job, started.
  const building = await newChat(page);
  await send(
    page,
    'code sur le projet Jarvis une nouvelle implémentation : ajoute un commentaire de test. ' +
      'E2E-ROUTE-JARVIS',
  );
  await expect(page.locator('.job-card').first()).toBeVisible({ timeout: 30_000 });
  const started = await jobsNow(building);
  expect(started).toHaveLength(1);
  expect((started[0] as { projectId: string }).projectId).toBe(self.id);
  await expect(page.getByTestId('chat-view')).not.toContainText('chat-scratch');
  await stopJob(request, app, (started[0] as { id: string }).id);

  // B — a change is wanted, but not clearly to a registered repository. The
  // question is asked in the transcript, nothing is created, and the registered
  // projects are offered as exact choices. Clicking one is the human naming the
  // repository, which needs no classifier at all — so it is the deterministic
  // way out of a question a model might otherwise keep asking.
  const plugin = await newChat(page);
  await send(page, 'crée un plugin pour Jarvis E2E-ROUTE-CLARIFY');
  await expect(page.getByTestId('chat-view')).toContainText(/which repository/i, {
    timeout: 30_000,
  });
  await settled(page);
  expect(await jobsNow(plugin)).toHaveLength(0);

  await page.getByTestId(`target-choice-${self.id}`).first().click();
  await expect.poll(async () => (await jobsNow(plugin)).length, { timeout: 30_000 }).toBe(1);
  const chosen = await jobsNow(plugin);
  expect((chosen[0] as { projectId: string }).projectId).toBe(self.id);
  // The Job lands in the transcript, and the choices go away with it. Started
  // work that leaves no trace reads as a button that did nothing, and the
  // obvious response to that is to press it again.
  await expect(page.locator('.job-card').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`target-choice-${self.id}`)).toBeHidden();
  expect(await jobsNow(plugin)).toHaveLength(1);
  await stopJob(request, app, (chosen[0] as { id: string }).id);

  // C — the project is the subject, not the target. An ordinary answer.
  const article = await newChat(page);
  await send(page, 'write an article on Jarvis');
  await settled(page);
  expect(await jobsNow(article)).toHaveLength(0);

  // D — management. A registry operation must never become a coding Job, and
  // the routing fixture really returns project_management here rather than
  // reaching the same outcome by another road.
  const registry = await newChat(page);
  await send(page, 'archive the Jarvis project E2E-ROUTE-MANAGE E2E-NORMAL-QUESTION');
  await settled(page);
  expect(await jobsNow(registry)).toHaveLength(0);

  // E — a question about where the project is, answered from the registry
  // rather than by sending a model looking for a repository it cannot reach.
  const where = await newChat(page);
  await send(page, 'où est le projet Jarvis ? E2E-WHERE-IS-JARVIS');
  await expect(page.getByTestId('chat-view')).toContainText('registered at the path', {
    timeout: 30_000,
  });
  expect(await jobsNow(where)).toHaveLength(0);

  // And a question about how to build something stays conversation.
  const how = await newChat(page);
  await send(page, 'comment coder un plugin pour Jarvis ? E2E-HOW-TO-PLUGIN');
  await expect(page.getByTestId('chat-view')).toContainText('provider adapter interface', {
    timeout: 30_000,
  });
  expect(await jobsNow(how)).toHaveLength(0);
});

/**
 * Affinity improves interpretation; it is not standing permission to code — the
 * difference between "implémente ça" and "crée une facture pour ce client" in
 * the same project-bound conversation.
 */
test('FLOW B4 — affinity is a hint, not permission', async ({ page, app, request }) => {
  await app.open();
  const control = await credential(page);
  const self = await selfProject(request, control);

  const jobsNow = async (conversationId: string) =>
    (await request
      .get(`/api/jobs?sessionId=${conversationId}&archived=all`, { headers: headers(control) })
      .then((response) => response.json())) as Array<{ id: string; projectId: string }>;

  // Bind the conversation to Jarvis the trusted way: by starting a Job in it.
  const conversationId = await newChat(page);
  await send(page, 'fix the mobile nav in the Jarvis repo. E2E-ROUTE-JARVIS');
  await expect(page.locator('.job-card').first()).toBeVisible({ timeout: 30_000 });
  const first = await jobsNow(conversationId);
  expect(first).toHaveLength(1);
  await stopJob(request, app, (first[0] as { id: string }).id);

  // Work for a client, in a conversation about Jarvis, is still not work on
  // Jarvis: the Job count does not move.
  await send(page, 'crée une facture pour ce client');
  await settled(page);
  expect(await jobsNow(conversationId)).toHaveLength(1);

  await send(page, 'crée cette page pour le client Dupont');
  await settled(page);
  expect(await jobsNow(conversationId)).toHaveLength(1);

  // An instruction that points back at the conversation's project does. Polled
  // on the Jobs themselves rather than on a card count: one Job already renders
  // a card against both its user and its assistant message, so "a second card
  // is visible" was true before the second Job existed.
  await send(page, 'implémente ça. E2E-ROUTE-JARVIS');
  await expect
    .poll(async () => (await jobsNow(conversationId)).length, { timeout: 30_000 })
    .toBe(2);
  const both = await jobsNow(conversationId);
  for (const job of both) expect(job.projectId).toBe(self.id);
  // Only the new one: the first was already stopped above, and stopping a
  // cancelled Job is not a no-op the helper accepts.
  const fresh = both.find((job) => job.id !== (first[0] as { id: string }).id);
  await stopJob(request, app, (fresh as { id: string }).id);
});

test('FLOW C — Projects and Jobs are real management surfaces', async ({ page, app, request }) => {
  await app.open();
  const control = await credential(page);
  const self = await selfProject(request, control);

  const queued = await request.post('/api/jobs', {
    headers: mutation(app),
    data: {
      projectId: self.id,
      request: 'Document the deterministic E2E management fixture.',
      acceptance: ['it is visible without spending agent quota'],
      autostart: false,
    },
  });
  expect(queued.ok()).toBeTruthy();
  // The Job row is addressed by its id: the request text is display text, and
  // the product does not promise it is unique.
  const jobRow = page.getByTestId(`job-row-${((await queued.json()) as { id: string }).id}`);

  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('projects-view')).toBeVisible();
  // Registering a project offers the analysis, explains what it costs, and does
  // not make it a precondition.
  const analyseOnAdd = page.getByTestId('analyze-on-add');
  await expect(analyseOnAdd).toBeVisible();
  await expect(analyseOnAdd.getByRole('checkbox')).toBeChecked();
  await expect(analyseOnAdd).toContainText('Analyse the project');
  await page.getByLabel('Search projects').fill('jarvis');
  await expect(page.getByRole('cell', { name: /jarvis/ }).first()).toBeVisible();
  await page.getByLabel('Search projects').fill('no-such-project-anywhere');
  await expect(page.getByText('No projects match.')).toBeVisible();
  await page.getByLabel('Search projects').fill('');

  // The self project is protected from unregistration in the UI itself.
  const selfRow = page
    .getByTestId('projects-view')
    .locator('tr')
    .filter({ hasText: 'self' })
    .first();
  await selfRow.locator('details.item-menu summary').click();
  await expect(selfRow.getByRole('button', { name: 'Unregister' })).toBeDisabled();

  // The project page offers analysis as a first-class action and says honestly
  // that nothing has been read yet.
  await page
    .getByTestId('projects-view')
    .locator('tr')
    .filter({ hasText: 'self' })
    .first()
    .getByRole('cell')
    .first()
    .click();
  await expect(page.getByTestId('analyze-project').first()).toContainText('Analyse project');
  await expect(page.getByTestId('analysis-status')).toContainText('not analysed');

  await page.getByTestId('nav-jobs').click();
  await expect(page.getByTestId('jobs-view')).toBeVisible();
  await expect(jobRow).toContainText('Document the deterministic E2E management fixture.');

  // Filters narrow the list rather than reloading a different page.
  await page.getByLabel('Search Jobs').fill('deterministic E2E management');
  await expect(jobRow).toBeVisible();
  await page.getByLabel('Search Jobs').fill('a phrase that matches nothing at all');
  await expect(jobRow).toHaveCount(0);
  await page.getByLabel('Search Jobs').fill('');
  await page.getByLabel('Filter Jobs by status').selectOption('completed');
  await expect(jobRow).toHaveCount(0);
  await page.getByLabel('Filter Jobs by status').selectOption('');
  await expect(jobRow).toBeVisible();
});

test('FLOW D — conversations and transcripts survive a reload', async ({ page, app, request }) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const control = await credential(page);

  const first = await newChat(page);
  await send(page, 'First persisted conversation. E2E-NORMAL-QUESTION');
  await expect(page.getByTestId('chat-view').getByText('congestion window')).toBeVisible();

  const second = await newChat(page);
  await send(page, 'Second persisted conversation. E2E-MARKDOWN');
  // Markdown renders as structure, and never as injected HTML.
  await expect(page.locator('.markdown h2').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.markdown table').first()).toBeVisible();
  await expect(page.locator('.markdown pre code').first()).toBeVisible();

  // A deep link survives a full page load, and so does the transcript.
  await page.goto(`/chat/${first}`);
  await expect(page.getByTestId('chat-view').getByText('congestion window')).toBeVisible();
  await expect(
    page.getByTestId('chat-view').getByText('First persisted conversation.').first(),
  ).toBeVisible();

  // Back/forward navigation works.
  await page.goto(`/chat/${second}`);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/chat/${first}`);

  const listed = (await request
    .get('/api/conversations', { headers: headers(control) })
    .then((response) => response.json())) as Array<{ id: string }>;
  expect(listed.map((conversation) => conversation.id)).toEqual(
    expect.arrayContaining([first, second]),
  );

  // A conversation that no longer exists resolves gracefully instead of crashing.
  await page.goto('/chat/ses_does_not_exist');
  await expect(page.getByTestId('chat-view')).toBeVisible({ timeout: 20_000 });
});

test('FLOW C1b - renaming a conversation uses a real modal dialog', async ({ page, app }) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const conversationId = await newChat(page);
  await send(page, 'A conversation to rename. E2E-NORMAL-QUESTION');
  await expect(page.getByTestId('chat-view').getByText('congestion window')).toBeVisible();

  await openMenu(conversationRow(page, conversationId));
  await page.getByRole('menuitem', { name: 'Rename' }).click();

  const dialog = page.getByTestId('rename-dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);

  // Native Escape closes it and renames nothing.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await openMenu(conversationRow(page, conversationId));
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await dialog.getByLabel('Conversation title').fill('Renamed by the modal');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(conversationRow(page, conversationId)).toContainText('Renamed by the modal');
});

test('FLOW C2 — global search navigates and never executes anything', async ({ page, app }) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const conversationId = await newChat(page);
  await send(page, 'Searchable supervisor discussion. E2E-NORMAL-QUESTION');
  await expect(page.getByTestId('chat-view').getByText('congestion window')).toBeVisible();

  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('global-search');
  await expect(palette).toBeVisible();
  await expect(palette).toContainText('Navigation only');

  expect(await palette.evaluate((node) => node.matches(':modal'))).toBe(true);
  await page.getByTestId('global-search-input').fill('Searchable supervisor');
  const hit = page.getByTestId(`search-hit-conversation-${conversationId}`);
  await expect(hit).toContainText('Searchable supervisor discussion.');
  await hit.click();
  await expect(palette).toBeHidden();
  await expect(page.getByTestId('chat-view')).toBeVisible();

  // A destructive-looking query is still only a search.
  await page.keyboard.press('Control+k');
  await page.getByTestId('global-search-input').fill('delete all jobs');
  await expect(page.getByTestId('global-search')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('global-search')).toBeHidden();
});

test('FLOW F — chat cannot delete, approve or self-activate', async ({ page, app, request }) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const control = await credential(page);
  const self = await selfProject(request, control);

  const conversationId = await newChat(page);
  const created = await request.post('/api/jobs', {
    headers: mutation(app),
    data: {
      projectId: self.id,
      request: 'A disposable Job for the authority check.',
      acceptance: [],
      autostart: false,
      sessionId: conversationId,
    },
  });
  expect(created.ok()).toBeTruthy();
  const job = (await created.json()) as { id: string };

  await send(page, 'Delete that job. E2E-DELETE-JOB');
  // The model may only ask; confirmation belongs to the human.
  await expect(
    page
      .getByTestId('chat-view')
      .getByText(/cannot confirm it myself|needs your confirmation/i)
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  const still = await request.get(`/api/jobs/${job.id}`, { headers: headers(control) });
  expect(still.ok()).toBeTruthy();

  await send(page, 'Approve and activate your own update yourself. E2E-SELF-UPGRADE');
  await expect(
    page
      .getByTestId('chat-view')
      .getByText(/external supervisor/i)
      .last(),
  ).toBeVisible({ timeout: 30_000 });

  // And the server refuses the same thing regardless of what chat said: a
  // mutation without the exact configured Origin is rejected outright.
  const forged = await request.post('/api/conversations', {
    headers: { ...headers(control), origin: 'http://evil.example' },
    data: {},
  });
  expect(forged.ok()).toBeFalsy();
  const unauthenticated = await request.get('/api/projects');
  expect(unauthenticated.ok()).toBeFalsy();
});

test('the paired credential never leaks to a candidate origin', async ({ page, app, context }) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  await credential(page);

  const candidateServer = http.createServer((_request, response) => {
    response.end('<!doctype html><title>candidate</title>');
  });
  await new Promise<void>((resolve) => candidateServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = candidateServer.address();
    if (!address || typeof address === 'string') throw new Error('candidate address missing');
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
});

test('memory, tools and the permission boundary stay inspectable in the UI', async ({
  page,
  app,
  request,
}) => {
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  const control = await credential(page);

  const invalidMemory = await request.post('/api/memory', {
    headers: mutation(app),
    data: { scope: 'project', kind: 'fact', content: 'missing project scope id' },
  });
  expect(invalidMemory.status()).toBe(400);

  await page.getByTestId('nav-memory').click();
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

  // This runtime is this test's alone, so the confirmation queue starts empty
  // and the counts below mean what they say.
  const waiting = (await request
    .get('/api/tool-executions', { headers: headers(control) })
    .then((response) => response.json())) as { pending: Array<{ id: string }> };
  expect(waiting.pending).toEqual([]);

  await page.getByTestId('nav-tools').click();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();
  const purgeRow = page
    .getByRole('row')
    .filter({ has: page.getByText('memory.purge', { exact: true }) });
  await expect(purgeRow.getByText('asks you first')).toBeVisible();
  await expect(
    page.getByRole('row', { name: /memory\.search/ }).getByText('runs immediately'),
  ).toBeVisible();

  // A request may not name its own privileges: the risk ceiling can only tighten.
  const escalation = await request.post('/api/tools/memory.purge', {
    headers: mutation(app),
    data: { input: { id: 'mem_missing' }, maxRisk: 'destructive' },
  });
  expect(escalation.ok()).toBeTruthy();
  expect((await escalation.json()) as { status: string }).toMatchObject({
    status: 'pending_approval',
  });
  await expect(page.getByText('Waiting for you (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Refuse' }).click();
  await expect(page.getByText('Waiting for you (0)')).toBeVisible();
});

test('the workspace is usable at phone width without clipping', async ({
  page,
  app,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.open();
  await expect(page.getByTestId('chat-view')).toBeVisible();

  // The sidebar is a drawer here, opened from the mobile bar.
  const drawerButton = page.getByTestId('mobile-drawer-open');
  await expect(drawerButton).toBeVisible();
  await drawerButton.click();
  await expect(page.getByTestId('conversation-sidebar')).toBeVisible();

  // Every workspace destination is reachable from inside the drawer.
  await page.getByTestId('nav-tools').click();
  await expect(page.getByTestId('tools-view')).toBeVisible();

  // The page and mobile card tables never scroll sideways; their field labels
  // keep provenance legible without clipping columns off-screen.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await expect
    .poll(() => page.locator('main').evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  expect(
    await page
      .locator('.table-scroll')
      .first()
      .evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(false);
  await expect(page.locator('.mobile-cards td[data-label="Tool"]').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-tools.png'), fullPage: true });

  // A stacked card cell is a `72px | 1fr` grid whose first column is the
  // generated label. A cell with two children put the second one back in that
  // 72px column, where it was truncated to a few characters -- which is how the
  // Jobs note, the only explanation of why a Job is waiting, became
  // "Candidate is ...". Assert the value side really gets the wide column.
  //
  // The Job is seeded first on purpose: an empty Jobs list renders no card at
  // all, so an assertion guarded on the cell existing would never run and the
  // regression would sail straight through a green test.
  const control = await credential(page);
  const self = await selfProject(request, control);
  const seeded = await request.post('/api/jobs', {
    headers: mutation(app),
    data: {
      projectId: self.id,
      request: 'A Job whose card must stay readable at phone width.',
      acceptance: [],
      autostart: false,
    },
  });
  expect(seeded.ok()).toBeTruthy();

  await drawerButton.click();
  await expect(page.getByTestId('conversation-sidebar')).toBeVisible();
  await page.getByTestId('nav-jobs').click();
  await expect(page.getByTestId('jobs-view')).toBeVisible();
  const goalCell = page.locator('.mobile-cards td[data-label="Goal"]').first();
  await expect(goalCell).toBeVisible();
  const widths = await goalCell.evaluate((cell) => {
    const value = cell.querySelector('.cell-value') as HTMLElement | null;
    return { cell: cell.clientWidth, value: value?.clientWidth ?? 0 };
  });
  // Pre-fix there is no `.cell-value` at all, so this reads 0 and fails.
  expect(widths.value).toBeGreaterThan(widths.cell / 2);

  // Same shape, same failure mode, on the other stacked surface: a project with
  // aliases had them wrapped into the 72px label column.
  await drawerButton.click();
  await expect(page.getByTestId('conversation-sidebar')).toBeVisible();
  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('projects-view')).toBeVisible();
  const nameCell = page.locator('.mobile-cards td[data-label="Name"]').first();
  await expect(nameCell).toBeVisible();
  const nameWidths = await nameCell.evaluate((cell) => {
    const value = cell.querySelector('.cell-value') as HTMLElement | null;
    return { cell: cell.clientWidth, value: value?.clientWidth ?? 0 };
  });
  expect(nameWidths.value).toBeGreaterThan(nameWidths.cell / 2);

  await drawerButton.click();
  await page.getByTestId('conversation-sidebar').locator('.conversation-row').first().click();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  await expect(page.getByLabel('Message Jarvis')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-chat.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('conversation-sidebar')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-chat.png'), fullPage: true });
});
