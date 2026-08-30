import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import { foldAccents } from '../memory/policy.js';
import { repoStatus } from '../git/workspace.js';

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
 * Does this message REFER to the Jarvis repository, or merely address Jarvis?
 *
 * The rule is inverted on purpose. Two earlier rounds subtracted: strip the
 * address, treat whatever is left as a name -- and each round patched the one
 * phrasing the previous had missed ("Jarvis, ..." then "can you ..." then
 * "Jarvis fix the login bug"), because "not an address" is an open-ended set
 * and every miss silently retargets the conversation at Jarvis's own
 * repository. So a self synonym now counts as naming the project ONLY inside a
 * construction that cannot be address: a preposition, a possessive, or an
 * explicit noun. Everything else -- a bare mention anywhere in a sentence --
 * falls through to conversation affinity, and then to asking.
 *
 * That is the safe direction for the two ways this can be wrong. Failing to
 * recognise a reference costs one clarifying question; treating an address as a
 * reference starts work on the wrong repository without being asked.
 *
 * A message that is exactly the project's name still resolves at the `exact`
 * tier, which reads the real project name and needs nothing from here.
 */
const SELF_REFERENCE = [
  // The haystack is space-normalised and space-padded, so a leading and
  // trailing space is the word boundary.
  / (?:in|on|to|for|from|against|inside|within|onto|upon) (?:the )?(?:jarvis|yourself) /,
  / jarvis (?:s )?(?:own )?(?:repo|repository|project|codebase|code|source|ui|itself) /,
  / (?:the|this) jarvis /,
  / your own (?:repo|repository|project|codebase|code|source|ui) /,
];

/** True when the message names the Jarvis repository as the thing to act on. */
export function mentionsSelfProject(normalisedHaystack: string): boolean {
  return SELF_REFERENCE.some((pattern) => pattern.test(normalisedHaystack));
}

/** Every name a project answers to, strongest first. */
export function projectNameKeys(project: Project): string[] {
  const keys = [project.name, ...project.aliases, path.basename(project.rootPath)];
  return [...new Set(keys.map(normaliseProjectName).filter(Boolean))];
}

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
    const name = input.name?.trim() || path.basename(root);
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
    const memories = count(
      `SELECT COUNT(*) AS n FROM memories WHERE scope='project' AND scope_id = ?`,
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
      const removed =
        Number(this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
      return { removed, mode: 'hard', reason: preflight.reason };
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
  resolve(text: string, options: { affinityProjectId?: string | null } = {}): ProjectResolution {
    const all = this.list();
    const haystack = ` ${foldAccents(text)
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()} `;

    const byId = all.find((project) => text.includes(project.id));
    if (byId) {
      return { status: 'resolved', project: byId, confidence: 1, reason: 'explicit project id' };
    }

    const exact: Project[] = [];
    const mentioned: Project[] = [];
    for (const project of all) {
      const keys = projectNameKeys(project);
      if (keys.some((key) => normaliseProjectName(text) === key)) {
        exact.push(project);
        continue;
      }
      // The self project is excluded from generic name containment on purpose.
      // Its name, its repository basename and its aliases are all the word the
      // user says to ADDRESS it, so any key-based match here fires on "Jarvis
      // fix the login bug" and outranks the conversation's own project. It
      // qualifies through an explicit reference instead; the exact tier above
      // still resolves a message that is nothing but the name.
      if (project.isSelf) {
        if (mentionsSelfProject(haystack)) mentioned.push(project);
        continue;
      }
      // Word-boundary containment on the normalised text, so "sitepilot" in
      // "Implement OAuth in Sitepilot" matches and "pilot" alone does not.
      if (keys.some((key) => key && haystack.includes(` ${key.replace(/-/g, ' ')} `))) {
        mentioned.push(project);
      }
    }

    for (const [group, reason, confidence] of [
      [exact, 'exact project name or alias', 1],
      [mentioned, 'project named in the message', 0.85],
    ] as const) {
      const usable = group.filter((project) => !project.archivedAt);
      const pool = usable.length ? usable : group;
      if (pool.length === 1) {
        return { status: 'resolved', project: pool[0] as Project, confidence, reason };
      }
      if (pool.length > 1) {
        return {
          status: 'ambiguous',
          candidates: pool,
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

/** Aliases are stored normalised so lookups never depend on how they were typed. */
function normaliseAliases(aliases: string[]): string[] {
  return [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))].slice(0, 20);
}
