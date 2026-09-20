import { describe, expect, it } from 'vitest';
import type { Job } from '../jobs/service.js';
import type { Project } from '../projects/service.js';
import { mobileRelevant, visualQaEligibility } from './candidate-plan.js';

const project = (overrides: Partial<Project> = {}) =>
  ({
    isSelf: false,
    config: { visualQa: { required: true } },
    ...overrides,
  }) as Project;

const job = (visualQaConfig: Job['visualQaConfig'] = null) =>
  ({ visualQaConfig }) as Pick<Job, 'visualQaConfig'>;

const eligible = (changedFiles: string[], p = project(), j = job()) =>
  visualQaEligibility({ job: j, project: p, changedFiles });

describe('deterministic visual QA eligibility', () => {
  it('never needs a model call', () => {
    // The whole point of the gate: it is a pure function of the diff, the
    // project config and the job. Nothing here can reach a provider.
    expect(visualQaEligibility).toHaveLength(1);
  });

  it('skips a backend-only candidate even when the project requires visual QA', () => {
    const outcome = eligible([
      'packages/core/src/memory/service.ts',
      'packages/core/src/db/index.ts',
    ]);
    expect(outcome.eligible).toBe(false);
    expect(outcome.reason).toContain('no rendered UI file changed');
  });

  it.each([
    ['a migration', ['packages/core/src/db/schema.sql']],
    ['a parser', ['packages/core/src/context/pack.ts']],
    ['a CLI script', ['scripts/dev.mjs']],
    ['unit tests only', ['packages/core/src/jobs/pipeline.test.ts']],
    ['documentation only', ['docs/architecture.md', 'README.md']],
  ])('skips %s', (_name, files) => {
    expect(eligible(files).eligible).toBe(false);
  });

  it.each([
    ['a web view', ['apps/web/src/views/Chat.tsx']],
    ['a stylesheet', ['src/theme.css']],
    ['a template', ['src/index.html']],
  ])('runs for %s', (_name, files) => {
    expect(eligible(files).eligible).toBe(true);
  });

  it('uses the self-UI predicate for the Jarvis project itself', () => {
    const self = project({ isSelf: true });
    expect(eligible(['apps/web/src/views/JobDetail.tsx'], self).eligible).toBe(true);
    // A rendered file that moved out of apps/web is still self UI.
    expect(eligible(['packages/core/src/panels/Widget.tsx'], self).eligible).toBe(true);
    // Its own tests and stories are not.
    expect(eligible(['apps/web/src/views/Chat.test.tsx'], self).eligible).toBe(false);
    expect(eligible(['packages/core/src/jobs/service.ts'], self).eligible).toBe(false);
  });

  it('skips entirely when the project has no isolated visual-QA runtime', () => {
    const bare = project({ config: {} as Project['config'] });
    const outcome = eligible(['apps/web/src/views/Chat.tsx'], bare);
    expect(outcome.eligible).toBe(false);
    expect(outcome.reason).toContain('no isolated visual-QA runtime');
  });

  it('always runs when the job carries an explicit visual QA configuration', () => {
    const explicit = job({ required: true, scenarios: [{ name: 'tools', route: '/' }] });
    expect(eligible(['packages/core/src/db/index.ts'], project(), explicit).eligible).toBe(true);
  });

  describe('mobile relevance', () => {
    const self = (changedFiles: string[]) => mobileRelevant({ changedFiles, isSelf: true });

    it('(a) requires mobile for any rendered file under the UI folder', () => {
      expect(self(['apps/web/src/styles.css'])).toBe(true);
      expect(self(['apps/web/src/components.tsx'])).toBe(true);
      expect(self(['apps/web/src/views/Chat.tsx'])).toBe(true);
      // The hole this closes: a view the old name-based regex never matched.
      expect(self(['apps/web/src/views/JobDetail.tsx'])).toBe(true);
      expect(self(['apps/web/src/theme.scss'])).toBe(true);
      // A generic project has no apps/web, so any rendered file counts.
      expect(mobileRelevant({ changedFiles: ['src/App.vue'], isSelf: false })).toBe(true);
      expect(mobileRelevant({ changedFiles: ['src/App.vue'], isSelf: true })).toBe(false);
    });

    it('(b) requires mobile when the request or a criterion says so, accents and all', () => {
      const asked = (text: string) =>
        mobileRelevant({ changedFiles: ['packages/core/src/x.ts'], isSelf: true, texts: [text] });
      expect(asked('Make the job list readable on mobile')).toBe(true);
      expect(asked('Le panneau doit être responsive')).toBe(true);
      expect(asked('Lisible sur téléphone')).toBe(true);
      expect(asked('Works on a small screen')).toBe(true);
      expect(asked('Rework the SQLite migration')).toBe(false);
    });

    it('(c) requires mobile when a planned scenario declares that viewport', () => {
      const withScenarios = (viewports: ('desktop' | 'mobile')[]) =>
        mobileRelevant({
          changedFiles: ['packages/core/src/x.ts'],
          isSelf: true,
          scenarios: [{ viewports }],
        });
      expect(withScenarios(['desktop', 'mobile'])).toBe(true);
      expect(withScenarios(['desktop'])).toBe(false);
    });

    it('leaves a backend-only candidate alone', () => {
      expect(
        mobileRelevant({
          changedFiles: ['packages/core/src/memory/service.ts', 'apps/web/src/App.test.tsx'],
          isSelf: true,
          texts: ['Rank memories by recency', 'scope-filter before ranking'],
          scenarios: [{ viewports: ['desktop'] }],
        }),
      ).toBe(false);
    });
  });
});
