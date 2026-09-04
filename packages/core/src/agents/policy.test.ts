import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MODELS,
  CAPABILITY_TIERS,
  EFFORT_LEVELS,
  classifyChangedPaths,
  modelFor,
  ROLE_POLICY,
  selectExecutionProfile,
  type CapabilityTier,
  type EffortLevel,
  type TaskSignals,
} from './policy.js';
import type { AgentRole, ProviderId } from './types.js';

const ROLES = Object.keys(ROLE_POLICY) as AgentRole[];

const decide = (role: AgentRole, signals: TaskSignals = {}) =>
  selectExecutionProfile({ role, signals });

/** `normal/medium` — the raw policy verdict. */
const tier = (role: AgentRole, signals: TaskSignals = {}): string => {
  const p = decide(role, signals);
  return `${p.capabilityTier}/${p.effort}`;
};

/** `claude/opus/high` — the shape a human reads in the Job view. */
const run = (id: ProviderId, role: AgentRole, signals: TaskSignals = {}): string => {
  const p = decide(role, signals);
  return `${id}/${modelFor(id, p.capabilityTier)}/${p.effort}`;
};

/** A change big enough on complexity alone to leave the normal tier. */
const BIG: TaskSignals = {
  hasCompiledBrief: true,
  requirements: 12,
  acceptanceCriteria: 9,
  packagesTouched: 4,
  frontendTouched: true,
  backendTouched: true,
  filesChanged: 40,
  linesChanged: 2_000,
};

const ALARMING: TaskSignals = {
  selfDevelopment: true,
  highRisk: true,
  sensitive: ['auth', 'permissions'],
  linesChanged: 9_000,
};

/** Signal sets used by the exhaustive sweeps. */
const MATRIX: TaskSignals[] = [
  {},
  { mechanical: true },
  { selfDevelopment: true },
  { highRisk: true },
  { selfDevelopment: true, highRisk: true },
  { sensitive: ['auth'] },
  { sensitive: ['auth', 'permissions', 'database_migration'] },
  { requestChars: 12_000 },
  { hasCompiledBrief: true, requirements: 14, acceptanceCriteria: 14 },
  { repairCycle: 3, blockers: 5, highSeverityBlocker: true },
  { productDefect: true, uiFilesChanged: 30 },
  { escalated: true },
  { filesChanged: 1, linesChanged: 1 },
  { failedChecks: 7 },
  BIG,
  ALARMING,
  { ...BIG, ...ALARMING },
];

