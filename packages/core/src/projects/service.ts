import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
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
    config: parseJson(row.config as string, {} as ProjectConfig),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

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
    config?: ProjectConfig;
  }): Promise<Project> {
    const rootPath = path.resolve(input.rootPath);
    if (!fs.existsSync(rootPath)) throw new Error(`path does not exist: ${rootPath}`);

    const status = await repoStatus(rootPath);
    if (!status.isRepo) throw new Error(`${rootPath} is not a git repository`);
    const root = status.root ?? rootPath;

    const existing = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(root) as
      Row | undefined;
    if (existing) return rowToProject(existing);

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
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, dev_url, summary,
          is_self, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY is_self DESC, name ASC')
      .all() as Row[];
    return rows.map(rowToProject);
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Project,
        'name' | 'summary' | 'devUrl' | 'commands' | 'defaultBranch' | 'stack' | 'config'
      >
    >,
  ): Project | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name=?, summary=?, dev_url=?, commands=?, default_branch=?, stack=?, config=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.summary,
        next.devUrl,
        JSON.stringify(next.commands),
        next.defaultBranch,
        JSON.stringify(next.stack),
        JSON.stringify(next.config),
        nowIso(),
        id,
      );
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

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
  }
}
