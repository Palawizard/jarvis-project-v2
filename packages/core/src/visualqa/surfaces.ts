import type { Job } from '../jobs/service.js';
import type { Project, VisualQaScenario } from '../projects/service.js';

/** Fixture profiles a candidate runtime may be asked to seed for Visual QA. */
export type VisualFixtureProfile = 'paused-job';

/** Deterministic id of the synthetic paused Job the `paused-job` fixture seeds. */
export const FIXTURE_PAUSED_JOB_ID = 'job_qafixture_paused';

export interface VisualQaPlan {
  source: 'job_override' | 'changed_surface' | 'project_default';
  required?: boolean;
  scenarios: VisualQaScenario[];
  /** Deterministic `<changed file> -> <surface>` lines; never model-authored. */
  reasons: string[];
  fixtures: VisualFixtureProfile[];
}

interface SelfSurface {
  name: string;
  patterns: RegExp[];
  scenario: Omit<VisualQaScenario, 'name'>;
}

const VIEWPORTS: ('desktop' | 'mobile')[] = ['desktop', 'mobile'];
const testId = (id: string) => `[data-testid='${id}']`;

/** Reach a top-level view through the real sidebar, then prove it rendered. */
function navSurface(nav: string, view: string): Omit<VisualQaScenario, 'name'> {
  return {
    route: '/',
    interactions: [
      { action: 'click', selector: testId(nav) },
      { action: 'wait', selector: testId(view) },
    ],
    expectedSelector: testId(view),
    viewports: VIEWPORTS,
  };
}

/**
 * The Jarvis self-UI surface catalog.
 *
 * Every surface is a bounded, declared interaction script ending at a semantic
 * selector that proves the surface actually rendered. Nothing here lets a model
 * browse or click freely.
 */
export const SELF_VISUAL_SURFACES: SelfSurface[] = [
  {
    name: 'command',
    patterns: [/^apps\/web\/src\/views\/Command[^/]*\.tsx$/i],
    scenario: {
      route: '/',
      expectedSelector: testId('command-view'),
      viewports: VIEWPORTS,
    },
  },
  {
    name: 'projects',
    patterns: [/^apps\/web\/src\/views\/Projects[^/]*\.tsx$/i],
    scenario: navSurface('nav-projects', 'projects-view'),
  },
  {
    name: 'jobs-list',
    patterns: [/^apps\/web\/src\/views\/Jobs\.tsx$/i],
    scenario: navSurface('nav-jobs', 'jobs-view'),
  },
  {
    name: 'job-detail-paused',
    patterns: [/^apps\/web\/src\/views\/JobDetail[^/]*\.tsx$/i],
    scenario: {
      route: '/',
      fixture: 'paused-job',
      interactions: [
        { action: 'click', selector: testId('nav-jobs') },
        { action: 'wait', selector: testId('jobs-view') },
        { action: 'click', selector: testId(`job-row-${FIXTURE_PAUSED_JOB_ID}`) },
        { action: 'wait', selector: testId('job-detail-view') },
        { action: 'wait', selector: testId('resume-job') },
        { action: 'wait', selector: testId('pause-explanation') },
      ],
      expectedSelector: testId('pause-explanation'),
      viewports: VIEWPORTS,
    },
  },
  {
    name: 'memory',
    patterns: [/^apps\/web\/src\/views\/Memory[^/]*\.tsx$/i],
    scenario: navSurface('nav-memory', 'memory-view'),
  },
  {
    name: 'tools',
    patterns: [/^apps\/web\/src\/views\/Tools[^/]*\.tsx$/i],
    scenario: navSurface('nav-tools', 'tools-view'),
  },
];

/** Files that shape every surface, so a change to one earns the broad smoke set. */
const SELF_GLOBAL_PATTERNS = [
  /^apps\/web\/src\/App\.tsx$/i,
  /^apps\/web\/src\/main\.tsx$/i,
  /^apps\/web\/src\/components\.tsx$/i,
  /^apps\/web\/src\/styles\.css$/i,
  /^apps\/web\/src\/index\.css$/i,
];
const SELF_GLOBAL_SMOKE = ['command', 'jobs-list', 'job-detail-paused', 'tools'];

