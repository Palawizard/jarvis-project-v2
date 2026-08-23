import type { Db } from '../db/index.js';
import { getConfig, type JarvisConfig } from '../config.js';
import { newId, nowIso } from '../ids.js';
import type { MemoryService } from '../memory/service.js';
import type { RetrievedMemory, ScopeSelector } from '../memory/types.js';

/**
 * Rough token estimate. Deliberately not a real tokenizer: the budget only needs
 * to be conservative and stable, and pulling in a tokenizer for a 15% accuracy
 * gain is not worth the dependency or the startup cost.
 * ~3.6 chars/token is a safe over-estimate for mixed English/French prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export interface ContextPackRequest {
  role: 'implementer' | 'reviewer' | 'fixer' | 'chat' | 'visual_reviewer';
  /** The text retrieval is matched against — normally the job goal or user message. */
  query: string;
  projectId?: string | null;
  sessionId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  /** Compact structured project snapshot rendered verbatim if it fits. */
  projectSnapshot?: string | null;
  /** Layer 1 working memory, already compacted. */
  sessionState?: string | null;
  budgetTokens?: number;
}

export interface ContextSelection {
  memoryId: string;
  scope: string;
  kind: string;
  score: number;
  reason: string;
  tokens: number;
  section: string;
}

export interface ContextPack {
  id: string;
  role: string;
  rendered: string;
  usedTokens: number;
  budgetTokens: number;
  selections: ContextSelection[];
  /** Sections that were truncated or dropped because the budget ran out. */
  dropped: { section: string; reason: string; count: number }[];
}

/**
 * Builds the ONLY memory context an agent ever receives.
 *
 * Providers must not do their own retrieval — that is what keeps injected
 * context bounded, auditable and identical across Claude, Codex and any future
 * provider.
 */
export class ContextPackBuilder {
  constructor(
    private readonly db: Db,
    private readonly memory: MemoryService,
    private readonly config: JarvisConfig = getConfig(),
  ) {}

  async build(request: ContextPackRequest): Promise<ContextPack> {
    const budget = request.budgetTokens ?? this.config.context.budgetTokens;
    const share = this.config.context.sectionShare;
    const selections: ContextSelection[] = [];
    const selectedMemoryIds = new Set<string>();
    const dropped: ContextPack['dropped'] = [];
    const parts: string[] = [];
    let used = 0;

    const fits = (text: string, cap: number) => {
      const cost = estimateTokens(text);
      return cost <= cap && used + cost <= budget;
    };
    const push = (text: string, cap: number): boolean => {
      if (!fits(text, cap)) return false;
      parts.push(text);
      used += estimateTokens(text);
      return true;
    };

    // ---- Section: core user memory (Layer 2) --------------------------------
    // Always-available, deliberately tiny. Pinned + highest-importance only.
    const coreCap = Math.floor(budget * share.coreUser);
    const core = this.memory.list({
      scope: 'user',
      scopeId: null,
      status: 'active',
      limit: 60,
    }).items;
    if (core.length > 0) {
      const lines: string[] = [];
      let coreUsed = 0;
      let coreDropped = 0;
      for (const memory of [...core].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance,
      )) {
        const line = `- ${memory.subject ? `[${memory.subject}] ` : ''}${memory.content}`;
        const cost = estimateTokens(line);
        if (coreUsed + cost > coreCap) {
          coreDropped++;
          continue;
        }
        lines.push(line);
        coreUsed += cost;
        selections.push({
          memoryId: memory.id,
          scope: memory.scope,
          kind: memory.kind,
          score: memory.importance,
          reason: memory.pinned ? 'pinned core user memory' : 'core user memory by importance',
          tokens: cost,
          section: 'core_user',
        });
        selectedMemoryIds.add(memory.id);
      }
      if (lines.length) push(`## What Jarvis knows about you\n${lines.join('\n')}`, coreCap + 20);
      if (coreDropped)
        dropped.push({ section: 'core_user', reason: 'section budget', count: coreDropped });
    }

    // ---- Section: project snapshot (Layer 3 rollup) --------------------------
    if (request.projectSnapshot) {
      const cap = Math.floor(budget * share.projectSnapshot);
      const text = `## Project snapshot\n${request.projectSnapshot.trim()}`;
      if (!push(text, cap)) {
        const truncated = `## Project snapshot\n${truncateToTokens(request.projectSnapshot.trim(), cap - 10)}`;
        if (!push(truncated, cap)) {
          dropped.push({ section: 'project_snapshot', reason: 'budget exhausted', count: 1 });
        } else {
          dropped.push({ section: 'project_snapshot', reason: 'truncated to fit', count: 1 });
        }
      }
    }

