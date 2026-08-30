import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspace } from '../git/workspace.js';
import type { Job } from '../jobs/service.js';
import type { Project } from '../projects/service.js';
import {
  CATALOG_BUDGET_MS,
  catalogWorstCaseMs,
  resolveVisualPlanForCandidate,
  validateCatalog,
  VISUAL_QA_CATALOG_PATH,
  VisualQaPlanningError,
} from './candidate-plan.js';
import { selfSurfaceScenario } from './surfaces.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const selector = (id: string) => `[data-testid='${id}']`;
const scenario = (
  name: string,
  matcher: Record<string, string> = { exact: `apps/web/src/views/${name}.tsx` },
  extra: Record<string, unknown> = {},
) => ({
  name,
  matchers: [matcher],
  route: '/',
  expectedSelector: selector(`${name}-view`),
  viewports: ['desktop', 'mobile'],
  ...extra,
});

const catalog = (
  scenarios: Record<string, unknown>[] = [
    scenario('command', { prefix: 'apps/web/src/views/Command' }),
  ],
  globalSmoke: Record<string, unknown>[] = [],
) => ({ version: 1, scenarios, globalSmoke });

function candidateWorktree(rawCatalog: unknown | string | null = catalog()): {
  cwd: string;
  head: string;
  git: (args: string[]) => string;
  writeCatalog: (value: unknown | string) => void;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-catalog-'));
  roots.push(cwd);
  const writeCatalog = (value: unknown | string) => {
    const target = path.join(cwd, ...VISUAL_QA_CATALOG_PATH.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'packages/core/dist/\n');
  if (rawCatalog !== null) writeCatalog(rawCatalog);
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', '-A']);
  git(['commit', '-qm', 'candidate']);
  return { cwd, head: git(['rev-parse', 'HEAD']), git, writeCatalog };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'prj_self',
    name: 'jarvis',
    rootPath: 'C:/repo',
    defaultBranch: 'main',
    stack: { languages: ['typescript'], frameworks: ['react'], hasTests: true },
    commands: {},
    devUrl: null,
    summary: null,
    isSelf: true,
    config: { visualQa: { required: true, scenarios: [selfSurfaceScenario('jobs-list')] } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_test',
    sessionId: null,
    projectId: 'prj_self',
    request: 'candidate UI',
    goal: 'validate candidate UI',
    acceptance: [],
    stage: 'visual_qa',
    status: 'running',
    error: null,
    branch: null,
    worktreePath: null,
    baseRef: null,
    headRef: null,
    fixCycles: 0,
    reviewFixCycles: 0,
    visualFixCycles: 0,
    resumeStage: null,
    pauseReason: null,
    restartReason: null,
    repairKind: null,
    repairCheckpoint: null,
    lastProvider: null,
    resumeSessionId: null,
    reviewedHead: null,
    visualHead: null,
    candidateBaseSha: null,
    candidateSourceSha: null,
    validationOnly: false,
    visualQaConfig: null,
    visualQaPlan: null,
    episodeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const names = (plan: Awaited<ReturnType<typeof resolveVisualPlanForCandidate>>) =>
  plan?.scenarios.map((entry) => entry.name) ?? [];

async function resolve(
  worktree: ReturnType<typeof candidateWorktree>,
  changedFiles: string[],
  overrides: { job?: Job; project?: Project; head?: string; deletedFiles?: string[] } = {},
) {
  return resolveVisualPlanForCandidate({
    job: overrides.job ?? job(),
    // The trusted read resolves the object store from the registered repository,
    // never from the candidate worktree it is handed.
    project: { ...(overrides.project ?? project()), rootPath: worktree.cwd },
    changedFiles,
    ...(overrides.deletedFiles ? { deletedFiles: overrides.deletedFiles } : {}),
    head: overrides.head ?? worktree.head,
  });
}

describe('the committed catalog', () => {
  const repoRoot = () =>
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
    }).trim();

  it('is valid and maps every tracked non-test apps/web file', async () => {
    const root = repoRoot();
    const raw = fs.readFileSync(path.join(root, ...VISUAL_QA_CATALOG_PATH.split('/')), 'utf8');
    validateCatalog(raw);

    // The parent and the candidate must agree on the surface vocabulary:
    // selfSurfaceScenario throws for a name only one of them knows, and the
    // deleted Command view must never resolve a legacy command scenario.
    for (const entry of validateCatalog(raw).scenarios) {
      expect(entry.name).not.toBe('command');
      expect(() => selfSurfaceScenario(entry.name)).not.toThrow();
    }

    // The wait budget is whole-catalog and is checked before selection, so a
    // catalog that creeps up to it pauses EVERY self UI job as planning
    // infrastructure rather than failing one. Assert the headroom here, where
    // it is cheap to see, instead of discovering it on a real candidate.
    const worstCaseMs = catalogWorstCaseMs(validateCatalog(raw));
    expect(worstCaseMs).toBeLessThan(CATALOG_BUDGET_MS * 0.85);

    const webFiles = execFileSync('git', ['ls-files', 'apps/web'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter((file) => file && !/[.](?:test|spec)[.]/.test(file));
    expect(webFiles.length).toBeGreaterThan(0);
    // Every shipped web file must be accounted for, or self planning fails
    // closed on a real Jarvis candidate.
    await expect(resolve(candidateWorktree(raw), webFiles)).resolves.not.toBeNull();
  });
});

describe('candidate Git catalog planning', () => {
  it('uses a future candidate catalog instead of the parent Command catalog', async () => {
    const wt = candidateWorktree(
      catalog(
        [
          scenario(
            'chat-workspace',
            { prefix: 'apps/web/src/views/Chat' },
            { fixture: 'chat-workspace' },
          ),
        ],
        [
          {
            matchers: [{ exact: 'apps/web/src/views/Command.tsx' }],
            scenarios: ['chat-workspace'],
          },
        ],
      ),
    );
    // The candidate replaced Command with Chat, so Command is a deleted path.
    const plan = await resolve(
      wt,
      ['apps/web/src/views/Command.tsx', 'apps/web/src/views/Chat.tsx'],
      { deletedFiles: ['apps/web/src/views/Command.tsx'] },
    );
    expect(names(plan)).toEqual(['chat-workspace']);
    expect(names(plan)).not.toContain('command');
    expect(plan?.plannerSource).toBe('candidate_catalog');
    expect(plan?.plannerHead).toBe(wt.head);
    expect(plan?.fixtures).toEqual(['chat-workspace']);
  });

  it('requires mapping for a rendered view relocated outside apps/web', async () => {
    // Scoping self UI to apps/web/ alone would let a candidate move a view one
    // directory up and shed its evidence duty on the way.
    const wt = candidateWorktree(catalog([scenario('chat', { suffix: 'Chat.tsx' })]));
    await expect(resolve(wt, ['packages/ui/src/views/Tools.tsx'])).rejects.toThrow(
      /left changed rendered UI unmapped/i,
    );
  });

  it('requires mapping for a rendered stylesheet relocated outside apps/web', async () => {
    // Same escape as a relocated view: a stylesheet the web app imports changes
    // what the UI looks like wherever the file happens to live.
    const wt = candidateWorktree(catalog([scenario('chat', { suffix: 'Chat.tsx' })]));
    await expect(resolve(wt, ['packages/ui/theme.css'])).rejects.toThrow(
      /left changed rendered UI unmapped/i,
    );
  });

  it('requires mapping for a rendered component under a fixtures directory', async () => {
    const wt = candidateWorktree(catalog([scenario('chat', { suffix: 'Chat.tsx' })]));
    await expect(resolve(wt, ['apps/web/src/fixtures/Widget.tsx'])).rejects.toThrow(
      /left changed rendered UI unmapped/i,
    );
    // The fixture file itself stays exempt by suffix.
    expect(await resolve(wt, ['apps/web/src/fixtures/Widget.fixtures.tsx'])).toBeNull();
  });

  it('rejects a deleted-file list beyond the bound', async () => {
    const wt = candidateWorktree(catalog([scenario('chat', { suffix: 'Chat.tsx' })]));
    const deletedFiles = Array.from({ length: 2_001 }, (_, i) => `apps/web/src/views/Gone${i}.tsx`);
    await expect(resolve(wt, ['apps/web/src/views/Chat.tsx'], { deletedFiles })).rejects.toThrow(
      /deleted-file bound/i,
    );
  });

  it('selects a candidate Chat scenario', async () => {
    const wt = candidateWorktree(catalog([scenario('chat', { suffix: 'Chat.tsx' })]));
    expect(names(await resolve(wt, ['apps/web/src/views/Chat.tsx']))).toEqual(['chat']);
  });

  it('preserves viewport-specific mobile interactions', async () => {
    const mobile = [
      { action: 'click', selector: selector('mobile-drawer-open') },
      { action: 'wait', selector: selector('conversation-sidebar') },
      { action: 'click', selector: selector('nav-jobs') },
    ];
    const wt = candidateWorktree(
      catalog([
        scenario(
          'jobs-list',
          { exact: 'apps/web/src/views/Jobs.tsx' },
          {
            viewportInteractions: { mobile },
          },
        ),
      ]),
    );
    const plan = await resolve(wt, ['apps/web/src/views/Jobs.tsx']);
    expect(plan?.scenarios[0]?.viewportInteractions?.mobile).toEqual(mobile);
  });

  it('binds the plan to the exact Git HEAD and blob identity', async () => {
    const wt = candidateWorktree();
    const plan = await resolve(wt, ['apps/web/src/views/Command.tsx']);
    const blob = wt.git(['rev-parse', `${wt.head}:${VISUAL_QA_CATALOG_PATH}`]);
    const bytes = execFileSync('git', ['cat-file', 'blob', blob], { cwd: wt.cwd });
    expect(plan?.plannerHead).toBe(wt.head);
    expect(plan?.catalogVersion).toBe(1);
    expect(plan?.catalogBlobSha).toBe(blob);
    expect(plan?.catalogDigest).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('ignores Git replacement objects when reading catalog provenance', async () => {
    const wt = candidateWorktree();
    const originalBlob = wt.git(['rev-parse', `${wt.head}:${VISUAL_QA_CATALOG_PATH}`]);
    const replacementBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: wt.cwd,
      input: JSON.stringify(catalog([scenario('forged')])),
      encoding: 'utf8',
    }).trim();
    wt.git(['replace', originalBlob, replacementBlob]);

    const plan = await resolve(wt, ['apps/web/src/views/Command.tsx']);
    const originalBytes = execFileSync(
      'git',
      ['--no-replace-objects', 'cat-file', 'blob', originalBlob],
      { cwd: wt.cwd },
    );
    expect(names(plan)).toEqual(['command']);
    expect(plan?.catalogBlobSha).toBe(originalBlob);
    expect(plan?.catalogDigest).toBe(createHash('sha256').update(originalBytes).digest('hex'));
  });

  it('maps a renamed self-UI file by its literal destination path', async () => {
    const wt = candidateWorktree();
    const views = path.join(wt.cwd, 'apps/web/src/views');
    fs.mkdirSync(views, { recursive: true });
    fs.writeFileSync(path.join(views, 'Command.tsx'), 'export const Command = true;\n');
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'add command']);
    const base = wt.git(['rev-parse', 'HEAD']);
    fs.renameSync(path.join(views, 'Command.tsx'), path.join(views, 'Chat.tsx'));
    wt.writeCatalog(
      catalog(
        [scenario('chat', { exact: 'apps/web/src/views/Chat.tsx' })],
        [
          {
            matchers: [{ exact: 'apps/web/src/views/Command.tsx' }],
            scenarios: ['chat'],
          },
        ],
      ),
    );
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'rename command to chat']);
    const head = wt.git(['rev-parse', 'HEAD']);
    const changes = await new GitWorkspace(path.join(wt.cwd, '.worktrees')).collectChanges(
      wt.cwd,
      base,
    );

    expect(changes.files.map((file) => file.path)).toContain('apps/web/src/views/Chat.tsx');
    expect(
      names(
        await resolve(
          wt,
          changes.files.map((file) => file.path),
          { head, deletedFiles: changes.deleted },
        ),
      ),
    ).toEqual(['chat']);
  });

  it('fails closed for an unmapped renamed self-UI destination', async () => {
    const wt = candidateWorktree();
    const views = path.join(wt.cwd, 'apps/web/src/views');
    fs.mkdirSync(views, { recursive: true });
    fs.writeFileSync(path.join(views, 'Command.tsx'), 'export const Command = true;\n');
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'add command']);
    const base = wt.git(['rev-parse', 'HEAD']);
    fs.renameSync(path.join(views, 'Command.tsx'), path.join(views, 'Unmapped.tsx'));
    wt.writeCatalog(catalog([scenario('jobs-list')]));
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'rename command to unmapped view']);
    const head = wt.git(['rev-parse', 'HEAD']);
    const changes = await new GitWorkspace(path.join(wt.cwd, '.worktrees')).collectChanges(
      wt.cwd,
      base,
    );

    await expect(
      resolve(
        wt,
        changes.files.map((file) => file.path),
        { head, deletedFiles: changes.deleted },
      ),
    ).rejects.toThrow(/left changed rendered UI unmapped/);
  });

  it('gives forged ignored dist JavaScript zero influence', async () => {
    const wt = candidateWorktree(
      catalog([scenario('chat', { prefix: 'apps/web/src/views/Chat' })]),
    );
    const forged = path.join(wt.cwd, 'packages/core/dist/visualqa/surfaces.js');
    fs.mkdirSync(path.dirname(forged), { recursive: true });
    fs.writeFileSync(forged, 'throw new Error("executed forged planner")');
    expect(wt.git(['status', '--short'])).toBe('');
    expect(names(await resolve(wt, ['apps/web/src/views/Chat.tsx']))).toEqual(['chat']);
  });

  it('gives a modified dirty worktree catalog no influence at all', async () => {
    const wt = candidateWorktree();
    wt.writeCatalog(catalog([scenario('forged')]));
    // The worktree file is never opened, so the committed bytes still win.
    expect(names(await resolve(wt, ['apps/web/src/views/Command.tsx']))).toEqual(['command']);
  });

  it('fails closed on a commit the repository does not contain', async () => {
    const wt = candidateWorktree();
    await expect(
      resolve(wt, ['apps/web/src/views/Command.tsx'], { head: '0'.repeat(40) }),
    ).rejects.toThrow(VisualQaPlanningError);
  });

  it('fails closed when the head names a blob instead of a commit', async () => {
    const wt = candidateWorktree();
    const blob = wt.git(['rev-parse', `${wt.head}:${VISUAL_QA_CATALOG_PATH}`]);
    // The walk asks Git for a commit at that address and there is not one.
    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'], { head: blob })).rejects.toThrow(
      VisualQaPlanningError,
    );
  });

  it('fails closed when the catalog path is a directory rather than a blob', async () => {
    const wt = candidateWorktree(null);
    const target = path.join(wt.cwd, ...VISUAL_QA_CATALOG_PATH.split('/'), 'inner.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(catalog()));
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'catalog as a directory']);
    await expect(
      resolve(wt, ['apps/web/src/views/Command.tsx'], { head: wt.git(['rev-parse', 'HEAD']) }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('reads each of two commits as its own committed catalog', async () => {
    const wt = candidateWorktree();
    const first = wt.head;
    wt.writeCatalog(catalog([scenario('chat', { prefix: 'apps/web/src/views/Chat' })]));
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'second catalog']);
    const second = wt.git(['rev-parse', 'HEAD']);

    expect(names(await resolve(wt, ['apps/web/src/views/Command.tsx'], { head: first }))).toEqual([
      'command',
    ]);
    expect(names(await resolve(wt, ['apps/web/src/views/Chat.tsx'], { head: second }))).toEqual([
      'chat',
    ]);
  });

  it('fails closed when the required catalog is missing', async () => {
    const wt = candidateWorktree(null);
    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'])).rejects.toThrow(/missing/);
  });

  it('fails closed on malformed committed JSON', async () => {
    const wt = candidateWorktree('{nope');
    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'])).rejects.toThrow(/malformed/);
  });

  it('fails closed when rendered UI has no candidate mapping', async () => {
    const wt = candidateWorktree(catalog([scenario('jobs-list')]));
    await expect(resolve(wt, ['apps/web/src/views/Chat.tsx'])).rejects.toThrow(
      /left changed rendered UI unmapped/,
    );
  });

  it('normalises Windows separators before matching', async () => {
    const wt = candidateWorktree();
    expect(names(await resolve(wt, ['apps\\web\\src\\views\\Command.tsx']))).toEqual(['command']);
  });

  it('never falls back to the stale parent self catalog for test-only UI changes', async () => {
    const wt = candidateWorktree(null);
    expect(await resolve(wt, ['apps/web/src/views/Command.test.tsx'])).toBeNull();
  });

  it('fails closed per file when only some changed rendered UI is mapped', async () => {
    const wt = candidateWorktree(
      catalog([scenario('tools', { exact: 'apps/web/src/views/Tools.tsx' })]),
    );
    await expect(
      resolve(wt, ['apps/web/src/views/Tools.tsx', 'apps/web/src/views/Memory.tsx']),
    ).rejects.toThrow('views/Memory.tsx');
  });

  it('requires deleted rendered UI to map to surviving global smoke evidence', async () => {
    const wt = candidateWorktree(
      catalog([scenario('chat', { exact: 'apps/web/src/views/Chat.tsx' })]),
    );
    await expect(
      resolve(wt, ['apps/web/src/views/Chat.tsx', 'apps/web/src/views/Command.tsx'], {
        deletedFiles: ['apps/web/src/views/Command.tsx'],
      }),
    ).rejects.toThrow('views/Command.tsx');
  });

  it('does not plan a scenario for a rendered view the candidate deleted', async () => {
    const wt = candidateWorktree(
      catalog(
        [
          scenario('memory', { prefix: 'apps/web/src/views/Memory' }),
          scenario('chat', { exact: 'apps/web/src/views/Chat.tsx' }),
        ],
        [{ matchers: [{ exact: 'apps/web/src/views/Memory.tsx' }], scenarios: ['chat'] }],
      ),
    );
    expect(
      names(
        await resolve(wt, ['apps/web/src/views/Memory.tsx', 'apps/web/src/views/Chat.tsx'], {
          deletedFiles: ['apps/web/src/views/Memory.tsx'],
        }),
      ),
    ).toEqual(['chat']);
  });

  it('does not allow a deletion-only rendered self-UI diff to skip evidence', async () => {
    const wt = candidateWorktree(catalog([scenario('chat')]));
    await expect(
      resolve(wt, ['apps/web/src/views/Memory.tsx'], {
        deletedFiles: ['apps/web/src/views/Memory.tsx'],
      }),
    ).rejects.toThrow('views/Memory.tsx');
  });

  it('does not let global smoke reselect the scenario whose surface was deleted', async () => {
    const deleted = 'apps/web/src/views/Command.tsx';
    const wt = candidateWorktree(
      catalog(
        [scenario('command', { exact: deleted })],
        [{ matchers: [{ exact: deleted }], scenarios: ['command'] }],
      ),
    );
    await expect(resolve(wt, [deleted], { deletedFiles: [deleted] })).rejects.toThrow(deleted);
  });

  it('keeps only surviving global smoke when a deleted scenario is also referenced', async () => {
    const deleted = 'apps/web/src/views/Command.tsx';
    const wt = candidateWorktree(
      catalog(
        [scenario('command', { exact: deleted }), scenario('chat')],
        [{ matchers: [{ exact: deleted }], scenarios: ['command', 'chat'] }],
      ),
    );
    expect(names(await resolve(wt, [deleted], { deletedFiles: [deleted] }))).toEqual(['chat']);
  });

  it('requires a mapping for a non-rendered web source, not only for views', async () => {
    // apps/web/src/hooks.ts renders no markup itself but shapes every screen.
    const wt = candidateWorktree(
      catalog([scenario('command', { prefix: 'apps/web/src/views/Command' })]),
    );
    await expect(resolve(wt, ['apps/web/src/hooks.ts'])).rejects.toThrow('apps/web/src/hooks.ts');
  });

  it('exempts a web unit test that renders nothing', async () => {
    const wt = candidateWorktree(
      catalog([scenario('command', { prefix: 'apps/web/src/views/Command' })]),
    );
    expect(await resolve(wt, ['apps/web/src/advisories.test.ts'])).toBeNull();
  });

  it('rejects a catalog whose engine-default waits alone exceed the budget', async () => {
    // Every step costs the engine's 15s default even with no timeoutMs declared.
    const step = { action: 'click', selector: selector('nav-jobs') };
    const wt = candidateWorktree(
      catalog(
        Array.from({ length: 8 }, (_unused, index) =>
          scenario(
            `surface-${index}`,
            { exact: `apps/web/src/views/Surface${index}.tsx` },
            { interactions: Array.from({ length: 20 }, () => step) },
          ),
        ),
      ),
    );
    await expect(resolve(wt, ['apps/web/src/views/Surface0.tsx'])).rejects.toThrow(
      /waiting-time budget/,
    );
  });

  it('rejects a catalog that declares more waiting than the time budget', async () => {
    const wait = { action: 'wait', timeoutMs: 30_000 };
    const wt = candidateWorktree(
      catalog([
        scenario(
          'command',
          { prefix: 'apps/web/src/views/Command' },
          {
            interactions: Array.from({ length: 30 }, () => wait),
          },
        ),
        scenario(
          'jobs-list',
          { exact: 'apps/web/src/views/Jobs.tsx' },
          {
            interactions: Array.from({ length: 30 }, () => wait),
          },
        ),
      ]),
    );
    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'])).rejects.toThrow(/time budget/);
  });

  it('treats rendered web files outside src as self UI that must be mapped', async () => {
    const wt = candidateWorktree(
      catalog([scenario('command', { prefix: 'apps/web/src/views/Command' })]),
    );
    await expect(resolve(wt, ['apps/web/index.html'])).rejects.toThrow(
      /left changed rendered UI unmapped/,
    );
    const mapped = candidateWorktree(
      catalog(
        [scenario('command', { prefix: 'apps/web/src/views/Command' })],
        [{ matchers: [{ exact: 'apps/web/index.html' }], scenarios: ['command'] }],
      ),
    );
    expect(names(await resolve(mapped, ['apps/web/index.html']))).toEqual(['command']);
  });

  it('reports an oversized committed catalog as a byte-limit failure', async () => {
    const wt = candidateWorktree();
    wt.writeCatalog(JSON.stringify({ version: 1, scenarios: [], globalSmoke: [], pad: 'x' }));
    const padded = JSON.stringify({
      version: 1,
      scenarios: [scenario('command', { prefix: 'apps/web/src/views/Command' })],
      globalSmoke: [],
      pad: 'x'.repeat(300 * 1024),
    });
    wt.writeCatalog(padded);
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'oversized catalog']);
    const head = wt.git(['rev-parse', 'HEAD']);
    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'], { head })).rejects.toThrow(
      /byte limit/,
    );
  });

  it('keeps explicit Job configuration highest priority without reading Git', async () => {
    const wt = candidateWorktree(null);
    const override = { required: true, scenarios: [{ name: 'explicit', route: '/' }] };
    const plan = await resolve(wt, ['apps/web/src/views/Command.tsx'], {
      job: job({ visualQaConfig: override }),
    });
    expect(plan?.source).toBe('job_override');
    expect(names(plan)).toEqual(['explicit']);
  });

  it('leaves non-self projects on existing parent behavior', async () => {
    const wt = candidateWorktree(null);
    const plan = await resolve(wt, ['apps/web/src/views/Command.tsx'], {
      project: project({ isSelf: false }),
    });
    expect(plan?.plannerSource).toBe('parent');
  });

  it('rejects a catalog carrying prototype-pollution keys', async () => {
    // JSON.parse makes __proto__ an ordinary own key, so the closed-key check is
    // what stops it; this pins that it is actually rejected rather than read.
    // Only the raw JSON path produces a real own key; an object literal would
    // merely reassign the prototype and prove nothing.
    const clean = JSON.stringify(catalog([scenario('chat', { suffix: 'Chat.tsx' })]));
    const poisoned = clean.replace('"name":"chat"', '"__proto__":{"polluted":true},"name":"chat"');
    expect(poisoned).not.toBe(clean);
    await expect(
      resolve(candidateWorktree(poisoned), ['apps/web/src/views/Chat.tsx']),
    ).rejects.toThrow(/unknown scenario fields/i);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('truncates mapping reasons at the ceiling without dropping scenarios', async () => {
    // One prefix matcher over many changed files: stays far inside the matcher
    // bound, so this exercises the reason ceiling itself and not another bound.
    const wt = candidateWorktree(catalog([scenario('chat', { prefix: 'apps/web/src/views/' })]));
    const changed = Array.from({ length: 260 }, (_, i) => `apps/web/src/views/View${i}.tsx`);
    const plan = await resolve(wt, changed);
    expect(names(plan)).toEqual(['chat']);
    // Truncated, not rejected, and it says so.
    expect(plan?.reasons.length).toBeLessThanOrEqual(201);
    expect(plan?.reasons.at(-1)).toMatch(/truncated at 200/);
  });

  it('uses declared global-smoke relationships without parent scenario knowledge', async () => {
    const wt = candidateWorktree(
      catalog(
        [scenario('chat', { prefix: 'apps/web/src/views/Chat' }), scenario('tools')],
        [{ matchers: [{ exact: 'apps/web/src/App.tsx' }], scenarios: ['chat', 'tools'] }],
      ),
    );
    expect(names(await resolve(wt, ['apps/web/src/App.tsx']))).toEqual(['chat', 'tools']);
  });
});

