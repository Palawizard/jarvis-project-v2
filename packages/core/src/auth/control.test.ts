import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { HumanControlAuth } from './control.js';

describe('human control authentication', () => {
  it('uses a one-use bootstrap and persists only the reusable credential hash', () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const auth = new HumanControlAuth(db);
    const bootstrap = auth.createBootstrap();
    expect(auth.pair('wrong')).toBeNull();
    const credential = auth.pair(bootstrap);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(auth.pair(bootstrap)).toBeNull();
    expect(auth.authenticated(credential ?? undefined)).toBe(true);
    expect(auth.authenticated('wrong')).toBe(false);

    const row = db.prepare("SELECT * FROM human_control WHERE id='primary'").get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain(bootstrap);
    expect(JSON.stringify(row)).not.toContain(credential);
    expect(new HumanControlAuth(db).authenticated(credential ?? undefined)).toBe(true);
    auth.revoke();
    expect(auth.authenticated(credential ?? undefined)).toBe(false);
    db.close();
  });

  // What `pnpm repair-pairing` sells: a home whose browser credential is gone
  // can be paired again from the terminal, and the lost credential stays dead.
  it('lets a revoked home pair again without reviving the old credential', () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const auth = new HumanControlAuth(db);
    const first = auth.pair(auth.createBootstrap());
    expect(auth.paired()).toBe(true);

    auth.revoke();
    expect(auth.paired()).toBe(false);

    const second = auth.pair(auth.createBootstrap());
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(auth.authenticated(second ?? undefined)).toBe(true);
    expect(auth.authenticated(first ?? undefined)).toBe(false);
    db.close();
  });
});

describe('candidate-runtime Visual QA control', () => {
  const hashOf = (credential: string) =>
    createHash('sha256').update(credential, 'utf8').digest('hex');

  it('seeds isolated candidate authority only inside a candidate runtime', () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const auth = new HumanControlAuth(db);
    const credential = randomBytes(32).toString('base64url');
    const env = { JARVIS_CANDIDATE_QA_CREDENTIAL_HASH: hashOf(credential) };

    // A real Jarvis with no browser credential stays locked: pairing UI only.
    expect(auth.initCandidateVisualQa(env)).toBe(false);
    expect(auth.paired()).toBe(false);
    expect(auth.authenticated(credential)).toBe(false);

    // Candidate flag alone is not enough either — the material must be present.
    expect(auth.initCandidateVisualQa({ JARVIS_CANDIDATE_RUNTIME: '1' })).toBe(false);
    expect(
      auth.initCandidateVisualQa({
        JARVIS_CANDIDATE_RUNTIME: '1',
        JARVIS_CANDIDATE_QA_CREDENTIAL_HASH: 'not-a-hash',
      }),
    ).toBe(false);
    expect(auth.paired()).toBe(false);

    expect(auth.initCandidateVisualQa({ ...env, JARVIS_CANDIDATE_RUNTIME: '1' })).toBe(true);
    expect(auth.authenticated(credential)).toBe(true);
    expect(auth.authenticated(hashOf(credential))).toBe(false); // The hash is not authority.
    db.close();
  });

  it('never lets a candidate credential reach the real control plane', () => {
    const real = openDb(loadConfig({ dbPath: ':memory:' }));
    const realAuth = new HumanControlAuth(real);
    const realCredential = realAuth.pair(realAuth.createBootstrap());
    expect(realCredential).toBeTruthy();

    const candidate = openDb(loadConfig({ dbPath: ':memory:' }));
    const candidateAuth = new HumanControlAuth(candidate);
    const qaCredential = randomBytes(32).toString('base64url');
    candidateAuth.initCandidateVisualQa({
      JARVIS_CANDIDATE_RUNTIME: '1',
      JARVIS_CANDIDATE_QA_CREDENTIAL_HASH: hashOf(qaCredential),
    });

    expect(realAuth.authenticated(qaCredential)).toBe(false);
    expect(candidateAuth.authenticated(realCredential ?? undefined)).toBe(false);
    // The real row is never read or copied into candidate state.
    const candidateRow = candidate.prepare("SELECT * FROM human_control WHERE id='primary'").get();
    expect(JSON.stringify(candidateRow)).not.toContain(
      (
        real.prepare("SELECT credential_hash AS h FROM human_control WHERE id='primary'").get() as {
          h: string;
        }
      ).h,
    );
    real.close();
    candidate.close();
  });
});