    // ---- Sections: retrieved atomic memories + episodes ----------------------
    // Scope filtering happens here: only the target project, never siblings.
    const scopes: ScopeSelector[] = [{ scope: 'user', scopeId: null }];
    if (request.projectId) scopes.push({ scope: 'project', scopeId: request.projectId });
    if (request.sessionId) scopes.push({ scope: 'session', scopeId: request.sessionId });

    const atomic = await this.memory.retrieve({
      query: request.query,
      scopes,
      kinds: [
        'preference',
        'fact',
        'constraint',
        'decision',
        'project_knowledge',
        'unresolved',
        'correction',
        'procedure',
      ],
      limit: 14,
    });
    const episodes = await this.memory.retrieve({
      query: request.query,
      scopes: request.projectId ? [{ scope: 'project', scopeId: request.projectId }] : [],
      kinds: ['episode'],
      limit: 4,
    });

    for (const group of [
      {
        items: atomic,
        cap: Math.floor(budget * share.memories),
        heading: 'Relevant memory',
        section: 'memories',
      },
      {
        items: episodes,
        cap: Math.floor(budget * share.episodes),
        heading: 'Related past work',
        section: 'episodes',
      },
    ]) {
      const block = renderMemoryBlock(
        group.items.filter((item) => !selectedMemoryIds.has(item.memory.id)),
        group.cap,
        budget - used,
        group.heading,
        group.section,
      );
      selections.push(...block.selections);
      for (const selection of block.selections) selectedMemoryIds.add(selection.memoryId);
      if (block.skipped)
        dropped.push({ section: group.section, reason: 'section budget', count: block.skipped });
      if (block.text) {
        parts.push(block.text);
        used += estimateTokens(block.text);
      }
    }

    // ---- Section: session working memory (Layer 1) ---------------------------
    if (request.sessionState?.trim()) {
      const cap = Math.floor(budget * share.session);
      const text = `## Current session state\n${request.sessionState.trim()}`;
      if (!push(text, cap))
        dropped.push({ section: 'session', reason: 'budget exhausted', count: 1 });
    }

    const rendered = parts.join('\n\n');
    const pack: ContextPack = {
      id: newId('pack'),
      role: request.role,
      rendered,
      usedTokens: estimateTokens(rendered),
      budgetTokens: budget,
      selections,
      dropped,
    };

    this.db
      .prepare(
        `INSERT INTO context_packs (id, job_id, session_id, run_id, role, query, budget_tokens,
          used_tokens, rendered, selections, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        pack.id,
        request.jobId ?? null,
        request.sessionId ?? null,
        request.runId ?? null,
        pack.role,
        request.query,
        pack.budgetTokens,
        pack.usedTokens,
        pack.rendered,
        JSON.stringify(pack.selections),
        nowIso(),
      );

    return pack;
  }

  /** Read back a stored pack for the "why did Jarvis use this?" UI. */
  getPack(id: string): (ContextPack & { jobId: string | null; createdAt: string }) | null {
    const row = this.db.prepare('SELECT * FROM context_packs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      role: row.role as string,
      rendered: row.rendered as string,
      usedTokens: Number(row.used_tokens),
      budgetTokens: Number(row.budget_tokens),
      selections: JSON.parse((row.selections as string) || '[]') as ContextSelection[],
      dropped: [],
      jobId: (row.job_id as string) ?? null,
      createdAt: row.created_at as string,
    };
  }
}

/**
 * Render retrieved memories as one bounded section.
 * `cap` is the section's share; `remaining` is what is left of the whole budget.
 * Whichever is smaller wins, so a section can never overrun the global budget.
 */
function renderMemoryBlock(
  items: RetrievedMemory[],
  cap: number,
  remaining: number,
  heading: string,
  section: string,
): { text: string | null; selections: ContextSelection[]; skipped: number } {
  const selections: ContextSelection[] = [];
  const lines: string[] = [];
  const limit = Math.min(cap, remaining);
  // The heading itself costs tokens; reserve it up front.
  let sectionUsed = estimateTokens(`## ${heading}\n`);
  let skipped = 0;

  for (const item of items) {
    const line = `- ${item.memory.subject ? `[${item.memory.subject}] ` : ''}${item.memory.content}`;
    const cost = estimateTokens(line) + 1;
    if (sectionUsed + cost > limit) {
      skipped++;
      continue;
    }
    lines.push(line);
    sectionUsed += cost;
    selections.push({
      memoryId: item.memory.id,
      scope: item.memory.scope,
      kind: item.memory.kind,
      score: item.score,
      reason: item.reason,
      tokens: cost,
      section,
    });
  }
  return {
    text: lines.length ? `## ${heading}\n${lines.join('\n')}` : null,
    selections,
    skipped,
  };
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * 3.6);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.floor(maxChars) - 3)}...`;
}
