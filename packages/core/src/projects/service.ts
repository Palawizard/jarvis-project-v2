import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { parseJson, transaction } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import { foldAccents } from '../memory/policy.js';
import {
  classifyProjectReference,
  tokenizeMessage,
  type MessageTokens,
  type ProjectReference,
} from './reference.js';
import { repoStatus } from '../git/workspace.js';
import { createLogger } from '../logger.js';
import {
  parseStoredAnalysisState,
  parseStoredProfile,
  type ProjectAnalysisState,
  type ProjectProfile,
} from './profile.js';

const log = createLogger('projects');

export interface ProjectCommands {
  install?: string;
  dev?: string;
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  format?: string;
}

export interface ProjectStack {
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  hasTests: boolean;
  /** Routes worth screenshotting in visual QA. */
  webRoutes?: string[];
}

export type VisualInteraction =
  | { action: 'goto'; route: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'wait'; selector?: string; timeoutMs?: number }
  | { action: 'screenshot'; name?: string };

export interface VisualQaScenario {
  name: string;
  route: string;
  interactions?: VisualInteraction[];
  /**
   * Real setup steps for a viewport that exposes a different navigation
   * affordance (a mobile drawer instead of a visible sidebar). Same bounded
   * DSL as `interactions`; it replaces them for that viewport, never adds
   * scripting authority.
   */
  viewportInteractions?: Partial<Record<'desktop' | 'mobile', VisualInteraction[]>>;
  viewports?: ('desktop' | 'mobile')[];
  /**
   * Selector that proves the intended surface actually rendered. Failing to
   * reach it is an evidence-coverage failure, never a product defect.
   */
  expectedSelector?: string;
  /** Bound for the expected-selector wait, like any other declared wait. */
  expectedSelectorTimeoutMs?: number;
  /**
   * Candidate-only fixture state this scenario needs to exist at all. A bounded
   * identifier, never a path or a command: the implementation lives inside the
   * candidate runtime, so a newer candidate may name a profile this parent has
   * never heard of. An unknown name is simply not seeded.
   */
  fixture?: string;
}

export interface VerificationStep {
  name: string;
  command: string;
  timeoutMs?: number;
  required?: boolean;
  kind?: 'setup' | 'check' | 'integration' | 'e2e';
}

export interface CandidateRuntimeConfig {
  /** Executable + argv are trusted project configuration; ports are supplied through env only. */
  command: { executable: string; args: string[] };
  portEnvironment: string;
  apiPortEnvironment?: string;
  healthPath?: string;
}

