import { describe, expect, it } from 'vitest';
import type { Job } from '../jobs/service.js';
import type { Project } from '../projects/service.js';
import { FIXTURE_PAUSED_JOB_ID, resolveVisualPlan, selfSurfaceScenario } from './surfaces.js';

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
    config: {
      visualQa: { required: true, scenarios: [selfSurfaceScenario('command')] },
    },
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
    request: 'clearer paused explanation',
    goal: 'paused jobs show a clearer short explanation next to the Resume button',
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

const names = (plan: { scenarios: { name: string }[] } | null) =>
  (plan?.scenarios ?? []).map((scenario) => scenario.name);

describe('resolveVisualPlan', () => {
  it('selects job-detail-paused for the exact production JobDetail change', () => {
    const plan = resolveVisualPlan(job(), project(), ['apps/web/src/views/JobDetail.tsx']);
    expect(plan?.source).toBe('changed_surface');
    expect(names(plan)).toEqual(['job-detail-paused']);
    expect(plan?.scenarios[0]?.viewports).toEqual(['desktop', 'mobile']);
    expect(plan?.reasons).toContain('apps/web/src/views/JobDetail.tsx -> job-detail-paused');
    expect(plan?.fixtures).toEqual(['paused-job']);
  });

  it('selects tools for a Tools change, and not JobDetail', () => {
    const plan = resolveVisualPlan(job(), project(), ['apps/web/src/views/Tools.tsx']);
    expect(names(plan)).toEqual(['tools']);
    expect(names(plan)).not.toContain('job-detail-paused');
    expect(plan?.fixtures).toEqual([]);
  });

  it('does not select every default scenario for a single local view change', () => {
    const plan = resolveVisualPlan(job(), project(), ['apps/web/src/views/JobDetail.tsx']);
    expect(plan?.scenarios).toHaveLength(1);
    expect(names(plan)).not.toContain('command');
    expect(names(plan)).not.toContain('tools');
  });

  it('selects the broad smoke set for a global App/CSS change', () => {
    for (const file of ['apps/web/src/App.tsx', 'apps/web/src/styles.css']) {
      const plan = resolveVisualPlan(job(), project(), [file]);
      expect(plan?.source).toBe('changed_surface');
      expect(names(plan)).toEqual(['command', 'jobs-list', 'job-detail-paused', 'tools']);
      expect(plan?.reasons.every((reason) => reason.includes('global UI smoke'))).toBe(true);
    }
  });

  it('lets an explicit job visualQaConfig override automatic mapping', () => {
    const override = { required: true, scenarios: [{ name: 'custom', route: '/' }] };
    const plan = resolveVisualPlan(job({ visualQaConfig: override }), project(), [
      'apps/web/src/views/JobDetail.tsx',
    ]);
    expect(plan?.source).toBe('job_override');
    expect(names(plan)).toEqual(['custom']);
  });

  it('falls back to project defaults for an unknown UI file', () => {
    const plan = resolveVisualPlan(job(), project(), ['apps/web/src/api.ts']);
    expect(plan?.source).toBe('project_default');
    expect(names(plan)).toEqual(['command']);
  });

  it('never uses the self catalog for a non-self project', () => {
    const other = project({
      isSelf: false,
      config: { visualQa: { routes: ['/'] } },
    });
    const plan = resolveVisualPlan(job(), other, ['apps/web/src/views/JobDetail.tsx']);
    expect(plan?.source).toBe('project_default');
    expect(names(plan)).toEqual(['default']);
  });

  it('returns null when the project configures no visual QA at all', () => {
    expect(resolveVisualPlan(job(), project({ config: {} }), ['apps/web/src/App.tsx'])).toBeNull();
  });

  it('deduplicates surfaces and keeps catalog order regardless of diff order', () => {
    const plan = resolveVisualPlan(job(), project(), [
      'apps/web/src/views/Tools.tsx',
      'apps/web/src/views/JobDetail.tsx',
      'apps/web/src/views/Tools.tsx',
    ]);
    expect(names(plan)).toEqual(['job-detail-paused', 'tools']);
  });
});

describe('job-detail-paused scenario', () => {
  const scenario = selfSurfaceScenario('job-detail-paused');

  it('reaches the exact expected selector through bounded declared interactions', () => {
    expect(scenario.expectedSelector).toBe("[data-testid='pause-explanation']");
    expect(scenario.interactions?.map((step) => step.action)).toEqual([
      'click',
      'wait',
      'click',
      'wait',
      'wait',
      'wait',
    ]);
    const selectors = (scenario.interactions ?? []).map((step) =>
      'selector' in step ? step.selector : null,
    );
    expect(selectors).toEqual([
      "[data-testid='nav-jobs']",
      "[data-testid='jobs-view']",
      `[data-testid='job-row-${FIXTURE_PAUSED_JOB_ID}']`,
      "[data-testid='job-detail-view']",
      "[data-testid='resume-job']",
      "[data-testid='pause-explanation']",
    ]);
  });

  it('declares the fixture it needs and both viewports', () => {
    expect(scenario.fixture).toBe('paused-job');
    expect(scenario.viewports).toEqual(['desktop', 'mobile']);
  });

  it('confines every scenario to a same-origin absolute route', () => {
    for (const name of ['command', 'projects', 'jobs-list', 'job-detail-paused', 'memory', 'tools'])
      expect(selfSurfaceScenario(name).route).toBe('/');
  });
});