export function selfSurfaceScenario(name: string): VisualQaScenario {
  const surface = SELF_VISUAL_SURFACES.find((entry) => entry.name === name);
  if (!surface) throw new Error(`unknown self visual surface: ${name}`);
  return { name: surface.name, ...surface.scenario };
}

function normalise(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Map a candidate diff onto the self-UI surfaces it actually changed.
 * Returns null when nothing in the catalog matches, so callers can fall back.
 */
export function mapChangedFilesToSurfaces(
  changedFiles: string[],
): { scenarios: VisualQaScenario[]; reasons: string[] } | null {
  const selected = new Map<string, string[]>();
  const add = (surface: string, reason: string) => {
    const reasons = selected.get(surface) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    selected.set(surface, reasons);
  };
  for (const raw of changedFiles) {
    const file = normalise(raw);
    if (SELF_GLOBAL_PATTERNS.some((pattern) => pattern.test(file))) {
      for (const name of SELF_GLOBAL_SMOKE) add(name, `${file} -> ${name} (global UI smoke)`);
      continue;
    }
    for (const surface of SELF_VISUAL_SURFACES) {
      if (surface.patterns.some((pattern) => pattern.test(file))) {
        add(surface.name, `${file} -> ${surface.name}`);
      }
    }
  }
  if (selected.size === 0) return null;
  // Catalog order, so the plan is stable regardless of diff ordering.
  const names = SELF_VISUAL_SURFACES.map((surface) => surface.name).filter((name) =>
    selected.has(name),
  );
  return {
    scenarios: names.map(selfSurfaceScenario),
    reasons: names.flatMap((name) => selected.get(name) as string[]),
  };
}

function projectDefaultScenarios(project: Project): VisualQaScenario[] {
  const visual = project.config.visualQa;
  if (!visual) return [];
  if (visual.scenarios?.length) return visual.scenarios;
  const routes = visual.routes?.length
    ? visual.routes
    : project.stack.webRoutes?.length
      ? project.stack.webRoutes
      : ['/'];
  return routes.map((route) => ({
    name: route === '/' ? 'default' : route,
    route,
    ...(visual.interactions ? { interactions: visual.interactions } : {}),
  }));
}

/**
 * Resolve the Visual QA plan for a candidate.
 *
 * Priority: explicit Job override, then deterministic changed-surface mapping,
 * then project defaults. Project defaults are a fallback, never the first
 * choice — broad defaults are what let unrelated pre-existing findings block a
 * narrowly scoped change.
 */
export function resolveVisualPlan(
  job: Job,
  project: Project,
  changedFiles: string[],
): VisualQaPlan | null {
  const build = (
    source: VisualQaPlan['source'],
    scenarios: VisualQaScenario[],
    reasons: string[],
    required?: boolean,
  ): VisualQaPlan => ({
    source,
    ...(required === undefined ? {} : { required }),
    scenarios,
    reasons,
    fixtures: [
      ...new Set(scenarios.flatMap((scenario) => (scenario.fixture ? [scenario.fixture] : []))),
    ] as VisualFixtureProfile[],
  });

  if (job.visualQaConfig) {
    return build(
      'job_override',
      job.visualQaConfig.scenarios,
      ['explicit job visualQaConfig overrides changed-surface mapping'],
      job.visualQaConfig.required,
    );
  }
  const visual = project.config.visualQa;
  if (!visual) return null;
  if (project.isSelf) {
    const mapped = mapChangedFilesToSurfaces(changedFiles);
    if (mapped) return build('changed_surface', mapped.scenarios, mapped.reasons, visual.required);
  }
  const scenarios = projectDefaultScenarios(project);
  if (scenarios.length === 0) return null;
  return build(
    'project_default',
    scenarios,
    ['no changed-surface mapping matched; using project default scenarios'],
    visual.required,
  );
}
