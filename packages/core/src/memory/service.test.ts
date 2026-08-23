import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, type Db } from '../db/index.js';
import { loadConfig, type JarvisConfig } from '../config.js';
import { EventBus } from '../events/bus.js';
import { MemoryService, calibrateSemantic, toFtsQuery } from './service.js';
import { ContextPackBuilder, estimateTokens } from '../context/pack.js';
import type { EmbeddingProvider } from './embeddings.js';

/**
 * Deterministic stand-in for the local embedding model.
 *
 * Tests must assert retrieval behaviour, not model quality — and they must run
 * without downloading 100MB of ONNX weights. Uses a hashed bag-of-words vector,
 * which is enough for "related text scores higher than unrelated text".
 */
function fakeEmbeddings(dim = 64): EmbeddingProvider {
  const embed = (text: string): Float32Array => {
    const vec = new Float32Array(dim);
    for (const token of text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
      vec[hash % dim] = (vec[hash % dim] as number) + 1;
    }
    let sum = 0;
    for (let i = 0; i < dim; i++) sum += (vec[i] as number) ** 2;
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < dim; i++) vec[i] = (vec[i] as number) / norm;
    return vec;
  };
  return {
    id: 'test-fake-v1',
    dim,
    available: async () => true,
    embedPassages: async (texts) => texts.map(embed),
    embedQuery: async (text) => embed(text),
    status: () => ({ enabled: true, ready: true, model: 'test-fake-v1', dim }),
  };
}

let home: string;
let db: Db;
let config: JarvisConfig;
let memory: MemoryService;
let bus: EventBus;

