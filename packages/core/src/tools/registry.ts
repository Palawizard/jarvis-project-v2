import { z } from 'zod';

/**
 * Risk level gates what a tool may do without explicit approval. The autonomy
 * policy maps levels to permission, so adding a tool never means inventing new
 * permission logic.
 */
export type RiskLevel =
  'observe' | 'safe_action' | 'reversible_modification' | 'sensitive' | 'destructive';

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  risk: RiskLevel;
  input: z.ZodType<TInput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export interface ToolContext {
  sessionId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  /** Highest risk level the caller is allowed to invoke. */
  maxRisk: RiskLevel;
}

const RISK_ORDER: RiskLevel[] = [
  'observe',
  'safe_action',
  'reversible_modification',
  'sensitive',
  'destructive',
];

export function riskExceeds(risk: RiskLevel, max: RiskLevel): boolean {
  return RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(max);
}

export class ToolPermissionError extends Error {
  constructor(toolName: string, risk: RiskLevel, maxRisk: RiskLevel) {
    super(`tool "${toolName}" requires risk level ${risk}, caller is limited to ${maxRisk}`);
    this.name = 'ToolPermissionError';
  }
}

/**
 * Generic tool registry.
 *
 * Deliberately small: schema, risk metadata, and one execution boundary that
 * validates input and enforces the risk ceiling. Future tools (screen capture,
 * gmail, calendar, desktop control) register here without changing this file.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never, unknown>>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition<never, unknown>);
  }

  list(): Array<{ name: string; description: string; risk: RiskLevel; schema: unknown }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: z.toJSONSchema(tool.input as z.ZodType),
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if (riskExceeds(tool.risk, ctx.maxRisk))
      throw new ToolPermissionError(name, tool.risk, ctx.maxRisk);
    const parsed = (tool.input as z.ZodType).safeParse(rawInput);
    if (!parsed.success) {
      throw new Error(
        `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    return tool.execute(parsed.data as never, ctx);
  }
}
