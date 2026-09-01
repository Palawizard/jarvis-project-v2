import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { ProjectService, type Project } from './service.js';

const roots: string[] = [];
const open: Db[] = [];
let db: Db;
let projects: ProjectService;
let templateRoot: string | null = null;

afterAll(() => {
  if (templateRoot) fs.rmSync(templateRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const handle of open.splice(0)) {
    try {
      handle.close();
    } catch {
      // Already closed.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-projects-'));
  roots.push(home);
  db = openDb(loadConfig({ home }));
  open.push(db);
  projects = new ProjectService(db);
});

/**
 * A real git repository, because register() refuses anything else.
 *
 * Built once per file and copied per test: spawning `git init` plus three more
 * commands for every repository is by far the most expensive thing these tests
 * do, and it slows the whole parallel suite down.
 */
let template: string | null = null;

function repo(name: string): string {
  if (!template) {
    // Deliberately not in `roots`: that is emptied after every test, and the
    // template has to outlive them all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-repo-template-'));
    templateRoot = dir;
    const source = path.join(dir, 'template');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# fixture\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '-m', 'initial');
    template = source;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-repo-${name}-`));
  roots.push(dir);
  const root = path.join(dir, name);
  fs.cpSync(template, root, { recursive: true });
  return root;
}

function addJob(
  projectId: string,
  stage: string,
  id = `job_${Math.random().toString(16).slice(2)}`,
) {
  db.prepare(
    `INSERT INTO jobs (id, project_id, request, goal, acceptance, stage, status,
      created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, projectId, 'r', 'g', '[]', stage, 'running', 'now', 'now');
  return id;
}

describe('project aliases and natural resolution', () => {
  let sitepilot: Project;
  let self: Project;

  beforeEach(async () => {
    sitepilot = await projects.register({ name: 'sitepilot', rootPath: repo('sitepilot') });
    self = await projects.register({
      name: 'jarvis',
      rootPath: repo('jarvis'),
      isSelf: true,
    });
  });

  it('resolves an exact name, an alias and a repository basename', async () => {
    projects.update(sitepilot.id, { aliases: ['sp', 'site pilot'] });

    for (const text of ['sitepilot', 'SP', 'Site Pilot']) {
      const resolved = projects.resolve(text);
      expect(resolved.status).toBe('resolved');
      if (resolved.status === 'resolved') expect(resolved.project.id).toBe(sitepilot.id);
    }
  });

  it('resolves the self project from a natural sentence, with no chooser', () => {
    const resolved = projects.resolve('Fix the Jobs page in Jarvis');
    expect(resolved.status).toBe('resolved');
    if (resolved.status === 'resolved') {
      expect(resolved.project.id).toBe(self.id);
      expect(resolved.confidence).toBeGreaterThan(0.5);
    }
  });

  it('matches on word boundaries rather than substrings', async () => {
    const resolved = projects.resolve('Implement OAuth in Sitepilot');
    expect(resolved.status).toBe('resolved');
    if (resolved.status === 'resolved') expect(resolved.project.id).toBe(sitepilot.id);
    // "pilot" alone is not "sitepilot".
    expect(projects.resolve('fly the pilot program').status).toBe('none');
  });

  it('asks instead of guessing when several projects match', async () => {
    const websiteA = await projects.register({ name: 'website', rootPath: repo('website') });
    const websiteB = await projects.register({ name: 'company-website', rootPath: repo('other') });
    projects.update(websiteB.id, { aliases: ['website'] });

    const resolved = projects.resolve('Fix auth in website');
    expect(resolved.status).toBe('ambiguous');
    if (resolved.status === 'ambiguous') {
      expect(resolved.candidates.map((p) => p.id).sort()).toEqual(
        [websiteA.id, websiteB.id].sort(),
      );
    }
  });

  it('uses conversation affinity only when the message names no project', () => {
    const byAffinity = projects.resolve('add dark mode', { affinityProjectId: sitepilot.id });
    expect(byAffinity.status).toBe('resolved');
    if (byAffinity.status === 'resolved') expect(byAffinity.project.id).toBe(sitepilot.id);

    // Naming another project overrides the affinity: it is convenience, not
    // authority. For the self project that means an explicit reference -- a
    // bare "fix Jarvis instead" is address, and address defers to affinity.
    const overridden = projects.resolve('actually fix the Jarvis repo instead', {
      affinityProjectId: sitepilot.id,
    });
    expect(overridden.status).toBe('resolved');
    if (overridden.status === 'resolved') expect(overridden.project.id).toBe(self.id);
  });

  it('treats addressing Jarvis as address, and only a reference as naming it', () => {
    // Three rounds of subtractive rules each missed one phrasing, and every
    // miss silently retargeted the conversation at Jarvis own repository. The
    // rule is inverted: a synonym names the project only in a construction
    // that cannot be address.
    for (const text of [
      'Jarvis fix the login bug on the checkout page',
      'Jarvis, create a job to fix the OAuth redirect',
      'jarvis: add dark mode',
      'Hey Jarvis, ship the header fix',
      'can you do it yourself',
      'Can you add OAuth login to the dashboard?',
      'could you fix the header please',
    ]) {
      const resolved = projects.resolve(text, { affinityProjectId: sitepilot.id });
      expect(resolved.status).toBe('resolved');
      if (resolved.status === 'resolved') expect(resolved.project.id).toBe(sitepilot.id);
    }

    // A reference still names it, wherever it appears in the sentence.
    for (const text of [
      'Create a job on Jarvis to fix the Jobs page',
      'fix the Jobs page in jarvis',
      'update the jarvis repo',
      'work on the jarvis UI',
      'fix jarvis itself',
    ]) {
      const named = projects.resolve(text, { affinityProjectId: sitepilot.id });
      expect(named.status).toBe('resolved');
      if (named.status === 'resolved') expect(named.project.id).toBe(self.id);
    }

    // And the bare name on its own is still an exact match.
    const bare = projects.resolve('jarvis', { affinityProjectId: sitepilot.id });
    expect(bare.status).toBe('resolved');
    if (bare.status === 'resolved') expect(bare.project.id).toBe(self.id);

    // With no affinity, address resolves nothing rather than guessing Jarvis.
    expect(projects.resolve('Jarvis fix the login bug').status).toBe('none');
  });

  it('recognises French references to the self project, and only French ones', () => {
    // The deployed regression: every self-reference construction was English,
    // so "code sur le projet Jarvis ..." named the project unmistakably and
    // resolved to nothing at all.
    for (const text of [
      'code sur le projet Jarvis une nouvelle implémentation',
      'ajoute cette feature à Jarvis',
      'corrige ce bug dans Jarvis',
      'code ça sur Jarvis',
      'où est le projet Jarvis',
      'explique-moi le code de Jarvis',
    ]) {
      const resolved = projects.resolve(text, { affinityProjectId: sitepilot.id });
      expect(`${text} -> ${resolved.status}`).toBe(`${text} -> resolved`);
      if (resolved.status === 'resolved') expect(resolved.project.id).toBe(self.id);
    }

    // "à" and the English article "a" are the same token once accents are
    // folded, so " a jarvis " used to match. Combined with the imperative
    // router that started an agent on Jarvis's own repository from a sentence
    // about somebody else's code.
    for (const text of [
      'write a jarvis plugin for slack',
      'add a Jarvis webhook to the deploy script',
      'create a jarvis dashboard widget',
      'add a jarvis style logger',
    ]) {
      const resolved = projects.resolve(text, { affinityProjectId: sitepilot.id });
      expect(`${text} -> ${resolved.status}`).toBe(`${text} -> resolved`);
      if (resolved.status === 'resolved') expect(resolved.project.id).toBe(sitepilot.id);
    }
    expect(projects.resolve('write a jarvis plugin for slack').status).toBe('none');
  });

  it('separates a reference from a bare mention, and only relaxes on request', () => {
    // Strict is what every ACTION uses. The relaxed form exists so a question
    // in a conversation with no project still gets that project's context.
    expect(projects.resolve('quelle stack utilise Jarvis').status).toBe('none');
    const relaxed = projects.resolve('quelle stack utilise Jarvis', { selfMention: 'any' });
    expect(relaxed.status).toBe('resolved');
    if (relaxed.status === 'resolved') expect(relaxed.project.id).toBe(self.id);
  });

  it('drops archived projects from default candidates but still resolves them when named', () => {
    projects.setArchived(sitepilot.id, true);
    expect(projects.list({ status: 'active' }).map((p) => p.id)).not.toContain(sitepilot.id);
    expect(projects.list({ status: 'archived' }).map((p) => p.id)).toContain(sitepilot.id);

    const named = projects.resolve('sitepilot');
    expect(named.status).toBe('resolved');
    if (named.status === 'resolved') expect(named.project.id).toBe(sitepilot.id);

    // But it is no longer a silent affinity target.
    expect(projects.resolve('add dark mode', { affinityProjectId: sitepilot.id }).status).toBe(
      'none',
    );
  });

  it('unarchives by re-registering the same path rather than duplicating it', async () => {
    projects.setArchived(sitepilot.id, true);
    const again = await projects.register({ name: 'sitepilot', rootPath: sitepilot.rootPath });
    expect(again.id).toBe(sitepilot.id);
    expect(again.archivedAt).toBeNull();
  });
});

describe('project unregister semantics', () => {
  it('never lets the Jarvis self project be unregistered', async () => {
    const self = await projects.register({ rootPath: repo('jarvis'), isSelf: true });
    const preflight = projects.unregisterPreflight(self.id);
    expect(preflight.eligible).toBe(false);
    expect(preflight.reason).toContain('self project cannot be unregistered');
    expect(() => projects.unregister(self.id)).toThrow(/self project/);
    expect(projects.getSelf()?.id).toBe(self.id);
  });

  it('refuses while Jobs are still active, and names the blocker', async () => {
    const project = await projects.register({ rootPath: repo('busy') });
    addJob(project.id, 'implementing');

    const preflight = projects.unregisterPreflight(project.id);
    expect(preflight.eligible).toBe(false);
    expect(preflight.activeJobs).toBe(1);
    expect(preflight.reason).toContain('cancel or finish them first');
    expect(() => projects.unregister(project.id)).toThrow(/still active/);
  });

  it('soft-unregisters a project with history so Jobs stay understandable', async () => {
    const project = await projects.register({ rootPath: repo('historic') });
    const jobId = addJob(project.id, 'completed');

    const outcome = projects.unregister(project.id);
    expect(outcome).toMatchObject({ removed: true, mode: 'soft' });
    // The row survives, archived, so the historical Job still resolves a project.
    expect(projects.get(project.id)?.archivedAt).toBeTruthy();
    expect(db.prepare('SELECT project_id FROM jobs WHERE id = ?').get(jobId)).toEqual({
      project_id: project.id,
    });
  });

  it('does not let its own analysis notes turn every project into a soft archive', async () => {
    // Analysis is offered by default when a project is registered, and it
    // writes project memories. Counted as history, those would make every
    // freshly registered project soft-archive instead of unregistering
    // outright — silently changing the documented semantics for the common
    // case, from Jarvis's own notes rather than from anything the user did.
    const project = await projects.register({ rootPath: repo('analysed') });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, scope, scope_id, kind, content, source_type, content_hash,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      'mem_analysis',
      'project',
      project.id,
      'project_knowledge',
      'Jarvis is a local-first assistant.',
      'project_analysis',
      'hash-analysis',
      now,
      now,
    );

    expect(projects.unregisterPreflight(project.id)).toMatchObject({ mode: 'hard', memories: 0 });

    // ...and the hard path must then take those memories WITH it. `scope_id` is
    // a plain column with no foreign key, so nothing in the schema would clean
    // up after the row: discounting them from the decision without deleting
    // them is how you get memory rows pointing at a project that no longer
    // exists.
    expect(projects.unregister(project.id)).toMatchObject({ removed: true, mode: 'hard' });
    expect(projects.get(project.id)).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE scope_id = ?').get(project.id),
    ).toEqual({ n: 0 });
  });

  it('keeps the project and its memory intact when a hard unregister fails', async () => {
    const project = await projects.register({ rootPath: repo('atomic') });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, scope, scope_id, kind, content, source_type, content_hash,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      'mem_atomic',
      'project',
      project.id,
      'project_knowledge',
      'Analysis note.',
      'project_analysis',
      'hash-atomic',
      now,
      now,
    );
    // A row that cannot be deleted: jobs.project_id is ON DELETE CASCADE, so
    // instead make the project row itself unreachable mid-transaction by
    // pointing the delete at a project that vanishes first. Simplest faithful
    // stand-in: delete the row out from under the transaction.
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    expect(() => projects.unregister(project.id)).toThrow();
    // The memory delete rolled back with the failed project delete.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE scope_id = ?').get(project.id),
    ).toEqual({ n: 1 });
  });

  it('still soft-archives when the user stated something about the project', async () => {
    const project = await projects.register({ rootPath: repo('remembered') });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, scope, scope_id, kind, content, source_type, content_hash,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      'mem_user',
      'project',
      project.id,
      'constraint',
      'Deploy only on Tuesdays.',
      'user_explicit',
      'hash-user',
      now,
      now,
    );

    expect(projects.unregisterPreflight(project.id)).toMatchObject({ mode: 'soft', memories: 1 });
    projects.unregister(project.id);
    // Soft: the row is archived, so the memory still has a project to belong to.
    expect(projects.get(project.id)?.archivedAt).toBeTruthy();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE scope_id = ?').get(project.id),
    ).toEqual({ n: 1 });
  });

  it('hard-removes only a registration nothing depends on', async () => {
    const project = await projects.register({ rootPath: repo('disposable') });
    expect(projects.unregisterPreflight(project.id).mode).toBe('hard');
    expect(projects.unregister(project.id)).toMatchObject({ removed: true, mode: 'hard' });
    expect(projects.get(project.id)).toBeNull();
  });

  it('never deletes the repository from disk', async () => {
    const root = repo('precious');
    const withHistory = await projects.register({ rootPath: root });
    addJob(withHistory.id, 'completed');
    projects.unregister(withHistory.id);
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true);

    const clean = await projects.register({ rootPath: repo('also-precious') });
    const cleanRoot = clean.rootPath;
    projects.unregister(clean.id);
    expect(fs.existsSync(path.join(cleanRoot, 'README.md'))).toBe(true);
  });
});

describe('project metadata', () => {
  it('edits display name, aliases and dev URL without touching the repository path', async () => {
    const project = await projects.register({ rootPath: repo('renamed') });
    const updated = projects.update(project.id, {
      name: 'Nice Name',
      aliases: ['nn', 'nn', '  '],
      devUrl: 'http://localhost:3000',
    });
    expect(updated?.name).toBe('Nice Name');
    // Blank and duplicate aliases are dropped rather than stored.
    expect(updated?.aliases).toEqual(['nn']);
    expect(updated?.rootPath).toBe(project.rootPath);
  });

  it('lists with search and status filters', async () => {
    const alpha = await projects.register({ name: 'alpha', rootPath: repo('alpha') });
    await projects.register({ name: 'beta', rootPath: repo('beta') });
    expect(projects.list({ search: 'alph' }).map((p) => p.name)).toEqual(['alpha']);

    projects.setArchived(alpha.id, true);
    expect(projects.list({ status: 'active' }).map((p) => p.name)).toEqual(['beta']);
    // The unfiltered list stays complete on purpose: resolve() must still be
    // able to name an archived project the user asked for explicitly.
    expect(projects.list()).toHaveLength(2);
    expect(projects.list({ status: 'all' })).toHaveLength(2);
  });
});