function makeMemory(): MemoryService {
  return new MemoryService({ db, bus, config, embeddings: fakeEmbeddings() });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
  config = loadConfig({ home });
  db = openDb(config);
  bus = new EventBus(db);
  memory = makeMemory();
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const PROJECT_A = 'prj_aaa';
const PROJECT_B = 'prj_bbb';

/** Lexically distinct subjects, so fixtures are not accidentally deduped. */
const TOPICS = [
  'Keyboard-driven navigation',
  'Trunk based branching',
  'Conventional commit messages',
  'Automatic dependency pinning',
  'Structured logging output',
  'Colocated unit tests',
  'Strict null checking',
  'Zero downtime migrations',
];

/**
 * Each entry shares only the query terms ("scheduler queue") and is otherwise
 * lexically unique, so they survive write-time dedupe AND retrieval diversity.
 * Fixtures that differ only by a number collapse: the tokenizer drops digits.
 */
const MODULES: Array<[string, string]> = [
  ['billing', 'invoice proration dunning'],
  ['telemetry', 'histogram exemplar cardinality'],
  ['ingestion', 'backfill watermark partition'],
  ['notification', 'digest throttle unsubscribe'],
  ['permission', 'delegation inheritance revocation'],
  ['reporting', 'rollup cohort attribution'],
  ['archival', 'tombstone retention coldline'],
  ['geocoding', 'centroid bounding reverse'],
  ['reconciliation', 'ledger discrepancy adjustment'],
  ['provisioning', 'tenancy quota bootstrap'],
  ['translation', 'locale pluralization glossary'],
  ['attachment', 'thumbnail antivirus checksum'],
  ['subscription', 'renewal grace entitlement'],
  ['moderation', 'appeal escalation classifier'],
  ['checkout', 'basket coupon fulfilment'],
  ['inventory', 'reservation replenishment shrinkage'],
  ['settlement', 'payout chargeback remittance'],
  ['onboarding', 'invitation walkthrough activation'],
  ['exporting', 'columnar manifest compression'],
  ['auditing', 'immutability signature attestation'],
];

describe('scope isolation', () => {
  it('never returns project A memory when retrieving for project B', async () => {
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'decision',
      content: 'Project A uses Redis for the rate limiter.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_B,
      kind: 'decision',
      content: 'Project B uses Postgres advisory locks for the rate limiter.',
      sourceType: 'user_explicit',
      explicit: true,
    });

    const forB = await memory.retrieve({
      query: 'rate limiter implementation',
      scopes: [{ scope: 'project', scopeId: PROJECT_B }],
    });

    expect(forB.length).toBeGreaterThan(0);
    expect(forB.every((r) => r.memory.scopeId === PROJECT_B)).toBe(true);
    expect(forB.some((r) => r.memory.content.includes('Redis'))).toBe(false);
  });

  it('does not leak project memory into a user-scope-only retrieval', async () => {
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'fact',
      content: 'The deployment target is Scalingo.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const results = await memory.retrieve({
      query: 'deployment target',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(results).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('survives closing and reopening the database', async () => {
    await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.editor',
      content: 'The user edits code in Neovim with a tmux split.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    db.close();

    // Reopen exactly as a restarted process would.
    db = openDb(config);
    bus = new EventBus(db);
    const reopened = makeMemory();

    const results = await reopened.retrieve({
      query: 'which editor does the user use',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(results[0]?.memory.content).toContain('Neovim');
  });
});

describe('explicit remember and forget', () => {
  it('stores an explicit request even below the automatic importance threshold', async () => {
    const outcome = await memory.remember({
      scope: 'user',
      kind: 'other',
      content: 'Call me Bapt, not Baptiste.',
      importance: 0.05,
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(outcome.status).toBe('stored');
  });

  it('drops a low-value automatic candidate', async () => {
    const outcome = await memory.remember({
      scope: 'user',
      kind: 'other',
      content: 'ok thanks',
      sourceType: 'system',
    });
    expect(outcome.status).toBe('rejected');
  });

  it('forget removes it from retrieval but keeps it auditable', async () => {
    const stored = await memory.remember({
      scope: 'user',
      kind: 'fact',
      content: 'The user works primarily on Windows 11 with WSL disabled.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    if (stored.status !== 'stored') throw new Error('setup failed');

    expect(memory.forget(stored.memory.id)).toBe(true);

    const active = await memory.retrieve({
      query: 'windows',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(active.find((r) => r.memory.id === stored.memory.id)).toBeUndefined();

    // Still inspectable.
    expect(memory.get(stored.memory.id)?.status).toBe('deleted');
  });
});

describe('temporal correction', () => {
  it('supersedes the previous value for the same subject key', async () => {
    const first = await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.package_manager',
      content: 'The user prefers npm.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const second = await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.package_manager',
      content: 'The user prefers pnpm.',
      sourceType: 'user_explicit',
      explicit: true,
    });

    if (first.status !== 'stored' || second.status !== 'stored') throw new Error('setup failed');
    expect(second.supersededId).toBe(first.memory.id);

    const old = memory.get(first.memory.id);
    expect(old?.status).toBe('superseded');
    expect(old?.supersededBy).toBe(second.memory.id);

    const results = await memory.retrieve({
      query: 'package manager preference',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(results.map((r) => r.memory.id)).toContain(second.memory.id);
    expect(results.map((r) => r.memory.id)).not.toContain(first.memory.id);
  });

  it('treats a near-identical A to B subject update as supersession, not deduplication', async () => {
    const first = await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.test',
      content: 'Preference = A',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const second = await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.test',
      content: 'Preference = B',
      sourceType: 'user_explicit',
      explicit: true,
    });

    expect(first.status).toBe('stored');
    expect(second.status).toBe('stored');
    if (first.status === 'stored' && second.status === 'stored') {
      expect(second.supersededId).toBe(first.memory.id);
      expect(memory.get(first.memory.id)?.status).toBe('superseded');
    }
  });

  it('correct() links supersession even without a shared subject key', async () => {
    const first = await memory.remember({
      scope: 'user',
      kind: 'fact',
      content: 'The user deploys the API to Heroku.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    if (first.status !== 'stored') throw new Error('setup failed');

    const corrected = await memory.correct(
      first.memory.id,
      'The user deploys the API to Scalingo, not Heroku.',
    );
    expect(corrected.status).toBe('stored');
    expect(memory.get(first.memory.id)?.status).toBe('superseded');
    if (corrected.status === 'stored') {
      expect(memory.get(corrected.memory.id)?.supersedes).toBe(first.memory.id);
    }
  });

  it('correct() cannot be swallowed by near-deduplication', async () => {
    const first = await memory.remember({
      scope: 'user',
      kind: 'preference',
      content: 'Preference = A',
      sourceType: 'user_explicit',
      explicit: true,
    });
    if (first.status !== 'stored') throw new Error('setup failed');

    const corrected = await memory.correct(first.memory.id, 'Preference = B');

    expect(corrected.status).toBe('stored');
    if (corrected.status === 'stored') {
      expect(corrected.supersededId).toBe(first.memory.id);
      expect(memory.get(first.memory.id)?.status).toBe('superseded');
    }
  });
});

describe('deduplication', () => {
  it('keeps identical content under distinct structured identities', async () => {
    const first = await memory.remember({
      scope: 'user',
      kind: 'fact',
      subject: 'editor.primary',
      content: 'Neovim',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const second = await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'editor.preferred',
      content: 'Neovim',
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(first.status).toBe('stored');
    expect(second.status).toBe('stored');
  });

  it('correction supersedes its target even when the new content already exists', async () => {
    const target = await memory.remember({
      scope: 'user',
      kind: 'fact',
      content: 'Editor A',
      sourceType: 'user_explicit',
      explicit: true,
    });
    await memory.remember({
      scope: 'user',
      kind: 'fact',
      content: 'Editor B',
      sourceType: 'user_explicit',
      explicit: true,
    });
    if (target.status !== 'stored') throw new Error('setup failed');

    const corrected = await memory.correct(target.memory.id, 'Editor B');
    expect(corrected.status).toBe('stored');
    expect(memory.get(target.memory.id)?.status).toBe('superseded');
  });

  it('does not grow storage when the same fact is asserted repeatedly', async () => {
    const content = 'The Jarvis orchestrator listens on port 4319 by default.';
    for (let i = 0; i < 6; i++) {
      await memory.remember({
        scope: 'project',
        scopeId: PROJECT_A,
        kind: 'project_knowledge',
        content,
        sourceType: 'agent_proposal',
        explicit: true,
      });
    }
    expect(memory.list({ scope: 'project', scopeId: PROJECT_A }).total).toBe(1);
  });

  it('collapses near-duplicate phrasings of the same fact', async () => {
    await memory.remember({
      scope: 'user',
      kind: 'preference',
      content: 'The user likes dark mode enabled everywhere.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const second = await memory.remember({
      scope: 'user',
      kind: 'preference',
      content: 'The user likes dark mode enabled everywhere!',
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(second.status).toBe('duplicate');
    expect(memory.list({ scope: 'user', scopeId: null }).total).toBe(1);
  });
});

describe('expiry', () => {
  it('excludes memories whose validity window has closed', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await memory.remember({
      scope: 'user',
      kind: 'fact',
      content: 'The user is on holiday until the end of the sprint.',
      sourceType: 'user_explicit',
      explicit: true,
      validUntil: past,
    });
    const results = await memory.retrieve({
      query: 'holiday sprint',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(results).toHaveLength(0);

    expect(memory.expireStale()).toBe(1);
    expect(memory.list({ scope: 'user', scopeId: null, status: 'expired' }).total).toBe(1);
  });

  it('honours valid_from for a memory that is not active yet', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await memory.remember({
      scope: 'user',
      kind: 'constraint',
      content: 'Starting next month the team freezes dependency upgrades.',
      sourceType: 'user_explicit',
      explicit: true,
      validFrom: future,
    });
    const now = await memory.retrieve({
      query: 'dependency upgrades freeze',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(now).toHaveLength(0);

    const later = await memory.retrieve({
      query: 'dependency upgrades freeze',
      scopes: [{ scope: 'user', scopeId: null }],
      at: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(later).toHaveLength(1);
  });
});

describe('retrieval relevance', () => {
  it('ranks a relevant memory above an unrelated one', async () => {
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'decision',
      content: 'Authentication uses OAuth device flow because the CLI has no browser.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'decision',
      content: 'The invoice PDF renderer uses Puppeteer with a fixed A4 viewport.',
      sourceType: 'user_explicit',
      explicit: true,
    });

    const results = await memory.retrieve({
      query: 'how does login authentication work',
      scopes: [{ scope: 'project', scopeId: PROJECT_A }],
    });
    expect(results[0]?.memory.content).toContain('OAuth');
  });

  it('excludes memories with no relevance signal instead of padding the result', async () => {
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'fact',
      content: 'The invoice PDF renderer uses Puppeteer with a fixed A4 viewport.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const results = await memory.retrieve({
      query: 'kubernetes ingress certificate rotation',
      scopes: [{ scope: 'project', scopeId: PROJECT_A }],
    });
    expect(results).toHaveLength(0);
  });

  it('works with no semantic provider at all (lexical only)', async () => {
    const lexicalOnly = new MemoryService({
      db,
      bus,
      config: loadConfig({ home, memory: { ...config.memory, embeddingsEnabled: false } }),
    });
    await lexicalOnly.remember({
      scope: 'user',
      kind: 'fact',
      content: 'The staging database snapshot is refreshed every Monday morning.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const results = await lexicalOnly.retrieve({
      query: 'staging database snapshot',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.signals.semantic).toBeUndefined();
    expect(results[0]?.signals.lexical).toBeGreaterThan(0);
  });

  it('returns diverse results rather than five phrasings of one fact', async () => {
    // Distinct enough to survive dedupe, similar enough to be near-duplicates at retrieval.
    // The first two share 8 of 10 significant tokens (Jaccard ~0.67): distinct
    // enough to survive write-time dedupe (>0.8), similar enough that retrieval
    // diversity (>0.6) must collapse them to one.
    const variants = [
      'nightly integration tests validate staging cluster deployment pipeline before release',
      'nightly integration tests validate staging cluster deployment pipeline during maintenance',
      'Deployment to production requires two approvals from the platform group.',
    ];
    for (const [i, content] of variants.entries()) {
      await memory.remember({
        scope: 'project',
        scopeId: PROJECT_A,
        kind: 'fact',
        subject: `fact.${i}`,
        content,
        sourceType: 'user_explicit',
        explicit: true,
      });
    }
    const results = await memory.retrieve({
      query: 'integration tests staging',
      scopes: [{ scope: 'project', scopeId: PROJECT_A }],
      limit: 5,
    });
    // The two near-identical staging facts must not both be returned.
    const stagingHits = results.filter((r) => r.memory.content.toLowerCase().includes('staging'));
    expect(stagingHits.length).toBe(1);
  });
});

describe('provenance', () => {
  it('retains source references and exposes retrieval evidence', async () => {
    const stored = await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'decision',
      content: 'Job persistence uses SQLite via node:sqlite so there are no native dependencies.',
      sourceType: 'job_consolidation',
      sourceRef: { jobId: 'job_123', runId: 'run_456', sessionId: 'ses_789' },
      explicit: true,
    });
    if (stored.status !== 'stored') throw new Error('setup failed');

    const fetched = memory.get(stored.memory.id);
    expect(fetched?.sourceType).toBe('job_consolidation');
    expect(fetched?.sourceRef.jobId).toBe('job_123');
    expect(fetched?.sourceRef.runId).toBe('run_456');

    const [result] = await memory.retrieve({
      query: 'job persistence sqlite',
      scopes: [{ scope: 'project', scopeId: PROJECT_A }],
    });
    expect(result?.reason).toBeTruthy();
    expect(result?.signals.scopePriority).toBeGreaterThan(0);
    // Access accounting proves retrieval is observable.
    expect(memory.get(stored.memory.id)?.accessCount).toBe(1);
  });
});

describe('secret handling', () => {
  const secrets = [
    'The API key is sk-ant-api03-QQQQwwwweeeerrrrttttyyyyuuuuiiiioooo',
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'db password = SuperSecret123!',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    'connect to postgres://admin:hunter2hunter2@db.internal:5432/app',
  ];

  for (const content of secrets) {
    it(`rejects credential-like content: ${content.slice(0, 28)}…`, async () => {
      const outcome = await memory.remember({
        scope: 'user',
        kind: 'fact',
        content,
        sourceType: 'user_explicit',
        explicit: true, // even an explicit request must not bypass this gate
      });
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.reason).toBe('secret_detected');
    });
  }

  it('allows ordinary prose that merely mentions authentication', async () => {
    const outcome = await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'project_knowledge',
      content:
        'The auth module validates tokens with the provider SDK; secrets live in the OS keychain.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(outcome.status).toBe('stored');
  });

  it.each([
    { subject: 'password = SuperSecret123!' },
    { sourceRef: { note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } },
    { metadata: { token: 'sk-ant-api03-QQQQwwwweeeerrrrttttyyyyuuuuiiiioooo' } },
  ])('rejects credentials anywhere in the persisted envelope: %o', async (extra) => {
    const outcome = await memory.remember({
      scope: 'user',
      kind: 'fact',
      content: 'This otherwise harmless memory must not be stored.',
      sourceType: 'user_explicit',
      explicit: true,
      ...extra,
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.reason).toBe('secret_detected');
  });
});

describe('core user memory bound', () => {
  it('trims the always-available block to the configured cap', async () => {
    const small = new MemoryService({
      db,
      bus,
      config: loadConfig({ home, memory: { ...config.memory, coreUserMemoryMax: 3 } }),
      embeddings: fakeEmbeddings(),
    });
    for (let i = 0; i < TOPICS.length; i++) {
      await small.remember({
        scope: 'user',
        kind: 'preference',
        subject: `preference.topic_${i}`,
        content: `${TOPICS[i]} is how the user prefers to work, and Jarvis should respect it.`,
        importance: 0.4 + i * 0.05,
        sourceType: 'user_explicit',
        explicit: true,
      });
    }
    expect(small.list({ scope: 'user', scopeId: null }).total).toBe(8);
    const trimmed = small.trimCoreUserMemory();
    expect(trimmed).toBe(5);
    expect(small.list({ scope: 'user', scopeId: null }).total).toBe(3);
  });
});

describe('context pack budgeting', () => {
  it('stays inside the configured budget when memories exceed it', async () => {
    // Enough distinct memories to blow any sane budget.
    // Content must be genuinely distinct: the token filter drops digits, so
    // "module 1"/"module 2" would be identical to dedupe and collapse to one row.
    for (const [i, [name, terms]] of MODULES.entries()) {
      await memory.remember({
        scope: 'project',
        scopeId: PROJECT_A,
        kind: 'project_knowledge',
        subject: `knowledge.module_${i}`,
        content: `The scheduler queue drives ${name}: ${terms}.`,
        sourceType: 'user_explicit',
        explicit: true,
      });
    }

    const budget = 400;
    const builder = new ContextPackBuilder(
      db,
      memory,
      loadConfig({ home, context: { ...config.context, budgetTokens: budget } }),
    );
    const pack = await builder.build({
      role: 'implementer',
      query: 'scheduler queue',
      projectId: PROJECT_A,
      projectSnapshot: 'Name: test\nLanguages: typescript',
    });

    expect(pack.usedTokens).toBeLessThanOrEqual(budget);
    expect(estimateTokens(pack.rendered)).toBeLessThanOrEqual(budget);
    expect(pack.selections.length).toBeGreaterThan(0);
    expect(pack.selections.length).toBeLessThan(MODULES.length);
    // The overflow must be reported, not silently swallowed.
    expect(pack.dropped.length).toBeGreaterThan(0);
  });

  it('records why each memory was selected, and persists the pack', async () => {
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_A,
      kind: 'constraint',
      subject: 'constraint.node_version',
      content: 'This project requires Node 22 or newer because it relies on node:sqlite.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const builder = new ContextPackBuilder(db, memory, config);
    const pack = await builder.build({
      role: 'implementer',
      query: 'node version requirement sqlite',
      projectId: PROJECT_A,
      jobId: 'job_abc',
    });

    expect(pack.selections.length).toBeGreaterThan(0);
    expect(pack.selections[0]?.reason).toBeTruthy();

    // Readable back for the "why did Jarvis use this?" UI.
    const stored = builder.getPack(pack.id);
    expect(stored?.selections.length).toBe(pack.selections.length);
    expect(stored?.jobId).toBe('job_abc');
  });

  it('injects each memory id at most once across context sections', async () => {
    await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.editor',
      content: 'The user prefers Neovim for editing code.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const pack = await new ContextPackBuilder(db, memory, config).build({
      role: 'implementer',
      query: 'preferred code editor Neovim',
    });
    const ids = pack.selections.map((selection) => selection.memoryId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(pack.rendered.match(/Neovim/g)).toHaveLength(1);
  });

  it('never includes an unrelated project in the pack', async () => {
    await memory.remember({
      scope: 'project',
      scopeId: PROJECT_B,
      kind: 'decision',
      content: 'Project B pins the scheduler queue to a single worker.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const builder = new ContextPackBuilder(db, memory, config);
    const pack = await builder.build({
      role: 'implementer',
      query: 'scheduler queue worker',
      projectId: PROJECT_A,
    });
    expect(pack.selections.some((s) => s.scope === 'project')).toBe(false);
    expect(pack.rendered).not.toContain('Project B pins');
  });
});

describe('embedding lifecycle', () => {
  it('embeds a new memory exactly once and never re-embeds unchanged text', async () => {
    let calls = 0;
    const inner = fakeEmbeddings();
    const counting: EmbeddingProvider = {
      ...inner,
      embedPassages: async (texts) => {
        calls += texts.length;
        return inner.embedPassages(texts);
      },
    };
    const service = new MemoryService({ db, bus, config, embeddings: counting });
    const stored = await service.remember({
      scope: 'user',
      kind: 'fact',
      content: 'The build pipeline caches the pnpm store between runs.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    if (stored.status !== 'stored') throw new Error('setup failed');

    // Exactly one embedding for a write: the dedupe probe's vector is reused for
    // the index, rather than embedding the same string a second time.
    expect(calls).toBe(1);

    await service.indexEmbedding(stored.memory);
    await service.indexEmbedding(stored.memory);
    expect(calls).toBe(1);

    // Changing the text does require a fresh vector.
    const changed = {
      ...stored.memory,
      content: 'Something entirely different about browser caching.',
    };
    await service.indexEmbedding(changed);
    expect(calls).toBe(2);
  });

  it('falls back to lexical retrieval when the embedding provider throws', async () => {
    const broken: EmbeddingProvider = {
      id: 'broken',
      dim: 8,
      available: async () => false,
      embedPassages: async () => {
        throw new Error('onnx runtime unavailable');
      },
      embedQuery: async () => {
        throw new Error('onnx runtime unavailable');
      },
      status: () => ({
        enabled: true,
        ready: false,
        model: 'broken',
        dim: 8,
        error: 'onnx runtime unavailable',
      }),
    };
    const service = new MemoryService({ db, bus, config, embeddings: broken });

    const stored = await service.remember({
      scope: 'user',
      kind: 'fact',
      content: 'Playwright chromium binaries are cached under the local app data directory.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(stored.status).toBe('stored');

    const results = await service.retrieve({
      query: 'playwright chromium cache',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    expect(results.length).toBe(1);
    expect(results[0]?.signals.semantic).toBeUndefined();
    expect(service.embeddingStatus().disabledForProcess).toBe(true);
  });

  it('rebuilds a corrupted embedding rather than poisoning ranking', async () => {
    const stored = await memory.remember({
      scope: 'user',
      kind: 'fact',
      content: 'The orchestrator persists events before emitting them to subscribers.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    if (stored.status !== 'stored') throw new Error('setup failed');
    await memory.indexEmbedding(stored.memory);

    // Corrupt the stored vector: wrong byte length for a Float32Array.
    db.prepare('UPDATE memory_embeddings SET vector = ? WHERE memory_id = ?').run(
      new Uint8Array([1, 2, 3]),
      stored.memory.id,
    );

    const results = await memory.retrieve({
      query: 'orchestrator persists events',
      scopes: [{ scope: 'user', scopeId: null }],
    });
    // Retrieval still works; the bad row was dropped instead of throwing.
    expect(results.length).toBe(1);
  });
});

describe('events', () => {
  it('emits stored and superseded events with useful payloads', async () => {
    const seen: string[] = [];
    bus.on((event) => seen.push(event.type));

    const first = await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.theme',
      content: 'The user prefers a dark theme in every application.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    await memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.theme',
      content: 'The user switched to a light theme during daytime work.',
      sourceType: 'user_explicit',
      explicit: true,
    });

    expect(first.status).toBe('stored');
    expect(seen).toContain('memory.stored');
    expect(seen).toContain('memory.superseded');
  });
});

describe('semantic calibration', () => {
  it('adapts to a compressed cosine range (e5-style, everything near 0.8)', () => {
    // Real measured behaviour: unrelated pairs still score ~0.75 with e5.
    const raw = [
      { id: 'related', sim: 0.82 },
      { id: 'somewhat', sim: 0.79 },
      { id: 'unrelated1', sim: 0.75 },
      { id: 'unrelated2', sim: 0.748 },
      { id: 'unrelated3', sim: 0.751 },
    ];
    const scores = calibrateSemantic(raw, { absoluteFloor: 0.2, margin: 0.06 });
    // A fixed 0.2 floor would have admitted all five.
    expect(scores.has('related')).toBe(true);
    expect(scores.has('unrelated1')).toBe(false);
    expect(scores.has('unrelated3')).toBe(false);
    expect(scores.get('related')).toBeCloseTo(1, 5);
  });

  it('adapts to a wide cosine range (MiniLM-style)', () => {
    const raw = [
      { id: 'related', sim: 0.71 },
      { id: 'unrelated1', sim: 0.09 },
      { id: 'unrelated2', sim: 0.12 },
      { id: 'unrelated3', sim: 0.05 },
    ];
    const scores = calibrateSemantic(raw, { absoluteFloor: 0.2, margin: 0.06 });
    expect([...scores.keys()]).toEqual(['related']);
  });

  it('rejects everything when nothing beats the null baseline', () => {
    // Measured e5 behaviour: an unrelated query still scores ~0.75 against every
    // memory. Only the null baseline can tell that apart from a real match.
    const raw = [
      { id: 'a', sim: 0.752 },
      { id: 'b', sim: 0.739 },
      { id: 'c', sim: 0.732 },
      { id: 'd', sim: 0.727 },
    ];
    const withBaseline = calibrateSemantic(raw, {
      absoluteFloor: 0.2,
      margin: 0.06,
      nullBaseline: { mean: 0.696, stdev: 0.019 },
    });
    expect(withBaseline.size).toBe(0);
  });

  it('accepts a genuine match that clears the null baseline', () => {
    const raw = [
      { id: 'auth', sim: 0.841 },
      { id: 'retry', sim: 0.787 },
      { id: 'deploy', sim: 0.762 },
      { id: 'pdf', sim: 0.754 },
    ];
    const scores = calibrateSemantic(raw, {
      absoluteFloor: 0.2,
      margin: 0.06,
      nullBaseline: { mean: 0.719, stdev: 0.011 },
    });
    expect(scores.has('auth')).toBe(true);
    expect(scores.get('auth')).toBeCloseTo(1, 5);
    expect(scores.has('pdf')).toBe(false);
  });

  it('falls back to the absolute floor with too few candidates for statistics', () => {
    expect(
      calibrateSemantic([{ id: 'a', sim: 0.9 }], { absoluteFloor: 0.2, margin: 0.06 }).has('a'),
    ).toBe(true);
    expect(
      calibrateSemantic([{ id: 'a', sim: 0.05 }], { absoluteFloor: 0.2, margin: 0.06 }).has('a'),
    ).toBe(false);
  });

  it('never emits a score outside 0..1', () => {
    const scores = calibrateSemantic(
      [
        { id: 'a', sim: 0.99 },
        { id: 'b', sim: 0.5 },
        { id: 'c', sim: 0.1 },
        { id: 'd', sim: 0.05 },
      ],
      { absoluteFloor: 0.2, margin: 0.06 },
    );
    for (const value of scores.values()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('lexical query construction', () => {
  it('strips stopwords that would otherwise match every memory', () => {
    const q = toFtsQuery('what is the capital of Peru');
    expect(q).toBe('"capital" OR "peru"');
  });

  it('strips French stopwords too', () => {
    const q = toFtsQuery('comment fonctionne la connexion des utilisateurs');
    expect(q).toContain('connexion');
    expect(q).toContain('utilisateurs');
    expect(q).not.toContain('comment');
    expect(q).not.toContain('"des"');
  });

  it('deduplicates repeated terms', () => {
    expect(toFtsQuery('cache cache cache')).toBe('"cache"');
  });

  it('returns null when nothing meaningful is left', () => {
    expect(toFtsQuery('what is the')).toBeNull();
    expect(toFtsQuery('')).toBeNull();
  });
});