describe('strict bounded catalog schema', () => {
  const accept = (value: unknown) => validateCatalog(JSON.stringify(value));
  const reject = (value: unknown, message?: RegExp) =>
    expect(() => accept(value)).toThrow(message ?? VisualQaPlanningError);

  it('rejects an unsupported version', () => reject({ ...catalog(), version: 2 }, /unsupported/));
  it('rejects the total byte limit', () =>
    expect(() => validateCatalog(Buffer.alloc(256 * 1024 + 1))).toThrow(/byte limit/));
  it('rejects the scenario limit', () =>
    reject(
      catalog(Array.from({ length: 33 }, (_, index) => scenario(`s${index}`))),
      /scenario count/,
    ));
  it('rejects the interaction limit', () =>
    reject(
      catalog([
        scenario('chat', undefined, {
          interactions: Array.from({ length: 33 }, () => ({ action: 'wait', timeoutMs: 1 })),
        }),
      ]),
      /too many interactions/,
    ));
  it('rejects the selector limit', () =>
    reject(
      catalog([scenario('chat', undefined, { expectedSelector: 'a'.repeat(241) })]),
      /selector/,
    ));
  it('rejects the route limit', () =>
    reject(catalog([scenario('chat', undefined, { route: `/${'a'.repeat(200)}` })]), /route/));

  it('rejects zero expected-selector timeout because Playwright treats it as unbounded', () =>
    reject(
      catalog([scenario('chat', undefined, { expectedSelectorTimeoutMs: 0 })]),
      /out-of-range timeout/,
    ));

  it('rejects zero selector-wait timeout because Playwright treats it as unbounded', () =>
    reject(
      catalog([
        scenario('chat', undefined, {
          interactions: [{ action: 'wait', selector: '#never', timeoutMs: 0 }],
        }),
      ]),
      /out-of-range timeout/,
    ));

  it.each([
    'https://evil.test',
    'http://evil.test',
    'javascript:alert(1)',
    'data:text/html,x',
    '//evil.test',
  ])('rejects unsafe route %s', (route) =>
    reject(catalog([scenario('chat', undefined, { route })]), /outside/),
  );

  it('rejects unknown interactions including navigation and script-like operations', () => {
    for (const action of ['goto', 'evaluate', 'screenshot', 'force-click']) {
      reject(
        catalog([scenario('chat', undefined, { interactions: [{ action, route: '/' }] })]),
        /unknown/,
      );
    }
  });

  it.each(['../real-db', 'a/b', 'a\\b', 'hello world', 'x;rm'])('rejects fixture %s', (fixture) =>
    reject(catalog([scenario('chat', undefined, { fixture })]), /fixture/),
  );

  it.each([
    { exact: '../outside.tsx' },
    { prefix: '/absolute' },
    { suffix: 'C:\\secret' },
    { exact: 'apps//web/App.tsx' },
    { exact: 'apps/web\n/App.tsx' },
  ])('rejects unsafe matcher $exact$prefix$suffix', (matcher) =>
    reject(catalog([scenario('chat', matcher)]), /matcher/),
  );

  it.each([
    [{ exact: 'apps/web/src/App.tsx' }, 'apps/web/src/App.tsx'],
    [{ prefix: 'apps/web/src/views/Chat' }, 'apps/web/src/views/ChatPanel.tsx'],
    [{ suffix: 'Chat.tsx' }, 'apps/web/src/views/Chat.tsx'],
  ])('accepts the exact/prefix/suffix matcher DSL', (matcher) => {
    expect(accept(catalog([scenario('chat', matcher as Record<string, string>)]))).toBeTruthy();
  });

  it('rejects unknown fields at every trust-boundary object', () => {
    reject({ ...catalog(), executable: 'node evil.js' }, /unknown top-level/);
    reject(catalog([{ ...scenario('chat'), regex: '.*' }]), /unknown scenario/);
    reject(catalog([scenario('chat', { regex: '.*' })]), /matcher/);
    reject(
      catalog([
        scenario('chat', undefined, {
          interactions: [{ action: 'click', selector: '#x', force: true }],
        }),
      ]),
      /unknown click/,
    );
  });

  it('rejects invalid global-smoke references', () =>
    reject(
      catalog(
        [scenario('chat')],
        [{ matchers: [{ exact: 'apps/web/src/App.tsx' }], scenarios: ['missing'] }],
      ),
      /reference/,
    ));

  it('accepts bounded click, fill and wait operations only', () => {
    const parsed = accept(
      catalog([
        scenario('chat', undefined, {
          interactions: [
            { action: 'click', selector: '#open' },
            { action: 'fill', selector: '#query', value: 'Jarvis' },
            { action: 'wait', selector: '#results', timeoutMs: 1000 },
          ],
        }),
      ]),
    );
    expect(parsed.scenarios[0]?.interactions).toHaveLength(3);
  });
});