describe('model policy — anchored cases', () => {
  it('1. the router is always the cheap bounded model', () => {
    expect(run('claude', 'router')).toBe('claude/sonnet/low');
    expect(run('codex', 'router')).toBe('codex/gpt-5.6-terra/low');
    // Even the most alarming signals cannot buy the router a stronger model.
    expect(run('claude', 'router', ALARMING)).toBe('claude/sonnet/low');
  });

  it('2. the autostart verifier is sonnet low', () => {
    expect(run('claude', 'autostart_verifier')).toBe('claude/sonnet/low');
    expect(run('claude', 'autostart_verifier', ALARMING)).toBe('claude/sonnet/low');
  });

  it('3. a simple brief compilation is sonnet low', () => {
    expect(run('claude', 'brief_compiler', { requestChars: 120 })).toBe('claude/sonnet/low');
  });

  it('3b. a huge request lifts the compiler to its medium ceiling and no further', () => {
    expect(tier('brief_compiler', { requestChars: 20_000 })).toBe('normal/medium');
    expect(tier('brief_compiler', { requestChars: 20_000, ...ALARMING })).toBe('normal/medium');
  });

  it('4. a small UI change (tooltip) is sonnet medium for the implementer', () => {
    const small = { hasCompiledBrief: true, requirements: 1, acceptanceCriteria: 2 };
    expect(run('claude', 'implementer', small)).toBe('claude/sonnet/medium');
  });

  it('5. a mechanical typo/docs change never goes strong', () => {
    const p = decide('implementer', { mechanical: true, hasCompiledBrief: true });
    expect(p.capabilityTier).toBe('normal');
    expect(['low', 'medium']).toContain(p.effort);
  });

  it('6. changing the Jarvis pipeline itself is at least strong/medium', () => {
    const p = decide('implementer', {
      selfDevelopment: true,
      hasCompiledBrief: true,
      requirements: 8,
      acceptanceCriteria: 6,
      packagesTouched: 2,
    });
    expect(p.capabilityTier).toBe('strong');
    expect(['medium', 'high']).toContain(p.effort);
  });

  it('7. permissions / auth / sandbox / supervisor work is strong high', () => {
    const categories = [
      'auth',
      'permissions',
      'sandbox_isolation',
      'supervisor_activation',
    ] as const;
    for (const category of categories) {
      expect(tier('implementer', { sensitive: [category] })).toBe('strong/high');
      expect(tier('fixer', { sensitive: [category] })).toBe('strong/high');
      expect(tier('reviewer', { sensitive: [category] })).toBe('strong/high');
      expect(tier('visual_fixer', { sensitive: [category] })).toBe('strong/high');
    }
  });

  it('8. a big cross-package feature with DB, UI and backend is strong high', () => {
    const feature = { ...BIG, dbMigration: true };
    expect(run('claude', 'implementer', feature)).toBe('claude/opus/high');
    expect(run('codex', 'implementer', feature)).toBe('codex/gpt-5.6-sol/high');
  });

  it('8b. complexity alone, with no risk signal at all, still reaches strong', () => {
    expect(decide('implementer', BIG).capabilityTier).toBe('strong');
  });

  it('9. a small formatter/lint fixer stays normal and cheap', () => {
    const lint = { mechanical: true, filesChanged: 1, linesChanged: 4, failedChecks: 1 };
    const p = decide('fixer', lint);
    expect(p.capabilityTier).toBe('normal');
    expect(['low', 'medium']).toContain(p.effort);
  });

  it('10. fixing a HIGH security blocker is strong high', () => {
    const blocker: TaskSignals = {
      repairCycle: 1,
      blockers: 1,
      highSeverityBlocker: true,
      sensitive: ['auth'],
      filesChanged: 2,
      linesChanged: 12,
    };
    expect(run('claude', 'fixer', blocker)).toBe('claude/opus/high');
  });

  it('11. an ordinary review of a small diff is normal high', () => {
    const ordinary = { filesChanged: 3, linesChanged: 60, packagesTouched: 1 };
    expect(run('claude', 'reviewer', ordinary)).toBe('claude/sonnet/high');
  });

  it('12. a self-development security-sensitive review is strong high', () => {
    const sensitive: TaskSignals = {
      selfDevelopment: true,
      sensitive: ['permissions'],
      filesChanged: 4,
      linesChanged: 120,
    };
    expect(run('claude', 'reviewer', sensitive)).toBe('claude/opus/high');
  });

  it('13. a visual review of a small change is normal medium', () => {
    expect(run('claude', 'visual_reviewer', { uiFilesChanged: 2 })).toBe('claude/sonnet/medium');
  });

  it('13b. a large changed UI surface lifts the visual reviewer to high', () => {
    expect(tier('visual_reviewer', { uiFilesChanged: 12 })).toBe('normal/high');
  });

  it('13c. the one escalated visual re-look gets a stronger model', () => {
    expect(tier('visual_reviewer', { escalated: true, uiFilesChanged: 2 })).toBe('strong/medium');
  });

  it('14. no signal combination can ever produce haiku', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        const model = modelFor('claude', decide(role, signals).capabilityTier);
        expect(model).not.toBe('haiku');
        expect(ALLOWED_MODELS.claude).toContain(model);
      }
    }
  });

  it('15/16/17. every decision stays inside the declared model and effort space', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        const { effort, capabilityTier } = decide(role, signals);
        expect(EFFORT_LEVELS).toContain(effort);
        expect(CAPABILITY_TIERS).toContain(capabilityTier);
        expect(['sonnet', 'opus']).toContain(modelFor('claude', capabilityTier));
        expect(['gpt-5.6-terra', 'gpt-5.6-sol']).toContain(modelFor('codex', capabilityTier));
      }
    }
  });
});

