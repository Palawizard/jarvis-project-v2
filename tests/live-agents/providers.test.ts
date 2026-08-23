import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ClaudeProvider } from '../../packages/core/src/agents/claude.js';
import { CodexProvider } from '../../packages/core/src/agents/codex.js';
import type {
  AgentEvent,
  AgentProvider,
  ProviderCapabilities,
} from '../../packages/core/src/agents/types.js';

const exec = promisify(execFile);
const enabled = process.env.JARVIS_LIVE_AGENT_TESTS === '1';
const reportPath = path.resolve(
  process.env.JARVIS_LIVE_AGENT_REPORT ?? '.jarvis/live-agent-smoke.json',
);

interface LiveResult {
  provider: 'claude' | 'codex';
  version?: string;
  available: boolean;
  authenticated: boolean;
  authMethod?: string;
  outcome: 'passed' | 'unavailable' | 'unauthenticated' | 'rate_limited' | 'unsupported' | 'failed';
  processLaunched?: boolean;
  sessionCaptured?: boolean;
  structuredEvents?: number;
  fileModified?: boolean;
  verificationPassed?: boolean;
  error?: string;
}

const reports: LiveResult[] = [];
const claude = new ClaudeProvider();
const codex = new CodexProvider();
const claudeCaps = enabled ? await claude.capabilities() : null;
const codexCaps = enabled ? await codex.capabilities() : null;

afterAll(() => {
  if (!enabled) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ createdAt: new Date().toISOString(), results: reports }, null, 2)}\n`,
  );
  process.stdout.write(`Live-agent report: ${reportPath}\n`);
});

describe.skipIf(!enabled)('subscription-backed provider smoke tests', () => {
  it.skipIf(!claudeCaps?.available)('Claude edits and verifies a tiny repository', async () => {
    await smoke(claude, claudeCaps as ProviderCapabilities, 'haiku');
  });

  it.skipIf(!codexCaps?.available)('Codex edits and verifies a tiny repository', async () => {
    await smoke(codex, codexCaps as ProviderCapabilities);
  });
});

if (enabled) {
  for (const caps of [claudeCaps, codexCaps]) {
    if (caps?.available) continue;
    reports.push({
      provider: caps?.id ?? (caps === claudeCaps ? 'claude' : 'codex'),
      version: caps?.version,
      available: false,
      authenticated: caps?.authenticated ?? false,
      authMethod: caps?.authMethod,
      outcome: classifyFailure(caps?.reason ?? 'provider unavailable'),
      error: caps?.reason ?? 'provider capability check failed',
    });
  }
}

async function smoke(
  provider: AgentProvider,
  capabilities: ProviderCapabilities,
  model?: string,
): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-live-${provider.id}-`));
  const events: AgentEvent[] = [];
  const report: LiveResult = {
    provider: provider.id,
    version: capabilities.version,
    available: capabilities.available,
    authenticated: capabilities.authenticated,
    authMethod: capabilities.authMethod,
    outcome: 'failed',
  };
  reports.push(report);

  try {
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(
      path.join(cwd, 'src', 'math.ts'),
      'export function add(_a: number, _b: number): number { return 0; }\n',
    );
    fs.writeFileSync(
      path.join(cwd, 'src', 'math.test.ts'),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './math.ts';\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
    );
    await exec('git', ['init', '--quiet'], { cwd });
    await exec('git', ['config', 'user.email', 'jarvis-live@example.invalid'], { cwd });
    await exec('git', ['config', 'user.name', 'Jarvis Live Smoke'], { cwd });
    await exec('git', ['add', '.'], { cwd });
    await exec('git', ['commit', '--quiet', '-m', 'fixture'], { cwd });

    const result = await provider.run(
      {
        cwd,
        role: 'implementer',
        prompt:
          'Modify only src/math.ts so add(a, b) returns the sum. Do not add files, commit, or explain at length.',
        safeMode: true,
        ephemeral: true,
        timeoutMs: 120_000,
        ...(model ? { model } : {}),
      },
      (event) => events.push(event),
    );
    report.processLaunched = events.some((event) => event.kind === 'started');
    report.sessionCaptured = Boolean(result.sessionId);
    report.structuredEvents = events.length;
    const { stdout: diff } = await exec('git', ['diff', '--', 'src/math.ts'], { cwd });
    report.fileModified = diff.trim().length > 0;

    if (result.status !== 'completed') throw new Error(result.error ?? result.status);
    await exec(process.execPath, ['--experimental-strip-types', '--test', 'src/math.test.ts'], {
      cwd,
      timeout: 30_000,
    });
    report.verificationPassed = true;
    expect(report.processLaunched).toBe(true);
    expect(report.sessionCaptured).toBe(true);
    expect(report.structuredEvents).toBeGreaterThan(1);
    expect(report.fileModified).toBe(true);
    report.outcome = 'passed';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.outcome = classifyFailure(report.error);
    throw error;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function classifyFailure(error: string): LiveResult['outcome'] {
  if (/rate.?limit|usage limit|spend limit|session limit|too many requests/i.test(error)) {
    return 'rate_limited';
  }
  if (/not logged in|unauthenticated|authentication|\b401\b|\b403\b/i.test(error)) {
    return 'unauthenticated';
  }
  if (/unsupported|not supported|unknown (?:option|flag)/i.test(error)) return 'unsupported';
  if (/not found|could not be executed|unavailable/i.test(error)) return 'unavailable';
  return 'failed';
}
