import { describe, expect, it } from 'vitest';
import { MAX_GRANTABLE_RISK, RISK_LEVELS, decide, previewDecision, riskExceeds } from './policy.js';
import type { RiskLevel, ToolActor } from './policy.js';

describe('tool permission policy', () => {
  it('orders risk levels correctly', () => {
    expect(riskExceeds('destructive', 'observe')).toBe(true);
    expect(riskExceeds('observe', 'destructive')).toBe(false);
    expect(riskExceeds('reversible_modification', 'reversible_modification')).toBe(false);
  });

  it('never lets an agent reach a sensitive or destructive tool', () => {
    for (const risk of ['sensitive', 'destructive'] as RiskLevel[]) {
      for (const hasGrant of [false, true]) {
        expect(decide({ risk, actor: 'agent', hasGrant }).decision).toBe('deny');
      }
    }
  });

  it('asks the user to confirm anything sensitive or destructive', () => {
    expect(decide({ risk: 'sensitive', actor: 'user', hasGrant: false }).decision).toBe('confirm');
    expect(decide({ risk: 'destructive', actor: 'user', hasGrant: false }).decision).toBe(
      'confirm',
    );
    expect(
      decide({ risk: 'reversible_modification', actor: 'user', hasGrant: false }).decision,
    ).toBe('allow');
  });

  it('lets a grant upgrade confirm to allow, up to the grantable ceiling', () => {
    expect(decide({ risk: 'sensitive', actor: 'user', hasGrant: true }).decision).toBe('allow');
    // Destructive always comes back to a human, grant or no grant.
    expect(decide({ risk: 'destructive', actor: 'user', hasGrant: true }).decision).toBe('confirm');
    expect(riskExceeds('destructive', MAX_GRANTABLE_RISK)).toBe(true);
  });

  it('never lets a grant overturn a denial', () => {
    const actors: ToolActor[] = ['user', 'agent', 'system'];
    for (const actor of actors) {
      for (const risk of RISK_LEVELS) {
        const without = decide({ risk, actor, hasGrant: false });
        const with_ = decide({ risk, actor, hasGrant: true });
        if (without.decision === 'deny') expect(with_.decision).toBe('deny');
      }
    }
  });

  it('treats maxRisk as a tightening ceiling only', () => {
    // Lowers an allow to a deny...
    expect(
      decide({
        risk: 'reversible_modification',
        actor: 'user',
        hasGrant: false,
        maxRisk: 'observe',
      }).decision,
    ).toBe('deny');
    // ...and cannot raise an agent past its own limit.
    expect(
      decide({ risk: 'destructive', actor: 'agent', hasGrant: true, maxRisk: 'destructive' })
        .decision,
    ).toBe('deny');
  });

  it('explains what the catalog would do without running anything', () => {
    expect(previewDecision('observe', 'agent')).toBe('allow');
    expect(previewDecision('destructive', 'system')).toBe('deny');
  });
});