describe('model policy — brief recommendations', () => {
  const recommendation = (capabilityTier: CapabilityTier, effort: EffortLevel): TaskSignals => ({
    executionRecommendation: {
      capabilityTier,
      effort,
      reasons: ['semantic fixture'],
    },
  });

  it('uses semantic tier and effort independently, then applies the implementer floor', () => {
    expect(tier('implementer', recommendation('normal', 'low'))).toBe('normal/medium');
    expect(tier('implementer', recommendation('normal', 'high'))).toBe('normal/high');
    expect(tier('implementer', recommendation('strong', 'medium'))).toBe('strong/medium');
    expect(tier('implementer', recommendation('strong', 'high'))).toBe('strong/high');
  });

  it('lets a trusted sensitive-path floor override semantic advice', () => {
    expect(
      tier('implementer', { ...recommendation('normal', 'medium'), sensitive: ['permissions'] }),
    ).toBe('strong/high');
  });

  it('does not let brief counts or request length override semantic advice', () => {
    const profile = decide('implementer', {
      ...recommendation('normal', 'low'),
      requestChars: 50_000,
      requirements: 14,
      acceptanceCriteria: 14,
    });
    expect(`${profile.capabilityTier}/${profile.effort}`).toBe('normal/medium');
    expect(profile.factors).toContain('brief recommendation: normal/low');
  });

  it('ignores malformed advice and keeps deterministic fallback', () => {
    const profile = decide('implementer', {
      executionRecommendation: {
        capabilityTier: 'normal',
        effort: 'high',
        reasons: [],
      } as unknown as TaskSignals['executionRecommendation'],
      requestChars: 12_000,
    });
    expect(`${profile.capabilityTier}/${profile.effort}`).toBe('normal/medium');
  });

  it('does not let the brief compiler, reviewer, or fixer select from its advice', () => {
    const signals = recommendation('strong', 'high');
    expect(tier('brief_compiler', signals)).toBe('normal/low');
    expect(tier('reviewer', signals)).toBe('normal/high');
    expect(tier('fixer', signals)).toBe('normal/medium');
  });
});

describe('model policy — role floors and ceilings', () => {
  it('never returns strong for a role whose ceiling is normal', () => {
    const capped = ROLES.filter((role) => ROLE_POLICY[role].maxTier === 'normal');
    expect(capped).toContain('router');
    expect(capped).toContain('autostart_verifier');
    expect(capped).toContain('brief_compiler');
    expect(capped).toContain('chat');
    for (const role of capped) {
      for (const signals of MATRIX) {
        expect(decide(role, signals).capabilityTier).toBe('normal');
      }
    }
  });

  it('never reviews code at less than high effort', () => {
    for (const signals of MATRIX) {
      expect(decide('reviewer', signals).effort).toBe('high');
    }
  });

  it('keeps every role inside its own declared effort bounds', () => {
    for (const role of ROLES) {
      const policy = ROLE_POLICY[role];
      const min = EFFORT_LEVELS.indexOf(policy.minEffort);
      const max = EFFORT_LEVELS.indexOf(policy.maxEffort);
      for (const signals of MATRIX) {
        const at = EFFORT_LEVELS.indexOf(decide(role, signals).effort);
        expect(at).toBeGreaterThanOrEqual(min);
        expect(at).toBeLessThanOrEqual(max);
      }
    }
  });

  it('gives the implementer at least medium effort even for a trivial change', () => {
    const trivial = { mechanical: true, filesChanged: 1, linesChanged: 2 };
    expect(decide('implementer', trivial).effort).toBe('medium');
  });

  it('lets a fixer go all the way down to low, and a chat turn too', () => {
    const trivial = { mechanical: true, filesChanged: 1, linesChanged: 2 };
    expect(decide('fixer', trivial).effort).toBe('low');
    expect(decide('chat', { requestChars: 40 }).effort).toBe('low');
  });

  it('scales a chat turn up with the size of the question, never past normal', () => {
    expect(tier('chat', { requestChars: 40 })).toBe('normal/low');
    expect(tier('chat', { requestChars: 3_000 })).toBe('normal/medium');
    expect(tier('chat', { requestChars: 9_000, selfDevelopment: true })).toBe('normal/high');
    expect(tier('chat', ALARMING)).toBe('normal/high');
  });

  it('starts the project analyst at normal medium and lets it reach strong', () => {
    expect(tier('project_analyst')).toBe('normal/medium');
    expect(tier('project_analyst', { selfDevelopment: true, highRisk: true })).toBe('normal/high');
    expect(tier('project_analyst', ALARMING)).toBe('strong/high');
    const heavy = { selfDevelopment: true, highRisk: true, packagesTouched: 6 };
    expect(tier('project_analyst', heavy)).toBe('strong/medium');
  });
});

