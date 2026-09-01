import type { Job } from '../jobs/service.js';
import type { Project, VisualQaScenario } from '../projects/service.js';

/** Fixture profiles a candidate runtime may be asked to seed for Visual QA. */
export const VISUAL_FIXTURE_PROFILES = [
  'paused-job',
  'chat-workspace',
  'project-analysis',
] as const;

export type VisualFixtureProfile = (typeof VISUAL_FIXTURE_PROFILES)[number];

/** Deterministic id of the synthetic paused Job the `paused-job` fixture seeds. */
export const FIXTURE_PAUSED_JOB_ID = 'job_qafixture_paused';
export const FIXTURE_CHAT_ID = 'session_qafixture_chat';
/** Projects the `project-analysis` fixture seeds, one per analysis state. */
export const FIXTURE_ANALYSED_PROJECT_ID = 'prj_qafixture_analysed';
export const FIXTURE_ANALYSIS_FAILED_PROJECT_ID = 'prj_qafixture_analysis_failed';

export interface VisualQaPlan {
  source: 'job_override' | 'changed_surface' | 'project_default';
  required?: boolean;
  scenarios: VisualQaScenario[];
  /** Deterministic `<changed file> -> <surface>` lines; never model-authored. */
  reasons: string[];
  /**
   * Bounded fixture identifiers. Implementations live in the candidate runtime,
   * so this is deliberately not narrowed to the profiles this parent knows.
   */
  fixtures: string[];
  /** Who mapped the diff onto surfaces. */
  plannerSource?: 'parent' | 'candidate_catalog';
  /** Exact validated candidate HEAD a committed catalog plan is bound to. */
  plannerHead?: string;
  /** Version and immutable identities of the catalog blob read from that HEAD. */
  catalogVersion?: number;
  catalogBlobSha?: string;
  catalogDigest?: string;
}

interface SelfSurface {
  name: string;
  patterns: RegExp[];
  scenario: Omit<VisualQaScenario, 'name'>;
}

const VIEWPORTS: ('desktop' | 'mobile')[] = ['desktop', 'mobile'];
const testId = (id: string) => `[data-testid='${id}']`;

const mobileNav = (nav: string) => [
  { action: 'click' as const, selector: testId('mobile-drawer-open') },
  { action: 'wait' as const, selector: testId('conversation-sidebar') },
  { action: 'click' as const, selector: testId(nav) },
];

