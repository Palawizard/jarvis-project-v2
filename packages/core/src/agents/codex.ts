import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig, type JarvisConfig } from '../config.js';
import { extractMemoryProposals } from './proposals.js';
import { resolveCli, type ResolvedCli } from './resolve.js';
import { runJsonlProcess } from './spawn.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentStartOptions,
  ProviderCapabilities,
} from './types.js';

const exec = promisify(execFile);

/**
 * Codex CLI adapter.
 *
 * Uses `codex exec --json`, an official machine-readable JSONL event stream
 * (thread.started / turn.started / item.completed / turn.completed|failed), so
 * there is no interactive terminal scraping here.
 *
 * `codex app-server` was evaluated and deliberately not used: in the installed
 * version (0.147.0) it is marked experimental and would require implementing a
 * full JSON-RPC session protocol for no capability Jarvis needs today. Because
 * everything provider-specific is confined to this file, switching later is a
 * local change.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  private cached: ProviderCapabilities | undefined;
  private cli: ResolvedCli | null | undefined;

  constructor(private readonly config: JarvisConfig = getConfig()) {}

  private resolve(): ResolvedCli | null {
    if (this.cli === undefined) {
      this.cli = resolveCli({ binName: 'codex', packageName: '@openai/codex', envOverride: 'JARVIS_CODEX_BIN' });
    }
    return this.cli;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    if (this.cached) return this.cached;
    const base: ProviderCapabilities = {
      id: 'codex',
      available: false,
      authenticated: false,
      streaming: true,
      resumable: true,
      structuredOutput: true,
      models: [],
    };

    const cli = this.resolve();
    if (!cli) {
      this.cached = { ...base, reason: 'Codex CLI not found. Install it with `npm i -g @openai/codex`.' };
      return this.cached;
    }
    try {
      const { stdout } = await exec(cli.command, [...cli.prefixArgs, '--version'], { timeout: 30_000 });
      base.version = stdout.trim();
    } catch (error) {
      this.cached = { ...base, reason: `Codex CLI could not be executed: ${(error as Error).message}` };
      return this.cached;
    }
    try {
      const { stdout, stderr } = await exec(cli.command, [...cli.prefixArgs, 'login', 'status'], { timeout: 45_000 });
      // 0.147 prints a human-readable line and sends it to stderr, not stdout.
      // There is no JSON form, so both streams are inspected.
      const text = `${stdout}\n${stderr}`.trim();
      base.authenticated = /logged in/i.test(text);
      const method = (/logged in using\s*(.+)/i.exec(text)?.[1] ?? '').trim();
      if (method) base.authMethod = method;
      base.available = base.authenticated;
      if (!base.authenticated) base.reason = 'Codex CLI is installed but not logged in. Run `codex login`.';
    } catch (error) {
      base.reason = `could not read Codex login status: ${(error as Error).message}`;
    }
    this.cached = base;
    return base;
  }

  async run(options: AgentStartOptions, onEvent: (event: AgentEvent) => void): Promise<AgentRunResult> {
    const caps = await this.capabilities();
    const cli = this.resolve();
    if (!caps.available || !cli) {
      // Explicit, honest failure — never a silent fallback that pretends Codex ran.
      const error = caps.reason ?? 'Codex is unavailable';
      onEvent({ kind: 'failed', error });
      return { status: 'failed', result: '', error, memoryProposals: [] };
    }

    const model = options.model ?? this.config.agents.codexModel;
    const args = ['exec'];
    if (options.resumeSessionId) args.push('resume', options.resumeSessionId);
    args.push('--json', '--skip-git-repo-check');
    if (model) args.push('--model', model);
    // Reviewers only read; implementers need to write inside their worktree.
    const writes = options.role === 'implementer' || options.role === 'fixer';
    args.push('--sandbox', writes ? 'workspace-write' : 'read-only');
    args.push('-C', options.cwd);
    // '-' makes codex read the prompt from stdin instead of argv.
    args.push('-');

    let threadId: string | undefined;
    let lastMessage = '';
    let usage: Record<string, unknown> | undefined;
    let reportedError: string | undefined;

    const outcome = await runJsonlProcess({
      cli,
      args,
      cwd: options.cwd,
      stdin: options.prompt,
      timeoutMs: options.timeoutMs ?? this.config.agents.runTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      scope: 'codex',
      onLine: (event) => {
        switch (event.type) {
          case 'thread.started': {
            threadId = event.thread_id as string;
            onEvent({
              kind: 'started',
              ...(threadId ? { sessionId: threadId } : {}),
              ...(model ? { model } : {}),
            });
            break;
          }
          case 'item.completed': {
            const item = event.item as Record<string, unknown> | undefined;
            if (!item) break;
            switch (item.type) {
              case 'agent_message':
                if (typeof item.text === 'string') {
                  lastMessage = item.text;
                  onEvent({ kind: 'text', text: item.text });
                }
                break;
              case 'reasoning':
                if (typeof item.text === 'string') onEvent({ kind: 'thinking', text: item.text });
                break;
              case 'command_execution':
                onEvent({
                  kind: 'tool_completed',
                  tool: 'shell',
                  isError: Number(item.exit_code ?? 0) !== 0,
                  preview: String(item.command ?? '').slice(0, 400),
                });
                break;
              case 'file_change':
                onEvent({ kind: 'tool_completed', tool: 'edit', preview: JSON.stringify(item.changes ?? {}).slice(0, 400) });
                break;
              case 'error':
                reportedError = String(item.message ?? 'codex reported an error');
                break;
              default:
                break;
            }
            break;
          }
          case 'turn.completed':
            if (event.usage) usage = event.usage as Record<string, unknown>;
            break;
          case 'turn.failed': {
            const err = event.error as { message?: string } | undefined;
            reportedError = err?.message ?? 'codex turn failed';
            break;
          }
          default:
            break;
        }
      },
    });

    const { proposals, cleanedText } = extractMemoryProposals(lastMessage);

    if (outcome.cancelled) {
      return { status: 'cancelled', result: cleanedText, error: 'cancelled by user', memoryProposals: proposals, ...(threadId ? { sessionId: threadId } : {}) };
    }
    if (outcome.timedOut) {
      const error = `agent exceeded ${options.timeoutMs ?? this.config.agents.runTimeoutMs}ms`;
      onEvent({ kind: 'failed', error });
      return { status: 'timeout', result: cleanedText, error, memoryProposals: proposals, ...(threadId ? { sessionId: threadId } : {}) };
    }
    if (outcome.startError) {
      const error = `could not start Codex: ${outcome.startError}`;
      onEvent({ kind: 'failed', error });
      return { status: 'failed', result: '', error, memoryProposals: [] };
    }
    if (reportedError || outcome.code !== 0) {
      const error = reportedError ?? `codex exited with code ${outcome.code}${outcome.stderr ? `: ${outcome.stderr}` : ''}`;
      onEvent({ kind: 'failed', error, ...(threadId ? { sessionId: threadId } : {}) });
      return {
        status: 'failed',
        result: cleanedText,
        error,
        memoryProposals: proposals,
        ...(threadId ? { sessionId: threadId } : {}),
      };
    }

    onEvent({ kind: 'completed', result: cleanedText, ...(threadId ? { sessionId: threadId } : {}), ...(usage ? { usage } : {}) });
    return {
      status: 'completed',
      result: cleanedText,
      memoryProposals: proposals,
      ...(threadId ? { sessionId: threadId } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