describe('model policy — score boundaries', () => {
  const reqs = (n: number): TaskSignals => ({ hasCompiledBrief: true, requirements: n });

  it('does not count requirements until each threshold is crossed', () => {
    expect(decide('implementer', reqs(5)).score).toBe(0);
    expect(decide('implementer', reqs(6)).score).toBe(1);
    expect(decide('implementer', reqs(10)).score).toBe(1);
    expect(decide('implementer', reqs(11)).score).toBe(2);
  });

  it('does not count acceptance criteria until the threshold is crossed', () => {
    const at = (n: number) => ({ hasCompiledBrief: true, acceptanceCriteria: n });
    expect(decide('implementer', at(5)).score).toBe(0);
    expect(decide('implementer', at(6)).score).toBe(1);
  });

  it('counts diff size at 400 and again at 1500 lines', () => {
    expect(decide('implementer', { linesChanged: 400 }).score).toBe(0);
    expect(decide('implementer', { linesChanged: 401 }).score).toBe(1);
    expect(decide('implementer', { linesChanged: 1_500 }).score).toBe(1);
    expect(decide('implementer', { linesChanged: 1_501 }).score).toBe(2);
  });

  it('counts a second workspace, a second blocker and a long request, not the first', () => {
    expect(decide('implementer', { packagesTouched: 1 }).score).toBe(0);
    expect(decide('implementer', { packagesTouched: 2 }).score).toBe(1);
    expect(decide('fixer', { blockers: 1 }).score).toBe(0);
    expect(decide('fixer', { blockers: 2 }).score).toBe(1);
    expect(decide('implementer', { requestChars: 2_000 }).score).toBe(0);
    expect(decide('implementer', { requestChars: 2_001 }).score).toBe(1);
  });

  it('ignores request size once a compiled brief exists, to avoid double counting', () => {
    const long = { requestChars: 20_000 };
    expect(decide('implementer', long).score).toBe(2);
    expect(decide('implementer', { ...long, hasCompiledBrief: true }).score).toBe(0);
  });

  it('lands on each band exactly at its edge', () => {
    expect(bandOf(2)).toBe('normal/medium');
    expect(bandOf(3)).toBe('normal/high');
    expect(bandOf(4)).toBe('normal/high');
    expect(bandOf(5)).toBe('strong/medium');
    expect(bandOf(6)).toBe('strong/medium');
    expect(bandOf(7)).toBe('strong/high');
  });

  it('requires the diff to be known before calling a change trivial', () => {
    expect(decide('fixer', { filesChanged: 1 }).score).toBe(0);
    expect(decide('fixer', { filesChanged: 1, linesChanged: 4 }).score).toBe(-1);
  });
});

/** Independent complexity signals, stacked to reach an exact score. */
function scoreTo(target: number): TaskSignals {
  const signals: TaskSignals = { hasCompiledBrief: true };
  const ladder: Array<(s: TaskSignals) => void> = [
    (s) => (s.requirements = 6),
    (s) => (s.acceptanceCriteria = 6),
    (s) => (s.packagesTouched = 2),
    (s) => {
      s.frontendTouched = true;
      s.backendTouched = true;
    },
    (s) => (s.dbMigration = true),
    (s) => (s.linesChanged = 401),
    (s) => (s.requirements = 11),
    (s) => (s.linesChanged = 1_501),
  ];
  for (let i = 0; i < target; i++) ladder[i]?.(signals);
  return signals;
}

/** `implementer` has no bias, so its verdict is the raw band. */
function bandOf(target: number): string {
  const profile = selectExecutionProfile({ role: 'implementer', signals: scoreTo(target) });
  expect(profile.score).toBe(target);
  return `${profile.capabilityTier}/${profile.effort}`;
}