export interface ProjectConfig {
  candidateRuntime?: CandidateRuntimeConfig;
  visualQa?: {
    required?: boolean;
    scenarios?: VisualQaScenario[];
    routes?: string[];
    interactions?: VisualInteraction[];
  };
  verification?: { steps: VerificationStep[] };
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  stack: ProjectStack;
  commands: ProjectCommands;
  devUrl: string | null;
  summary: string | null;
  isSelf: boolean;
  /** Extra names the natural-language resolver accepts for this project. */
  aliases: string[];
  /** Archived projects stay in the database and drop out of default resolution. */
  archivedAt: string | null;
  config: ProjectConfig;
  /** What a bounded read-only analysis agent learned about this repository. */
  profile: ProjectProfile | null;
  /** In-flight or last-failed analysis run. Null once a run has succeeded. */
  analysis: ProjectAnalysisState | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function rowToProject(row: Row): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    rootPath: row.root_path as string,
    defaultBranch: row.default_branch as string,
    stack: parseJson(row.stack as string, { languages: [], frameworks: [], hasTests: false }),
    commands: parseJson(row.commands as string, {}),
    devUrl: (row.dev_url as string) ?? null,
    summary: (row.summary as string) ?? null,
    isSelf: Number(row.is_self) === 1,
    aliases: parseJson(row.aliases as string, [] as string[]),
    archivedAt: (row.archived_at as string) ?? null,
    config: parseJson(row.config as string, {} as ProjectConfig),
    // Both tolerate anything: a profile written by an older or newer Jarvis
    // simply reads back as "not analysed" rather than breaking the project.
    profile: parseStoredProfile(row.profile),
    analysis: parseStoredAnalysisState(row.analysis),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Case/punctuation-insensitive key used by every name comparison below. */
export function normaliseProjectName(value: string): string {
  return foldAccents(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Does this message name the Jarvis repository as the thing to act on?
 *
 * The rule is inverted on purpose. Two earlier rounds subtracted: strip the
 * address, treat whatever is left as a name -- and each round patched the one
 * phrasing the previous had missed ("Jarvis, ..." then "can you ..." then
 * "Jarvis fix the login bug"), because "not an address" is an open-ended set
 * and every miss silently retargets the conversation at Jarvis's own
 * repository. So a self synonym counts as naming the project ONLY inside a
 * construction that cannot be address.
 *
 * A third round taught the same lesson from the other side: enumerating the
 * constructions that DO count grew its own tail of false positives, because
 * "pour Jarvis", "a Jarvis UI plugin" and "à Jarvis" are lexically close to
 * phrases that do name the repository. So the judgement now lives in
 * `classifyProjectReference`, which decides it from the grammar around the
 * name, and this function is the boundary that says an address is not a
 * reference.
 *
 * That is the safe direction for the two ways this can be wrong. Failing to
 * recognise a reference costs one clarifying question; treating an address as a
 * reference starts work on the wrong repository without being asked.
 *
 * A message that is exactly the project's name still resolves at the `exact`
 * tier, which reads the real project name and needs nothing from here.
 */
export function mentionsSelfProject(tokens: MessageTokens, keys: string[]): boolean {
  return classifyProjectReference(tokens, keys) === 'strong';
}

/** Every name a project answers to, strongest first. */
export function projectNameKeys(project: Project): string[] {
  const keys = [project.name, ...project.aliases, path.basename(project.rootPath)];
  return [...new Set(keys.map(normaliseProjectName).filter(Boolean))];
}

/**
 * What project is this message ABOUT?
 *
 * Deliberately has no field that could be mistaken for authority. This answers
 * a context question — which profile to inject, which candidates to offer — and
 * nothing here may start work. An earlier design carried a `targeting: 'strong'`
 * flag here, and "strong reference" quietly became "permission to run an agent
 * on that repository" twice.
 *
 * The repository an unattended agent runs in is never CHOSEN from text by this
 * service. It is chosen in `chat/router.ts` — two independent tool-free
 * classifications that must agree on an id trusted code offered them — and this
 * function is then called with that exact id, which the `explicit project id`
 * tier resolves. Ids are fixed-length and generated, so that tier cannot be
 * reached by a sentence: it is a lookup, not an interpretation.
 */
export type ProjectResolution =
  | { status: 'resolved'; project: Project; confidence: number; reason: string }
  | { status: 'ambiguous'; candidates: Project[]; reason: string }
  | { status: 'none'; reason: string };

/**
 * Best-effort stack detection. Everything it produces is overridable — detection
 * is a convenience, never the source of truth for what Jarvis will execute.
 */
export function detectStack(rootPath: string): { stack: ProjectStack; commands: ProjectCommands } {
  const stack: ProjectStack = { languages: [], frameworks: [], hasTests: false };
  const commands: ProjectCommands = {};
  const has = (rel: string) => fs.existsSync(path.join(rootPath, rel));

  if (has('package.json')) {
    stack.languages.push('javascript');
    let pkg: {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      packageManager?: string;
    } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8'));
    } catch {
      /* malformed package.json: fall through with defaults */
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (has('tsconfig.json') || deps.typescript) stack.languages.push('typescript');
    for (const [dep, name] of [
      ['next', 'next.js'],
      ['react', 'react'],
      ['vue', 'vue'],
      ['svelte', 'svelte'],
      ['vite', 'vite'],
      ['express', 'express'],
      ['hono', 'hono'],
      ['fastify', 'fastify'],
    ] as const) {
      if (deps[dep]) stack.frameworks.push(name);
    }

    const pm =
      pkg.packageManager?.split('@')[0] ??
      (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm');
    stack.packageManager = pm;
    const run = (script: string) => `${pm} run ${script}`;
    const scripts = pkg.scripts ?? {};
    if (scripts.build) commands.build = run('build');
    if (scripts.test) commands.test = run('test');
    if (scripts.lint) commands.lint = run('lint');
    if (scripts.typecheck) commands.typecheck = run('typecheck');
    else if (scripts['type-check']) commands.typecheck = run('type-check');
    if (scripts['format:check']) commands.format = run('format:check');
    if (scripts.dev) commands.dev = run('dev');
    commands.install =
      pm === 'npm'
        ? has('package-lock.json')
          ? 'npm ci'
          : 'npm install'
        : pm === 'pnpm'
          ? has('pnpm-lock.yaml')
            ? 'pnpm install --frozen-lockfile'
            : 'pnpm install'
          : has('.yarnrc.yml')
            ? 'yarn install --immutable'
            : 'yarn install --frozen-lockfile';
    stack.hasTests = Boolean(scripts.test);
  }

  if (has('pyproject.toml') || has('requirements.txt')) {
    stack.languages.push('python');
    commands.install ??= has('requirements.txt')
      ? 'python -m pip install -r requirements.txt'
      : 'python -m pip install -e .';
    if (has('pyproject.toml')) commands.test ??= 'pytest';
  }
  if (has('Cargo.toml')) {
    stack.languages.push('rust');
    commands.install ??= 'cargo fetch';
    commands.build ??= 'cargo build';
    commands.test ??= 'cargo test';
  }
  if (has('go.mod')) {
    stack.languages.push('go');
    commands.install ??= 'go mod download';
    commands.build ??= 'go build ./...';
    commands.test ??= 'go test ./...';
  }
  return { stack, commands };
}

export class ProjectService {
  constructor(private readonly db: Db) {}

  async register(input: {
    name?: string;
    rootPath: string;
    isSelf?: boolean;
    devUrl?: string | null;
    commands?: ProjectCommands;
    summary?: string | null;
    aliases?: string[];
    config?: ProjectConfig;
  }): Promise<Project> {
    const rootPath = path.resolve(input.rootPath);
    if (!fs.existsSync(rootPath)) throw new Error(`path does not exist: ${rootPath}`);

    const status = await repoStatus(rootPath);
    if (!status.isRepo) throw new Error(`${rootPath} is not a git repository`);
    const root = status.root ?? rootPath;

    const existing = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(root) as
      Row | undefined;
    // Re-registering a path is how a soft-unregistered project comes back.
    if (existing) {
      const project = rowToProject(existing);
      return project.archivedAt ? (this.setArchived(project.id, false) ?? project) : project;
    }

    const detected = detectStack(root);
    // Bounded at registration, matching the 80 that `project.update` enforces.
    // An unbounded name is not an injection risk — it is JSON-quoted wherever
    // it is rendered — but it lands in the trusted region of every routing
    // prompt, where one very long name would crowd out the other candidates.
    const name = (input.name?.trim() || path.basename(root)).slice(0, 80);
    const now = nowIso();
    const project: Project = {
      id: newId('prj'),
      name,
      rootPath: root,
      defaultBranch: status.branch && status.branch !== 'HEAD' ? status.branch : 'main',
      stack: detected.stack,
      commands: { ...detected.commands, ...input.commands },
      devUrl: input.devUrl ?? null,
      summary: input.summary ?? null,
      isSelf: input.isSelf ?? false,
      aliases: normaliseAliases(input.aliases ?? []),
      archivedAt: null,
      config: input.config ?? {},
      profile: null,
      analysis: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, dev_url, summary,
          is_self, aliases, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        project.id,
        project.name,
        project.rootPath,
        project.defaultBranch,
        JSON.stringify(project.stack),
        JSON.stringify(project.commands),
        project.devUrl,
        project.summary,
        project.isSelf ? 1 : 0,
        JSON.stringify(project.aliases),
        JSON.stringify(project.config),
        now,
        now,
      );
    return project;
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToProject(row) : null;
  }

  getByPath(rootPath: string): Project | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE root_path = ?')
      .get(path.resolve(rootPath)) as Row | undefined;
    return row ? rowToProject(row) : null;
  }

  getSelf(): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE is_self = 1 LIMIT 1').get() as
      Row | undefined;
    return row ? rowToProject(row) : null;
  }

  list(options: { status?: 'active' | 'archived' | 'all'; search?: string } = {}): Project[] {
    const status = options.status ?? 'all';
    const where =
      status === 'active'
        ? 'WHERE archived_at IS NULL'
        : status === 'archived'
          ? 'WHERE archived_at IS NOT NULL'
          : '';
    const rows = this.db
      .prepare(`SELECT * FROM projects ${where} ORDER BY is_self DESC, name ASC`)
      .all() as Row[];
    const projects = rows.map(rowToProject);
    const search = options.search?.trim().toLowerCase();
    if (!search) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(search) ||
        project.rootPath.toLowerCase().includes(search) ||
        project.aliases.some((alias) => alias.toLowerCase().includes(search)),
    );
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Project,
        | 'name'
        | 'summary'
        | 'devUrl'
        | 'commands'
        | 'defaultBranch'
        | 'stack'
        | 'aliases'
        | 'config'
      >
    >,
  ): Project | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('project name must not be empty');
      next.name = name;
    }
    if (patch.aliases !== undefined) next.aliases = normaliseAliases(patch.aliases);
    this.db
      .prepare(
        `UPDATE projects SET name=?, summary=?, dev_url=?, commands=?, default_branch=?, stack=?,
           aliases=?, config=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.summary,
        next.devUrl,
        JSON.stringify(next.commands),
        next.defaultBranch,
        JSON.stringify(next.stack),
        JSON.stringify(next.aliases),
        JSON.stringify(next.config),
        nowIso(),
        id,
      );
    return this.get(id);
  }

  /**
   * Archive is the ordinary way to hide a project.
   *
   * The row, its jobs, its history and its memory all stay exactly where they
   * are; the project simply stops being a default resolver candidate.
   */
  setArchived(id: string, archived: boolean): Project | null {
    const project = this.get(id);
    if (!project) return null;
    if (archived && project.isSelf) {
      throw new Error('the Jarvis self project cannot be archived');
    }
    this.db
      .prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archived ? nowIso() : null, nowIso(), id);
    return this.get(id);
  }

  /**
   * Has the repository moved past the commit its profile was built from?
   *
   * A stale profile is never discarded — it is still the best orientation
   * Jarvis has — but every surface that shows it says so, and re-analysis is
   * always the human's call so a busy repository cannot silently burn quota.
   */
  async profileStaleness(
    project: Project,
  ): Promise<{ analysed: boolean; stale: boolean; head: string | null }> {
    if (!project.profile) return { analysed: false, stale: false, head: null };
    const status = await repoStatus(project.rootPath).catch(() => null);
    const head = status?.head ?? null;
    return {
      analysed: true,
      stale: Boolean(head && head !== project.profile.analyzedCommit),
      head,
    };
  }

  /**
   * Record where an analysis run has got to.
   *
   * Deliberately a separate column from `profile`: a failed or in-flight run
   * must never be able to damage the last good profile, and the UI has to be
   * able to say "analysing" and "the previous answer is still this" at once.
   */
  setAnalysisState(id: string, state: ProjectAnalysisState | null): Project | null {
    if (!this.get(id)) return null;
    this.db
      .prepare('UPDATE projects SET analysis = ?, updated_at = ? WHERE id = ?')
      .run(state ? JSON.stringify(state) : null, nowIso(), id);
    return this.get(id);
  }

  /** Store a completed profile and clear the run state in one transition. */
  setProfile(id: string, profile: ProjectProfile): Project | null {
    if (!this.get(id)) return null;
    this.db
      .prepare('UPDATE projects SET profile = ?, analysis = NULL, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(profile), nowIso(), id);
    return this.get(id);
  }

  /** Re-run detection against the current filesystem state. */
  refreshDetection(id: string): Project | null {
    const project = this.get(id);
    if (!project) return null;
    const detected = detectStack(project.rootPath);
    return this.update(id, {
      stack: detected.stack,
      // Detected commands fill gaps but never overwrite explicit configuration.
      commands: { ...detected.commands, ...project.commands },
    });
  }

  /**
   * Whether this project may be unregistered, and what that would mean.
   *
   * Unregistering NEVER deletes the repository from disk. It removes Jarvis's
   * registration only. When history exists the row is archived rather than
   * deleted, because `jobs.project_id` cascades and a hard delete would take
   * every Job, verification, review and application record with it.
   */
  unregisterPreflight(id: string): {
    eligible: boolean;
    mode: 'hard' | 'soft';
    reason: string;
    activeJobs: number;
    historicalJobs: number;
    memories: number;
  } {
    const project = this.get(id);
    if (!project) {
      return {
        eligible: false,
        mode: 'soft',
        reason: 'project not found',
        activeJobs: 0,
        historicalJobs: 0,
        memories: 0,
      };
    }
    const count = (sql: string, ...params: unknown[]) =>
      Number((this.db.prepare(sql).get(...(params as never[])) as { n: number }).n);
    const activeJobs = count(
      `SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?
        AND stage NOT IN ('completed','failed','cancelled')`,
      id,
    );
    const historicalJobs = count('SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?', id);
    // Analysis-authored memories are Jarvis's own orientation notes, not the
    // user's history, and the register dialog offers analysis by default. Left
    // in the count they would make every freshly registered project
    // soft-archive instead of unregister outright, silently changing the
    // documented semantics for the common case.
    const memories = count(
      `SELECT COUNT(*) AS n FROM memories
        WHERE scope='project' AND scope_id = ? AND source_type <> 'project_analysis'`,
      id,
    );
    if (project.isSelf) {
      return {
        eligible: false,
        mode: 'soft',
        reason: 'the Jarvis self project cannot be unregistered',
        activeJobs,
        historicalJobs,
        memories,
      };
    }
    if (activeJobs > 0) {
      return {
        eligible: false,
        mode: 'soft',
        reason: `${activeJobs} job(s) are still active; cancel or finish them first`,
        activeJobs,
        historicalJobs,
        memories,
      };
    }
    const hasHistory = historicalJobs > 0 || memories > 0;
    return {
      eligible: true,
      mode: hasHistory ? 'soft' : 'hard',
      reason: hasHistory
        ? 'history exists; the project is archived so Jobs and memory stay understandable'
        : 'no Jobs or memory reference this project; the registration can be removed outright',
      activeJobs,
      historicalJobs,
      memories,
    };
  }

  /**
   * Unregister a project. The repository on disk is never touched.
   *
   * Returns which of the two outcomes happened so callers can say so honestly.
   */
  unregister(id: string): { removed: boolean; mode: 'hard' | 'soft'; reason: string } {
    const preflight = this.unregisterPreflight(id);
    if (!preflight.eligible) throw new Error(preflight.reason);
    if (preflight.mode === 'hard') {
      // One transaction, because `memories.scope_id` is a plain column with no
      // foreign key: nothing in the schema would clean up after the row.
      //
      // The preflight discounts Jarvis's own analysis notes when deciding hard
      // versus soft, so the hard path can now run while project-scoped memories
      // still exist. Every one of them is scoped to a project that is about to
      // stop existing, so every one of them goes with it — not only the source
      // type the preflight discounted, since a dangling scope_id is dangling
      // whoever wrote it.
      return transaction(this.db, () => {
        const purged = Number(
          this.db.prepare(`DELETE FROM memories WHERE scope = 'project' AND scope_id = ?`).run(id)
            .changes,
        );
        const removed =
          Number(this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
        if (!removed) throw new Error('project not found');
        if (purged) log.info('purged project memory with its registration', { id, purged });
        return { removed, mode: 'hard' as const, reason: preflight.reason };
      });
    }
    this.setArchived(id, true);
    return { removed: true, mode: 'soft', reason: preflight.reason };
  }

  /**
   * Resolve a project from natural language, deterministically.
   *
   * Precedence, strongest first:
   *   1. an exact project id in the text;
   *   2. an exact canonical name / alias / repo basename / self synonym;
   *   3. a unique word-boundary mention of one of those names;
   *   4. the conversation's current affinity, when the text names no project.
   *
   * Several plausible projects never resolve silently: the caller is told to
   * ask. Archived projects are only candidates when explicitly named.
   */
  resolve(
    text: string,
    options: {
      affinityProjectId?: string | null;
      /**
       * How a mention of the self project counts.
       *
       * `reference` (the default) is the strict rule every ACTION uses: only a
       * construction that cannot be an address resolves the Jarvis repository,
       * so "Jarvis fix the login bug" never retargets work at Jarvis itself.
       *
       * `any` is for read-only per-turn context enrichment, where a bare
       * mention is enough. Being wrong there costs a paragraph of unused
       * context, not a Job against the wrong repository.
       */
      selfMention?: 'reference' | 'any';
    } = {},
  ): ProjectResolution {
    const all = this.list();
    const tokens = tokenizeMessage(text);

    const byId = all.find((project) => text.includes(project.id));
    if (byId) {
      return { status: 'resolved', project: byId, confidence: 1, reason: 'explicit project id' };
    }

    const exact: Project[] = [];
    const mentioned: { project: Project; reference: ProjectReference }[] = [];
    for (const project of all) {
      const keys = projectNameKeys(project);
      if (keys.some((key) => normaliseProjectName(text) === key)) {
        exact.push(project);
        continue;
      }
      const reference = classifyProjectReference(tokens, keys);
      if (reference === 'none') continue;
      // The self project is excluded from generic name containment on purpose.
      // Its name, its repository basename and its aliases are all the word the
      // user says to ADDRESS it, so a bare match here fires on "Jarvis fix the
      // login bug" and outranks the conversation's own project. It qualifies
      // through a construction that cannot be address instead; the exact tier
      // above still resolves a message that is nothing but the name.
      if (project.isSelf && reference !== 'strong' && options.selfMention !== 'any') continue;
      mentioned.push({ project, reference });
    }

    const exactTier = exact.map((project) => ({
      project,
      reference: 'strong' as ProjectReference,
    }));
    for (const [group, reason, confidence] of [
      [exactTier, 'exact project name or alias', 1],
      [mentioned, 'project named in the message', 0.85],
    ] as const) {
      const usable = group.filter((entry) => !entry.project.archivedAt);
      const pool = usable.length ? usable : group;
      const chosen = pool[0];
      if (pool.length === 1 && chosen) {
        return { status: 'resolved', project: chosen.project, confidence, reason };
      }
      if (pool.length > 1) {
        return {
          status: 'ambiguous',
          candidates: pool.map((entry) => entry.project),
          reason: `${pool.length} projects match that name`,
        };
      }
    }

    if (options.affinityProjectId) {
      const affinity = all.find((project) => project.id === options.affinityProjectId);
      if (affinity && !affinity.archivedAt) {
        return {
          status: 'resolved',
          project: affinity,
          confidence: 0.6,
          reason: 'the project this conversation is already about',
        };
      }
    }
    return { status: 'none', reason: 'no project was named and this conversation has no project' };
  }
}

/** Ceilings for the registry rendered into every conversation. */
const REGISTRY_LIMITS = { projects: 12, aliases: 3, stack: 6, summary: 160, total: 2400 } as const;

/**
 * The compact list of projects Jarvis has registered, for a model prompt.
 *
 * The point is that the conversational model should never have to ask where a
 * repository lives — that was the most visible symptom of the regression this
 * fixes. It is informational only: `ProjectService.resolve` remains the sole
 * authority for which project an operation actually targets, so a model that
 * misreads this list can at worst name a project that trusted code then
 * resolves for itself.
 *
 * Bounded on every axis, and deliberately narrow on content: names, aliases,
 * path, stack, one-line summary and analysis status. Never `config`, which
 * carries runtime commands and verification steps.
 */
export function renderProjectRegistry(projects: Project[]): string {
  const cut = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const entries = projects
    .filter((project) => !project.archivedAt)
    .slice(0, REGISTRY_LIMITS.projects)
    .map((project) => {
      const stack = [...project.stack.languages, ...project.stack.frameworks].slice(
        0,
        REGISTRY_LIMITS.stack,
      );
      const summary = project.summary?.replace(/\s+/g, ' ').trim();
      return [
        `- ${project.name}${project.isSelf ? ' (Jarvis itself)' : ''}`,
        `  id: ${project.id}`,
        `  path: ${project.rootPath}`,
        project.aliases.length
          ? `  aliases: ${project.aliases.slice(0, REGISTRY_LIMITS.aliases).join(', ')}`
          : '',
        stack.length ? `  stack: ${stack.join(', ')}` : '',
        summary ? `  summary: ${cut(summary, REGISTRY_LIMITS.summary)}` : '',
        project.profile
          ? `  analysed: ${project.profile.analyzedAt} at ${project.profile.analyzedCommit.slice(0, 12)}`
          : project.analysis
            ? `  analysis: ${project.analysis.status}`
            : '  analysed: never',
      ]
        .filter(Boolean)
        .join('\n');
    });
  if (entries.length === 0) return '';

  const kept: string[] = [];
  let used = 0;
  for (const entry of entries) {
    if (used + entry.length > REGISTRY_LIMITS.total) break;
    kept.push(entry);
    used += entry.length + 1;
  }
  if (kept.length === 0) return '';
  const omitted = projects.filter((project) => !project.archivedAt).length - kept.length;
  return [kept.join('\n'), omitted > 0 ? `- (${omitted} more not listed)` : '']
    .filter(Boolean)
    .join('\n');
}

/** Aliases are stored normalised so lookups never depend on how they were typed. */
function normaliseAliases(aliases: string[]): string[] {
  return [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))].slice(0, 20);
}
