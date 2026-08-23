import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getConfig, type JarvisConfig } from '../config.js';
import { extractMemoryProposals } from './proposals.js';
import { resolveCli, type ResolvedCli } from './resolve.js';
import { jsonlProtocolError, runJsonlProcess } from './spawn.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentStartOptions,
  ProviderCapabilities,
} from './types.js';

const exec = promisify(execFile);

/**
 * Claude Code adapter.
 *
 * Uses the officially supported non-interactive path:
 *   claude -p --output-format stream-json --verbose
 * which emits one JSON object per line. No terminal scraping.
 *
 * Authentication stays entirely inside the Claude Code CLI (Claude Pro
 * subscription). Jarvis never reads, copies or stores any credential.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  private cached: ProviderCapabilities | undefined;
  private cachedAt = 0;
  private cli: ResolvedCli | null | undefined;

  constructor(private readonly config: JarvisConfig = getConfig()) {}

  private resolve(): ResolvedCli | null {
    if (this.cli === undefined) {
      this.cli = resolveCli({
        binName: 'claude',
        packageName: '@anthropic-ai/claude-code',
        envOverride: 'JARVIS_CLAUDE_BIN',
      });
    }
    return this.cli;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    if (this.cached && Date.now() - this.cachedAt < 30_000) return this.cached;
    const base: ProviderCapabilities = {
      id: 'claude',
      available: false,
      authenticated: false,
      streaming: true,
      resumable: true,
      structuredOutput: true,
      models: ['opus', 'sonnet', 'haiku'],
    };

    const cli = this.resolve();
    if (!cli) {
      return this.cache({
        ...base,
        reason: 'Claude Code CLI not found. Install it with `npm i -g @anthropic-ai/claude-code`.',
      });
    }

    try {
      const { stdout } = await exec(cli.command, [...cli.prefixArgs, '--version'], {
        timeout: 30_000,
      });
      base.version = stdout.trim();
    } catch (error) {
      return this.cache({
        ...base,
        reason: `Claude Code CLI could not be executed: ${(error as Error).message}`,
      });
    }

    try {
      const { stdout } = await exec(cli.command, [...cli.prefixArgs, 'auth', 'status'], {
        timeout: 45_000,
      });
      const status = JSON.parse(stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        subscriptionType?: string;
      };
      base.authenticated = Boolean(status.loggedIn);
      if (status.authMethod) {
        base.authMethod = `${status.authMethod}${status.subscriptionType ? ` (${status.subscriptionType})` : ''}`;
      }
      base.available = base.authenticated;
      if (!base.authenticated)
        base.reason = 'Claude Code is installed but not logged in. Run `claude auth login`.';
    } catch (error) {
      base.reason = `could not read Claude auth status: ${(error as Error).message}`;
    }
    return this.cache(base);
  }

  private cache(capabilities: ProviderCapabilities): ProviderCapabilities {
    this.cached = capabilities;
    this.cachedAt = Date.now();
    return capabilities;
  }

  async run(
    options: AgentStartOptions,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const cli = this.resolve();
    if (!cli) {
      const error = 'Claude Code CLI not found on this machine.';
      onEvent({ kind: 'failed', error });
      return { status: 'failed', result: '', error, memoryProposals: [] };
    }

    const model = options.model ?? this.config.agents.claudeModel;
    let args: string[];
    try {
      args = buildClaudeArgs(options, model, this.config.agents.claudePermissionMode);
    } catch (error) {
      const message = `invalid Claude input: ${error instanceof Error ? error.message : String(error)}`;
      onEvent({ kind: 'failed', error: message });
      return { status: 'failed', result: '', error: message, memoryProposals: [] };
    }

    let sessionId: string | undefined;
    let finalResult = '';
    let usage: Record<string, unknown> | undefined;
    let structuredOutput: unknown;
    let reportedError: string | undefined;
    let sawTerminalResult = false;
    const textChunks: string[] = [];

    const outcome = await runJsonlProcess({
      cli,
      args,
      cwd: options.cwd,
      stdin: buildClaudePrompt(options),
      timeoutMs: options.timeoutMs ?? this.config.agents.runTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      scope: 'claude',
      onLine: (event) => {
        if (event.type === 'result') sawTerminalResult = true;
        const id = event.session_id as string | undefined;
        if (id) sessionId = id;
        handleClaudeEvent(event, {
          onEvent,
          pushText: (t) => textChunks.push(t),
          setResult: (r) => {
            finalResult = r;
          },
          setUsage: (u) => {
            usage = u;
          },
          setStructuredOutput: (value) => {
            structuredOutput = value;
          },
          setFailure: (f) => {
            reportedError = f;
          },
          model,
        });
      },
    });

    const raw = finalResult || textChunks.join('');
    const { proposals, cleanedText } = extractMemoryProposals(raw);

    if (outcome.cancelled) {
      return {
        status: 'cancelled',
        result: cleanedText,
        error: 'cancelled by user',
        memoryProposals: proposals,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (outcome.timedOut) {
      const error = `agent exceeded ${options.timeoutMs ?? this.config.agents.runTimeoutMs}ms`;
      onEvent({ kind: 'failed', error });
      return {
        status: 'timeout',
        result: cleanedText,
        error,
        memoryProposals: proposals,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (outcome.startError) {
      const error = `could not start Claude Code: ${outcome.startError}`;
      onEvent({ kind: 'failed', error });
      return { status: 'failed', result: '', error, memoryProposals: [] };
    }
    const protocolError = jsonlProtocolError('Claude Code', outcome, sawTerminalResult);
    if (protocolError) {
      onEvent({ kind: 'failed', error: protocolError, ...(sessionId ? { sessionId } : {}) });
      return {
        status: 'failed',
        result: cleanedText,
        error: protocolError,
        memoryProposals: proposals,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (reportedError || outcome.code !== 0) {
      const error =
        reportedError ??
        `claude exited with code ${outcome.code}${outcome.stderr ? `: ${outcome.stderr}` : ''}`;
      onEvent({ kind: 'failed', error, ...(sessionId ? { sessionId } : {}) });
      return {
        status: 'failed',
        result: cleanedText,
        error,
        memoryProposals: proposals,
        ...(sessionId ? { sessionId } : {}),
        ...(usage ? { usage } : {}),
      };
    }

    onEvent({
      kind: 'completed',
      result: cleanedText,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
    });
    return {
      status: 'completed',
      result: cleanedText,
      memoryProposals: proposals,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    };
  }
}

export function buildClaudePrompt(options: AgentStartOptions): string {
  if (!options.imagePaths?.length) return options.prompt;
  return `${options.prompt}\n\nInspect these local image files as image evidence:\n${options.imagePaths.map((file) => `- ${path.resolve(options.cwd, file)}`).join('\n')}`;
}

export function buildClaudeArgs(
  options: AgentStartOptions,
  model: string,
  configuredPermissionMode: JarvisConfig['agents']['claudePermissionMode'],
): string[] {
  const readOnly = options.role === 'reviewer' || options.role === 'visual_reviewer';
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // stream-json in print mode requires --verbose; the CLI errors out without it.
    '--verbose',
    '--model',
    model,
    '--permission-mode',
    readOnly ? 'plan' : configuredPermissionMode,
    '--no-chrome',
  ];
  if (options.safeMode) args.push('--safe-mode');
  if (options.ephemeral) args.push('--no-session-persistence');
  if (options.role === 'visual_reviewer') args.push('--tools', 'Read');
  for (const dir of new Set(
    options.imagePaths?.map((file) => path.dirname(path.resolve(options.cwd, file))) ?? [],
  )) {
    args.push('--add-dir', dir);
  }
  if (options.outputSchemaPath) {
    args.push(
      '--json-schema',
      fs.readFileSync(path.resolve(options.cwd, options.outputSchemaPath), 'utf8'),
    );
  }
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  return args;
}

interface Handlers {
  onEvent: (event: AgentEvent) => void;
  pushText: (text: string) => void;
  setResult: (result: string) => void;
  setUsage: (usage: Record<string, unknown>) => void;
  setStructuredOutput: (value: unknown) => void;
  setFailure: (error: string) => void;
  model: string;
}

/** Translate one Claude Code stream-json object into normalized Jarvis events. */
export function handleClaudeEvent(event: Record<string, unknown>, h: Handlers): void {
  const sessionId = event.session_id as string | undefined;

  switch (event.type as string) {
    case 'system': {
      // Hook lifecycle noise belongs to Claude Code's own config, not to the job.
      if (event.subtype === 'init') {
        h.onEvent({
          kind: 'started',
          ...(sessionId ? { sessionId } : {}),
          model: (event.model as string) ?? h.model,
        });
      }
      return;
    }
    case 'assistant': {
      const message = event.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          h.pushText(b.text);
          h.onEvent({ kind: 'text', text: b.text });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          h.onEvent({ kind: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          h.onEvent({
            kind: 'tool_started',
            tool: String(b.name ?? 'tool'),
            ...(typeof b.id === 'string' ? { id: b.id } : {}),
            input: b.input,
          });
        }
      }
      return;
    }
    case 'user': {
      // Tool results arrive as a synthetic user message.
      const message = event.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        h.onEvent({
          kind: 'tool_completed',
          ...(typeof b.tool_use_id === 'string' ? { id: b.tool_use_id } : {}),
          isError: b.is_error === true,
          preview: previewToolResult(b.content),
        });
      }
      return;
    }
    case 'result': {
      if (typeof event.result === 'string') h.setResult(event.result);
      if (event.structured_output !== undefined) {
        h.setStructuredOutput(event.structured_output);
        h.setResult(JSON.stringify(event.structured_output));
      }
      if (event.usage) h.setUsage(event.usage as Record<string, unknown>);
      if (event.is_error === true) {
        h.setFailure(
          typeof event.result === 'string' && event.result
            ? event.result
            : `agent reported error (${String(event.subtype ?? 'unknown')})`,
        );
      }
      return;
    }
    case 'rate_limit_event': {
      const info = event.rate_limit_info as { status?: string } | undefined;
      if (info?.status && info.status !== 'allowed') {
        h.onEvent({ kind: 'waiting', note: `rate limit: ${info.status}` });
      }
      return;
    }
    default:
      return;
  }
}

function previewToolResult(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              typeof c === 'object' && c && 'text' in c
                ? String((c as { text: unknown }).text)
                : '',
            )
            .join('')
        : '';
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}