describe('model policy — invariants', () => {
  const rank = (p: { capabilityTier: CapabilityTier; effort: EffortLevel }): number =>
    CAPABILITY_TIERS.indexOf(p.capabilityTier) * 3 + EFFORT_LEVELS.indexOf(p.effort);

  it('is deterministic: the same inputs always give the same decision', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        expect(decide(role, signals)).toEqual(decide(role, signals));
      }
    }
  });

  it('turning highRisk on never weakens the decision', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        const on = rank(decide(role, { ...signals, highRisk: true }));
        const off = rank(decide(role, { ...signals, highRisk: false }));
        expect(on).toBeGreaterThanOrEqual(off);
      }
    }
  });

  it('turning selfDevelopment on never weakens the decision', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        const on = rank(decide(role, { ...signals, selfDevelopment: true }));
        const off = rank(decide(role, { ...signals, selfDevelopment: false }));
        expect(on).toBeGreaterThanOrEqual(off);
      }
    }
  });

  it('adding a high-severity blocker never weakens the decision', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        const on = rank(decide(role, { ...signals, highSeverityBlocker: true }));
        const off = rank(decide(role, signals));
        expect(on).toBeGreaterThanOrEqual(off);
      }
    }
  });

  it('marking a change mechanical never strengthens the decision', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        const on = rank(decide(role, { ...signals, mechanical: true }));
        const off = rank(decide(role, { ...signals, mechanical: false }));
        expect(on).toBeLessThanOrEqual(off);
      }
    }
  });

  it('always explains itself with at least one bounded factor', () => {
    for (const role of ROLES) {
      for (const signals of MATRIX) {
        const { factors } = decide(role, signals);
        expect(factors.length).toBeGreaterThan(0);
        expect(factors.length).toBeLessThanOrEqual(12);
      }
    }
  });

  it('treats missing signals as absent, never as an error', () => {
    for (const role of ROLES) {
      expect(() => selectExecutionProfile({ role })).not.toThrow();
    }
    // No brief, no diff stats, no provider preference: still a real decision.
    expect(tier('implementer')).toBe('normal/medium');
    expect(tier('fixer')).toBe('normal/medium');
    expect(tier('reviewer')).toBe('normal/high');
  });
});

describe('model policy — trusted path facts', () => {
  it('reads workspaces, stacks and sensitive areas off git paths only', () => {
    const facts = classifyChangedPaths([
      'packages/core/src/auth/control.ts',
      'packages/core/src/db/migrations/013.sql',
      'apps/web/src/views/JobDetail.tsx',
      'apps/orchestrator/src/routes.ts',
    ]);
    expect(facts.filesChanged).toBe(4);
    expect(facts.packagesTouched).toBe(3);
    expect(facts.frontendTouched).toBe(true);
    expect(facts.backendTouched).toBe(true);
    expect(facts.dbMigration).toBe(true);
    expect(facts.sensitive).toContain('auth');
    expect(facts.sensitive).toContain('database_migration');
  });

  it('finds nothing sensitive in an ordinary documentation change', () => {
    const facts = classifyChangedPaths(['docs/architecture.md', 'docs/jobs.md']);
    expect(facts.sensitive).toEqual([]);
    expect(facts.frontendTouched).toBe(false);
    expect(facts.packagesTouched).toBe(1);
    const docs = { ...facts, linesChanged: 12, mechanical: true };
    expect(tier('implementer', docs)).toBe('normal/medium');
  });

  it('uses only the length of a request, never the words in it', () => {
    const a = decide('implementer', { requestChars: 300 });
    const b = decide('implementer', { requestChars: 300 });
    expect(a).toEqual(b);
    expect(JSON.stringify(a.factors)).not.toMatch(/security|auth/i);
  });
});

describe('model policy — worked explanations', () => {
  it('explains a strong/high implementer decision in readable factors', () => {
    const profile = decide('implementer', {
      selfDevelopment: true,
      highRisk: true,
      hasCompiledBrief: true,
      requirements: 11,
      packagesTouched: 3,
    });
    expect(profile.capabilityTier).toBe('strong');
    expect(profile.effort).toBe('high');
    expect(profile.factors).toContain('11 requirements (+1)');
    expect(profile.factors).toContain('3 workspaces touched (+1)');
    expect(profile.factors).toContain('self-development (+2)');
    expect(profile.factors).toContain('high-risk (+2)');
  });

  it('explains a bounded brief_compiler decision by its role policy', () => {
    const profile = decide('brief_compiler', { requestChars: 200 });
    expect(run('claude', 'brief_compiler', { requestChars: 200 })).toBe('claude/sonnet/low');
    expect(profile.factors.join(' ')).toContain('bounded tool-free structured compilation');
  });

  it('explains a security floor rather than hiding it in the score', () => {
    const profile = decide('reviewer', { sensitive: ['permissions'] });
    expect(profile.factors.join(' ')).toContain('security-sensitive');
  });
});