/** Reach a top-level view through the real desktop sidebar or mobile drawer. */
function navSurface(nav: string, view: string): Omit<VisualQaScenario, 'name'> {
  return {
    route: '/',
    interactions: [
      { action: 'click', selector: testId(nav) },
      { action: 'wait', selector: testId(view) },
    ],
    viewportInteractions: {
      mobile: [...mobileNav(nav), { action: 'wait', selector: testId(view) }],
    },
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
    name: 'chat-workspace',
    patterns: [/^apps\/web\/src\/views\/Chat[^/]*\.tsx$|^apps\/web\/src\/components\.tsx$/i],
    scenario: {
      route: `/chat/${FIXTURE_CHAT_ID}`,
      fixture: 'chat-workspace',
      expectedSelector: testId('chat-view'),
      viewports: VIEWPORTS,
    },
  },
  {
    name: 'conversation-menu',
    patterns: [/^apps\/web\/src\/App\.tsx$/i],
    scenario: {
      route: `/chat/${FIXTURE_CHAT_ID}`,
      fixture: 'chat-workspace',
      interactions: [{ action: 'click', selector: testId(`conversation-menu-${FIXTURE_CHAT_ID}`) }],
      viewportInteractions: {
        mobile: [
          { action: 'click', selector: testId('mobile-drawer-open') },
          { action: 'click', selector: testId(`conversation-menu-${FIXTURE_CHAT_ID}`) },
        ],
      },
      expectedSelector: testId(`conversation-actions-${FIXTURE_CHAT_ID}`),
      viewports: VIEWPORTS,
    },
  },
  {
    name: 'destructive-dialog',
    patterns: [/^apps\/web\/src\/(?:App|components)\.tsx$/i],
    scenario: {
      route: `/chat/${FIXTURE_CHAT_ID}`,
      fixture: 'chat-workspace',
      interactions: [
        { action: 'click', selector: testId(`conversation-menu-${FIXTURE_CHAT_ID}`) },
        { action: 'click', selector: testId(`conversation-delete-${FIXTURE_CHAT_ID}`) },
      ],
      viewportInteractions: {
        mobile: [
          { action: 'click', selector: testId('mobile-drawer-open') },
          { action: 'click', selector: testId(`conversation-menu-${FIXTURE_CHAT_ID}`) },
          { action: 'click', selector: testId(`conversation-delete-${FIXTURE_CHAT_ID}`) },
        ],
      },
      expectedSelector: testId('confirm-dialog'),
      viewports: VIEWPORTS,
    },
  },
  {
    name: 'global-search',
    patterns: [/^apps\/web\/src\/App\.tsx$/i],
    scenario: {
      route: `/chat/${FIXTURE_CHAT_ID}`,
      fixture: 'chat-workspace',
      interactions: [
        { action: 'click', selector: testId('global-search-open') },
        { action: 'fill', selector: testId('global-search-input'), value: 'Jarvis' },
      ],
      viewportInteractions: {
        mobile: [
          { action: 'click', selector: testId('mobile-drawer-open') },
          { action: 'click', selector: testId('global-search-open') },
          { action: 'fill', selector: testId('global-search-input'), value: 'Jarvis' },
        ],
      },
      expectedSelector: testId('global-search'),
      viewports: VIEWPORTS,
    },
  },
  {
    name: 'mobile-conversation-drawer',
    patterns: [/^apps\/web\/src\/App\.tsx$|^apps\/web\/src\/styles\.css$/i],
    scenario: {
      route: `/chat/${FIXTURE_CHAT_ID}`,
      fixture: 'chat-workspace',
      interactions: [
        { action: 'click', selector: testId('mobile-drawer-open') },
        { action: 'wait', selector: testId('conversation-sidebar') },
      ],
      // The scrim, not the sidebar: a closed sidebar is only translated off
      // screen, so it stays "visible" to Playwright and the scenario would
      // photograph a closed drawer and pass. The scrim is `display: none`
      // until `.drawer-open` applies, so it actually proves the drawer opened.
      expectedSelector: testId('drawer-scrim'),
      viewports: ['mobile'],
    },
  },
  {
    name: 'projects',
    patterns: [/^apps\/web\/src\/views\/Projects[^/]*\.tsx$/i],
    scenario: navSurface('nav-projects', 'projects-view'),
  },
  {
    // An analysed project: the profile, its provenance, and the stale badge.
    // The fixture points at a real repository and records an analysed commit
    // that repository has never had, which is exactly the "the repository has
    // moved on" state the badge exists for.
    name: 'project-analysis',
    patterns: [/^apps\/web\/src\/views\/Projects[^/]*\.tsx$/i],
    scenario: {
      route: `/projects/${FIXTURE_ANALYSED_PROJECT_ID}`,
      fixture: 'project-analysis',
      expectedSelector: testId('analysis-status'),
      viewports: VIEWPORTS,
    },
  },
  {
    // The other half of the state machine: a failed run, its reason, and the
    // retry. A project whose analysis failed must still look like a project.
    name: 'project-analysis-failed',
    patterns: [/^apps\/web\/src\/views\/Projects[^/]*\.tsx$/i],
    scenario: {
      route: `/projects/${FIXTURE_ANALYSIS_FAILED_PROJECT_ID}`,
      fixture: 'project-analysis',
      // The status row, not the button: the button renders on every project
      // detail page whatever the analysis state, so it could not tell a failed
      // run from any other and the scenario would pass without showing one.
      expectedSelector: testId('analysis-status'),
      viewports: VIEWPORTS,
    },
  },
  {
    name: 'jobs-list',
    patterns: [/^apps\/web\/src\/views\/Jobs\.tsx$/i],
    // Seeded: an empty Jobs list photographs "No Jobs match these filters" and
    // shows none of the card layout this surface exists to watch. The fixture's
    // paused Job carries a pause reason, which is the cell that was truncated to
    // "Candidate is ..." at phone width.
    scenario: { ...navSurface('nav-jobs', 'jobs-view'), fixture: 'paused-job' },
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
      viewportInteractions: {
        mobile: [
          ...mobileNav('nav-jobs'),
          { action: 'wait', selector: testId('jobs-view') },
          { action: 'click', selector: testId(`job-row-${FIXTURE_PAUSED_JOB_ID}`) },
          { action: 'wait', selector: testId('job-detail-view') },
          { action: 'wait', selector: testId('resume-job') },
          { action: 'wait', selector: testId('pause-explanation') },
        ],
      },
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
    scenario: { ...navSurface('nav-tools', 'tools-view'), fixture: 'chat-workspace' },
  },
];