/**
 * The architectural regression. Rather than one test per Git setting -- a list
 * that grew over several review rounds and never closed -- this poisons every
 * candidate-writable lever at once and asserts the trusted read is unchanged,
 * because it runs against a repository the parent built where none of them
 * exists.
 */
describe('candidate Git configuration and metadata', () => {
  const GIT_ENV_POISON: Record<string, string> = {
    GIT_DIR: 'C:/nope/.git',
    GIT_WORK_TREE: 'C:/nope',
    GIT_INDEX_FILE: 'C:/nope/index',
    GIT_OBJECT_DIRECTORY: 'C:/nope/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: 'C:/nope/objects',
    GIT_CONFIG_GLOBAL: 'C:/nope/gitconfig',
    GIT_CONFIG_SYSTEM: 'C:/nope/gitconfig',
    GIT_ATTR_NOSYSTEM: '0',
    GIT_NO_REPLACE_OBJECTS: '',
    GIT_REPLACE_REF_BASE: 'refs/replace',
    GIT_CEILING_DIRECTORIES: 'C:/',
  };

  /**
   * `git cat-file blob` returns whatever inflates at an address without
   * checking that it hashes to that address, and packed reads are not verified
   * at all. The object store is candidate-writable by construction, so the read
   * enforces the content address itself rather than trusting Git to.
   */
  it('rejects forged bytes stored at the honest catalog address', async () => {
    const wt = candidateWorktree();
    const blob = wt.git(['rev-parse', `${wt.head}:${VISUAL_QA_CATALOG_PATH}`]);
    const loose = path.join(wt.cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    const forged = JSON.stringify(catalog([scenario('forged')]));
    fs.chmodSync(loose, 0o666);
    fs.writeFileSync(
      loose,
      zlib.deflateSync(
        Buffer.concat([Buffer.from(`blob ${forged.length}\0`), Buffer.from(forged)]),
      ),
    );
    // Git itself hands the forged bytes over without complaint.
    expect(execFileSync('git', ['cat-file', 'blob', blob], { cwd: wt.cwd, encoding: 'utf8' })).toBe(
      forged,
    );

    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'])).rejects.toThrow(
      /content-address verification/,
    );
  });

  /**
   * Git verifies a commit and its root tree, but not the trees below it. A
   * candidate that rewrites one subtree in place keeps every object honestly
   * hashed -- the forged blob is its own real hash -- and redirects the catalog
   * entry without ever forging a preimage. Only walking the chain and checking
   * each object's own id catches it.
   */
  it('rejects a forged subtree that redirects the catalog entry', async () => {
    const wt = candidateWorktree();
    const evil = JSON.stringify(catalog([scenario('forged')]));
    const evilBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: wt.cwd,
      input: evil,
      encoding: 'utf8',
    }).trim();
    // packages/core is two levels below the root tree, so it is never verified.
    const subtree = wt.git(['rev-parse', `${wt.head}:packages/core`]);
    const raw = execFileSync('git', ['cat-file', 'tree', subtree], { cwd: wt.cwd });
    const name = Buffer.from('visualqa.catalog.json');
    const at = raw.indexOf(name);
    expect(at).toBeGreaterThan(-1);
    const forgedTree = Buffer.concat([
      raw.subarray(0, at + name.length + 1),
      Buffer.from(evilBlob, 'hex'),
      raw.subarray(at + name.length + 21),
    ]);
    const loose = path.join(wt.cwd, '.git', 'objects', subtree.slice(0, 2), subtree.slice(2));
    fs.chmodSync(loose, 0o666);
    fs.writeFileSync(
      loose,
      zlib.deflateSync(Buffer.concat([Buffer.from(`tree ${forgedTree.length}\0`), forgedTree])),
    );
    // Git itself resolves the commit straight to the attacker's blob.
    expect(
      execFileSync('git', ['rev-parse', `${wt.head}:${VISUAL_QA_CATALOG_PATH}`], {
        cwd: wt.cwd,
        encoding: 'utf8',
      }).trim(),
    ).toBe(evilBlob);

    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'])).rejects.toThrow(
      /content-address verification/,
    );
  });
  /**
   * Git resolves a duplicated tree entry to the first one but checks the last
   * one out, so accepting either would let the plan and the build the parent
   * photographs disagree about the catalog.
   */
  it('rejects a tree that names the catalog twice', async () => {
    const wt = candidateWorktree();
    const evil = JSON.stringify(catalog([scenario('forged')]));
    const evilBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: wt.cwd,
      input: evil,
      encoding: 'utf8',
    }).trim();
    const subtree = wt.git(['rev-parse', `${wt.head}:packages/core`]);
    const raw = execFileSync('git', ['cat-file', 'tree', subtree], { cwd: wt.cwd });
    const name = Buffer.from('visualqa.catalog.json');
    const at = raw.indexOf(name);
    const entryEnd = at + name.length + 21;
    const duplicated = Buffer.concat([
      raw.subarray(0, at - '100644 '.length),
      Buffer.from('100644 '),
      name,
      Buffer.from([0]),
      Buffer.from(evilBlob, 'hex'),
      raw.subarray(at - '100644 '.length, entryEnd),
      raw.subarray(entryEnd),
    ]);
    const loose = path.join(wt.cwd, '.git', 'objects', subtree.slice(0, 2), subtree.slice(2));
    fs.chmodSync(loose, 0o666);
    fs.writeFileSync(
      loose,
      zlib.deflateSync(Buffer.concat([Buffer.from(`tree ${duplicated.length}\0`), duplicated])),
    );

    await expect(resolve(wt, ['apps/web/src/views/Command.tsx'])).rejects.toThrow(
      /more than once|content-address verification/,
    );
  });
  it('cannot change the catalog bytes attributed to an exact commit', async () => {
    const wt = candidateWorktree(null);
    const markers = ['filter-ran', 'textconv-ran', 'fsmonitor-ran', 'hook-ran'].map((name) =>
      path.join(wt.cwd, name),
    );
    const driver = path.join(wt.cwd, 'driver.mjs');
    fs.writeFileSync(
      driver,
      "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'ran');\nprocess.stdin.resume();\n",
    );
    const command = (marker: string) => `node ${JSON.stringify(driver)} ${JSON.stringify(marker)}`;
    const posix = (value: string) => value.split('\\').join('/');
    // Committed attributes bind the drivers below to every path, the catalog
    // included. They are part of the reviewed commit and still inert.
    fs.writeFileSync(path.join(wt.cwd, '.gitattributes'), '* filter=evil diff=evil\n');
    const honest = JSON.stringify(catalog());
    wt.writeCatalog(honest);
    wt.git(['add', '-A']);
    wt.git(['commit', '-qm', 'catalog with hostile attributes']);
    const head = wt.git(['rev-parse', 'HEAD']);
    const blob = wt.git(['rev-parse', `${head}:${VISUAL_QA_CATALOG_PATH}`]);

    // One forged catalog, reachable four ways: a replacement object, a decoy
    // work tree, the dirty working file and an ignored build artifact.
    const forged = JSON.stringify(catalog([scenario('forged')]));
    const forgedBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: wt.cwd,
      input: forged,
      encoding: 'utf8',
    }).trim();
    wt.git(['replace', blob, forgedBlob]);
    const decoy = path.join(wt.cwd, 'decoy');
    const decoyCatalog = path.join(decoy, ...VISUAL_QA_CATALOG_PATH.split('/'));
    fs.mkdirSync(path.dirname(decoyCatalog), { recursive: true });
    fs.writeFileSync(decoyCatalog, forged);
    wt.writeCatalog(forged);
    const dist = path.join(wt.cwd, 'packages/core/dist/visualqa/surfaces.js');
    fs.mkdirSync(path.dirname(dist), { recursive: true });
    fs.writeFileSync(dist, 'throw new Error("executed forged planner")');

    const gitDir = path.join(wt.cwd, '.git');
    const included = path.join(wt.cwd, 'included.config');
    fs.writeFileSync(included, `[filter "evil"]\n\tsmudge = ${command(markers[0] as string)}\n`);
    const hooks = path.join(wt.cwd, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'post-index-change'),
      `#!/bin/sh\ntouch "${posix(markers[3] as string)}"\n`,
    );
    fs.appendFileSync(
      path.join(gitDir, 'config'),
      [
        '[core]',
        `\tworktree = ${posix(decoy)}`,
        '\tbare = false',
        `\tfsmonitor = ${command(markers[2] as string)}`,
        `\thooksPath = ${posix(hooks)}`,
        `\tattributesFile = ${posix(path.join(wt.cwd, 'global.attributes'))}`,
        `\texcludesFile = ${posix(path.join(wt.cwd, 'global.excludes'))}`,
        '[filter "evil"]',
        `\tclean = ${command(markers[0] as string)}`,
        `\tsmudge = ${command(markers[0] as string)}`,
        '\trequired = true',
        '[diff "evil"]',
        `\ttextconv = ${command(markers[1] as string)}`,
        '[include]',
        `\tpath = ${posix(included)}`,
        '[includeIf "gitdir:**"]',
        `\tpath = ${posix(included)}`,
        '[extensions]',
        '\tworktreeConfig = true',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(gitDir, 'config.worktree'),
      `[core]\n\tworktree = ${posix(decoy)}\n`,
    );
    fs.writeFileSync(path.join(wt.cwd, 'global.attributes'), '* filter=evil diff=evil\n');
    fs.writeFileSync(path.join(wt.cwd, 'global.excludes'), `${VISUAL_QA_CATALOG_PATH}\n`);
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), `${VISUAL_QA_CATALOG_PATH}\n*\n`);
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* filter=evil diff=evil\n');

    const restore = { ...process.env };
    Object.assign(process.env, GIT_ENV_POISON);
    try {
      const plan = await resolve(wt, ['apps/web/src/views/Command.tsx'], { head });
      expect(names(plan)).toEqual(['command']);
      expect(plan?.catalogBlobSha).toBe(blob);
      expect(plan?.catalogDigest).toBe(createHash('sha256').update(honest).digest('hex'));
    } finally {
      for (const key of Object.keys(GIT_ENV_POISON)) delete process.env[key];
      Object.assign(process.env, restore);
    }
    // Nothing candidate-configured was allowed to execute along the way.
    for (const marker of markers) expect(fs.existsSync(marker)).toBe(false);
  });
});
