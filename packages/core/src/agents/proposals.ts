import type { MemoryKind, MemoryScope } from '../memory/types.js';
import type { MemoryProposal } from './types.js';

const VALID_KINDS: MemoryKind[] = [
  'preference',
  'fact',
  'constraint',
  'decision',
  'project_knowledge',
  'episode',
  'procedure',
  'unresolved',
  'correction',
  'other',
];
const VALID_SCOPES: MemoryScope[] = ['user', 'project', 'session', 'procedure'];

/** The fenced block agents are asked to emit. */
const BLOCK_RE = /```(?:json\s+)?jarvis-memory\s*\n([\s\S]*?)```/gi;

/**
 * Extract memory proposals from an agent's final message.
 *
 * Parsing is deliberately forgiving about formatting and strict about content:
 * a malformed block yields zero proposals rather than throwing, because a bad
 * memory block must never fail an otherwise-successful job.
 */
export function extractMemoryProposals(text: string): {
  proposals: MemoryProposal[];
  cleanedText: string;
} {
  const proposals: MemoryProposal[] = [];
  let cleanedText = text;

  for (const match of text.matchAll(BLOCK_RE)) {
    const body = match[1];
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue; // malformed block: ignore, keep the rest of the result
    }
    const items = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray((parsed as { memories?: unknown }).memories)
        ? (parsed as { memories: unknown[] }).memories
        : [parsed];

    for (const item of items) {
      const proposal = validateProposal(item);
      if (proposal) proposals.push(proposal);
    }
  }

  cleanedText = text.replace(BLOCK_RE, '').trim();
  return { proposals, cleanedText };
}

function validateProposal(raw: unknown): MemoryProposal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const content = typeof obj.content === 'string' ? obj.content.trim() : '';
  if (content.length < 8 || content.length > 1200) return null;

  const type = obj.type ?? obj.kind;
  const kind = VALID_KINDS.includes(type as MemoryKind) ? (type as MemoryKind) : 'other';
  const scope = VALID_SCOPES.includes(obj.scope as MemoryScope)
    ? (obj.scope as MemoryScope)
    : 'project';

  const clamp = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
  };

  return {
    type: kind,
    scope,
    ...(typeof obj.subject === 'string' && obj.subject.trim()
      ? { subject: obj.subject.trim().slice(0, 120) }
      : {}),
    content,
    // Agents systematically over-rate their own output; cap the self-assessment.
    importance: Math.min(0.85, clamp(obj.importance, 0.6)),
    confidence: Math.min(0.9, clamp(obj.confidence, 0.7)),
    ...(typeof obj.reason === 'string' ? { reason: obj.reason.slice(0, 300) } : {}),
  };
}

/** Instruction appended to worker prompts so proposals ride along on work we already paid for. */
export const MEMORY_PROPOSAL_INSTRUCTIONS = `
## Durable memory (optional, end of your final message)

If — and only if — you learned something that will still matter weeks from now,
append ONE fenced block at the very end of your final message:

\`\`\`jarvis-memory
[
  {"type":"decision","scope":"project","subject":"db.engine",
   "content":"Local persistence uses SQLite via node:sqlite; no native deps.",
   "importance":0.9,"confidence":0.95,"reason":"architecture decision made in this job"}
]
\`\`\`

Rules:
- type: decision | constraint | project_knowledge | procedure | unresolved | preference | fact
- scope: project (default) | user
- subject: a stable dotted key when one exists, so later corrections supersede this cleanly.
- Emit 0-4 items. Zero is the right answer for routine work.
- NEVER include credentials, tokens, file contents, diffs, or transcript text.
- Write durable knowledge, not a summary of what you just did.
`.trim();