/** Files that shape every surface, so a change to one earns the broad smoke set. */
const SELF_GLOBAL_PATTERNS = [
  /^apps\/web\/src\/App\.tsx$/i,
  /^apps\/web\/src\/main\.tsx$/i,
  /^apps\/web\/src\/styles\.css$/i,
  /^apps\/web\/src\/index\.css$/i,
  // api.ts and hooks.ts shape every screen too, and the committed catalog has
  // always listed them; this legacy fallback list had drifted from both the
  // catalog and the comment above it.
  /^apps\/web\/src\/api\.ts$/i,
  /^apps\/web\/src\/hooks\.ts$/i,
];
// components.tsx holds Badge, StageBadge, ConfirmDialog, Markdown and the table
// chrome, so it shapes the management views as much as the chat. At BASE it was
// a global-smoke file; narrowing it to the two chat surfaces meant a regression
// in shared rendering on Jobs, Job detail or Tools was no longer photographed.
const SELF_COMPONENT_SMOKE = [
  'chat-workspace',
  'destructive-dialog',
  'jobs-list',
  'job-detail-paused',
  'projects',
  'tools',
];
// App.tsx, styles.css, api.ts and hooks.ts shape every screen, so a change to
// one earns the broad set -- and "broad" has to mean every view the shell
// renders. At BASE that included the Job detail and Tools pages; dropping them
// while widening the chat surfaces left a shell regression on either page
// unphotographed, which is the same gap components.tsx was widened to close.
const SELF_GLOBAL_SMOKE = [
  'chat-workspace',
  'conversation-menu',
  'destructive-dialog',
  'global-search',
  'mobile-conversation-drawer',
  'projects',
  'jobs-list',
  'job-detail-paused',
  'tools',
];

export function selfSurfaceScenario(name: string): VisualQaScenario {
  const surface = SELF_VISUAL_SURFACES.find((entry) => entry.name === name);
  if (!surface) throw new Error(`unknown self visual surface: ${name}`);
  return { name: surface.name, expectedSelectorTimeoutMs: 30_000, ...surface.scenario };
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
    if (/^apps\/web\/src\/components\.tsx$/i.test(file)) {
      for (const name of SELF_COMPONENT_SMOKE) add(name, `${file} -> ${name} (shared UI smoke)`);
      continue;
    }
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

/** Deduplicated fixture profiles a scenario set asks the candidate runtime for. */
export function planFixtures(scenarios: VisualQaScenario[]): string[] {
  return [
    ...new Set(scenarios.flatMap((scenario) => (scenario.fixture ? [scenario.fixture] : []))),
  ];
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
    plannerSource: 'parent',
    ...(required === undefined ? {} : { required }),
    scenarios,
    reasons,
    fixtures: planFixtures(scenarios),
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
